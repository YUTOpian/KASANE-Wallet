// Metadata on ANOTHER account's address, mosaic or namespace (他アカウント宛てのメタデータ).
//
// The wallet is the "source" of the entry (it signs the metadata transaction and the aggregate), and the owner of
// the target is the account the metadata is attached to. Symbol requires the target's owner to sign too, so the
// aggregate is BONDED: the wallet pays a hash lock, announces the aggregate as a partial transaction, and the owner
// co-signs it later (from its own wallet: 署名待ち / 連署). Only when the owner is a multisig account that the
// wallet alone can approve (minApproval 1) is the aggregate complete and announced directly.
// Entries are stored per (source, target, key): they never overwrite the owner's own entries for the same key.
import { getDefaultFeeSpeed } from './feeSpeed';
import { announceSigned, feeMultipliers, fetchMetadataValue, networkTimeMs, nodeRequest, quoteFeesForSize, resolveRecipientInput } from './api';
import type { MetadataTargetRef } from './api';
import { resolveSigner } from './aggregateApi';
import type { AggregateSigner } from './aggregate';
import { addressBytesToString, addressFromPublicKey, bytesToHex, hexToBytes, isValidAddress, normalizeAddress } from './crypto';
import { classifyRecipientInput } from './recipientInput';
import { parseRestrictionAddressInput } from './restrictionAlias';
import { METADATA_TYPE_CODE, decodeValueText, metadataAggregateSize } from './metadata';
import type { MetadataItem, MetadataTargetType } from './metadata';
import { announcePartial, fetchHashLockAmount, waitConfirmed } from './multisigApi';
import { getNetworkConfig } from './network';
import { BONDED_LIFETIME_MS, COSIGNATURE_SIZE, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE, signHashLock, signMetadata } from './tx';
import type { MetadataChange, MetadataTarget } from './tx';

/** Whether the aggregate has to be bonded: the owner of the target must still sign (unless the wallet alone can approve for it). */
export function metadataNeedsBonded(owner: AggregateSigner): boolean {
  return !owner.selfSufficient;
}

/**
 * Describes the owner of the target as a signer: whether it is a multisig account, and how many other signatures it
 * still needs. Throws 'invalid_signer' when it cannot sign yet (its public key is not known to the network, i.e. it
 * never sent a transaction and nobody sent it one), and 'same_account' for the wallet's own address.
 */
export async function resolveMetadataOwner(walletAddress: string, ownerAddress: string): Promise<AggregateSigner> {
  const addr = normalizeAddress(ownerAddress);
  if (!isValidAddress(addr)) throw new Error('invalid_signer');
  if (addr === normalizeAddress(walletAddress)) throw new Error('same_account');
  return resolveSigner(walletAddress, addr);
}

export type OwnerInputError =
  | 'invalid_address' | 'own_address' | 'wrong_network'
  | 'alias_not_found' | 'alias_no_address' | 'alias_expired' | 'alias_wrong_network' | 'alias_lookup_failed'
  | 'invalid_signer' | 'lookup_failed';

export type OwnerInputResult =
  | { ok: true; owner: AggregateSigner; alias?: string }
  | { ok: false; error: OwnerInputError };

const OWNER_INPUT_ERRORS: readonly string[] = [
  'invalid_address', 'own_address', 'wrong_network', 'alias_not_found', 'alias_no_address', 'alias_expired', 'alias_wrong_network', 'alias_lookup_failed',
];

/**
 * What was typed for "another account": an address, a namespace alias ("nem.group") or a 64-hex public key. The alias is
 * looked up once and the REAL address it points to is used, so the confirm screen shows who will actually be asked to
 * sign. The account must be known to the network (its public key), otherwise it cannot co-sign.
 */
export async function resolveMetadataOwnerInput(raw: string, walletAddress: string): Promise<OwnerInputResult> {
  const cfg = getNetworkConfig();
  let address: string;
  let alias: string | undefined;
  let knownKey: string | undefined;
  const classified = classifyRecipientInput(raw);
  if (classified.kind === 'publicKey') {
    knownKey = classified.publicKey;
    address = addressFromPublicKey(classified.publicKey, cfg.networkByte);
    if (normalizeAddress(address) === normalizeAddress(walletAddress)) return { ok: false, error: 'own_address' };
  } else {
    const parsed = await parseRestrictionAddressInput(raw, { networkByte: cfg.networkByte, ownAddress: walletAddress }, resolveRecipientInput);
    if (!parsed.ok) return { ok: false, error: (OWNER_INPUT_ERRORS.includes(parsed.error) ? parsed.error : 'invalid_address') as OwnerInputError };
    address = parsed.value;
    alias = parsed.alias;
  }
  try {
    const owner = knownKey === undefined
      ? await resolveMetadataOwner(walletAddress, address)
      : await resolveSigner(walletAddress, address, knownKey);
    return { ok: true, owner, alias };
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (message === 'same_account') return { ok: false, error: 'own_address' };
    if (message === 'invalid_signer') return { ok: false, error: 'invalid_signer' };
    return { ok: false, error: 'lookup_failed' };
  }
}

