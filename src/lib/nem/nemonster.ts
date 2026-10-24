// NEMonster on NIS1, compatible with the official NEM Nano Wallet.
//
// How it works (same as the Nano Wallet):
//  - every account has its own "sink" address, derived from its address: the private key is
//    Keccak-256("NEMonster-" + address). Nobody keeps that key, the sink is only a place to point at.
//  - "catching" a monster = sending 0 XEM from the account to its sink (the fee is the only cost).
//  - every such transfer (its transaction hash) is one monster; the hash decides how it looks (monster.ts).
//  - the collection = the transfers the account itself made to its sink, plus the starter monster.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '../symbol/crypto';
import { nodeRequest, sendNemTransfer } from './api';
import { NEM_TX_TYPE_MULTISIG } from './constants';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from './crypto';
import { monsterFromHash, STARTER_MONSTER } from './monster';
import type { Monster } from './monster';
import { nemTransferFee } from './tx';

const SINK_SEED_PREFIX = 'NEMonster-';
const PAGE_SIZE = 100; // NIS1 allows up to 100 per page
const MAX_PAGES = 20; // 2,000 catches; far more than anybody has

/** The dedicated sink address of an account (the same one the official Nano Wallet uses). */
export function nemonsterSinkAddress(address: string, networkByte: number): string {
  const seed = new TextEncoder().encode(`${SINK_SEED_PREFIX}${normalizeNemAddress(address)}`);
  const pair = nemKeyPairFromPrivateKey(bytesToHex(keccak_256(seed)));
  return nemAddressFromPublicKey(pair.publicKey, networkByte);
}

/** Catching costs only the fee of a 0 XEM transfer without a message (0.05 XEM). */
export function nemonsterCatchFee(): bigint {
  return nemTransferFee(0n, undefined);
}

interface RawEntry {
  meta?: { id?: number; hash?: { data?: string } };
  transaction?: { type?: number; signer?: string; otherTrans?: { signer?: string } };
}

export interface NemonsterState {
  sink: string;
  hashes: string[]; // transaction hashes of the confirmed catches, newest first
  pending: number; // catches announced but not in a block yet
}

export interface CollectedMonster {
  hash: string | null; // null = the starter monster
  monster: Monster;
}

/** The monster of every catch, newest first, and the starter monster at the end. */
export function buildCollection(hashes: string[]): CollectedMonster[] {
  return [
    ...hashes.map((hash) => ({ hash, monster: monsterFromHash(hash) })),
    { hash: null, monster: STARTER_MONSTER },
  ];
}

/** Reads the catches of an account from the sink's incoming transfers. */
export async function fetchNemonsterState(address: string, networkByte: number): Promise<NemonsterState> {
  const me = normalizeNemAddress(address);
  const sink = nemonsterSinkAddress(me, networkByte);

  // Signer public key -> is it me? (the same few keys come back again and again)
  const mine = new Map<string, boolean>();
  const isMine = (publicKey: string | undefined): boolean => {
    if (!publicKey) return false;
    let known = mine.get(publicKey);
    if (known === undefined) {
      try {
        known = nemAddressFromPublicKey(publicKey, networkByte) === me;
      } catch {
        known = false;
      }
      mine.set(publicKey, known);
    }
    return known;
  };
  // A multisig wrapper carries the real transfer inside; the wrapper's hash is the one NIS1 lists.
  const signerOf = (entry: RawEntry): string | undefined => {
    const tx = entry.transaction;
    return tx?.type === NEM_TX_TYPE_MULTISIG ? tx.otherTrans?.signer : tx?.signer;
  };

  const seen = new Set<string>();
  const hashes: string[] = [];
  let lastId: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data?: RawEntry[] }>(
      `/account/transfers/incoming?address=${sink}&pageSize=${PAGE_SIZE}${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = res.data ?? [];
    for (const entry of entries) {
      const hash = entry.meta?.hash?.data;
      if (hash && isMine(signerOf(entry)) && !seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash);
      }
    }
    lastId = entries.length > 0 ? entries[entries.length - 1].meta?.id : undefined;
    if (entries.length < PAGE_SIZE || lastId === undefined) break;
  }

  // Catches that are still waiting for a block (they become monsters once confirmed).
  let pending = 0;
  try {
    const res = await nodeRequest<{ data?: RawEntry[] }>(`/account/unconfirmedTransactions?address=${sink}`);
    for (const entry of res.data ?? []) {
      const hash = entry.meta?.hash?.data;
      if (hash && !seen.has(hash) && isMine(signerOf(entry))) pending += 1;
    }
  } catch {
    // the confirmed collection is still worth showing
  }
  return { sink, hashes, pending };
}

export interface CatchNemonsterInput {
  privateKey: string;
  publicKey: string;
  address: string;
  networkByte: number;
}

/** Catches a monster: a 0 XEM transfer to the account's own sink. Resolves with the transaction hash. */
export function catchNemonster(input: CatchNemonsterInput): Promise<{ hash: string }> {
  return sendNemTransfer({
    privateKey: input.privateKey,
    publicKey: input.publicKey,
    recipient: nemonsterSinkAddress(input.address, input.networkByte),
    amount: 0n,
  });
}
