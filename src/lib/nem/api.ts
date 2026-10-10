// NEM (NIS1) node access: node selection, balance, history, announcing a transfer.
import { getNetwork } from '../symbol/network';
import { formatAtomic } from '../symbol/amount';
import { SymbolSendError } from '../symbol/api';
import type { MosaicBalance, SymbolTransfer } from '../symbol/api';
import { getNemCustomNode, getNemNetworkConfig, onNemNodeSettingsChange } from './network';
import { NEM_NODE_LIST_PAGE_URL, NEM_SUPERNODE_LIST_URL, NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_EPOCH_SECONDS, NEM_NATIVE_ID, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import type { NemNetworkConfig } from './constants';
import type { SymbolNetwork } from '../symbol/constants';
import { nemAddressFromPublicKey, normalizeNemAddress } from './crypto';
import {
  NEM_NAMESPACE_DURATION_BLOCKS, nemTransferFee, signNemMosaicCreation, signNemNamespaceRegistration, signNemTransfer,
} from './tx';
import type { NemMosaicParams } from './tx';

// --- plumbing -------------------------------------------------------------------------------
async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const activeNode: Partial<Record<SymbolNetwork, string>> = {};
const badNodes = new Set<string>();
onNemNodeSettingsChange(() => {
  delete activeNode.mainnet;
  delete activeNode.testnet;
  badNodes.clear();
});

export function isHttpsUrl(url: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(url.trim());
}

/**
 * Extra HTTPS nodes, best effort (every source may fail; the built-in nodes are then used alone):
 *  1. the public node list page (nemnodes.org) - HTTPS nodes are linked as https://host:port/chain/height
 *  2. the official supernode list (JSON)
 * Only domain names are taken - a certificate cannot match a bare IP address.
 */
let discovered: string[] | null = null;
async function discoverFromNodeListPage(): Promise<string[]> {
  const html = await fetchText(NEM_NODE_LIST_PAGE_URL, 8000);
  const found = new Set<string>();
  const re = /https:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}):(\d{2,5})\/chain\/height/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) found.add(`https://${m[1].toLowerCase()}:${m[2]}`);
  return Array.from(found);
}

async function discoverFromSupernodeList(): Promise<string[]> {
  const found = new Set<string>();
  const list = await fetchJson<unknown>(NEM_SUPERNODE_LIST_URL, undefined, 6000);
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    const o = value as Record<string, unknown>;
    const host = [o.host, o.alias, o.domain].find((v) => typeof v === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v as string)) as string | undefined;
    const protocol = typeof o.protocol === 'string' ? o.protocol.toLowerCase() : 'https';
    const port = Number(o.port ?? 7891) || 7891;
    if (host && protocol === 'https') found.add(`https://${host.toLowerCase()}:${port}`);
    Object.values(o).forEach((v) => visit(v, depth + 1));
  };
  visit(list, 0);
  return Array.from(found);
}

async function discoverSupernodes(): Promise<string[]> {
  if (discovered) return discovered;
  const results = await Promise.allSettled([discoverFromNodeListPage(), discoverFromSupernodeList()]);
  const all = new Set<string>();
  for (const r of results) if (r.status === 'fulfilled') r.value.forEach((u) => all.add(u));
  // Do not cache an empty result: the next attempt may succeed.
  if (all.size > 0) discovered = Array.from(all);
  return Array.from(all);
}

/** A node is usable when it is HTTPS, answers, and belongs to the network we expect. */
async function probeNode(url: string, cfg: NemNetworkConfig): Promise<boolean> {
  if (!isHttpsUrl(url)) return false;
  try {
    const info = await fetchJson<{ metaData?: { networkId?: number } }>(`${url}/node/info`, undefined, 8000);
    return info.metaData?.networkId === cfg.networkId;
  } catch {
    return false;
  }
}

// Returns the first candidate that answers the probe (all candidates are probed in parallel).
async function firstHealthy(candidates: string[], cfg: NemNetworkConfig): Promise<string | null> {
  const list = candidates.filter((c) => !badNodes.has(c));
  if (list.length === 0) return null;
  return new Promise((resolve) => {
    let pending = list.length;
    let done = false;
    for (const url of list) {
      probeNode(url, cfg).then((ok) => {
        if (done) return;
        if (ok) {
          done = true;
          resolve(url);
        } else if (--pending === 0) {
          resolve(null);
        }
      });
    }
  });
}