export interface MetadataOtherQuote {
  fee: bigint; // the aggregate's maximum fee (room for the cosignatures included)
  lockFee: bigint; // fee of the hash lock; 0 when no lock is needed
  lockAmount: bigint; // XYM held by the hash lock until the aggregate is confirmed (then returned); 0 when no lock is needed
  bonded: boolean;
  multiplier: number;
}

/** Cost of setting the given values on another account's target, at the standard fee level. */
export async function quoteMetadataForOther(type: MetadataTargetType, valueLengths: number[], owner: AggregateSigner): Promise<MetadataOtherQuote> {
  const bonded = metadataNeedsBonded(owner);
  const cosignatures = bonded ? owner.cosignatures : 0;
  const size = metadataAggregateSize(type, valueLengths) + COSIGNATURE_SIZE * cosignatures;
  const [fees, lockAmount] = await Promise.all([quoteFeesForSize(size), bonded ? fetchHashLockAmount() : Promise.resolve(0n)]);
  const quote = fees[getDefaultFeeSpeed()];
  return {
    fee: quote.fee,
    lockFee: bonded ? BigInt(HASH_LOCK_SIZE) * BigInt(quote.multiplier) : 0n,
    lockAmount,
    bonded,
    multiplier: quote.multiplier,
  };
}

export interface SetMetadataOtherInput {
  privateKey: string;
  publicKey: string; // the wallet (the source of the entries)
  address: string; // the wallet's address
  owner: AggregateSigner; // the account the metadata is attached to / that owns the target
  target: MetadataTarget;
  items: MetadataItem[];
}

export interface SetMetadataOtherResult {
  hash: string;
  bonded: boolean; // true = waiting for the owner's cosignature
  payload: string; // the signed aggregate (hex); the cosign-request QR can carry it
}

/** The entries the wallet itself has set on the owner's target (what an update has to XOR against). */
export function otherMetadataRef(walletAddress: string, ownerAddress: string, target: MetadataTarget): MetadataTargetRef {
  return {
    type: target.type,
    address: ownerAddress,
    sourceAddress: walletAddress,
    targetId: target.type === 'mosaic' ? target.mosaicId : target.type === 'namespace' ? target.namespaceId : undefined,
  };
}

export async function setMetadataForOther(input: SetMetadataOtherInput): Promise<SetMetadataOtherResult> {
  const cfg = getNetworkConfig();
  const ref = otherMetadataRef(input.address, input.owner.address, input.target);
  // Overwriting an existing key needs its current value (the transaction carries old XOR new).
  const changes: MetadataChange[] = await Promise.all(input.items.map(async (item) => ({
    targetAddress: input.owner.address,
    target: input.target,
    key: item.key,
    oldValue: await fetchMetadataValue(ref, item.key),
    newValue: item.value,
  })));
  const bonded = metadataNeedsBonded(input.owner);
  const multipliers = await feeMultipliers();
  const multiplier = multipliers[getDefaultFeeSpeed()];
  const now = BigInt(await networkTimeMs());
  const signed = signMetadata(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    ownerAddress: input.address,
    networkByte: cfg.networkByte,
    changes,
    feeMultiplier: multiplier,
    bonded,
    cosignatureCount: bonded ? input.owner.cosignatures : 0,
    // A complete aggregate is processed at once; a bonded one waits a long time for the owner's signature.
    deadline: now + (bonded ? BONDED_LIFETIME_MS : 2n * 60n * 60n * 1000n),
  });
  if (!bonded) {
    await announceSigned(signed);
    return { hash: signed.hash, bonded: false, payload: signed.payload };
  }
  // Bonded: lock funds against the aggregate's hash, wait until the lock is confirmed, then announce the aggregate
  // as a partial transaction that the owner can cosign.
  const lock = signHashLock(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    currencyMosaicId: cfg.currencyMosaicId,
    amount: await fetchHashLockAmount(),
    duration: HASH_LOCK_DURATION_BLOCKS,
    aggregateHash: signed.hash,
    feeMultiplier: multiplier,
    deadline: now + 2n * 60n * 60n * 1000n,
  });
  await announceSigned(lock);
  await waitConfirmed(lock.hash);
  await announcePartial(signed.payload, signed.hash);
  return { hash: signed.hash, bonded: true, payload: signed.payload };
}

