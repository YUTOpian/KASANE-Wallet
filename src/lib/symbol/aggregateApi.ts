// Quote and send an aggregate (see ./aggregate.ts). Fee levels and the announce / status check are shared
// with the single-transaction screens; the bonded flow (hash lock, then the partial transaction) is the one
// the multisig screens use.
import {
  announceSigned, feeMultipliers, fetchMosaicRentalFee, fetchNamespaceRentalFees, networkTimeMs, quoteFeesForSize,
} from './api';
import type { FeeQuote, FeeSpeed } from './api';
import { aggregateSize, cosignatureCount, needsBonded, signAggregate } from './aggregate';
import type { AggregateItem, AggregateSigner } from './aggregate';
import { addressFromPublicKey, isValidAddress, normalizeAddress } from './crypto';
import { announcePartial, fetchAccountPublicKey, fetchHashLockAmount, fetchMultisigInfo, waitConfirmed } from './multisigApi';
import { getNetworkConfig } from './network';
import { BONDED_LIFETIME_MS, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE, signHashLock } from './tx';

export interface AggregateQuote {
  fees: Record<FeeSpeed, FeeQuote>; // fee of the aggregate itself at each level (room for cosignatures included)
  lockFees: Record<FeeSpeed, bigint>; // fee of the hash lock at each level; 0 when no lock is needed
  lockAmount: bigint; // XYM held back by the hash lock until the aggregate is confirmed (then returned); 0 when no lock is needed
  bonded: boolean;
  rental: bigint | null; // mosaic + namespace rental, atomic XYM; null when the node's prices could not be read
}

/** Rental fees the items cost on top of the transaction fee (paid once, not refunded). */
export async function quoteRental(items: AggregateItem[]): Promise<bigint | null> {
  let total = 0n;
  const mosaics = items.filter((i) => i.kind === 'mosaic_definition').length;
  if (mosaics > 0) total += (await fetchMosaicRentalFee()) * BigInt(mosaics);
  const namespaces = items.filter((i): i is Extract<AggregateItem, { kind: 'namespace' }> => i.kind === 'namespace');
  if (namespaces.length > 0) {
    const prices = await fetchNamespaceRentalFees();
    if (prices === null) return null;
    for (const ns of namespaces) total += ns.parent ? prices.childFee : prices.rootFeePerBlock * ns.durationBlocks;
  }
  return total;
}

export async function quoteAggregate(publicKey: string, address: string, items: AggregateItem[]): Promise<AggregateQuote> {
  const size = aggregateSize(publicKey, address, getNetworkConfig().networkByte, items);
  const bonded = needsBonded(items);
  const [fees, rental, lockAmount] = await Promise.all([quoteFeesForSize(size), quoteRental(items), bonded ? fetchHashLockAmount() : Promise.resolve(0n)]);
  const lockFee = (speed: FeeSpeed) => (bonded ? BigInt(HASH_LOCK_SIZE) * BigInt(fees[speed].multiplier) : 0n);
  return { fees, rental, lockAmount, bonded, lockFees: { slow: lockFee('slow'), standard: lockFee('standard'), fast: lockFee('fast') } };
}

/**
 * Describes another account as a signer of a transfer: whether it is a multisig account the wallet cosigns for,
 * and how many other signatures it still needs. Throws 'invalid_signer' when the account cannot sign yet
 * (the network does not know its public key) or the key does not match the address.
 */
export async function resolveSigner(walletAddress: string, address: string, knownPublicKey?: string): Promise<AggregateSigner> {
  const addr = normalizeAddress(address);
  const publicKey = knownPublicKey ?? await fetchAccountPublicKey(addr);
  if (!publicKey || !isValidAddress(addr)) throw new Error('invalid_signer');
  const info = await fetchMultisigInfo(addr);
  const walletIsCosigner = info.cosignatories.includes(normalizeAddress(walletAddress));
  if (!info.isMultisig) return { address: addr, publicKey, multisig: false, selfSufficient: false, cosignatures: 1 };
  const selfSufficient = walletIsCosigner && info.minApproval <= 1;
  // The aggregate's own signer counts as one approval when it is a cosigner of the account.
  const cosignatures = selfSufficient ? 0 : Math.max(info.minApproval - (walletIsCosigner ? 1 : 0), 1);
  return { address: addr, publicKey, multisig: true, selfSufficient, cosignatures };
}

/** The signer for an account given by public key (the address is derived from it). */
export async function resolveSignerByKey(walletAddress: string, publicKeyHex: string): Promise<AggregateSigner> {
  const key = publicKeyHex.trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(key)) throw new Error('invalid_signer');
  return resolveSigner(walletAddress, addressFromPublicKey(key, getNetworkConfig().networkByte), key);
}

export interface SendAggregateInput {
  privateKey: string;
  publicKey: string;
  address: string;
  items: AggregateItem[];
  feeSpeed: FeeSpeed;
}

export interface SendAggregateResult {
  hash: string;
  bonded: boolean; // true = waiting for the other accounts' cosignatures
}

export async function sendAggregate(input: SendAggregateInput): Promise<SendAggregateResult> {
  const cfg = getNetworkConfig();
  const multipliers = await feeMultipliers();
  const multiplier = multipliers[input.feeSpeed];
  const bonded = needsBonded(input.items);
  const now = BigInt(await networkTimeMs());
  const signed = signAggregate(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    ownerAddress: input.address,
    networkByte: cfg.networkByte,
    items: input.items,
    feeMultiplier: multiplier,
    // A complete aggregate is processed at once; a bonded one waits a long time for signatures.
    deadline: now + (bonded ? BONDED_LIFETIME_MS : 2n * 60n * 60n * 1000n),
  });
  if (!bonded) {
    await announceSigned(signed);
    return { hash: signed.hash, bonded: false };
  }
  // Bonded: lock funds against the aggregate's hash, wait until the lock is confirmed, then announce the aggregate
  // as a partial transaction that the other accounts can cosign.
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
  return { hash: signed.hash, bonded: true };
}

export { cosignatureCount };
