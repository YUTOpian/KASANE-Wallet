// Full transaction history (every transaction type, three groups) read from the Symbol REST gateway.
// The older fetchTransfers() in api.ts keeps serving Home and the send form (transfers only).
import { addressBytesToString, addressFromPublicKey, bytesToHex, hexToBytes, normalizeAddress } from './crypto';
import { CURRENCY_DIVISIBILITY } from './constants';
import { getNetworkConfig } from './network';
import { formatAtomic } from './amount';
import { getMosaicInfos, nodeRequest, resolveMosaicId } from './api';

export type HistoryStatus = 'confirmed' | 'unconfirmed' | 'partial';
export const HISTORY_STATUSES: HistoryStatus[] = ['confirmed', 'unconfirmed', 'partial'];

export type HistoryCategory = 'transfer' | 'aggregate' | 'mosaic' | 'namespace' | 'metadata' | 'multisig' | 'restriction' | 'lock' | 'link' | 'other';
export const HISTORY_CATEGORIES: HistoryCategory[] = ['transfer', 'aggregate', 'mosaic', 'namespace', 'metadata', 'multisig', 'restriction', 'lock', 'link'];

// Transaction type -> [i18n key suffix, category].
const TYPE_INFO: Record<number, [string, HistoryCategory]> = {
  0x4154: ['transfer', 'transfer'],
  0x4141: ['aggregate_complete', 'aggregate'],
  0x4241: ['aggregate_bonded', 'aggregate'],
  0x414d: ['mosaic_definition', 'mosaic'],
  0x424d: ['mosaic_supply_change', 'mosaic'],
  0x434d: ['mosaic_supply_revocation', 'mosaic'],
  0x414e: ['namespace_registration', 'namespace'],
  0x424e: ['address_alias', 'namespace'],
  0x434e: ['mosaic_alias', 'namespace'],
  0x4144: ['account_metadata', 'metadata'],
  0x4244: ['mosaic_metadata', 'metadata'],
  0x4344: ['namespace_metadata', 'metadata'],
  0x4155: ['multisig_modification', 'multisig'],
  0x4150: ['account_address_restriction', 'restriction'],
  0x4250: ['account_mosaic_restriction', 'restriction'],
  0x4350: ['account_operation_restriction', 'restriction'],
  0x4151: ['mosaic_global_restriction', 'restriction'],
  0x4251: ['mosaic_address_restriction', 'restriction'],
  0x4148: ['hash_lock', 'lock'],
  0x4152: ['secret_lock', 'lock'],
  0x4252: ['secret_proof', 'lock'],
  0x414c: ['account_key_link', 'link'],
  0x424c: ['node_key_link', 'link'],
  0x4143: ['voting_key_link', 'link'],
  0x4243: ['vrf_key_link', 'link'],
};

export function typeKey(type: number): string {
  return TYPE_INFO[type]?.[0] ?? 'unknown';
}
export function typeCategory(type: number): HistoryCategory {
  return TYPE_INFO[type]?.[1] ?? 'other';
}

export interface HistoryMosaic { id: string; symbol: string; amount: string }

export interface HistoryItem {
  hash: string;
  status: HistoryStatus;
  type: number;
  typeKey: string;
  category: HistoryCategory;
  timestampMs: number | null; // confirmed only
  deadlineMs: number | null;
  height: string;
  signerAddress: string;
  signerPublicKey: string;
  isOutgoing: boolean; // signed by this account
  fee: string; // XYM, '' when unknown
  // Transfers only
  recipient: string;
  isReception: boolean;
  mosaics: HistoryMosaic[];
  message: string;
  encryptedMessage: boolean;
  encryptedPayload: string; // hex of the encrypted message field ('' when the message is not encrypted)
}

