// Helpers for Symbol account restrictions (アカウント制限): the protocol's flag bits, how the node's REST answer
// maps to the three restriction kinds, validation of what the user types and the size maths for the fee.
// Nothing here talks to the network or the SDK, so it is safe to use from forms and from tests.
import { addressBytesToString, decodeAddress, normalizeAddress } from './crypto';

// --- flags ----------------------------------------------------------------------------------------
// AccountRestrictionFlags: the low bits say WHAT is restricted, the two high bits say how.
export const RESTRICTION_FLAG_ADDRESS = 0x0001;
export const RESTRICTION_FLAG_MOSAIC_ID = 0x0002;
export const RESTRICTION_FLAG_TRANSACTION_TYPE = 0x0004;
export const RESTRICTION_FLAG_OUTGOING = 0x4000;
export const RESTRICTION_FLAG_BLOCK = 0x8000;

/** What the restriction list holds. */
export type RestrictionKind = 'address' | 'mosaic' | 'operation';
/** allow = only the listed values are permitted / block = the listed values are refused. */
export type RestrictionMode = 'allow' | 'block';
export type RestrictionDirection = 'incoming' | 'outgoing';

export const RESTRICTION_KINDS: RestrictionKind[] = ['address', 'mosaic', 'operation'];

/** Directions the protocol offers for each kind: addresses both ways, mosaics only incoming, operations only outgoing. */
export const RESTRICTION_DIRECTIONS: Record<RestrictionKind, RestrictionDirection[]> = {
  address: ['incoming', 'outgoing'],
  mosaic: ['incoming'],
  operation: ['outgoing'],
};

/** One rule = one list the node keeps: a kind in one direction, in allow or block mode. */
export interface RestrictionRule {
  kind: RestrictionKind;
  direction: RestrictionDirection;
}

const KIND_FLAG: Record<RestrictionKind, number> = {
  address: RESTRICTION_FLAG_ADDRESS,
  mosaic: RESTRICTION_FLAG_MOSAIC_ID,
  operation: RESTRICTION_FLAG_TRANSACTION_TYPE,
};

/** The flags value of a transaction that edits `rule` in `mode`. */
export function restrictionFlags(rule: RestrictionRule, mode: RestrictionMode): number {
  return KIND_FLAG[rule.kind]
    | (rule.direction === 'outgoing' ? RESTRICTION_FLAG_OUTGOING : 0)
    | (mode === 'block' ? RESTRICTION_FLAG_BLOCK : 0);
}

/** Splits the node's flags into the rule they belong to and the mode; null for a value this wallet does not know. */
export function parseRestrictionFlags(flags: number): { rule: RestrictionRule; mode: RestrictionMode } | null {
  const what = flags & 0x0007;
  const kind: RestrictionKind | null = what === RESTRICTION_FLAG_ADDRESS ? 'address'
    : what === RESTRICTION_FLAG_MOSAIC_ID ? 'mosaic'
      : what === RESTRICTION_FLAG_TRANSACTION_TYPE ? 'operation' : null;
  if (kind === null) return null;
  return {
    rule: { kind, direction: (flags & RESTRICTION_FLAG_OUTGOING) !== 0 ? 'outgoing' : 'incoming' },
    mode: (flags & RESTRICTION_FLAG_BLOCK) !== 0 ? 'block' : 'allow',
  };
}

export function sameRule(a: RestrictionRule, b: RestrictionRule): boolean {
  return a.kind === b.kind && a.direction === b.direction;
}

// --- what the node returns ----------------------------------------------------------------------
/** The list the node holds for one rule. `values` are in a canonical form: base32 address / 16 hex mosaic id / hex tx type. */
export interface RestrictionList {
  rule: RestrictionRule;
  mode: RestrictionMode;
  values: string[];
}

