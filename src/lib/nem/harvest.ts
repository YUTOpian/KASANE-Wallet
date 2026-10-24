// NEM (NIS1) delegated harvesting, following the official NEM Nano Wallet:
//  1. an "importance transfer" transaction activates a remote (delegated) account - it can harvest
//     for the main account but cannot move any funds. It takes effect after about 6 hours.
//  2. the remote account's private key is then sent to a node (POST /account/unlock) so that the
//     node harvests on its behalf. POST /account/lock stops it.
// The remote account is derived from the main account's private key, so it never has to be
// stored: it is rebuilt (after the password) whenever it is needed.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { SymbolSendError } from '../symbol/api';
import { bytesToHex, hexToBytes } from '../symbol/crypto';
import { announceNemPayload, isHttpsUrl, nodeRequest } from './api';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from './crypto';
import type { NemKeyPair } from './crypto';
import { getNemCustomNode, getNemNetworkConfig } from './network';
import { signNemImportanceTransfer } from './tx';

export interface NemRemoteAccount extends NemKeyPair {
  address: string;
}

const REMOTE_DOMAIN = new TextEncoder().encode('KASANE Wallet / NEM delegated harvesting remote account / v1');

/**
 * The remote account of a main account: the private key is SHA3-256(domain || main private key).
 * Deterministic (so it can always be rebuilt) and one-way (the remote key reveals nothing about the
 * main key). It is NOT the account the official NEM wallet derives for the same key.
 */
export function deriveNemRemoteAccount(mainPrivateKey: string, networkByte: number): NemRemoteAccount {
  const main = hexToBytes(mainPrivateKey.trim());
  const data = new Uint8Array(REMOTE_DOMAIN.length + main.length);
  data.set(REMOTE_DOMAIN, 0);
  data.set(main, REMOTE_DOMAIN.length);
  const pair = nemKeyPairFromPrivateKey(bytesToHex(sha3_256(data)));
  return { ...pair, address: nemAddressFromPublicKey(pair.publicKey, networkByte) };
}

// --- the main account -------------------------------------------------------------------------
/** What NIS1 reports for the main account's delegation: INACTIVE -> ACTIVATING -> ACTIVE -> DEACTIVATING -> INACTIVE. */
export type NemRemoteStatus = 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING' | 'REMOTE' | 'UNKNOWN';

export interface NemHarvestState {
  balance: bigint; // micro-XEM
  vestedBalance: bigint; // micro-XEM
  harvestedBlocks: number;
  remoteStatus: NemRemoteStatus;
}

const REMOTE_STATUSES: NemRemoteStatus[] = ['INACTIVE', 'ACTIVATING', 'ACTIVE', 'DEACTIVATING', 'REMOTE'];

export async function fetchNemHarvestState(address: string): Promise<NemHarvestState> {
  const res = await nodeRequest<{
    account?: { balance?: number; vestedBalance?: number; harvestedBlocks?: number };
    meta?: { remoteStatus?: string };
  }>(`/account/get?address=${normalizeNemAddress(address)}`);
  const raw = (res.meta?.remoteStatus ?? '').toUpperCase() as NemRemoteStatus;
  return {
    balance: BigInt(res.account?.balance ?? 0),
    vestedBalance: BigInt(res.account?.vestedBalance ?? 0),
    harvestedBlocks: res.account?.harvestedBlocks ?? 0,
    remoteStatus: REMOTE_STATUSES.includes(raw) ? raw : 'UNKNOWN',
  };
}

export interface SendNemImportanceTransferInput {
  privateKey: string; // of the main account
  publicKey: string; // of the main account
  remotePublicKey: string;
  activate: boolean;
}

/** Activates / deactivates the remote account. Resolves with the transaction hash. */
export async function sendNemImportanceTransfer(input: SendNemImportanceTransferInput): Promise<{ hash: string }> {
  const payload = signNemImportanceTransfer(input.privateKey, {
    publicKey: input.publicKey,
    networkByte: getNemNetworkConfig().networkByte,
    remotePublicKey: input.remotePublicKey,
    activate: input.activate,
  });
  return announceNemPayload(payload);
}