interface RawTransaction {
  type: number;
  network: number;
  signerPublicKey: string;
  deadline?: string;
  maxFee?: string;
  size?: number;
  recipientAddress?: string;
  mosaics?: Array<{ id: string; amount: string }>;
  message?: string;
  transactions?: RawEntry[];
  cosignatures?: Array<{ signerPublicKey: string; signature?: string }>;
  [key: string]: unknown;
}
interface RawEntry {
  meta?: { hash?: string; aggregateHash?: string; timestamp?: string; height?: string; feeMultiplier?: number };
  transaction: RawTransaction;
}

function epochMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n + getNetworkConfig().epochAdjustment * 1000 : null;
}

/** Recipient as a base32 address, or "@<hex>" for a namespace alias. */
export function recipientToString(hex: string): string {
  const bytes = hexToBytes(hex);
  if ((bytes[0] & 1) === 1) return `@${bytesToHex(bytes.slice(1, 9))}`;
  return addressBytesToString(bytes);
}

async function readMosaics(raw: Array<{ id: string; amount: string }> | undefined): Promise<HistoryMosaic[]> {
  if (!raw || raw.length === 0) return [];
  const ids = await Promise.all(raw.map((m) => resolveMosaicId(m.id)));
  const infos = await getMosaicInfos(ids);
  return raw.map((m, i) => {
    const info = infos[ids[i]] ?? { id: ids[i], divisibility: 0, symbol: ids[i] };
    return { id: ids[i], symbol: info.symbol, amount: formatAtomic(BigInt(m.amount), info.divisibility) };
  });
}

function readMessage(hex: string | undefined): { message: string; encrypted: boolean; payload: string } {
  if (!hex || hex.length < 2) return { message: '', encrypted: false, payload: '' };
  const bytes = hexToBytes(hex);
  if (bytes[0] === 1) return { message: '', encrypted: true, payload: hex.toUpperCase() };
  return { message: new TextDecoder().decode(bytes.slice(1)), encrypted: false, payload: '' };
}

async function toItem(entry: RawEntry, myAddress: string, status: HistoryStatus): Promise<HistoryItem> {
  const tx = entry.transaction;
  const me = normalizeAddress(myAddress);
  const signerAddress = addressFromPublicKey(tx.signerPublicKey, tx.network);
  const isTransfer = tx.type === 0x4154;
  const recipient = isTransfer && tx.recipientAddress ? recipientToString(tx.recipientAddress) : '';

  let feeAtomic: bigint | null = null;
  if (entry.meta?.feeMultiplier !== undefined && tx.size) feeAtomic = BigInt(tx.size) * BigInt(entry.meta.feeMultiplier);
  else if (tx.maxFee) feeAtomic = BigInt(tx.maxFee);

  const { message, encrypted, payload } = isTransfer ? readMessage(tx.message) : { message: '', encrypted: false, payload: '' };
  return {
    hash: entry.meta?.hash ?? entry.meta?.aggregateHash ?? '',
    status,
    type: tx.type,
    typeKey: typeKey(tx.type),
    category: typeCategory(tx.type),
    timestampMs: status === 'confirmed' ? epochMs(entry.meta?.timestamp) : null,
    deadlineMs: epochMs(tx.deadline),
    height: entry.meta?.height ?? '',
    signerAddress,
    signerPublicKey: tx.signerPublicKey,
    isOutgoing: signerAddress === me,
    fee: feeAtomic === null ? '' : formatAtomic(feeAtomic, CURRENCY_DIVISIBILITY),
    recipient,
    isReception: isTransfer && recipient === me && signerAddress !== me,
    mosaics: isTransfer ? await readMosaics(tx.mosaics) : [],
    message,
    encryptedMessage: encrypted,
    encryptedPayload: payload,
  };
}

export const HISTORY_PAGE_SIZE = 25;

export interface HistoryPage {
  items: HistoryItem[];
  hasMore: boolean;
}