/** An operation (transaction type) is shown and stored as its 4-digit hex code, e.g. 4154 for a transfer. */
export function operationCode(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** The raw body of GET /restrictions/account/{address}. */
export interface RawAccountRestrictions {
  accountRestrictions?: {
    restrictions?: Array<{ restrictionFlags: number | string; values?: Array<string | number> }>;
  };
}

/**
 * A value as the node writes it (address = 48 hex chars, mosaic id = 16 hex, operation = number) in the canonical
 * form this file uses, or null. An address written as a namespace alias (the first byte's low bit is set; the
 * node keeps those in transactions still waiting for signatures) becomes "@" + the 16-hex namespace id.
 */
export function canonicalRestrictionValue(kind: RestrictionKind, raw: string | number): string | null {
  try {
    if (kind === 'address') {
      const text = String(raw).trim();
      // The node sends addresses as 48 hex chars (the 24 address bytes).
      if (/^[0-9a-fA-F]{48}$/.test(text)) {
        const bytes = new Uint8Array(24);
        for (let i = 0; i < 24; i += 1) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
        if ((bytes[0] & 1) === 1) {
          return `@${text.slice(2, 18).toUpperCase()}`;
        }
        return addressBytesToString(bytes);
      }
      return normalizeAddress(text);
    }
    if (kind === 'mosaic') return String(raw).trim().toUpperCase();
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? operationCode(n) : null;
  } catch {
    return null;
  }
}

/** Reads the node's answer into one list per restriction the account has set (an account with none yields an empty array). */
export function parseAccountRestrictions(raw: RawAccountRestrictions): RestrictionList[] {
  const out: RestrictionList[] = [];
  for (const r of raw.accountRestrictions?.restrictions ?? []) {
    const parsed = parseRestrictionFlags(Number(r.restrictionFlags));
    if (parsed === null) continue;
    const values = (r.values ?? [])
      .map((v) => canonicalRestrictionValue(parsed.rule.kind, v))
      .filter((v): v is string => v !== null);
    out.push({ rule: parsed.rule, mode: parsed.mode, values });
  }
  return out;
}

/** The list currently set for `rule` (undefined when the account has none there). */
export function findList(lists: RestrictionList[], rule: RestrictionRule): RestrictionList | undefined {
  return lists.find((l) => sameRule(l.rule, rule));
}

// --- operations (transaction types) ------------------------------------------------------------------
/** Transaction types an account can allow / block; `key` is the i18n key under restriction.ops. */
export const RESTRICTION_OPERATIONS: { code: number; key: string }[] = [
  { code: 0x4154, key: 'transfer' },
  { code: 0x4141, key: 'aggregate_complete' },
  { code: 0x4241, key: 'aggregate_bonded' },
  { code: 0x4148, key: 'hash_lock' },
  { code: 0x4152, key: 'secret_lock' },
  { code: 0x4252, key: 'secret_proof' },
  { code: 0x414D, key: 'mosaic_definition' },
  { code: 0x424D, key: 'mosaic_supply_change' },
  { code: 0x434D, key: 'mosaic_supply_revocation' },
  { code: 0x414E, key: 'namespace_registration' },
  { code: 0x424E, key: 'address_alias' },
  { code: 0x434E, key: 'mosaic_alias' },
  { code: 0x4144, key: 'account_metadata' },
  { code: 0x4244, key: 'mosaic_metadata' },
  { code: 0x4344, key: 'namespace_metadata' },
  { code: 0x4155, key: 'multisig_modification' },
  { code: 0x414C, key: 'account_key_link' },
  { code: 0x424C, key: 'node_key_link' },
  { code: 0x4143, key: 'voting_key_link' },
  { code: 0x4243, key: 'vrf_key_link' },
  { code: 0x4150, key: 'account_address_restriction' },
  { code: 0x4250, key: 'account_mosaic_restriction' },
  { code: 0x4350, key: 'account_operation_restriction' },
  { code: 0x4151, key: 'mosaic_global_restriction' },
  { code: 0x4251, key: 'mosaic_address_restriction' },
];

/** The transaction type that edits operation restrictions. It can never be blocked, and an allow list without it locks the account's restrictions for good. */
export const OPERATION_RESTRICTION_TYPE = 0x4350;

export function operationKey(code: string): string | null {
  const n = parseInt(code, 16);
  return RESTRICTION_OPERATIONS.find((o) => o.code === n)?.key ?? null;
}

// --- limits and validation --------------------------------------------------------------------------
/** The node's default limit of values per restriction list. */
export const MAX_RESTRICTION_VALUES = 512;
/** A transaction counts its additions and deletions in one byte each. */
export const MAX_RESTRICTION_CHANGES_PER_TX = 255;

export type RestrictionInputError =
  | 'invalid_address' | 'own_address' | 'wrong_network'
  | 'invalid_mosaic_id' | 'invalid_operation'
  | 'blocked_operation_restriction'
  // an address typed as a namespace alias (see restrictionAlias.ts)
  | 'alias_not_found' | 'alias_no_address' | 'alias_expired' | 'alias_wrong_network' | 'alias_lookup_failed';

/**
 * Turns what the user typed into the canonical value of `kind`, or says what is wrong with it.
 * `networkByte` / `ownAddress` are only used for addresses; `mode` only for the operation list.
 */
export function parseRestrictionInput(
  kind: RestrictionKind,
  input: string,
  opts: { networkByte?: number; ownAddress?: string; mode?: RestrictionMode } = {},
): { ok: true; value: string } | { ok: false; error: RestrictionInputError } {
  const text = input.trim();
  if (kind === 'address') {
    const bytes = decodeAddress(text);
    if (bytes === null) return { ok: false, error: 'invalid_address' };
    if (opts.networkByte !== undefined && bytes[0] !== opts.networkByte) return { ok: false, error: 'wrong_network' };
    const value = normalizeAddress(text);
    if (opts.ownAddress !== undefined && normalizeAddress(opts.ownAddress) === value) return { ok: false, error: 'own_address' };
    return { ok: true, value };
  }
  if (kind === 'mosaic') {
    if (!/^[0-9a-fA-F]{16}$/.test(text)) return { ok: false, error: 'invalid_mosaic_id' };
    return { ok: true, value: text.toUpperCase() };
  }
  const n = /^[0-9a-fA-F]{1,4}$/.test(text) ? parseInt(text, 16) : NaN;
  if (!RESTRICTION_OPERATIONS.some((o) => o.code === n)) return { ok: false, error: 'invalid_operation' };
  if (opts.mode === 'block' && n === OPERATION_RESTRICTION_TYPE) return { ok: false, error: 'blocked_operation_restriction' };
  return { ok: true, value: operationCode(n) };
}

/** The values the list will hold after the staged changes (current - removals + additions). */
export function resultingValues(current: string[], additions: string[], deletions: string[]): string[] {
  const removed = new Set(deletions);
  const kept = current.filter((v) => !removed.has(v));
  const keptSet = new Set(kept);
  return [...kept, ...additions.filter((v) => !keptSet.has(v))];
}

export type ChangeSetProblem =
  | 'no_changes' | 'too_many_values' | 'too_many_changes' | 'operation_lockout';

/** Checks the whole staged change before the user can go on (single-value rules are checked while typing). */
export function validateChangeSet(
  rule: RestrictionRule,
  mode: RestrictionMode,
  current: string[],
  additions: string[],
  deletions: string[],
): ChangeSetProblem | null {
  if (additions.length === 0 && deletions.length === 0) return 'no_changes';
  if (additions.length > MAX_RESTRICTION_CHANGES_PER_TX || deletions.length > MAX_RESTRICTION_CHANGES_PER_TX) return 'too_many_changes';
  const result = resultingValues(current, additions, deletions);
  if (result.length > MAX_RESTRICTION_VALUES) return 'too_many_values';
  // An allow list of operations that leaves out "change operation restrictions" could never be edited again.
  if (rule.kind === 'operation' && mode === 'allow' && result.length > 0 && !result.includes(operationCode(OPERATION_RESTRICTION_TYPE))) {
    return 'operation_lockout';
  }
  return null;
}

// --- sizes (to show the fee before signing) -------------------------------------------------------------
/** 128 bytes of common header + flags 2, counts 2 and 4 reserved bytes. */
export const RESTRICTION_BASE_SIZE = 136;
const VALUE_SIZE: Record<RestrictionKind, number> = { address: 24, mosaic: 8, operation: 2 };

export function restrictionTransactionSize(kind: RestrictionKind, additionCount: number, deletionCount: number): number {
  return RESTRICTION_BASE_SIZE + VALUE_SIZE[kind] * (additionCount + deletionCount);
}

/**
 * Size of the same change as an EMBEDDED transaction (inside an aggregate): 48 bytes of embedded header + the same
 * 8-byte body + the values, padded up to a multiple of 8 because aggregates align their inner transactions.
 */
export function embeddedRestrictionSize(kind: RestrictionKind, additionCount: number, deletionCount: number): number {
  const raw = 48 + 8 + VALUE_SIZE[kind] * (additionCount + deletionCount);
  return Math.ceil(raw / 8) * 8;
}

// --- restrictions of a multisig account (changed by a cosigner, through an aggregate) -------------------------
/** The three transaction types that edit restrictions, by what the list holds. */
export const RESTRICTION_TX_TYPE: Record<RestrictionKind, number> = {
  address: 0x4150,
  mosaic: 0x4250,
  operation: 0x4350,
};

/** What a restriction transaction changes, as shown to a cosigner before signing. */
export interface RestrictionChange {
  rule: RestrictionRule;
  mode: RestrictionMode;
  additions: string[];
  deletions: string[];
}

/**
 * Reads a restriction transaction (its type, flags and raw values) into a change. null when the type is not one of the
 * three, the flags say something else than the type, or a value cannot be read: the caller then shows it as an unknown
 * operation instead of guessing.
 */
export function parseRestrictionChange(
  txType: number,
  flags: number,
  additions: Array<string | number>,
  deletions: Array<string | number>,
): RestrictionChange | null {
  const kind = RESTRICTION_KINDS.find((k) => RESTRICTION_TX_TYPE[k] === txType);
  if (kind === undefined) return null;
  const parsed = parseRestrictionFlags(flags);
  if (parsed === null || parsed.rule.kind !== kind) return null;
  const read = (values: Array<string | number>): string[] | null => {
    const out: string[] = [];
    for (const v of values) {
      const c = canonicalRestrictionValue(kind, v);
      if (c === null) return null;
      out.push(c);
    }
    return out;
  };
  const add = read(additions);
  const del = read(deletions);
  if (add === null || del === null) return null;
  return { rule: parsed.rule, mode: parsed.mode, additions: add, deletions: del };
}

/** "Change multisig settings" - an operation allow list without it can never change the cosigners again. */
export const MULTISIG_MODIFICATION_TYPE = 0x4155;

/** true when an allow list of operations (after the change) would shut out changes to a multisig account's cosigners. */
export function lacksMultisigModification(rule: RestrictionRule, mode: RestrictionMode, resulting: string[]): boolean {
  return rule.kind === 'operation' && mode === 'allow' && resulting.length > 0
    && !resulting.includes(operationCode(MULTISIG_MODIFICATION_TYPE));
}