// Probes candidates a few at a time (in random order), so a phone is not asked to open dozens of
// TLS connections at once; returns the first node that answers.
async function firstHealthyBatched(candidates: string[], cfg: NemNetworkConfig, batchSize = 8): Promise<string | null> {
  const list = shuffled(candidates.filter((c) => !badNodes.has(c)));
  for (let i = 0; i < list.length; i += batchSize) {
    const node = await firstHealthy(list.slice(i, i + batchSize), cfg);
    if (node) return node;
  }
  return null;
}

export async function resolveNemNode(forceRefresh = false): Promise<string> {
  const network = getNetwork();
  const cfg = getNemNetworkConfig(network);
  const custom = getNemCustomNode(network);
  if (custom) return custom;
  if (!forceRefresh && activeNode[network]) return activeNode[network]!;
  if (network === 'testnet') {
    // No public HTTPS testnet node exists to pick automatically.
    throw new Error('nem_testnet_needs_https_node');
  }
  // Built-in nodes first; if none answers, the live node list is read and its nodes are tried too.
  let node = await firstHealthyBatched(cfg.fallbackNodes, cfg);
  if (!node) {
    const extra = (await discoverSupernodes()).filter((u) => !cfg.fallbackNodes.includes(u));
    node = await firstHealthyBatched(extra, cfg);
  }
  if (!node) {
    badNodes.clear();
    node = await firstHealthyBatched(cfg.fallbackNodes, cfg);
  }
  if (!node) throw new Error('no_node_available');
  activeNode[network] = node;
  return node;
}

export interface NemNodeDiagnosis {
  url: string;
  ok: boolean;
  // 'OK', or why it failed: HTTP status, timeout, wrong network, or "network" (DNS / TLS / CORS).
  detail: string;
}

/** Tries every candidate node and reports each result - for the connection test in Settings. */
export async function diagnoseNemNodes(): Promise<NemNodeDiagnosis[]> {
  const cfg = getNemNetworkConfig();
  const candidates = Array.from(new Set([...cfg.fallbackNodes, ...(cfg.fallbackNodes.length > 0 ? await discoverSupernodes() : [])])).slice(0, 70);
  return Promise.all(candidates.map(async (url): Promise<NemNodeDiagnosis> => {
    try {
      const info = await fetchJson<{ metaData?: { networkId?: number } }>(`${url}/node/info`, undefined, 10000);
      const id = info.metaData?.networkId;
      return id === cfg.networkId ? { url, ok: true, detail: 'OK' } : { url, ok: false, detail: `networkId ${String(id)}` };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const name = (e as Error).name;
      return { url, ok: false, detail: status ? `HTTP ${status}` : name === 'AbortError' ? 'timeout' : 'network' };
    }
  }));
}

/** Checks a hand-entered NIS node URL (used by the settings screen before saving it). */
export async function checkNemNode(url: string, network: SymbolNetwork): Promise<boolean> {
  return probeNode(url.trim().replace(/\/+$/, ''), getNemNetworkConfig(network));
}

export async function nodeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const node = await resolveNemNode(attempt > 0);
    try {
      return await fetchJson<T>(`${node}${path}`, init);
    } catch (e) {
      lastError = e;
      const status = (e as { status?: number }).status;
      // A definite answer from the node (4xx) is not a node failure.
      if (status !== undefined && status < 500) throw e;
      if (getNemCustomNode()) throw e;
      badNodes.add(node);
      delete activeNode[getNetwork()];
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request_failed');
}

// --- balance --------------------------------------------------------------------------------
function xemBalance(micro: bigint): MosaicBalance {
  return {
    id: NEM_NATIVE_ID,
    divisibility: NEM_CURRENCY_DIVISIBILITY,
    symbol: NEM_CURRENCY_SYMBOL,
    name: NEM_NATIVE_ID,
    transferable: true,
    amount: micro,
    balance: formatAtomic(micro, NEM_CURRENCY_DIVISIBILITY),
  };
}