/** One page (newest first) of the account's transactions in one group, of every type. */
export async function fetchHistoryPage(address: string, status: HistoryStatus, pageNumber = 1, pageSize = HISTORY_PAGE_SIZE): Promise<HistoryPage> {
  const addr = normalizeAddress(address);
  const query = `address=${addr}&order=desc&pageSize=${pageSize}&pageNumber=${pageNumber}`;
  const res = await nodeRequest<{ data: RawEntry[] }>(`/transactions/${status}?${query}`);
  const items = await Promise.all(res.data.map((entry) => toItem(entry, addr, status)));
  return { items, hasMore: res.data.length >= pageSize };
}

// --- detail ---------------------------------------------------------------------------------

export interface DetailField { key: string; value: string }

export interface InnerDetail {
  type: number;
  typeKey: string;
  category: HistoryCategory;
  signerAddress: string;
  signerPublicKey: string;
  transfer: { recipient: string; mosaics: HistoryMosaic[]; message: string; encryptedMessage: boolean; encryptedPayload: string } | null;
  fields: DetailField[];
}

export interface HistoryDetail {
  item: HistoryItem;
  fields: DetailField[]; // type specific fields of the transaction itself (non-aggregates)
  inner: InnerDetail[];
  cosigners: Array<{ address: string; publicKey: string }>;
}

// Fields shown elsewhere (or meaningless to a person); everything else is listed generically.
const HIDDEN_FIELDS = new Set([
  'signature', 'signerPublicKey', 'version', 'network', 'type', 'maxFee', 'deadline', 'size',
  'transactions', 'cosignatures', 'payloadSize', 'transactionsHash', 'aggregateTransactionHeaderReserved_1',
  'recipientAddress', 'mosaics', 'message',
]);
const ADDRESS_FIELDS = new Set(['targetAddress', 'recipientAddress', 'address']);
const ADDRESS_LIST_FIELDS = new Set(['addressAdditions', 'addressDeletions', 'restrictionAdditions', 'restrictionDeletions']);

function hexToText(hex: string): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex));
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

function looksLikeAddressHex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-Fa-f]{48}$/.test(v);
}

