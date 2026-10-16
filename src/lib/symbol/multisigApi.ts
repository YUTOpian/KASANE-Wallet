// Multisig on the REST gateway: who cosigns what, the transactions waiting for a signature, and the
// announce flows (complete aggregate, or hash lock + bonded aggregate, or a cosignature).
import { getDefaultFeeSpeed } from './feeSpeed';
import { addressBytesToString, bytesToHex, hexToBytes, normalizeAddress, addressFromPublicKey } from './crypto';
import { CURRENCY_DIVISIBILITY } from './constants';
import { formatAtomic } from './amount';
import { getNetworkConfig } from './network';
import {
  SymbolSendError, announceSigned, feeMultipliers, fetchBalances, fetchMetadataValue, getMosaicInfos, networkTimeMs, nodeRequest, resolveMosaicId,
} from './api';
import { applyValueChange, decodeValueText, metadataTypeOfTx } from './metadata';
import type { MetadataTargetType } from './metadata';
import type { FeeQuote, MosaicBalance } from './api';
import {
  BONDED_LIFETIME_MS, COSIGNATURE_SIZE, DEFAULT_HASH_LOCK_AMOUNT, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE,
  cosignAggregateHash, signHashLock, signMultisigAggregate,
} from './tx';
import type { CosignatureBody, MosaicAmount, MultisigChange, MultisigInner } from './tx';
import { RESTRICTION_TX_TYPE, parseRestrictionChange } from './restrictions';
import type { RestrictionChange } from './restrictions';
import { MAX_MULTISIG_DEPTH } from './multisigTree';
import type { MultisigGraph } from './multisigTree';

const TX_TYPE_MULTISIG_MODIFICATION = 0x4155;
const TX_TYPE_TRANSFER = 0x4154;
const ZERO_KEY = '0'.repeat(64);

// --- multisig graph -----------------------------------------------------------------------------
export interface MultisigInfo {
  address: string;
  minApproval: number;
  minRemoval: number;
  cosignatories: string[]; // accounts that cosign for this one
  multisigOf: string[]; // accounts this one cosigns for
  /** This account is a multisig account (it has cosigners). */
  isMultisig: boolean;
}

const hexToAddress = (hex: string) => addressBytesToString(hexToBytes(hex));

/** Cosigners and thresholds of an account. An account the network has never seen reads as empty. */
export async function fetchMultisigInfo(address: string): Promise<MultisigInfo> {
  const addr = normalizeAddress(address);
  try {
    const res = await nodeRequest<{
      multisig: { minApproval: number; minRemoval: number; cosignatoryAddresses?: string[]; multisigAddresses?: string[] };
    }>(`/account/${addr}/multisig`);
    const m = res.multisig;
    const cosignatories = (m.cosignatoryAddresses ?? []).map(hexToAddress);
    return {
      address: addr,
      minApproval: m.minApproval,
      minRemoval: m.minRemoval,
      cosignatories,
      multisigOf: (m.multisigAddresses ?? []).map(hexToAddress),
      isMultisig: cosignatories.length > 0,
    };
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    return { address: addr, minApproval: 0, minRemoval: 0, cosignatories: [], multisigOf: [], isMultisig: false };
  }
}

/**
 * マルチレベルマルチシグ: the cosigner tree under `address` (its cosigners, theirs if those are multisig too, …).
 * Every account looked at is in the map; an ordinary account is a leaf (`isMultisig` false).
 * Stops a little below the deepest nesting the network allows, and never visits an account twice.
 */
export async function fetchCosignerGraph(address: string, maxLevels = MAX_MULTISIG_DEPTH + 1): Promise<MultisigGraph> {
  const graph = new Map<string, MultisigInfo>();
  let frontier = [normalizeAddress(address)];
  for (let level = 0; frontier.length > 0 && level <= maxLevels; level++) {
    const infos = await Promise.all(frontier.map((a) => fetchMultisigInfo(a)));
    const next: string[] = [];
    for (const info of infos) {
      graph.set(info.address, info);
      if (!info.isMultisig) continue;
      for (const c of info.cosignatories) if (!graph.has(c) && !frontier.includes(c) && !next.includes(c)) next.push(c);
    }
    frontier = next;
  }
  return graph;
}

/** A multisig account an account cosigns for, directly (level 1) or through other multisig accounts (level 2, 3, …). */
export interface CosignedAccount {
  info: MultisigInfo;
  level: number;
  /** For level 2 and up: the multisig account one step down the chain (the one that cosigns this account). Empty for level 1. */
  via: string;
}

