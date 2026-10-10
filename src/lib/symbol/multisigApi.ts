// Multisig on the REST gateway: who cosigns what, the transactions waiting for a signature, and the
// announce flows (complete aggregate, or hash lock + bonded aggregate, or a cosignature).
import { addressBytesToString, hexToBytes, normalizeAddress, addressFromPublicKey } from './crypto';
import { CURRENCY_DIVISIBILITY } from './constants';
import { formatAtomic } from './amount';
import { getNetworkConfig } from './network';
import {
  SymbolSendError, announceSigned, feeMultipliers, fetchBalances, getMosaicInfos, networkTimeMs, nodeRequest, resolveMosaicId,
} from './api';
import type { FeeQuote, MosaicBalance } from './api';
import {
  BONDED_LIFETIME_MS, COSIGNATURE_SIZE, DEFAULT_HASH_LOCK_AMOUNT, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE,
  cosignAggregateHash, signHashLock, signMultisigAggregate,
} from './tx';
import type { MosaicAmount, MultisigChange, MultisigInner } from './tx';

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
  const multiplier = multipliers.standard;
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
    feeMultiplier: multipliers.standard,
    // A complete aggregate is processed at once; a bonded one waits for signatures for a long time.
    deadline: now + (input.bonded ? BONDED_LIFETIME_MS : 2n * 60n * 60n * 1000n),
  });
  if (!input.bonded) {
    await announceSigned(signed);
    return { hash: signed.hash, bonded: false };
  }
  const lock = signHashLock(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    currencyMosaicId: cfg.currencyMosaicId,
    amount: await fetchHashLockAmount(),
    duration: HASH_LOCK_DURATION_BLOCKS,
    aggregateHash: signed.hash,
    feeMultiplier: multipliers.standard,
    deadline: now + 2n * 60n * 60n * 1000n,
  });
  await announceSigned(lock);
  await waitConfirmed(lock.hash);
  await announcePartial(signed.payload, signed.hash);
  return { hash: signed.hash, bonded: true };
}

// --- transactions waiting for a signature -------------------------------------------------------
export type PartialItem =
  | { kind: 'transfer'; account: string; recipient: string; mosaics: Array<{ symbol: string; amount: string }>; message: string; encrypted: boolean }
  | { kind: 'multisig'; account: string; minApprovalDelta: number; minRemovalDelta: number; additions: string[]; deletions: string[] }
  | { kind: 'other'; account: string; type: number };

export interface PartialTransaction {
  hash: string;
  initiator: string; // address of the aggregate's signer
  deadlineMs: number;
  items: PartialItem[];
  cosignedBy: number; // signatures so far, besides the initiator's
  signedByMe: boolean;
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
  };
}

/**
 * Bonded aggregates still waiting for signatures that involve this wallet or any multisig account it
 * cosigns for, newest first.
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

/** Adds this wallet's cosignature to a partial transaction. */
export async function cosignPartial(privateKey: string, aggregateHash: string): Promise<void> {
  const body = cosignAggregateHash(privateKey, aggregateHash);
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

export { CURRENCY_DIVISIBILITY };
export type { MosaicAmount, MultisigChange, MultisigInner };