/** XEM first (always listed), then any other NEM mosaics the account holds. */
export async function fetchNemBalances(address: string): Promise<MosaicBalance[]> {
  const addr = normalizeNemAddress(address);
  const account = await nodeRequest<{ account?: { balance?: number } }>(`/account/get?address=${addr}`);
  const list: MosaicBalance[] = [xemBalance(BigInt(account.account?.balance ?? 0))];
  try {
    const owned = await nodeRequest<{ data?: Array<{ quantity: number; mosaicId: { namespaceId: string; name: string } }> }>(
      `/account/mosaic/owned?address=${addr}`,
    );
    for (const m of owned.data ?? []) {
      const id = `${m.mosaicId.namespaceId}:${m.mosaicId.name}`;
      if (id === NEM_NATIVE_ID) continue;
      list.push({ id, divisibility: 0, symbol: id, name: id, transferable: true, amount: BigInt(m.quantity), balance: String(m.quantity) });
    }
  } catch {
    // other mosaics are optional information
  }
  return list;
}

// --- history --------------------------------------------------------------------------------
interface RawNemTx {
  timeStamp: number;
  amount?: number;
  fee?: number;
  recipient?: string;
  type: number;
  version?: number;
  signer: string;
  message?: { payload?: string; type?: number };
  mosaics?: Array<{ quantity: number; mosaicId: { namespaceId: string; name: string } }>;
  otherTrans?: RawNemTx;
}
interface RawNemEntry {
  meta?: { id?: number; hash?: { data?: string } };
  transaction: RawNemTx;
}

function hexToText(hex: string): string {
  try {
    const bytes = new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16)));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function toTransfer(raw: RawNemEntry, myAddress: string, isConfirmed: boolean): SymbolTransfer | null {
  const outer = raw.transaction;
  const tx = outer.type === NEM_TX_TYPE_MULTISIG && outer.otherTrans ? outer.otherTrans : outer;
  if (tx.type !== NEM_TX_TYPE_TRANSFER || !tx.recipient) return null;

  // Network byte of the sender comes from the transaction version (0x68 / 0x98 in its top byte).
  const networkByte = ((tx.version ?? 0) >>> 24) & 0xff || getNemNetworkConfig().networkByte;
  const sender = nemAddressFromPublicKey(tx.signer, networkByte);
  const receiver = normalizeNemAddress(tx.recipient);
  const me = normalizeNemAddress(myAddress);

  const multiplier = BigInt(tx.amount ?? 0);
  let mosaics: SymbolTransfer['mosaics'];
  if (tx.mosaics && tx.mosaics.length > 0) {
    // Version 2 transfer: `amount` is a multiplier (1,000,000 = x1) of each mosaic's quantity.
    mosaics = tx.mosaics.map((m) => {
      const id = `${m.mosaicId.namespaceId}:${m.mosaicId.name}`;
      const quantity = (BigInt(m.quantity) * multiplier) / 1_000_000n;
      return id === NEM_NATIVE_ID
        ? { id, symbol: NEM_CURRENCY_SYMBOL, amount: formatAtomic(quantity, NEM_CURRENCY_DIVISIBILITY) }
        : { id, symbol: id, amount: quantity.toString() };
    });
  } else {
    mosaics = [{ id: NEM_NATIVE_ID, symbol: NEM_CURRENCY_SYMBOL, amount: formatAtomic(multiplier, NEM_CURRENCY_DIVISIBILITY) }];
  }

  const encrypted = tx.message?.type === 2;
  return {
    hash: raw.meta?.hash?.data ?? '',
    timestampMs: (tx.timeStamp + NEM_EPOCH_SECONDS) * 1000,
    isReception: receiver === me && sender !== me,
    isConfirmed,
    senderAddress: sender,
    receiverAddress: receiver,
    mosaics,
    message: !encrypted && tx.message?.payload ? hexToText(tx.message.payload) : '',
    encryptedMessage: encrypted,
    fee: formatAtomic(BigInt(tx.fee ?? 0), NEM_CURRENCY_DIVISIBILITY),
  };
}