/**
 * Every multisig account `address` can sign for: the ones it cosigns directly and, since a multisig account that is a
 * cosigner is approved by its own cosigners, the ones above those, up to the network's nesting limit.
 */
export async function fetchCosignedAccounts(address: string, maxLevels = MAX_MULTISIG_DEPTH, known?: MultisigInfo): Promise<CosignedAccount[]> {
  const root = known ?? await fetchMultisigInfo(address);
  const seen = new Set<string>([root.address]);
  const out: CosignedAccount[] = [];
  let frontier = root.multisigOf.map((a) => ({ address: a, via: '' }));
  for (let level = 1; frontier.length > 0 && level <= maxLevels; level++) {
    const fresh = frontier.filter((f, i) => !seen.has(f.address) && frontier.findIndex((g) => g.address === f.address) === i);
    fresh.forEach((f) => seen.add(f.address));
    const infos = await Promise.all(fresh.map((f) => fetchMultisigInfo(f.address)));
    frontier = [];
    infos.forEach((info, i) => {
      out.push({ info, level, via: fresh[i].via });
      for (const parent of info.multisigOf) frontier.push({ address: parent, via: info.address });
    });
  }
  return out;
}

/** How deep multisig accounts may be nested (maxMultisigDepth from /network/properties; 3 when unavailable). */
export async function fetchMaxMultisigDepth(): Promise<number> {
  try {
    const res = await nodeRequest<{ plugins?: { multisig?: { maxMultisigDepth?: string | number } } }>('/network/properties');
    const digits = String(res.plugins?.multisig?.maxMultisigDepth ?? '').replace(/[^0-9]/g, '');
    if (digits) return Number(digits);
  } catch { /* default below */ }
  return MAX_MULTISIG_DEPTH;
}

/** Public key of an account, or null when it has never signed anything (so the network does not know it). */
export async function fetchAccountPublicKey(address: string): Promise<string | null> {
  try {
    const res = await nodeRequest<{ account: { publicKey?: string } }>(`/accounts/${normalizeAddress(address)}`);
    const key = res.account.publicKey?.toUpperCase();
    return key && key !== ZERO_KEY ? key : null;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    return null;
  }
}

/** XYM and other mosaics held by a (multisig) account. */
export async function fetchAccountBalances(address: string): Promise<MosaicBalance[]> {
  return fetchBalances(address);
}

// --- fees ---------------------------------------------------------------------------------------
/** Funds that must be locked for a bonded aggregate (from /network/properties; 10 XYM when unavailable). */
export async function fetchHashLockAmount(): Promise<bigint> {
  try {
    const res = await nodeRequest<{ plugins?: { lockhash?: { lockedFundsPerAggregate?: string } } }>('/network/properties');
    const digits = res.plugins?.lockhash?.lockedFundsPerAggregate?.replace(/[^0-9]/g, '');
    if (digits) return BigInt(digits);
  } catch { /* default below */ }
  return DEFAULT_HASH_LOCK_AMOUNT;
}

export interface MultisigCost {
  bonded: boolean;
  aggregateFee: FeeQuote; // includes room for the cosignatures
  lockFee: bigint; // 0 when no lock is needed
  lockAmount: bigint; // locked until the aggregate is confirmed, then returned; 0 when no lock is needed
  /** What the wallet needs to hold to start: lock + all fees. */
  totalNeeded: bigint;
}

/** Cost of an aggregate of `baseSize` bytes with room for `cosignatureCount` cosignatures. */
export async function quoteMultisigCost(baseSize: number, cosignatureCount: number, bonded: boolean): Promise<MultisigCost> {
  const [multipliers, lockAmount] = await Promise.all([feeMultipliers(), bonded ? fetchHashLockAmount() : Promise.resolve(0n)]);
  const size = baseSize + COSIGNATURE_SIZE * cosignatureCount;
  const multiplier = multipliers[getDefaultFeeSpeed()];
  const aggregateFee: FeeQuote = { multiplier, size, fee: BigInt(size) * BigInt(multiplier) };
  const lockFee = bonded ? BigInt(HASH_LOCK_SIZE) * BigInt(multiplier) : 0n;
  return { bonded, aggregateFee, lockFee, lockAmount, totalNeeded: aggregateFee.fee + lockFee + lockAmount };
}