async function genericFields(tx: RawTransaction): Promise<DetailField[]> {
  const out: DetailField[] = [];
  for (const [key, value] of Object.entries(tx)) {
    if (HIDDEN_FIELDS.has(key) || value === undefined || value === null) continue;
    if (key === 'name' && typeof value === 'string') {
      out.push({ key, value: hexToText(value) ?? value });
    } else if (key === 'value' && typeof value === 'string') {
      const text = hexToText(value);
      out.push({ key, value: text !== null && text.length > 0 ? `${value} (${text})` : value });
    } else if (ADDRESS_FIELDS.has(key) && looksLikeAddressHex(value)) {
      out.push({ key, value: addressBytesToString(hexToBytes(value)) });
    } else if (ADDRESS_LIST_FIELDS.has(key) && Array.isArray(value)) {
      out.push({ key, value: value.map((v) => (looksLikeAddressHex(v) ? addressBytesToString(hexToBytes(v)) : String(v))).join('\n') });
    } else if (key === 'mosaic' && typeof value === 'object') {
      const m = value as { id: string; amount: string };
      const [r] = await readMosaics([m]);
      out.push({ key, value: `${r.amount} ${r.symbol}` });
    } else if (Array.isArray(value)) {
      out.push({ key, value: value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ') });
    } else if (typeof value === 'object') {
      out.push({ key, value: JSON.stringify(value) });
    } else {
      out.push({ key, value: String(value) });
    }
  }
  return out;
}

async function toInner(entry: RawEntry): Promise<InnerDetail> {
  const tx = entry.transaction;
  const isTransfer = tx.type === 0x4154;
  const { message, encrypted, payload } = isTransfer ? readMessage(tx.message) : { message: '', encrypted: false, payload: '' };
  return {
    type: tx.type,
    typeKey: typeKey(tx.type),
    category: typeCategory(tx.type),
    signerAddress: addressFromPublicKey(tx.signerPublicKey, tx.network),
    signerPublicKey: tx.signerPublicKey,
    transfer: isTransfer && tx.recipientAddress
      ? { recipient: recipientToString(tx.recipientAddress), mosaics: await readMosaics(tx.mosaics), message, encryptedMessage: encrypted, encryptedPayload: payload }
      : null,
    fields: isTransfer ? [] : await genericFields(tx),
  };
}

/** Everything the node knows about one transaction (inner transactions and cosignatures of an aggregate included). */
export async function fetchHistoryDetail(hash: string, status: HistoryStatus, myAddress: string): Promise<HistoryDetail> {
  const entry = await nodeRequest<RawEntry>(`/transactions/${status}/${hash.toUpperCase()}`);
  const item = await toItem(entry, myAddress, status);
  const tx = entry.transaction;
  const isAggregate = item.category === 'aggregate';
  const inner = isAggregate && Array.isArray(tx.transactions) ? await Promise.all(tx.transactions.map(toInner)) : [];
  const cosigners = (tx.cosignatures ?? []).map((c) => ({
    publicKey: c.signerPublicKey,
    address: addressFromPublicKey(c.signerPublicKey, tx.network),
  }));
  const fields = item.category === 'transfer' || isAggregate ? [] : await genericFields(tx);
  return { item, fields, inner, cosigners };
}

/** An unconfirmed / partial transaction whose deadline has passed can no longer be confirmed. */
export function isExpired(item: Pick<HistoryItem, 'status' | 'deadlineMs'>, nowMs: number = Date.now()): boolean {
  return item.status !== 'confirmed' && item.deadlineMs !== null && item.deadlineMs < nowMs;
}

/**
 * Like fetchHistoryDetail, but when the transaction has moved on (a partial one gathered its
 * cosignatures, an unconfirmed one got confirmed) it is looked up in the other groups too.
 */
export async function fetchHistoryDetailAny(hash: string, preferred: HistoryStatus, myAddress: string): Promise<HistoryDetail> {
  const order = [preferred, ...HISTORY_STATUSES.filter((s) => s !== preferred)];
  let lastError: unknown;
  for (const status of order) {
    try {
      return await fetchHistoryDetail(hash, status, myAddress);
    } catch (e) {
      lastError = e;
      // Only "not found" means "look in the next group"; anything else (node down) is reported as is.
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('not_found');
}

// --- filter + CSV -----------------------------------------------------------------------------

export type DirectionFilter = 'all' | 'incoming' | 'outgoing';

export function filterHistory(items: HistoryItem[], category: HistoryCategory | 'all', direction: DirectionFilter): HistoryItem[] {
  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (direction === 'outgoing' && !item.isOutgoing) return false;
    if (direction === 'incoming' && item.isOutgoing) return false;
    return true;
  });
}

// A spreadsheet treats a cell starting with = + - @ (or a tab / CR) as a formula. Message text and
// namespace names come from other people, so such cells are defused with a leading apostrophe.
function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface CsvLabels {
  header: string[];
  status: Record<HistoryStatus, string>;
  direction: { incoming: string; outgoing: string };
  type: (key: string) => string;
}

/** CSV text (UTF-8, with a BOM so Excel reads Japanese correctly) of the given history rows. */
export function historyToCsv(items: HistoryItem[], labels: CsvLabels): string {
  const rows = items.map((it) => {
    const when = it.timestampMs ?? it.deadlineMs;
    return [
      labels.status[it.status],
      when === null ? '' : new Date(when).toISOString(),
      labels.type(it.typeKey),
      it.isOutgoing ? labels.direction.outgoing : labels.direction.incoming,
      it.signerAddress,
      it.recipient,
      it.mosaics.map((m) => `${m.amount} ${m.symbol}`).join('; '),
      it.encryptedMessage ? '(encrypted)' : it.message,
      it.fee,
      it.height,
      it.hash,
    ];
  });
  const lines = [labels.header, ...rows].map((r) => r.map(csvCell).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
