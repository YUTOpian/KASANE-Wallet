// Aggregate CSV (CSVでまとめて送信), checking side: turns the rows of an uploaded file (see ./aggregateCsvText.ts) into
// transfer items for the aggregate draft, or into a list of what is wrong, row by row. Nothing is added unless the
// whole file is fine: an aggregate is all-or-nothing on the chain, so a half-imported file would only hide a mistake.
//
// Everything that needs the network (alias lookup, mosaic lookup, account restrictions) comes in through
// `CsvResolveDeps`, so the screen passes the real node calls and the tests pass fakes.
import { formatAtomic, parseDecimal } from './amount';
import { MAX_AGGREGATE_INNER, aggregateMosaicId, validateItem } from './aggregate';
import type { AggregateItem } from './aggregate';
import type { CsvRow } from './aggregateCsvText';
import type { RecipientResolution } from './api';
import { isValidAddress, normalizeAddress } from './crypto';
import { classifyRecipientInput } from './recipientInput';
import type { RecipientInput } from './recipientInput';
import type { RestrictionList } from './restrictions';
import { MAX_MESSAGE_BYTES, MOSAIC_FLAG_TRANSFERABLE, messageByteLength } from './tx';

type TransferItem = Extract<AggregateItem, { kind: 'transfer' }>;

/** What the checks need to know about a mosaic. */
export interface CsvMosaic {
  id: string; // 16 upper-case hex chars
  symbol: string;
  divisibility: number;
  transferable: boolean;
}

/** A message for the person: `key` is an i18n key, `params` its values. */
export interface CsvProblem {
  key: string;
  params?: Record<string, string | number>;
}

export interface CsvPreviewRow {
  row: CsvRow;
  /** The transfer this row becomes; null when the row has an error. */
  item: TransferItem | null;
  toAddress: string; // '' when the recipient could not be worked out
  alias?: string; // the namespace the recipient was written as
  mosaicSymbol: string;
  errors: CsvProblem[];
  warnings: CsvProblem[];
}

export interface CsvPreview {
  rows: CsvPreviewRow[];
  /** Problems of the file as a whole (too many rows, the total exceeds the balance, ...). */
  errors: CsvProblem[];
  warnings: CsvProblem[];
  /** What would be added to the draft; empty unless nothing at all is wrong. */
  items: AggregateItem[];
  errorCount: number;
  warningCount: number;
}

export interface CsvResolveDeps {
  networkByte: number;
  ownAddress: string; // base32 address of the wallet (the sender)
  currencyMosaicId: string; // 16 hex chars: what an empty mosaic cell means
  /** What the wallet holds (zero balances included, as the send forms list them). */
  held: Array<CsvMosaic & { amount: bigint }>;
  /** What is in the draft already: the mosaics it creates can be used, and what it sends counts against the balance. */
  existingItems: AggregateItem[];
  resolveRecipient: (input: RecipientInput) => Promise<RecipientResolution>;
  /** Info of a mosaic the wallet does not hold; null = no such mosaic. A rejected promise = the node could not be asked. */
  lookupMosaic: (id: string) => Promise<CsvMosaic | null>;
  /** Left out = the recipients' account restrictions are not checked. */
  getRestrictions?: (address: string) => Promise<RestrictionList[]>;
  newUid: () => string;
  concurrency?: number;
}

export type RestrictionProblem = 'sender_blocked' | 'sender_not_allowed' | 'mosaic_blocked' | 'mosaic_not_allowed';

/**
 * Whether the recipient's own account restrictions (incoming direction) would refuse a transfer from `senderAddress`
 * (and, when `mosaicId` is given, of that mosaic). Values written as namespace aliases cannot be compared, so they
 * never produce a problem on their own.
 */
export function recipientRestrictionProblem(lists: RestrictionList[], senderAddress: string, mosaicId: string | null): RestrictionProblem | null {
  const sender = normalizeAddress(senderAddress);
  for (const list of lists) {
    if (list.rule.direction !== 'incoming' || list.values.length === 0) continue;
    const hasAlias = list.values.some((v) => v.startsWith('@'));
    if (list.rule.kind === 'address') {
      const has = list.values.some((v) => normalizeAddress(v) === sender);
      if (list.mode === 'block' && has) return 'sender_blocked';
      if (list.mode === 'allow' && !has && !hasAlias) return 'sender_not_allowed';
    } else if (list.rule.kind === 'mosaic' && mosaicId !== null) {
      const has = list.values.some((v) => v.toUpperCase() === mosaicId.toUpperCase());
      if (list.mode === 'block' && has) return 'mosaic_blocked';
      if (list.mode === 'allow' && !has) return 'mosaic_not_allowed';
    }
  }
  return null;
}

async function mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      out[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, () => worker()));
  return out;
}

const HEX16 = /^(?:0x)?([0-9a-f]{16})$/i;