// --- announcing ---------------------------------------------------------------------------------
async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Waits until a transaction is confirmed (the lock must be on the chain before the partial is accepted). */
export async function waitConfirmed(hash: string, timeoutMs = 180_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(3000);
    try {
      const status = await nodeRequest<{ group: string; code: string }>(`/transactionStatus/${hash}`);
      if (status.group === 'failed') throw new SymbolSendError(status.code);
      if (status.group === 'confirmed') return;
    } catch (e) {
      if (e instanceof SymbolSendError) throw e;
      // 404 = not seen yet
    }
  }
  throw new SymbolSendError('lock_timeout');
}

export async function announcePartial(payload: string, hash: string): Promise<void> {
  try {
    await nodeRequest('/transactions/partial', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    throw new SymbolSendError('announce_failed', (e as Error).message);
  }
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    await sleep(1500);
    try {
      const status = await nodeRequest<{ group: string; code: string }>(`/transactionStatus/${hash}`);
      if (status.group === 'failed') throw new SymbolSendError(status.code);
      if (status.group === 'partial' || status.group === 'unconfirmed' || status.group === 'confirmed') return;
    } catch (e) {
      if (e instanceof SymbolSendError) throw e;
    }
  }
}

export interface SubmitMultisigInput {
  privateKey: string;
  publicKey: string; // the wallet
  inner: MultisigInner;
  bonded: boolean;
  cosignatureCount: number;
}

export interface SubmitMultisigResult {
  hash: string; // the aggregate
  bonded: boolean;
  payload: string; // the signed aggregate (hex); the cosign-request QR can carry it
}

/**
 * Sends an aggregate in the name of a multisig account. A complete aggregate is announced as is.
 * A bonded one first pays the hash lock, waits for it to be confirmed, and is then announced as a
 * partial transaction that the other cosigners can sign.
 */
export async function submitMultisig(input: SubmitMultisigInput): Promise<SubmitMultisigResult> {
  const cfg = getNetworkConfig();
  const multipliers = await feeMultipliers();
  const now = BigInt(await networkTimeMs());
  const signed = signMultisigAggregate(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    inner: input.inner,
    bonded: input.bonded,
    cosignatureCount: input.cosignatureCount,
    feeMultiplier: multipliers[getDefaultFeeSpeed()],
    // A complete aggregate is processed at once; a bonded one waits for signatures for a long time.
    deadline: now + (input.bonded ? BONDED_LIFETIME_MS : 2n * 60n * 60n * 1000n),
  });
  if (!input.bonded) {
    await announceSigned(signed);
    return { hash: signed.hash, bonded: false, payload: signed.payload };
  }
  const lock = signHashLock(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    currencyMosaicId: cfg.currencyMosaicId,
    amount: await fetchHashLockAmount(),
    duration: HASH_LOCK_DURATION_BLOCKS,
    aggregateHash: signed.hash,
    feeMultiplier: multipliers[getDefaultFeeSpeed()],
    deadline: now + 2n * 60n * 60n * 1000n,
  });
  await announceSigned(lock);
  await waitConfirmed(lock.hash);
  await announcePartial(signed.payload, signed.hash);
  return { hash: signed.hash, bonded: true, payload: signed.payload };
}

// --- transactions waiting for a signature -------------------------------------------------------
export type PartialItem =
  | { kind: 'transfer'; account: string; recipient: string; mosaics: Array<{ symbol: string; amount: string }>; message: string; encrypted: boolean }
  | { kind: 'multisig'; account: string; minApprovalDelta: number; minRemovalDelta: number; additions: string[]; deletions: string[] }
  | ({ kind: 'restriction'; account: string } & RestrictionChange)
  | MetadataPartialItem
  | { kind: 'other'; account: string; type: number };

/**
 * メタデータ: `account` is the SOURCE (who signs the entry); the metadata is attached to `targetAddress` (or to its mosaic /
 * namespace `targetId`), which is the account that has to co-sign. `change` is what the transaction carries: old XOR new,
 * so it equals the new value only for a brand-new key. `value` is the resulting value when it could be worked out
 * (the stored value is read from the node, or the key is new); undefined when it could not.
 */
export interface MetadataPartialItem {
  kind: 'metadata';
  account: string;
  targetType: MetadataTargetType;
  targetAddress: string;
  targetId?: string; // 16 hex chars, mosaic / namespace only
  key: string; // 16 hex chars
  valueSizeDelta: number;
  changeHex: string;
  value?: { text: string | null; hex: string };
}