/** Transfers of the account, newest first (unconfirmed ones first when asked for). */
export async function fetchNemTransfers(address: string, count: number, includeUnconfirmed = true): Promise<SymbolTransfer[]> {
  const addr = normalizeNemAddress(address);
  const result: SymbolTransfer[] = [];

  if (includeUnconfirmed) {
    try {
      const pending = await nodeRequest<{ data?: RawNemEntry[] }>(`/account/unconfirmedTransactions?address=${addr}`);
      for (const entry of pending.data ?? []) {
        const t = toTransfer(entry, addr, false);
        if (t) result.push(t);
      }
    } catch {
      // the confirmed history is still worth showing
    }
  }

  // NIS1 returns up to 25 per page; the next page starts after the last id seen.
  let lastId: number | undefined;
  while (result.filter((t) => t.isConfirmed).length < count) {
    const page = await nodeRequest<{ data?: RawNemEntry[] }>(
      `/account/transfers/all?address=${addr}${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = page.data ?? [];
    if (entries.length === 0) break;
    for (const entry of entries) {
      const t = toTransfer(entry, addr, true);
      if (t) result.push(t);
    }
    lastId = entries[entries.length - 1].meta?.id;
    if (entries.length < 25 || lastId === undefined) break;
  }
  const unconfirmed = result.filter((t) => !t.isConfirmed);
  const confirmed = result.filter((t) => t.isConfirmed).slice(0, count);
  return [...unconfirmed, ...confirmed];
}

// --- sending --------------------------------------------------------------------------------
export interface NemFeeQuote {
  fee: bigint; // micro-XEM
}

export function quoteNemFee(amountMicro: bigint, message: string | undefined): NemFeeQuote {
  return { fee: nemTransferFee(amountMicro, message) };
}

export interface SendNemTransferInput {
  privateKey: string;
  publicKey: string;
  recipient: string;
  amount: bigint; // micro-XEM
  message?: string;
}

export async function sendNemTransfer(input: SendNemTransferInput): Promise<{ hash: string }> {
  const cfg = getNemNetworkConfig();
  const recipient = normalizeNemAddress(input.recipient);
  const payload = signNemTransfer(input.privateKey, {
    publicKey: input.publicKey,
    networkByte: cfg.networkByte,
    recipient,
    amount: input.amount,
    message: input.message,
    fee: nemTransferFee(input.amount, input.message),
  });
  return announceNemPayload(payload);
}

/** Announces a signed NIS1 transaction (the JSON body) and returns its hash; throws SymbolSendError on rejection. */
export async function announceNemPayload(payload: string): Promise<{ hash: string }> {
  let res: { code?: number; message?: string; transactionHash?: { data?: string } };
  try {
    res = await nodeRequest(`/transaction/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch (e) {
    throw new SymbolSendError('announce_failed', (e as Error).message);
  }
  // code 1 = SUCCESS; anything else is a rejection (insufficient balance, expired, ...).
  if (res.code !== 1) throw new SymbolSendError(res.message ?? 'announce_failed');
  return { hash: res.transactionHash?.data ?? '' };
}

// --- namespaces -----------------------------------------------------------------------------
export interface NemOwnedNamespace {
  name: string; // full name, e.g. "root.sub"
  depth: number; // 1 = root
  expired: boolean;
  expiresAtMs: number; // approximate
}

async function currentHeight(): Promise<number> {
  return (await nodeRequest<{ height: number }>('/chain/height')).height;
}

type RawNamespace = { namespace?: { fqn?: string; height?: number; owner?: string } };

/** Namespaces the account owns (roots, and the sub-namespaces under them), newest registrations are not special-cased. */
export async function fetchNemOwnedNamespaces(address: string): Promise<NemOwnedNamespace[]> {
  const addr = normalizeNemAddress(address);
  const page = async (parent?: string) => {
    const res = await nodeRequest<{ data?: RawNamespace[] }>(
      `/account/namespace/page?address=${addr}&pageSize=100${parent ? `&parent=${encodeURIComponent(parent)}` : ''}`,
    );
    return (res.data ?? []).map((d) => d.namespace?.fqn).filter((f): f is string => typeof f === 'string');
  };
  const found = new Set<string>(await page());
  // Some nodes list only the roots without a parent: also ask for the children of each namespace found.
  let frontier = Array.from(found).filter((f) => !f.includes('.'));
  for (let level = 1; level < 3 && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const parent of frontier) {
      try {
        for (const fqn of await page(parent)) {
          if (!found.has(fqn)) next.push(fqn);
          found.add(fqn);
        }
      } catch {
        // children are best effort
      }
    }
    frontier = next;
  }
  if (found.size === 0) return [];

  const height = await currentHeight();
  const roots = Array.from(new Set(Array.from(found).map((f) => f.split('.')[0])));
  const rootHeight: Record<string, number | undefined> = {};
  await Promise.all(roots.map(async (root) => {
    try {
      rootHeight[root] = (await nodeRequest<{ height?: number }>(`/namespace?id=${encodeURIComponent(root)}`)).height;
    } catch {
      rootHeight[root] = undefined;
    }
  }));
  return Array.from(found)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const start = rootHeight[name.split('.')[0]];
      const endHeight = start === undefined ? undefined : start + NEM_NAMESPACE_DURATION_BLOCKS;
      const remaining = endHeight === undefined ? 0 : endHeight - height;
      return {
        name,
        depth: name.split('.').length,
        expired: endHeight !== undefined && remaining <= 0,
        expiresAtMs: Date.now() + (remaining * 60 * 1000),
      };
    });
}