/** The mosaic id a mosaic cell stands for (empty / "XYM" = the network currency), or null when it is not one. */
export function csvMosaicId(cell: string, currencyMosaicId: string): string | null {
  const text = cell.trim();
  if (text === '' || /^(?:symbol\.)?(?:xym|mijin)$/i.test(text)) return currencyMosaicId.toUpperCase();
  const match = HEX16.exec(text);
  return match ? match[1].toUpperCase() : null;
}

type MosaicState = { ok: true; info: CsvMosaic; balance: bigint | null } | { ok: false; problem: CsvProblem };

export async function resolveCsvRows(rows: CsvRow[], deps: CsvResolveDeps): Promise<CsvPreview> {
  const limit = deps.concurrency ?? 4;
  const own = normalizeAddress(deps.ownAddress);
  const errors: CsvProblem[] = [];
  const warnings: CsvProblem[] = [];

  if (rows.length === 0) errors.push({ key: 'aggregate.csv_err_no_rows' });
  if (deps.existingItems.length + rows.length > MAX_AGGREGATE_INNER) {
    errors.push({ key: 'aggregate.csv_err_too_many', params: { count: rows.length, draft: deps.existingItems.length, max: MAX_AGGREGATE_INNER } });
  }

  // ---- what the draft already holds ----
  const draftMosaics = new Map<string, { divisibility: number; transferable: boolean }>();
  const alreadySent = new Map<string, bigint>();
  for (const i of deps.existingItems) {
    if (i.kind === 'mosaic_definition') {
      draftMosaics.set(aggregateMosaicId(deps.ownAddress, i.nonce), { divisibility: i.divisibility, transferable: (i.flags & MOSAIC_FLAG_TRANSFERABLE) !== 0 });
    } else if (i.kind === 'transfer' && !i.signer) {
      const id = i.mosaicId.toUpperCase();
      alreadySent.set(id, (alreadySent.get(id) ?? 0n) + i.amount);
    }
  }

  // ---- mosaics: one lookup per distinct id ----
  const mosaicKeys = [...new Set(rows.map((r) => csvMosaicId(r.mosaic, deps.currencyMosaicId)).filter((k): k is string => k !== null))];
  const mosaicStates = new Map<string, MosaicState>();
  await mapLimit(mosaicKeys, limit, async (id) => {
    const held = deps.held.find((h) => h.id.toUpperCase() === id);
    let state: MosaicState;
    if (held) {
      state = { ok: true, info: held, balance: held.amount };
    } else if (draftMosaics.has(id)) {
      const d = draftMosaics.get(id)!;
      state = { ok: true, info: { id, symbol: id, divisibility: d.divisibility, transferable: d.transferable }, balance: null };
    } else {
      try {
        const info = await deps.lookupMosaic(id);
        state = info ? { ok: true, info, balance: 0n } : { ok: false, problem: { key: 'aggregate.csv_err_mosaic_unknown', params: { mosaic: id } } };
      } catch {
        state = { ok: false, problem: { key: 'aggregate.csv_err_lookup_failed' } };
      }
    }
    if (state.ok && !state.info.transferable) {
      state = { ok: false, problem: { key: 'aggregate.csv_err_mosaic_not_transferable', params: { mosaic: state.info.symbol } } };
    }
    mosaicStates.set(id, state);
  });

  // ---- recipients: addresses are used as they are, aliases and public keys are looked up once each ----
  const lookups = new Map<string, RecipientResolution | 'failed'>();
  const toLookup = [...new Set(rows
    .filter((r) => r.recipient !== '' && !isValidAddress(normalizeAddress(r.recipient)) && classifyRecipientInput(r.recipient).kind !== 'other')
    .map((r) => r.recipient))];
  await mapLimit(toLookup, limit, async (text) => {
    try {
      lookups.set(text, await deps.resolveRecipient(classifyRecipientInput(text)));
    } catch {
      lookups.set(text, 'failed');
    }
  });

  // ---- row by row ----
  const preview: CsvPreviewRow[] = rows.map((row) => {
    const rowErrors: CsvProblem[] = [];
    const rowWarnings: CsvProblem[] = [];
    let toAddress = '';
    let alias: string | undefined;

    if (row.recipient === '') {
      rowErrors.push({ key: 'aggregate.csv_err_recipient_empty' });
    } else {
      const typed = normalizeAddress(row.recipient);
      if (isValidAddress(typed, deps.networkByte)) {
        toAddress = typed;
      } else if (isValidAddress(typed)) {
        rowErrors.push({ key: 'aggregate.csv_err_address_network' });
      } else {
        const input = classifyRecipientInput(row.recipient);
        if (input.kind === 'other') {
          rowErrors.push({ key: 'common.invalid_address' });
        } else {
          const found = lookups.get(row.recipient);
          if (found === undefined || found === 'failed') rowErrors.push({ key: 'send.alias_lookup_failed' });
          else if (!found.ok) rowErrors.push({ key: `send.alias_${found.reason}` });
          else {
            toAddress = normalizeAddress(found.address);
            alias = found.via === 'alias' && input.kind === 'alias' ? input.name : undefined;
          }
        }
      }
    }

    const mosaicId = csvMosaicId(row.mosaic, deps.currencyMosaicId);
    let state: MosaicState | undefined;
    if (mosaicId === null) rowErrors.push({ key: 'aggregate.csv_err_mosaic_format' });
    else {
      state = mosaicStates.get(mosaicId);
      if (state && !state.ok) rowErrors.push(state.problem);
    }

    let amount = 0n;
    if (state?.ok && row.amount !== '') {
      const parsed = parseDecimal(row.amount, state.info.divisibility);
      if (parsed !== null) amount = parsed;
      else if (/^\d*\.\d*$/.test(row.amount) && row.amount.split('.')[1].length > state.info.divisibility) {
        rowErrors.push({ key: 'aggregate.csv_err_decimals', params: { max: state.info.divisibility } });
      } else {
        rowErrors.push({ key: 'aggregate.invalid_amount' });
      }
    }

    if (messageByteLength(row.message) > MAX_MESSAGE_BYTES) rowErrors.push({ key: 'aggregate.item_message_too_long' });

    let item: TransferItem | null = null;
    if (rowErrors.length === 0 && state?.ok && mosaicId !== null) {
      const candidate: TransferItem = {
        uid: deps.newUid(),
        kind: 'transfer',
        recipient: toAddress,
        recipientAlias: alias,
        mosaicId,
        mosaicSymbol: state.info.symbol,
        divisibility: state.info.divisibility,
        amount,
        message: row.message,
        label: row.label !== '' ? row.label : undefined,
      };
      const why = validateItem(candidate);
      if (why) rowErrors.push({ key: `aggregate.${why}` });
      else item = candidate;
    }

    if (toAddress !== '' && toAddress === own) rowWarnings.push({ key: 'aggregate.csv_warn_self' });
    return { row, item, toAddress, alias, mosaicSymbol: state?.ok ? state.info.symbol : row.mosaic, errors: rowErrors, warnings: rowWarnings };
  });

  // ---- the same transfer twice (a line pasted two times) ----
  const seen = new Map<string, number>();
  for (const p of preview) {
    if (!p.item) continue;
    const key = [p.toAddress, p.item.mosaicId, p.item.amount, p.item.message].join('|');
    const first = seen.get(key);
    if (first === undefined) seen.set(key, p.row.line);
    else p.warnings.push({ key: 'aggregate.csv_warn_duplicate', params: { line: first } });
  }

  // ---- the totals against what the wallet holds (the fee is checked on the page, with the rest of the cost) ----
  const totals = new Map<string, bigint>();
  for (const p of preview) {
    if (p.item) totals.set(p.item.mosaicId, (totals.get(p.item.mosaicId) ?? 0n) + p.item.amount);
  }
  for (const [id, sum] of totals) {
    const state = mosaicStates.get(id);
    if (!state?.ok || state.balance === null) continue;
    const total = sum + (alreadySent.get(id) ?? 0n);
    if (total > state.balance) {
      errors.push({
        key: 'aggregate.csv_err_total_exceeds',
        params: { symbol: state.info.symbol, total: formatAtomic(total, state.info.divisibility), balance: formatAtomic(state.balance, state.info.divisibility) },
      });
    }
  }

  // ---- the recipients' own account restrictions: such a transfer would fail on the chain, and with it the whole aggregate ----
  if (deps.getRestrictions) {
    const getRestrictions = deps.getRestrictions;
    const addresses = [...new Set(preview.filter((p) => p.item && p.toAddress !== own).map((p) => p.toAddress))];
    const lists = new Map<string, RestrictionList[] | null>();
    await mapLimit(addresses, limit, async (address) => {
      try {
        lists.set(address, await getRestrictions(address));
      } catch {
        lists.set(address, null);
      }
    });
    for (const p of preview) {
      if (!p.item || p.toAddress === own) continue;
      const found = lists.get(p.toAddress);
      if (!found) continue;
      const problem = recipientRestrictionProblem(found, own, p.item.amount > 0n ? p.item.mosaicId : null);
      if (problem) {
        p.errors.push({ key: `aggregate.csv_err_restriction_${problem}` });
        p.item = null;
      }
    }
    const unchecked = [...lists.values()].filter((v) => v === null).length;
    if (unchecked > 0) warnings.push({ key: 'aggregate.csv_warn_restriction_unchecked', params: { count: unchecked } });
  }

  const errorCount = errors.length + preview.filter((p) => p.errors.length > 0).length;
  const warningCount = warnings.length + preview.filter((p) => p.warnings.length > 0).length;
  const items = errorCount === 0 ? preview.flatMap((p) => (p.item ? [p.item] : [])) : [];
  return { rows: preview, errors, warnings, items, errorCount, warningCount };
}