// --- the harvesting node ----------------------------------------------------------------------
// These calls go to the node the person picked (not to the automatically chosen node), because
// the remote key is unlocked on that one node only.
export function cleanNemNodeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The nodes offered for harvesting: the node set in Settings (if any), then the built-in HTTPS nodes. */
export function nemHarvestNodeCandidates(): string[] {
  const custom = getNemCustomNode();
  const list = [...(custom ? [custom] : []), ...getNemNetworkConfig().fallbackNodes];
  return Array.from(new Set(list.map(cleanNemNodeUrl).filter(isHttpsUrl)));
}

async function nodeCall<T>(node: string, path: string, init?: RequestInit, timeoutMs = 15000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cleanNemNodeUrl(node)}${path}`, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!res.ok) {
      const message = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new SymbolSendError(message, message);
    }
    return body as T | null;
  } catch (e) {
    if (e instanceof SymbolSendError) throw e;
    if ((e as Error).name === 'AbortError') throw new SymbolSendError('timeout', 'timeout');
    throw new SymbolSendError('node_unreachable', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export interface NemNodeSlots {
  max: number; // how many delegated accounts the node accepts
  used: number;
}

/** The node's delegated-harvesting slots, or null when the node does not tell. */
export async function fetchNemNodeSlots(node: string): Promise<NemNodeSlots | null> {
  try {
    const res = await nodeCall<{ 'max-unlocked'?: number; 'num-unlocked'?: number }>(node, '/account/unlocked/info', undefined, 10000);
    if (!res || typeof res['max-unlocked'] !== 'number') return null;
    return { max: res['max-unlocked'], used: res['num-unlocked'] ?? 0 };
  } catch {
    return null;
  }
}

export type NemRemoteHarvestStatus = 'UNLOCKED' | 'LOCKED' | 'UNKNOWN';

/** Whether the remote account is currently harvesting on the node. */
export async function fetchNemRemoteHarvestStatus(node: string, remoteAddress: string): Promise<NemRemoteHarvestStatus> {
  try {
    const res = await nodeCall<{ meta?: { status?: string } }>(node, `/account/get?address=${normalizeNemAddress(remoteAddress)}`, undefined, 10000);
    const status = (res?.meta?.status ?? '').toUpperCase();
    return status === 'UNLOCKED' || status === 'LOCKED' ? status : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

async function postKey(node: string, path: '/account/unlock' | '/account/lock', remotePrivateKey: string): Promise<void> {
  if (!isHttpsUrl(node)) throw new SymbolSendError('node_not_https', 'node_not_https');
  await nodeCall<unknown>(node, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: remotePrivateKey }),
  });
}

/** Asks the node to harvest for the remote account (sends the remote private key to the node). */
export function startNemHarvesting(node: string, remotePrivateKey: string): Promise<void> {
  return postKey(node, '/account/unlock', remotePrivateKey);
}

/** Asks the node to stop harvesting for the remote account. */
export function stopNemHarvesting(node: string, remotePrivateKey: string): Promise<void> {
  return postKey(node, '/account/lock', remotePrivateKey);
}

// --- the node the person chose (remembered on this device) ------------------------------------
const nodeKey = (walletId: string) => `kasane.nem.harvestNode.${getNemNetworkConfig().key}.${walletId}`;

export function loadNemHarvestNode(walletId: string): string {
  try { return localStorage.getItem(nodeKey(walletId)) ?? ''; } catch { return ''; }
}

export function saveNemHarvestNode(walletId: string, node: string): void {
  try {
    if (node) localStorage.setItem(nodeKey(walletId), node);
    else localStorage.removeItem(nodeKey(walletId));
  } catch { /* remembering the node is optional */ }
}