export interface RegisterNemNamespaceInput {
  privateKey: string;
  publicKey: string;
  name: string; // the new part
  parentName?: string; // omit for a root namespace
}

export async function registerNemNamespace(input: RegisterNemNamespaceInput): Promise<{ hash: string }> {
  const payload = signNemNamespaceRegistration(input.privateKey, {
    publicKey: input.publicKey,
    networkByte: getNemNetworkConfig().networkByte,
    name: input.name,
    parentName: input.parentName,
  });
  return announceNemPayload(payload);
}

// --- mosaics --------------------------------------------------------------------------------
export interface NemOwnedMosaic {
  id: string; // "namespace:name"
  description: string;
  divisibility: number;
  initialSupply: string; // whole units
  supplyMutable: boolean;
  transferable: boolean;
}

/** Mosaic definitions the account created. */
export async function fetchNemCreatedMosaics(address: string): Promise<NemOwnedMosaic[]> {
  const addr = normalizeNemAddress(address);
  const res = await nodeRequest<{
    data?: Array<{
      description?: string;
      id?: { namespaceId: string; name: string };
      properties?: Array<{ name: string; value: string }>;
    }>;
  }>(`/account/mosaic/definition/page?address=${addr}&pageSize=100`);
  const out: NemOwnedMosaic[] = [];
  for (const d of res.data ?? []) {
    if (!d.id) continue;
    const prop = (name: string) => d.properties?.find((p) => p.name === name)?.value;
    out.push({
      id: `${d.id.namespaceId}:${d.id.name}`,
      description: d.description ?? '',
      divisibility: Number(prop('divisibility') ?? 0),
      initialSupply: prop('initialSupply') ?? '0',
      supplyMutable: prop('supplyMutable') === 'true',
      transferable: prop('transferable') !== 'false',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type CreateNemMosaicInput = Omit<NemMosaicParams, 'publicKey' | 'networkByte'> & { privateKey: string; publicKey: string };

export async function createNemMosaic(input: CreateNemMosaicInput): Promise<{ hash: string }> {
  const { privateKey, ...params } = input;
  const payload = signNemMosaicCreation(privateKey, { ...params, networkByte: getNemNetworkConfig().networkByte });
  return announceNemPayload(payload);
}

/** XEM balance in micro-XEM (for the "balance may not cover the cost" warning). */
export async function fetchNemXemBalance(address: string): Promise<bigint> {
  const account = await nodeRequest<{ account?: { balance?: number } }>(`/account/get?address=${normalizeNemAddress(address)}`);
  return BigInt(account.account?.balance ?? 0);
}

// --- explorer -------------------------------------------------------------------------------
export function nemExplorerTxUrl(hash: string): string {
  return `${getNemNetworkConfig().explorer}/#/s_tx?hash=${hash}`;
}

export function nemExplorerAccountUrl(address: string): string {
  return `${getNemNetworkConfig().explorer}/#/s_account?account=${normalizeNemAddress(address)}`;
}


export function nemExplorerNamespaceUrl(name: string): string {
  return `${getNemNetworkConfig().explorer}/#/s_namespace?namespace=${encodeURIComponent(name)}`;
}

export function nemExplorerMosaicUrl(id: string): string {
  return `${getNemNetworkConfig().explorer}/#/s_mosaic?mosaic=${encodeURIComponent(id)}`;
}
