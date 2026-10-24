// NEM (NIS1) node access: node selection, balance, history, announcing a transfer.
import { logDebug, logInfo, logWarn } from '../diagnostics';
import { getNetwork } from '../symbol/network';
import { formatAtomic } from '../symbol/amount';
import { SymbolSendError } from '../symbol/api';
import type { MosaicBalance, SymbolTransfer } from '../symbol/api';
import { getNemCustomNode, getNemNetworkConfig, onNemNodeSettingsChange } from './network';
import { NEM_NODE_LIST_PAGE_URL, NEM_SUPERNODE_LIST_URL, NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_EPOCH_SECONDS, NEM_NATIVE_ID, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import type { NemNetworkConfig } from './constants';
import type { SymbolNetwork } from '../symbol/constants';
import { nemAddressFromPublicKey, normalizeNemAddress, verifyNemSignature } from './crypto';
import { signWithLedger } from '../ledger/session';
import { encryptNemMessage } from './message';
import {
  NEM_NAMESPACE_DURATION_BLOCKS, NEM_XEM_FEE_INFO, NEM_XEM_MOSAIC_ID, nemSendFee, nemTransferFee, normalizeNemTransferMosaics, signNemMosaicCreation,
  signNemMosaicSupplyChange, signNemNamespaceRegistration, signNemTransfer,
} from './tx';
import { signNemTransferWith } from './tx';
import { saveKnownNemMosaics } from '../mosaicCache';
import { notifyNemAnnounced } from './liveSignal';
import type { NemMosaicAmount, NemMosaicParams, NemMosaicSupplyChangeParams } from './tx';
import { nemLevyFromRaw, nemMosaicEditAccess } from './mosaicEdit';
import type { NemMosaicDefinition, NemMosaicEditAccess } from './mosaicEdit';

// --- plumbing -------------------------------------------------------------------------------
async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // NIS1 explains a rejected request in the body ({ message, error }): keep it, it is the only clue to why (e.g. an HTTP 500 on announce).
      let reason = '';
      try {
        const text = (await res.text()).trim();
        try {
          const body = JSON.parse(text) as { message?: unknown; error?: unknown };
          reason = String(body.message ?? body.error ?? '').trim();
        } catch {
          reason = text;
        }
      } catch { /* no readable body */ }
      reason = reason.replace(/\s+/g, ' ').slice(0, 200);
      const err = new Error(reason ? `HTTP ${res.status}: ${reason}` : `HTTP ${res.status}`) as Error & { status?: number };
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
  let lastNode = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const node = await resolveNemNode(attempt > 0);
    lastNode = node;
    const started = Date.now();
    const what = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
    try {
      const result = await fetchJson<T>(`${node}${path}`, init);
      logDebug('nem-node', `${what} ← ${node.replace(/^https?:\/\//, '')} ${Date.now() - started} ms`);
      return result;
    } catch (e) {
      lastError = e;
      const status = (e as { status?: number }).status;
      logWarn('nem-node', `${what} ✗ ${node.replace(/^https?:\/\//, '')} ${Date.now() - started} ms: ${(e as Error).message}${attempt < 2 ? ' (retrying)' : ''}`);
      // A definite answer from the node (4xx) is not a node failure.
      if (status !== undefined && status < 500) throw e;
      if (getNemCustomNode()) throw e;
      badNodes.add(node);
      delete activeNode[getNetwork()];
    }
  }
  if (lastError instanceof Error) {
    // Say which node gave the final answer, so a node that keeps failing can be told apart from a request that is wrong.
    const host = lastNode.replace(/^https?:\/\//, '');
    if (host && !lastError.message.includes(host)) lastError.message = `${lastError.message} (${host})`;
    throw lastError;
  }
  throw new Error('request_failed');
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

// What the chain says about a mosaic (NIS1 mosaic definition).
export interface NemMosaicInfo {
  id: string; // "namespace:name"
  divisibility: number;
  supply: bigint; // whole units (the initial supply: what the definition carries)
  transferable: boolean;
  supplyMutable: boolean;
  creator: string; // public key (hex)
  hasLevy: boolean; // a levy is charged to the sender on every transfer
}

const XEM_INFO: NemMosaicInfo = {
  id: NEM_NATIVE_ID,
  divisibility: NEM_CURRENCY_DIVISIBILITY,
  supply: NEM_XEM_FEE_INFO.supply,
  transferable: true,
  supplyMutable: false,
  creator: '',
  hasLevy: false,
};

// Definitions never change under a given id for our purposes (divisibility is fixed), so keep them for the session.
const mosaicInfoCache = new Map<string, NemMosaicInfo>();
const infoKey = (id: string) => `${getNetwork()}|${id}`;

interface RawMosaicDefinition {
  creator?: string;
  id?: { namespaceId: string; name: string };
  properties?: Array<{ name: string; value: string }>;
  levy?: Record<string, unknown> | null;
}
interface RawMosaicDefinitionEntry extends RawMosaicDefinition {
  meta?: { id?: number };
  mosaic?: RawMosaicDefinition; // /namespace/mosaic/definition/page wraps each definition with its meta data
}

function toMosaicInfo(def: RawMosaicDefinition): NemMosaicInfo | null {
  if (!def.id) return null;
  const prop = (name: string) => def.properties?.find((p) => p.name === name)?.value;
  const supply = prop('initialSupply');
  if (supply === undefined || !/^\d+$/.test(supply)) return null;
  return {
    id: `${def.id.namespaceId}:${def.id.name}`,
    divisibility: Number(prop('divisibility') ?? 0),
    supply: BigInt(supply),
    transferable: prop('transferable') !== 'false',
    supplyMutable: prop('supplyMutable') === 'true',
    creator: def.creator ?? '',
    hasLevy: !!def.levy && Object.keys(def.levy).length > 0,
  };
}

/** Definitions of the wanted mosaics of one namespace (pages through the namespace's definitions). */
async function fetchNamespaceMosaicInfos(namespace: string, wanted: Set<string>): Promise<NemMosaicInfo[]> {
  const found = new Map<string, { info: NemMosaicInfo; metaId: number }>();
  let lastId: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await nodeRequest<{ data?: RawMosaicDefinitionEntry[] }>(
      `/namespace/mosaic/definition/page?namespace=${encodeURIComponent(namespace)}&pageSize=100${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = res.data ?? [];
    for (const entry of entries) {
      const info = toMosaicInfo(entry.mosaic ?? entry);
      if (!info || !wanted.has(info.id)) continue;
      // A mosaic that was defined again appears more than once: the newest definition wins.
      const metaId = entry.meta?.id ?? 0;
      const known = found.get(info.id);
      if (!known || metaId >= known.metaId) found.set(info.id, { info, metaId });
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 100 || next === undefined || found.size === wanted.size) break;
    lastId = next;
  }
  return Array.from(found.values(), (f) => f.info);
}

/**
 * Definitions (divisibility, supply, flags) of the given mosaics, keyed by id. A mosaic whose definition
 * could not be read is left out: callers must not guess its divisibility. "nem:xem" is built in.
 */
export async function fetchNemMosaicInfos(ids: string[]): Promise<Record<string, NemMosaicInfo>> {
  const out: Record<string, NemMosaicInfo> = {};
  const missingByNamespace = new Map<string, Set<string>>();
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (id === NEM_NATIVE_ID) { out[id] = XEM_INFO; continue; }
    const cached = mosaicInfoCache.get(infoKey(id));
    if (cached) { out[id] = cached; continue; }
    const cut = id.lastIndexOf(':');
    if (cut <= 0) continue;
    const ns = id.slice(0, cut);
    if (!missingByNamespace.has(ns)) missingByNamespace.set(ns, new Set());
    missingByNamespace.get(ns)!.add(id);
  }
  await Promise.all(Array.from(missingByNamespace, async ([ns, wanted]) => {
    try {
      for (const info of await fetchNamespaceMosaicInfos(ns, wanted)) {
        mosaicInfoCache.set(infoKey(info.id), info);
        out[info.id] = info;
      }
    } catch (e) {
      logWarn('nem-node', `mosaic definitions of ${ns} could not be read: ${(e as Error).message}`);
    }
  }));
  return out;
}

/** XEM first (always listed), then any other NEM mosaics the account holds (with their real divisibility). */
export async function fetchNemBalances(address: string): Promise<MosaicBalance[]> {
  const addr = normalizeNemAddress(address);
  const account = await nodeRequest<{ account?: { balance?: number } }>(`/account/get?address=${addr}`);
  const list: MosaicBalance[] = [xemBalance(BigInt(account.account?.balance ?? 0))];
  try {
    const owned = await nodeRequest<{ data?: Array<{ quantity: number; mosaicId: { namespaceId: string; name: string } }> }>(
      `/account/mosaic/owned?address=${addr}`,
    );
    const held = (owned.data ?? [])
      .map((m) => ({ id: `${m.mosaicId.namespaceId}:${m.mosaicId.name}`, quantity: BigInt(m.quantity) }))
      .filter((m) => m.id !== NEM_NATIVE_ID);
    const infos = held.length > 0 ? await fetchNemMosaicInfos(held.map((m) => m.id)) : {};
    const networkByte = getNemNetworkConfig().networkByte;
    for (const m of held) {
      const info = infos[m.id];
      if (!info) {
        // Definition unknown: shown with raw units as before, but without `supply`, so it is never offered for sending.
        list.push({ id: m.id, divisibility: 0, symbol: m.id, name: m.id, transferable: true, amount: m.quantity, balance: String(m.quantity) });
        continue;
      }
      // A non-transferable mosaic can still be sent by its creator.
      const isCreator = info.creator !== '' && nemAddressFromPublicKey(info.creator, networkByte) === addr;
      list.push({
        id: m.id,
        divisibility: info.divisibility,
        symbol: m.id,
        name: m.id,
        transferable: info.transferable || isCreator,
        amount: m.quantity,
        balance: formatAtomic(m.quantity, info.divisibility),
        supply: info.supply,
        hasLevy: info.hasLevy,
      });
    }
    // Remember what this account holds, so 「オフライン署名」 (no node there) can offer the mosaics to choose from. Only mosaics
    // whose definition was read (the fee needs supply and divisibility) and that can be sent, like the send screen's list.
    void saveKnownNemMosaics(getNetwork(), addr, list
      .filter((b, i) => i > 0 && b.supply !== undefined && b.transferable && b.amount > 0n)
      .map((b) => ({ id: b.id.toLowerCase(), divisibility: b.divisibility, supply: (b.supply as bigint).toString() })));
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
    encryptedPayload: encrypted ? (tx.message?.payload ?? '') : '',
    signerPublicKey: tx.signer.toUpperCase(),
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

/** Public key of an account as the network knows it (an account has one after its first outgoing transaction); null = none yet. */
export async function fetchNemAccountPublicKey(address: string): Promise<string | null> {
  const res = await nodeRequest<{ account?: { publicKey?: string | null } }>(`/account/get?address=${normalizeNemAddress(address)}`);
  return res.account?.publicKey ? res.account.publicKey.toUpperCase() : null;
}

export interface SendNemTransferInput {
  /** Ledger のアカウントなら空文字にして `ledgerIndex` を入れる。 */
  privateKey: string;
  ledgerIndex?: number;
  publicKey: string;
  recipient: string;
  amount: bigint; // micro-XEM (ignored when `mosaics` is given)
  message?: string;
  /** Send `message` encrypted for the recipient (needs `privateKey`, so not for a Ledger account, and the recipient's public key on the network). */
  encrypt?: boolean;
  /** Mosaics to send (XEM as "nem:xem" in micro-XEM). When given, `amount` is not used. */
  mosaics?: NemMosaicAmount[];
}

export async function sendNemTransfer(input: SendNemTransferInput): Promise<{ hash: string }> {
  const cfg = getNemNetworkConfig();
  const recipient = normalizeNemAddress(input.recipient);
  // Encrypted message: read the recipient's public key now and encrypt with the sender's private key.
  const encrypt = !!input.encrypt && !!input.message;
  let encryptedMessage: Uint8Array | undefined;
  if (encrypt) {
    if (input.ledgerIndex !== undefined || input.privateKey === '') throw new SymbolSendError('encrypt_needs_key', 'an encrypted message needs the private key');
    const recipientKey = await fetchNemAccountPublicKey(recipient);
    if (recipientKey === null) throw new SymbolSendError('recipient_public_key_missing', 'the recipient has no public key on the network');
    encryptedMessage = encryptNemMessage(input.privateKey, recipientKey, input.message as string);
  }
  const lines: NemMosaicAmount[] = input.mosaics ?? [{ id: NEM_XEM_MOSAIC_ID, quantity: input.amount }];
  const normalized = normalizeNemTransferMosaics(lines.map((m) => ({ ...m, id: m.id.toLowerCase() })));
  // Mosaic transfers are priced from each mosaic's supply and divisibility, read from the chain right now.
  let fee: bigint;
  if (normalized.mosaics) {
    const infos = await fetchNemMosaicInfos(normalized.mosaics.map((m) => m.id));
    const feeInfos = Object.fromEntries(Object.values(infos).map((i) => [i.id, { supply: i.supply, divisibility: i.divisibility }]));
    if (normalized.mosaics.some((m) => !infos[m.id])) throw new SymbolSendError('mosaic_info_unavailable', 'mosaic definition could not be read');
    fee = nemSendFee(cfg.networkByte, normalized.mosaics, feeInfos, input.message, encrypt);
  } else {
    fee = nemTransferFee(normalized.amount, input.message, encrypt);
  }
  const params = {
    publicKey: input.publicKey,
    networkByte: cfg.networkByte,
    recipient,
    amount: normalized.amount,
    mosaics: normalized.mosaics,
    message: encryptedMessage ? undefined : input.message,
    encryptedMessage,
    fee,
  };
  const ledgerIndex = input.ledgerIndex;
  const payload = ledgerIndex !== undefined
    ? await signNemTransferWith((serialized) => signWithLedger('nem', ledgerIndex, input.publicKey, cfg.networkByte, serialized, verifyNemSignature), params)
    : signNemTransfer(input.privateKey, params);
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
  if (res.code !== 1) {
    logWarn('tx', `NEM announce rejected: code ${res.code} ${res.message ?? ''}`);
    throw new SymbolSendError(res.message ?? 'announce_failed');
  }
  logInfo('tx', `NEM announced hash ${res.transactionHash?.data ?? ''}`);
  // Lets the live listener look at the node now, so the "announced" sound plays right after sending.
  notifyNemAnnounced();
  return { hash: res.transactionHash?.data ?? '' };
}

// --- apostille ------------------------------------------------------------------------------
export interface NemApostilleTx {
  hash: string;
  /** Public key of the account that signed the transaction (hex). */
  signer: string;
  /** Message payload (hex), of the inner transaction when it is a multisig one. */
  payloadHex: string;
  /** Unix ms of the transaction's time stamp. */
  timestampMs: number;
  confirmed: boolean;
}

/** The transaction with this hash (confirmed or not), or null when the node does not know it. */
export async function fetchNemTransactionByHash(hash: string): Promise<NemApostilleTx | null> {
  interface Raw {
    transaction?: { type?: number; signer?: string; timeStamp?: number; message?: { payload?: string; type?: number }; otherTrans?: { message?: { payload?: string } } };
    meta?: { height?: number };
  }
  let res: Raw;
  try {
    res = await nodeRequest<Raw>(`/transaction/get?hash=${encodeURIComponent(hash.toLowerCase())}`);
  } catch (e) {
    // NIS1 answers an unknown hash with a client error (404 / 400); a node that cannot be reached is a different failure.
    const status = (e as { status?: number }).status;
    if (status === 404 || status === 400) return null;
    throw e;
  }
  const tx = res.transaction;
  if (!tx || !tx.signer) return null;
  const message = tx.type === NEM_TX_TYPE_MULTISIG ? tx.otherTrans?.message : tx.message;
  return {
    hash: hash.toUpperCase(),
    signer: tx.signer.toUpperCase(),
    payloadHex: (message?.payload ?? '').toLowerCase(),
    timestampMs: (NEM_EPOCH_SECONDS + (tx.timeStamp ?? 0)) * 1000,
    confirmed: (res.meta?.height ?? 0) > 0,
  };
}

// --- namespaces -----------------------------------------------------------------------------
export interface NemOwnedNamespace {
  name: string; // full name, e.g. "root.sub"
  depth: number; // 1 = root
  expired: boolean;
  expiresAtMs: number; // approximate
  /** Blocks left until the root's expiry (negative once expired); undefined when the root's start height is unknown. */
  remainingBlocks?: number;
}

async function currentHeight(): Promise<number> {
  return (await nodeRequest<{ height: number }>('/chain/height')).height;
}

// NIS1 wraps each entry as { meta, namespace: { fqn, owner, height } }; some nodes / gateways answer the bare { fqn, owner, height }.
type RawNamespace = { namespace?: { fqn?: string; height?: number; owner?: string }; fqn?: string; height?: number; owner?: string };

/** Namespaces the account owns (roots, and the sub-namespaces under them), newest registrations are not special-cased. */
export async function fetchNemOwnedNamespaces(address: string): Promise<NemOwnedNamespace[]> {
  const addr = normalizeNemAddress(address);
  const page = async (parent?: string) => {
    const res = await nodeRequest<{ data?: RawNamespace[] }>(
      `/account/namespace/page?address=${addr}&pageSize=100${parent ? `&parent=${encodeURIComponent(parent)}` : ''}`,
    );
    return (res.data ?? []).map((d) => d.namespace?.fqn ?? d.fqn).filter((f): f is string => typeof f === 'string');
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
        remainingBlocks: endHeight === undefined ? undefined : remaining,
      };
    });
}

const NEM_TX_TYPE_NAMESPACE_PROVISION = 0x2001; // 8193

/**
 * Full names of the namespaces whose registration the account has announced but the network has not confirmed yet
 * (they are in the node's unconfirmed pool, so the owned list cannot show them until the next block takes them).
 */
export async function fetchNemPendingNamespaces(address: string): Promise<string[]> {
  const addr = normalizeNemAddress(address);
  interface RawPending {
    transaction?: { type?: number; newPart?: string; parent?: string | null; otherTrans?: { type?: number; newPart?: string; parent?: string | null } };
  }
  const res = await nodeRequest<{ data?: RawPending[] }>(`/account/unconfirmedTransactions?address=${addr}`);
  const out: string[] = [];
  for (const entry of res.data ?? []) {
    const outer = entry.transaction;
    const tx = outer?.type === NEM_TX_TYPE_MULTISIG && outer.otherTrans ? outer.otherTrans : outer;
    if (!tx || tx.type !== NEM_TX_TYPE_NAMESPACE_PROVISION || !tx.newPart) continue;
    out.push(tx.parent ? `${tx.parent}.${tx.newPart}` : tx.newPart);
  }
  return out;
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

/**
 * The newest definition of one mosaic, with everything a re-definition has to carry over (description, levy).
 * Not cached: it is read right before editing. null = no such mosaic.
 */
export async function fetchNemMosaicDefinition(id: string): Promise<NemMosaicDefinition | null> {
  const wanted = id.toLowerCase();
  const cut = wanted.lastIndexOf(':');
  if (cut <= 0) return null;
  const namespace = wanted.slice(0, cut);
  let best: { def: NemMosaicDefinition; metaId: number } | null = null;
  let lastId: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await nodeRequest<{ data?: Array<RawMosaicDefinitionEntry & { description?: string }> }>(
      `/namespace/mosaic/definition/page?namespace=${encodeURIComponent(namespace)}&pageSize=100${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = res.data ?? [];
    for (const entry of entries) {
      const raw = (entry.mosaic ?? entry) as RawMosaicDefinition & { description?: string };
      const info = toMosaicInfo(raw);
      if (!info || info.id !== wanted) continue;
      const metaId = entry.meta?.id ?? 0;
      if (best && metaId < best.metaId) continue; // a mosaic that was defined again appears more than once: the newest wins
      const prop = (name: string) => raw.properties?.find((p) => p.name === name)?.value;
      best = {
        metaId,
        def: {
          id: info.id,
          creator: info.creator,
          description: raw.description ?? '',
          divisibility: info.divisibility,
          initialSupply: info.supply,
          supplyMutable: prop('supplyMutable') === 'true',
          transferable: prop('transferable') !== 'false',
          levy: nemLevyFromRaw(raw.levy),
        },
      };
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 100 || next === undefined) break;
    lastId = next;
  }
  return best?.def ?? null;
}

/** The current supply of a mosaic (whole units), or null when the node can't tell. */
export async function fetchNemMosaicSupply(id: string): Promise<bigint | null> {
  try {
    const res = await nodeRequest<{ supply?: number | string }>(`/mosaic/supply?mosaicId=${encodeURIComponent(id.toLowerCase())}`);
    const supply = res.supply;
    if (supply === undefined || supply === null || (typeof supply === 'string' ? !/^\d+$/.test(supply) : !Number.isSafeInteger(supply) || supply < 0)) return null;
    return BigInt(supply);
  } catch (e) {
    logWarn('nem-node', `supply of ${id} could not be read: ${(e as Error).message}`);
    return null;
  }
}

/** How much of a mosaic an account holds (smallest units), or null when it can't be read. */
export async function fetchNemMosaicHolding(address: string, id: string): Promise<bigint | null> {
  try {
    const owned = await nodeRequest<{ data?: Array<{ quantity: number; mosaicId: { namespaceId: string; name: string } }> }>(
      `/account/mosaic/owned?address=${normalizeNemAddress(address)}`,
    );
    const hit = (owned.data ?? []).find((m) => `${m.mosaicId.namespaceId}:${m.mosaicId.name}`.toLowerCase() === id.toLowerCase());
    return BigInt(hit?.quantity ?? 0);
  } catch (e) {
    logWarn('nem-node', `holding of ${id} could not be read: ${(e as Error).message}`);
    return null;
  }
}

export interface NemMosaicEditState {
  definition: NemMosaicDefinition;
  /** The supply now (whole units) when the node could tell. */
  supply: bigint | null;
  creatorBalance: bigint | null;
  access: NemMosaicEditAccess;
}

/** Everything the edit screen needs: the definition, the supply, what the creator holds, and what may be changed. */
export async function fetchNemMosaicEditState(address: string, id: string): Promise<NemMosaicEditState | null> {
  const definition = await fetchNemMosaicDefinition(id);
  if (!definition) return null;
  const [supply, creatorBalance] = await Promise.all([
    definition.supplyMutable ? fetchNemMosaicSupply(id) : Promise.resolve<bigint | null>(definition.initialSupply),
    fetchNemMosaicHolding(address, id),
  ]);
  return { definition, supply, creatorBalance, access: nemMosaicEditAccess(definition, creatorBalance, supply) };
}

export type CreateNemMosaicInput = Omit<NemMosaicParams, 'publicKey' | 'networkByte'> & { privateKey: string; publicKey: string };

export async function createNemMosaic(input: CreateNemMosaicInput): Promise<{ hash: string }> {
  const { privateKey, ...params } = input;
  const payload = signNemMosaicCreation(privateKey, { ...params, networkByte: getNemNetworkConfig().networkByte });
  return announceNemPayload(payload);
}

export type ChangeNemMosaicSupplyInput = Omit<NemMosaicSupplyChangeParams, 'publicKey' | 'networkByte'> & { privateKey: string; publicKey: string };

export async function changeNemMosaicSupply(input: ChangeNemMosaicSupplyInput): Promise<{ hash: string }> {
  const { privateKey, ...params } = input;
  const payload = signNemMosaicSupplyChange(privateKey, { ...params, networkByte: getNemNetworkConfig().networkByte });
  return announceNemPayload(payload);
}

/** XEM balance in micro-XEM (for the "balance may not cover the cost" warning). */
export async function fetchNemXemBalance(address: string): Promise<bigint> {
  const account = await nodeRequest<{ account?: { balance?: number } }>(`/account/get?address=${normalizeNemAddress(address)}`);
  return BigInt(account.account?.balance ?? 0);
}

// --- network statistics ---------------------------------------------------------------------
export interface NemNetworkStats {
  height: number | null;
  /** Time of the latest block (ms since the Unix epoch). */
  latestBlockTimeMs: number | null;
  /** Average seconds between the latest blocks (null when the older block could not be read). */
  avgBlockSeconds: number | null;
  targetBlockSeconds: number;
  /** Nodes the node answering can reach (ACTIVE or BUSY). NEM has no Peer / API roles, so every node is counted. */
  peers: number | null;
  activePeers: number | null;
  nodeName: string | null;
  nodeVersion: string | null;
  nodePlatform: string | null;
  nodeHealthy: boolean | null;
}

/** NIS1 aims for one block a minute. */
const NEM_TARGET_BLOCK_SECONDS = 60;
/** How many blocks back the average block time is measured over. */
const NEM_BLOCK_TIME_SAMPLE = 30;
/** /status code 6 = "NIS is synchronized" (5 booted, 7 no remote node available, 8 loading ...). */
const NEM_STATUS_SYNCHRONIZED = 6;

/** Chain height, block time, peers and node figures of the connected NIS1 node (every part is optional: a part that cannot be read is null). */
export async function fetchNemNetworkStats(): Promise<NemNetworkStats> {
  const [last, reachable, active, info, status] = await Promise.allSettled([
    nodeRequest<{ timeStamp: number; height: number }>('/chain/last-block'),
    nodeRequest<{ data?: unknown[] }>('/node/peer-list/reachable'),
    nodeRequest<{ data?: unknown[] }>('/node/peer-list/active'),
    nodeRequest<{ metaData?: { version?: string; platform?: string }; identity?: { name?: string } }>('/node/info'),
    nodeRequest<{ code?: number }>('/status'),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
  const l = ok(last);
  const i = ok(info);
  const st = ok(status);

  // The average block time: the time between the latest block and the one NEM_BLOCK_TIME_SAMPLE blocks earlier.
  let avgBlockSeconds: number | null = null;
  if (l !== null && l.height > NEM_BLOCK_TIME_SAMPLE) {
    try {
      const older = await nodeRequest<{ timeStamp: number }>('/block/at/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ height: l.height - NEM_BLOCK_TIME_SAMPLE }),
      });
      avgBlockSeconds = (l.timeStamp - older.timeStamp) / NEM_BLOCK_TIME_SAMPLE;
    } catch (e) {
      logWarn('nem-node', `block time could not be measured: ${(e as Error).message}`);
    }
  }

  const peerCount = (r: PromiseSettledResult<{ data?: unknown[] }>): number | null => {
    const v = ok(r);
    return v !== null && Array.isArray(v.data) ? v.data.length : null;
  };
  return {
    height: l?.height ?? null,
    latestBlockTimeMs: l !== null ? (l.timeStamp + NEM_EPOCH_SECONDS) * 1000 : null,
    avgBlockSeconds: avgBlockSeconds !== null && Number.isFinite(avgBlockSeconds) && avgBlockSeconds > 0 ? avgBlockSeconds : null,
    targetBlockSeconds: NEM_TARGET_BLOCK_SECONDS,
    peers: peerCount(reachable),
    activePeers: peerCount(active),
    nodeName: i?.identity?.name ?? null,
    nodeVersion: i?.metaData?.version ?? null,
    nodePlatform: i?.metaData?.platform ?? null,
    nodeHealthy: typeof st?.code === 'number' ? st.code === NEM_STATUS_SYNCHRONIZED : null,
  };
}

// --- explorer -------------------------------------------------------------------------------
// Mainnet: nemtool explorer. Testnet: NEMSCAN (its Mainnet/Testnet switch is a per-visitor cookie, so a
// deep link opens on whichever network the browser last chose; switch to Testnet at the top right).
export function nemExplorerTxUrl(hash: string): string {
  const { key, explorer } = getNemNetworkConfig();
  return key === 'testnet' ? `${explorer}/tx/${hash}` : `${explorer}/#/s_tx?hash=${hash}`;
}

export function nemExplorerAccountUrl(address: string): string {
  const { key, explorer } = getNemNetworkConfig();
  const a = normalizeNemAddress(address);
  return key === 'testnet' ? `${explorer}/account/${a}` : `${explorer}/#/s_account?account=${a}`;
}

// NEMSCAN's testnet has no namespace/mosaic archive, and its detail-page URLs are unverified: open the list pages.
export function nemExplorerNamespaceUrl(name: string): string {
  const { key, explorer } = getNemNetworkConfig();
  return key === 'testnet' ? `${explorer}/namespaces` : `${explorer}/#/s_namespace?namespace=${encodeURIComponent(name)}`;
}

export function nemExplorerMosaicUrl(id: string): string {
  const { key, explorer } = getNemNetworkConfig();
  return key === 'testnet' ? `${explorer}/mosaics` : `${explorer}/#/s_mosaic?mosaic=${encodeURIComponent(id)}`;
}