// --- metadata that OTHER accounts have attached (他人が付けたメタデータ) ------------------------------------------
//
// Anyone can attach metadata to an account / mosaic / namespace as long as the owner co-signs, so a target can carry
// entries from several sources. The editor only reads and writes the entries of one source; this reads the rest, for
// display only (an entry of another source can never be changed from here).

export interface OtherMetadataEntry {
  source: string; // the account that attached the entry (Symbol address)
  key: string; // scoped metadata key, 16 hex chars
  value: Uint8Array;
  valueText: string | null; // the value as text when it is printable UTF-8
  valueHex: string;
}

interface RawOtherMetadata {
  metadataEntry?: { sourceAddress?: string; scopedMetadataKey?: string; value?: string };
}

/**
 * Turns one page of the node's `/metadata` answer into entries, leaving out every entry whose source is in `exclude`
 * (the wallet's own entries, which the editor lists separately). Malformed rows are skipped. Sorted by source (the owner
 * of the target first when given), then by key, so the list does not jump around between reloads.
 */
export function parseOtherMetadata(rows: RawOtherMetadata[], exclude: string[], ownerAddress?: string): OtherMetadataEntry[] {
  const excluded = new Set(exclude.map(normalizeAddress));
  const owner = ownerAddress ? normalizeAddress(ownerAddress) : '';
  const out: OtherMetadataEntry[] = [];
  for (const row of rows) {
    const e = row.metadataEntry;
    if (!e || typeof e.sourceAddress !== 'string' || typeof e.scopedMetadataKey !== 'string' || typeof e.value !== 'string') continue;
    let source: string;
    let value: Uint8Array;
    try {
      source = normalizeAddress(addressBytesToString(hexToBytes(e.sourceAddress)));
      value = hexToBytes(e.value);
    } catch {
      continue;
    }
    if (excluded.has(source)) continue;
    out.push({ source, key: e.scopedMetadataKey.toUpperCase(), value, valueText: decodeValueText(value), valueHex: bytesToHex(value) });
  }
  const rank = (e: OtherMetadataEntry) => (e.source === owner ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
}

const OTHERS_PAGE_SIZE = 100;
const OTHERS_MAX_PAGES = 5;

export interface OtherMetadataResult {
  entries: OtherMetadataEntry[];
  truncated: boolean; // true when the target has more entries than were read
}

/**
 * Every entry on the target (the account, or one of its mosaics / namespaces) set by an account that is NOT in
 * `exclude`. The query has no source filter, so the entries of all sources are read (up to a few pages) and filtered here.
 */
export async function fetchMetadataFromOthers(ref: MetadataTargetRef, exclude: string[]): Promise<OtherMetadataResult> {
  const target = normalizeAddress(ref.address);
  const id = ref.type === 'account' || !ref.targetId ? '' : `&targetId=${ref.targetId.toUpperCase()}`;
  const base = `/metadata?targetAddress=${target}&metadataType=${METADATA_TYPE_CODE[ref.type]}${id}&order=asc&pageSize=${OTHERS_PAGE_SIZE}`;
  const rows: RawOtherMetadata[] = [];
  let truncated = false;
  for (let page = 1; page <= OTHERS_MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data: RawOtherMetadata[] }>(`${base}&pageNumber=${page}`);
    rows.push(...res.data);
    if (res.data.length < OTHERS_PAGE_SIZE) break;
    if (page === OTHERS_MAX_PAGES) truncated = true;
  }
  return { entries: parseOtherMetadata(rows, exclude, ref.address), truncated };
}

/** Entries grouped by their source, in the order of `parseOtherMetadata`. */
export function groupBySource(entries: OtherMetadataEntry[]): Array<{ source: string; entries: OtherMetadataEntry[] }> {
  const groups: Array<{ source: string; entries: OtherMetadataEntry[] }> = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.source === e.source) last.entries.push(e);
    else groups.push({ source: e.source, entries: [e] });
  }
  return groups;
}
