// NEMonster on Symbol: the same game as the NEM one (lib/nem/nemonster.ts), played on the Symbol chain.
//
// The NEM version is compatible with the official NEM Nano Wallet. Symbol has no official NEMonster, so this
// version is KASANE's own, and it is built the same way:
//  - every account has its own "sink" address, derived from its address: the private key is
//    SHA3-256("NEMonster-Symbol-" + address). Nobody keeps that key, the sink is only a place to point at.
//  - "catching" a monster = sending a transfer with no mosaic (0 XYM) from the account to its sink; the fee is
//    the only cost.
//  - every such transfer (its transaction hash) is one monster; the hash decides how it looks (lib/nem/monster.ts,
//    ported from the official wallet; a Symbol transaction hash is also 64 upper-case hex characters).
//  - the collection = the transfers the account itself made to its sink, plus the starter monster.
// A NEM account and a Symbol account have different hashes, so their collections are separate.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { monsterFromHash } from '../nem/monster';
import { nodeRequest, quoteFee, sendTransfer } from './api';
import { TX_TYPE_TRANSFER } from './constants';
import { addressFromPublicKey, bytesToHex, keyPairFromPrivateKey, normalizeAddress } from './crypto';

export { buildCollection } from '../nem/nemonster';
export type { CollectedMonster } from '../nem/nemonster';
export { monsterFromHash };

const SINK_SEED_PREFIX = 'NEMonster-Symbol-';
const PAGE_SIZE = 100; // the REST gateway allows up to 100 per page
const MAX_PAGES = 20; // 2,000 catches; far more than anybody has

/** The dedicated sink address of an account. Pure computation: the same address always gives the same sink. */
export function symbolNemonsterSinkAddress(address: string, networkByte: number): string {
  const seed = new TextEncoder().encode(`${SINK_SEED_PREFIX}${normalizeAddress(address)}`);
  const pair = keyPairFromPrivateKey(bytesToHex(sha3_256(seed)));
  return addressFromPublicKey(pair.publicKey, networkByte);
}

/** Catching costs only the fee of a transfer with no mosaic and no message (160 bytes). */
export async function symbolNemonsterCatchFee(): Promise<bigint> {
  return (await quoteFee(0, undefined)).fee;
}

interface RawEntry {
  id?: string;
  meta?: { hash?: string; aggregateHash?: string };
  transaction?: { signerPublicKey?: string };
}

export interface SymbolNemonsterState {
  sink: string;
  hashes: string[]; // transaction hashes of the confirmed catches, newest first
  pending: number; // catches announced but not in a block yet
}

const sameKey = (a: string | undefined, b: string): boolean => a !== undefined && a.toUpperCase() === b.toUpperCase();

/** Reads the catches of an account: its own transfers to its sink. */
export async function fetchSymbolNemonsterState(address: string, publicKey: string, networkByte: number): Promise<SymbolNemonsterState> {
  const sink = symbolNemonsterSinkAddress(address, networkByte);
  const base = `recipientAddress=${sink}&signerPublicKey=${publicKey.toUpperCase()}&type=${TX_TYPE_TRANSFER}`;
  // A transfer inside an aggregate (a multisig account's) is listed with the aggregate's hash.
  const hashOf = (entry: RawEntry): string | undefined => entry.meta?.hash ?? entry.meta?.aggregateHash;

  const seen = new Set<string>();
  const hashes: string[] = [];
  let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data?: RawEntry[] }>(
      `/transactions/confirmed?${base}&order=desc&pageSize=${PAGE_SIZE}&embedded=true${offset ? `&offset=${offset}` : ''}`,
    );
    const entries = res.data ?? [];
    for (const entry of entries) {
      const hash = hashOf(entry);
      // The node already filtered by signer; this only guards against a gateway that ignores the filter.
      if (hash && sameKey(entry.transaction?.signerPublicKey, publicKey) && !seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash.toUpperCase());
      }
    }
    offset = entries.length > 0 ? entries[entries.length - 1].id : undefined;
    if (entries.length < PAGE_SIZE || !offset) break;
  }

  // Catches that are still waiting for a block (they become monsters once confirmed).
  let pending = 0;
  try {
    const res = await nodeRequest<{ data?: RawEntry[] }>(`/transactions/unconfirmed?${base}&embedded=true`);
    for (const entry of res.data ?? []) {
      const hash = hashOf(entry);
      if (hash && !seen.has(hash.toUpperCase()) && !seen.has(hash) && sameKey(entry.transaction?.signerPublicKey, publicKey)) pending += 1;
    }
  } catch {
    // the confirmed collection is still worth showing
  }
  return { sink, hashes, pending };
}

export interface CatchSymbolNemonsterInput {
  /** Empty for an SSS Extension account (set `sss`): the extension signs the transfer. */
  privateKey: string;
  sss?: boolean;
  publicKey: string;
  address: string;
  networkByte: number;
}

/** Catches a monster: a transfer with no mosaic to the account's own sink. Resolves with the transaction hash. */
export function catchSymbolNemonster(input: CatchSymbolNemonsterInput): Promise<{ hash: string }> {
  return sendTransfer({
    privateKey: input.privateKey,
    sss: input.sss,
    publicKey: input.publicKey,
    recipient: symbolNemonsterSinkAddress(input.address, input.networkByte),
    mosaics: [],
    allowNoMosaics: true,
  });
}