/** The value a metadata change results in: a new key is the change itself; otherwise the stored value is needed (null = unknown). */
export function resolveMetadataValue(change: Uint8Array, sizeDelta: number, stored: Uint8Array | null | 'new'): { text: string | null; hex: string } | undefined {
  const next = stored === 'new' ? (sizeDelta === change.length ? change : null) : applyValueChange(stored, change, sizeDelta);
  return next === null ? undefined : { text: decodeValueText(next), hex: bytesToHex(next) };
}

export interface PartialTransaction {
  hash: string;
  initiator: string; // address of the aggregate's signer
  deadlineMs: number;
  items: PartialItem[];
  cosignedBy: number; // signatures so far, besides the initiator's
  signedByMe: boolean;
  /** Addresses that have signed so far: the initiator and the cosigners (what the approval progress is worked out from). */
  signers: string[];
}

interface RawPartial {
  meta?: { hash?: string };
  transaction: {
    signerPublicKey: string;
    network: number;
    deadline: string;
    cosignatures?: Array<{ signerPublicKey: string }>;
    transactions?: Array<{
      transaction: {
        type: number;
        signerPublicKey: string;
        network: number;
        recipientAddress?: string;
        mosaics?: Array<{ id: string; amount: string }>;
        message?: string;
        minApprovalDelta?: number;
        minRemovalDelta?: number;
        addressAdditions?: string[];
        addressDeletions?: string[];
        targetAddress?: string;
        targetMosaicId?: string;
        targetNamespaceId?: string;
        scopedMetadataKey?: string;
        valueSizeDelta?: number;
        value?: string;
        restrictionFlags?: number | string;
        restrictionAdditions?: Array<string | number>;
        restrictionDeletions?: Array<string | number>;
      };
    }>;
  };
}

async function toPartial(raw: RawPartial, myPublicKey: string): Promise<PartialTransaction> {
  const cfg = getNetworkConfig();
  const tx = raw.transaction;
  const cosigners = (tx.cosignatures ?? []).map((c) => c.signerPublicKey.toUpperCase());
  const me = myPublicKey.toUpperCase();
  const items: PartialItem[] = [];
  for (const e of tx.transactions ?? []) {
    const inner = e.transaction;
    const account = addressFromPublicKey(inner.signerPublicKey, inner.network);
    if (inner.type === TX_TYPE_TRANSFER && inner.recipientAddress) {
      const ids = await Promise.all((inner.mosaics ?? []).map((m) => resolveMosaicId(m.id)));
      const infos = await getMosaicInfos(ids);
      const bytes = inner.message ? hexToBytes(inner.message) : new Uint8Array(0);
      const encrypted = bytes.length > 0 && bytes[0] === 1;
      const recipientBytes = hexToBytes(inner.recipientAddress);
      items.push({
        kind: 'transfer',
        account,
        recipient: (recipientBytes[0] & 1) === 1 ? '@namespace' : addressBytesToString(recipientBytes),
        mosaics: (inner.mosaics ?? []).map((m, i) => {
          const info = infos[ids[i]];
          return { symbol: info?.symbol ?? ids[i], amount: formatAtomic(BigInt(m.amount), info?.divisibility ?? 0) };
        }),
        message: bytes.length > 0 && !encrypted ? new TextDecoder().decode(bytes.slice(1)) : '',
        encrypted,
      });
    } else if (inner.type === TX_TYPE_MULTISIG_MODIFICATION) {
      items.push({
        kind: 'multisig',
        account,
        minApprovalDelta: inner.minApprovalDelta ?? 0,
        minRemovalDelta: inner.minRemovalDelta ?? 0,
        additions: (inner.addressAdditions ?? []).map(hexToAddress),
        deletions: (inner.addressDeletions ?? []).map(hexToAddress),
      });
    } else if (metadataTypeOfTx(inner.type) !== null && inner.targetAddress && inner.scopedMetadataKey) {
      const targetType = metadataTypeOfTx(inner.type) as MetadataTargetType;
      const targetAddress = hexToAddress(inner.targetAddress);
      const targetId = targetType === 'mosaic' ? inner.targetMosaicId : targetType === 'namespace' ? inner.targetNamespaceId : undefined;
      const key = inner.scopedMetadataKey.toUpperCase();
      const change = inner.value ? hexToBytes(inner.value) : new Uint8Array(0);
      const delta = Number(inner.valueSizeDelta ?? 0);
      // Show what the entry becomes, not the XOR'd bytes: the stored value (from this source) is read from the node.
      let stored: Uint8Array | null | 'new' = null;
      try {
        stored = await fetchMetadataValue({ type: targetType, address: targetAddress, sourceAddress: account, targetId: targetId?.toUpperCase() }, BigInt(`0x${key}`));
        if (stored.length === 0) stored = 'new';
      } catch { /* shown as the change only */ }
      items.push({
        kind: 'metadata', account, targetType, targetAddress, targetId: targetId?.toUpperCase(), key, valueSizeDelta: delta,
        changeHex: bytesToHex(change), value: resolveMetadataValue(change, delta, stored),
      });
    } else if (Object.values(RESTRICTION_TX_TYPE).includes(inner.type)) {
      const change = parseRestrictionChange(
        inner.type, Number(inner.restrictionFlags), inner.restrictionAdditions ?? [], inner.restrictionDeletions ?? [],
      );
      items.push(change ? { kind: 'restriction', account, ...change } : { kind: 'other', account, type: inner.type });
    } else {
      items.push({ kind: 'other', account, type: inner.type });
    }
  }
  return {
    hash: (raw.meta?.hash ?? '').toUpperCase(),
    initiator: addressFromPublicKey(tx.signerPublicKey, tx.network),
    deadlineMs: Number(tx.deadline) + cfg.epochAdjustment * 1000,
    items,
    cosignedBy: cosigners.length,
    signedByMe: tx.signerPublicKey.toUpperCase() === me || cosigners.includes(me),
    signers: [tx.signerPublicKey, ...cosigners].map((k) => addressFromPublicKey(k, tx.network)),
  };
}

/**
 * Bonded aggregates still waiting for signatures that involve this wallet or any multisig account it
 * cosigns for (directly or through other multisig accounts), newest first.
 */
export async function fetchPartialTransactions(address: string, publicKey: string, multisigAccounts: string[]): Promise<PartialTransaction[]> {
  const addresses = [...new Set([normalizeAddress(address), ...multisigAccounts.map(normalizeAddress)])];
  const lists = await Promise.all(addresses.map((a) =>
    nodeRequest<{ data: RawPartial[] }>(`/transactions/partial?address=${a}&order=desc&pageSize=50`).catch(() => ({ data: [] as RawPartial[] }))));
  const hashes = [...new Set(lists.flatMap((l) => l.data.map((d) => d.meta?.hash?.toUpperCase() ?? '')).filter(Boolean))].slice(0, 30);
  // The list may leave out the embedded transactions, so each aggregate is read on its own.
  const details = await Promise.all(hashes.map(async (hash): Promise<RawPartial | null> => {
    let raw: RawPartial | null = null;
    try {
      raw = await nodeRequest<RawPartial>(`/transactions/partial/${hash}`);
    } catch {
      raw = lists.flatMap((l) => l.data).find((d) => d.meta?.hash?.toUpperCase() === hash) ?? null;
    }
    return raw ? { ...raw, meta: { hash } } : null;
  }));
  const parsed = await Promise.all(details.filter((d): d is RawPartial => d !== null).map((d) => toPartial(d, publicKey)));
  return parsed.sort((a, b) => b.deadlineMs - a.deadlineMs);
}

/** Sends a finished cosignature to the node (from this wallet, or one received as a QR code). */
export async function announceCosignature(body: CosignatureBody): Promise<void> {
  try {
    await nodeRequest('/transactions/cosignature', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new SymbolSendError('announce_failed', (e as Error).message);
  }
}

/** Adds this wallet's cosignature to a partial transaction. */
export async function cosignPartial(privateKey: string, aggregateHash: string): Promise<void> {
  await announceCosignature(cosignAggregateHash(privateKey, aggregateHash));
}

/** One partial (bonded) transaction by its hash, as the node has it; null when the node does not know it. */
export async function fetchPartialByHash(hash: string, myPublicKey: string): Promise<PartialTransaction | null> {
  const h = hash.toUpperCase();
  try {
    const raw = await nodeRequest<RawPartial>(`/transactions/partial/${h}`);
    return await toPartial({ ...raw, meta: { hash: h } }, myPublicKey);
  } catch {
    return null; // 404 = not (or no longer) waiting for signatures
  }
}

export { CURRENCY_DIVISIBILITY };
export type { MosaicAmount, MultisigChange, MultisigInner };
