// Symbol REST gateway client: node discovery with failover plus the handful of endpoints a
// wallet needs (balances, mosaic metadata, history, fees, announce).
import { addressFromPublicKey, decodeAddress, addressBytesToString, bytesToHex, hexToBytes, isValidAddress, normalizeAddress } from './crypto';
import { namespaceIdPath, namespaceLabels } from './recipientInput';
import type { RecipientInput } from './recipientInput';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL, DEFAULT_MOSAIC_RENTAL_FEE, TX_TYPE_TRANSFER, XYM_NAMESPACE_ID } from './constants';
import type { NetworkConfig, SymbolNetwork } from './constants';
import { getCustomNode, getNetwork, getNetworkConfig, onNetworkSettingsChange } from './network';
import { formatAtomic } from './amount';
import {
  MOSAIC_CREATION_SIZE, encryptMessage, harvestDelegationSize, harvestLinkSize, namespaceRegistrationEmbeddedSize, namespaceRegistrationSize,
  newHarvestKeyPair, newMosaicNonce, signHarvestDelegation, signHarvestLinks, signMetadata, signMosaicCreation,
  signNamespaceRegistration, signTransfer, transferSize,
} from './tx';
import type { HarvestLink, MetadataChange, MetadataTarget, MosaicAmount, SignedTransaction } from './tx';
import { AGGREGATE_BASE_SIZE, METADATA_TYPE_CODE, decodeValueText, keyToHex, metadataAggregateSize, metadataEmbeddedSize } from './metadata';
import type { MetadataItem, MetadataTargetType } from './metadata';

const REQUEST_TIMEOUT_MS = 8000;

// --- node selection ---------------------------------------------------------------------
const activeNode: Partial<Record<SymbolNetwork, string>> = {};
const badNodes = new Set<string>();
onNetworkSettingsChange(() => {
  delete activeNode.mainnet;
  delete activeNode.testnet;
});

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.message === 'string') message = body.message;
      } catch { /* not JSON */ }
      const err = new Error(message) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** A node is usable when it is healthy and belongs to the network we expect. */
async function probeNode(url: string, cfg: NetworkConfig): Promise<boolean> {
  try {
    const [health, info] = await Promise.all([
      fetchJson<{ status?: { apiNode?: string; db?: string } }>(`${url}/node/health`, undefined, 5000),
      fetchJson<{ networkGenerationHashSeed?: string; networkIdentifier?: number }>(`${url}/node/info`, undefined, 5000),
    ]);
    const healthy = health.status?.apiNode === 'up' && health.status?.db === 'up';
    const sameNetwork = info.networkGenerationHashSeed?.toUpperCase() === cfg.generationHash && info.networkIdentifier === cfg.networkByte;
    return healthy && sameNetwork;
  } catch {
    return false;
  }
}

async function discoverCandidates(cfg: NetworkConfig): Promise<string[]> {
  const found: string[] = [];
  try {
    const nodes = await fetchJson<Array<{ apiStatus?: { restGatewayUrl?: string; isAvailable?: boolean } }>>(
      `${cfg.statisticsService}/nodes?filter=preferred&limit=12&ssl=true&order=random`,
      undefined,
      6000,
    );
    for (const n of nodes) {
      const url = n.apiStatus?.restGatewayUrl;
      if (url && n.apiStatus?.isAvailable !== false && url.startsWith('https://')) found.push(url.replace(/\/+$/, ''));
    }
  } catch {
    // directory unreachable: the built-in list below still works
  }
  return [...found, ...cfg.fallbackNodes];
}

// Returns the first candidate that answers the probe (all candidates are probed in parallel).
async function firstHealthy(candidates: string[], cfg: NetworkConfig): Promise<string | null> {
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

export async function resolveNode(forceRefresh = false): Promise<string> {
  const network = getNetwork();
  const cfg = getNetworkConfig(network);
  const custom = getCustomNode(network);
  if (custom) return custom; // the user is responsible for a hand-entered node
  if (!forceRefresh && activeNode[network]) return activeNode[network]!;
  let node = await firstHealthy(await discoverCandidates(cfg), cfg);
  if (!node) {
    badNodes.clear();
    node = await firstHealthy(cfg.fallbackNodes, cfg);
  }
  if (!node) throw new Error('no_node_available');
  activeNode[network] = node;
  return node;
}

/** Checks a hand-entered node URL (used by the settings screen before saving it). */
export async function checkNode(url: string, network: SymbolNetwork): Promise<boolean> {
  return probeNode(url.trim().replace(/\/+$/, ''), getNetworkConfig(network));
}

export async function nodeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const node = await resolveNode(attempt > 0);
    try {
      return await fetchJson<T>(`${node}${path}`, init);
    } catch (e) {
      lastError = e;
      const status = (e as { status?: number }).status;
      // A definite answer from the node (404 unknown account, 409/4xx rejection) is not a node failure.
      if (status !== undefined && status < 500) throw e;
      if (getCustomNode()) throw e;
      badNodes.add(node);
      delete activeNode[getNetwork()];
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request_failed');
}

// --- mosaic metadata --------------------------------------------------------------------
export interface MosaicInfo {
  id: string;
  divisibility: number;
  symbol: string; // XYM, or the namespace name (e.g. "company.token"), or the hex id
  name: string | null; // full namespace name when one is registered
  transferable: boolean;
}

const mosaicInfoCache: Record<string, MosaicInfo> = {};
const aliasCache: Record<string, string> = {};

function cacheKey(id: string): string {
  return `${getNetwork()}:${id}`;
}

function xymInfo(): MosaicInfo {
  const cfg = getNetworkConfig();
  return { id: cfg.currencyMosaicId, divisibility: CURRENCY_DIVISIBILITY, symbol: CURRENCY_SYMBOL, name: 'symbol.xym', transferable: true };
}

/** Namespace-alias ids (high bit set) used in transactions -> the real mosaic id. */
export async function resolveMosaicId(id: string): Promise<string> {
  const upper = id.toUpperCase();
  if (upper === XYM_NAMESPACE_ID) return getNetworkConfig().currencyMosaicId;
  const isAlias = (BigInt(`0x${upper}`) >> 63n) === 1n;
  if (!isAlias) return upper;
  const key = cacheKey(upper);
  if (aliasCache[key]) return aliasCache[key];
  try {
    const res = await nodeRequest<{ namespace?: { alias?: { type?: number; mosaicId?: string } } }>(`/namespaces/${upper}`);
    const alias = res.namespace?.alias;
    if (alias?.type === 1 && alias.mosaicId) {
      aliasCache[key] = alias.mosaicId.toUpperCase();
      return aliasCache[key];
    }
  } catch { /* unknown alias */ }
  return upper;
}

export async function getMosaicInfos(ids: string[]): Promise<Record<string, MosaicInfo>> {
  const cfg = getNetworkConfig();
  const result: Record<string, MosaicInfo> = {};
  const missing: string[] = [];
  for (const raw of new Set(ids.map((i) => i.toUpperCase()))) {
    if (raw === cfg.currencyMosaicId) {
      result[raw] = xymInfo();
    } else if (mosaicInfoCache[cacheKey(raw)]) {
      result[raw] = mosaicInfoCache[cacheKey(raw)];
    } else {
      missing.push(raw);
    }
  }
  if (missing.length === 0) return result;

  const infos: Record<string, { divisibility: number; transferable: boolean }> = {};
  const names: Record<string, string> = {};
  try {
    const mosaics = await nodeRequest<Array<{ mosaic: { id: string; divisibility: number; flags: number } }>>('/mosaics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mosaicIds: missing }),
    });
    for (const m of mosaics) infos[m.mosaic.id.toUpperCase()] = { divisibility: m.mosaic.divisibility, transferable: (m.mosaic.flags & 2) !== 0 };
  } catch (e) {
    console.warn('Failed to load mosaic info', e);
  }
  try {
    const res = await nodeRequest<{ mosaicNames: Array<{ mosaicId: string; names: string[] }> }>('/namespaces/mosaic/names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mosaicIds: missing }),
    });
    for (const entry of res.mosaicNames) if (entry.names.length > 0) names[entry.mosaicId.toUpperCase()] = entry.names[0];
  } catch (e) {
    console.warn('Failed to load mosaic names', e);
  }
  for (const id of missing) {
    const known = infos[id];
    const info: MosaicInfo = {
      id,
      divisibility: known?.divisibility ?? 0,
      symbol: names[id] ?? id,
      name: names[id] ?? null,
      transferable: known?.transferable ?? true,
    };
    // Only cache what the node actually answered, so a transient failure is retried next time.
    if (known) mosaicInfoCache[cacheKey(id)] = info;
    result[id] = info;
  }
  return result;
}

/** Info of a mosaic given by id (16 hex chars), or null when the chain has no such mosaic. Throws on a network failure. */
export async function fetchExistingMosaicInfo(id: string): Promise<MosaicInfo | null> {
  const upper = id.toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(upper)) return null;
  try {
    await nodeRequest(`/mosaics/${upper}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
  return (await getMosaicInfos([upper]))[upper] ?? null;
}

// --- balances ---------------------------------------------------------------------------
export interface MosaicBalance extends MosaicInfo {
  amount: bigint; // atomic units
  balance: string; // plain decimal string
}

export async function fetchBalances(address: string): Promise<MosaicBalance[]> {
  const cfg = getNetworkConfig();
  let owned: Array<{ id: string; amount: string }> = [];
  try {
    const res = await nodeRequest<{ account: { mosaics: Array<{ id: string; amount: string }> } }>(`/accounts/${normalizeAddress(address)}`);
    owned = res.account.mosaics ?? [];
  } catch (e) {
    // 404 = the address has never received anything: a legitimate zero balance.
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const infos = await getMosaicInfos([cfg.currencyMosaicId, ...owned.map((m) => m.id)]);
  const byId = new Map(owned.map((m) => [m.id.toUpperCase(), BigInt(m.amount)]));
  const ids = [cfg.currencyMosaicId, ...[...byId.keys()].filter((id) => id !== cfg.currencyMosaicId)];
  return ids.map((id) => {
    const info = infos[id] ?? { id, divisibility: 0, symbol: id, name: null, transferable: true };
    const amount = byId.get(id) ?? 0n;
    return { ...info, amount, balance: formatAtomic(amount, info.divisibility) };
  });
}

// --- recipient info ---------------------------------------------------------------------
export interface RecipientInfo {
  /** false = the node has never seen this address (nothing was ever sent to it or from it). */
  exists: boolean;
  /** The account's public key, or null while it has none on chain (it only appears after the first outgoing transaction). */
  publicKey: string | null;
  /** Everything the address holds (balance above zero), XYM first. */
  mosaics: MosaicBalance[];
  /** XYM balance as a plain decimal string. */
  xym: string;
  /** Full names of the namespaces the address owns and that have not expired. */
  namespaces: string[];
  /** The address's latest transfers (newest first), seen from the address's own side. */
  recent: SymbolTransfer[];
}

/** The public key an address has on chain (null while it has none), and whether the node knows the address at all. */
export async function fetchAccountPublicKey(address: string): Promise<{ exists: boolean; publicKey: string | null }> {
  const normalized = normalizeAddress(address);
  try {
    const res = await nodeRequest<{ account: { publicKey?: string; publicKeyHeight?: string } }>(`/accounts/${normalized}`);
    const key = (res.account.publicKey ?? '').toUpperCase();
    // An account that has only received funds has an all-zero key and publicKeyHeight "0".
    if (/^[0-9A-F]{64}$/.test(key) && !/^0+$/.test(key) && res.account.publicKeyHeight !== '0') return { exists: true, publicKey: key };
    return { exists: true, publicKey: null };
  } catch (e) {
    // 404 = unknown address: a valid address that has never been used.
    if ((e as { status?: number }).status !== 404) throw e;
    return { exists: false, publicKey: null };
  }
}

// --- recipient given as an alias or a public key ----------------------------------------
export type RecipientResolution =
  | { ok: true; address: string; via: 'alias' | 'publicKey'; label: string }
  | { ok: false; reason: 'not_found' | 'no_address_alias' | 'expired' | 'wrong_network' | 'invalid' };

interface RawNamespaceEntry {
  meta?: { active?: boolean };
  namespace: { ownerAddress?: string; endHeight: string; alias?: { type?: number; address?: string } };
}

async function fetchNamespaceEntry(id: string): Promise<RawNamespaceEntry | null> {
  try {
    return await nodeRequest<RawNamespaceEntry>(`/namespaces/${id}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** The address a namespace name is linked to right now, or why it cannot be used. Never returns a stale alias. */
async function resolveAddressAlias(name: string, networkByte: number): Promise<RecipientResolution> {
  const labels = namespaceLabels(name);
  if (!labels) return { ok: false, reason: 'invalid' };
  const ids = namespaceIdPath(labels);
  const [entry, root, chain] = await Promise.all([
    fetchNamespaceEntry(ids[ids.length - 1]),
    ids.length > 1 ? fetchNamespaceEntry(ids[0]) : Promise.resolve(null),
    nodeRequest<{ height: string }>('/chain/info'),
  ]);
  if (!entry) return { ok: false, reason: 'not_found' };
  const height = BigInt(chain.height);
  const live = (e: RawNamespaceEntry) => e.meta?.active !== false && (BigInt(e.namespace.endHeight) === ETERNAL_END_HEIGHT || height < BigInt(e.namespace.endHeight));
  // A child namespace is only good while its root is, and only for the root's current owner: after the
  // root lapses and someone else registers it again, the old child (and its alias) must not be trusted.
  if (!live(entry)) return { ok: false, reason: 'expired' };
  if (ids.length > 1) {
    if (!root || !live(root)) return { ok: false, reason: 'expired' };
    if ((root.namespace.ownerAddress ?? '').toUpperCase() !== (entry.namespace.ownerAddress ?? '').toUpperCase()) return { ok: false, reason: 'expired' };
  }
  const alias = entry.namespace.alias;
  if (alias?.type !== 2 || !alias.address) return { ok: false, reason: 'no_address_alias' }; // 2 = linked to an address
  const address = addressBytesToString(hexToBytes(alias.address));
  if (!isValidAddress(address, networkByte)) return { ok: false, reason: 'wrong_network' };
  return { ok: true, address, via: 'alias', label: name };
}

/**
 * Turns a typed recipient that is not an address - a namespace alias such as "nem.group" or a 64-hex
 * public key - into the address it stands for. The caller shows that address and sends to it directly.
 */
export async function resolveRecipientInput(input: RecipientInput, networkByte: number): Promise<RecipientResolution> {
  if (input.kind === 'publicKey') {
    return { ok: true, address: addressFromPublicKey(input.publicKey, networkByte), via: 'publicKey', label: input.publicKey };
  }
  if (input.kind === 'alias') return resolveAddressAlias(input.name, networkByte);
  return { ok: false, reason: 'invalid' };
}

/** What the chain knows about a recipient address; shown under the address field of the send form. */
export async function fetchRecipientInfo(address: string, recentCount = 5): Promise<RecipientInfo> {
  const normalized = normalizeAddress(address);
  const { exists, publicKey } = await fetchAccountPublicKey(normalized);
  if (!exists) return { exists, publicKey, mosaics: [], xym: '0', namespaces: [], recent: [] };

  const cfg = getNetworkConfig();
  const [balances, owned, recent] = await Promise.all([
    fetchBalances(normalized).catch(() => [] as MosaicBalance[]),
    fetchOwnedNamespaces(normalized).catch(() => [] as OwnedNamespace[]),
    fetchTransfers(normalized, recentCount, false).catch(() => [] as SymbolTransfer[]),
  ]);
  return {
    exists,
    publicKey,
    mosaics: balances.filter((b) => b.amount > 0n),
    xym: balances.find((b) => b.id.toUpperCase() === cfg.currencyMosaicId)?.balance ?? '0',
    namespaces: owned.filter((n) => !n.expired).map((n) => n.name),
    recent,
  };
}

// --- history ----------------------------------------------------------------------------
export interface SymbolTransfer {
  hash: string;
  timestampMs: number;
  isReception: boolean;
  isConfirmed: boolean;
  senderAddress: string;
  receiverAddress: string; // base32 address, or "@namespace" placeholder for alias recipients
  mosaics: Array<{ id: string; symbol: string; amount: string }>;
  message: string;
  encryptedMessage: boolean;
  fee: string; // XYM
}

interface RawTx {
  meta?: { hash?: string; aggregateHash?: string; timestamp?: string; feeMultiplier?: number };
  transaction: {
    type: number;
    network: number;
    signerPublicKey: string;
    recipientAddress?: string;
    mosaics?: Array<{ id: string; amount: string }>;
    message?: string;
    maxFee?: string;
    size?: number;
  };
}

async function toTransfer(raw: RawTx, myAddress: string, confirmed: boolean): Promise<SymbolTransfer | null> {
  const cfg = getNetworkConfig();
  const tx = raw.transaction;
  if (tx.type !== TX_TYPE_TRANSFER || !tx.recipientAddress) return null;
  const sender = addressFromPublicKey(tx.signerPublicKey, tx.network);
  const recipientBytes = hexToBytes(tx.recipientAddress);
  // Unresolved recipient: the first byte's low bit flags a namespace alias instead of an address.
  const aliasRecipient = (recipientBytes[0] & 1) === 1;
  const receiver = aliasRecipient ? `@${bytesToHex(recipientBytes.slice(1, 9))}` : addressBytesToString(recipientBytes);
  const me = normalizeAddress(myAddress);
  const isReception = receiver === me && sender !== me;

  const resolvedIds = await Promise.all((tx.mosaics ?? []).map((m) => resolveMosaicId(m.id)));
  const infos = await getMosaicInfos(resolvedIds);
  const mosaics = (tx.mosaics ?? []).map((m, i) => {
    const info = infos[resolvedIds[i]] ?? { id: resolvedIds[i], divisibility: 0, symbol: resolvedIds[i] };
    return { id: resolvedIds[i], symbol: info.symbol, amount: formatAtomic(BigInt(m.amount), info.divisibility) };
  });

  let message = '';
  let encryptedMessage = false;
  if (tx.message && tx.message.length >= 2) {
    const bytes = hexToBytes(tx.message);
    if (bytes[0] === 1) encryptedMessage = true;
    else message = new TextDecoder().decode(bytes.slice(1));
  }

  let feeAtomic: bigint | null = null;
  if (raw.meta?.feeMultiplier !== undefined && tx.size) feeAtomic = BigInt(tx.size) * BigInt(raw.meta.feeMultiplier);
  else if (tx.maxFee) feeAtomic = BigInt(tx.maxFee);

  const timestampMs = raw.meta?.timestamp !== undefined && confirmed
    ? Number(raw.meta.timestamp) + cfg.epochAdjustment * 1000
    : Date.now();

  return {
    hash: raw.meta?.hash ?? raw.meta?.aggregateHash ?? '',
    timestampMs,
    isReception,
    isConfirmed: confirmed,
    senderAddress: sender,
    receiverAddress: receiver,
    mosaics,
    message,
    encryptedMessage,
    fee: feeAtomic === null ? '' : formatAtomic(feeAtomic, CURRENCY_DIVISIBILITY),
  };
}

export async function fetchTransfers(address: string, count: number, includeUnconfirmed = true): Promise<SymbolTransfer[]> {
  const addr = normalizeAddress(address);
  const pageSize = Math.min(Math.max(count, 10), 100);
  const query = `address=${addr}&type=${TX_TYPE_TRANSFER}&order=desc&pageSize=${pageSize}`;
  const [confirmed, unconfirmed] = await Promise.all([
    nodeRequest<{ data: RawTx[] }>(`/transactions/confirmed?${query}&embedded=true`),
    includeUnconfirmed
      ? nodeRequest<{ data: RawTx[] }>(`/transactions/unconfirmed?${query}`).catch(() => ({ data: [] as RawTx[] }))
      : Promise.resolve({ data: [] as RawTx[] }),
  ]);
  const [c, u] = await Promise.all([
    Promise.all(confirmed.data.map((r) => toTransfer(r, addr, true))),
    Promise.all(unconfirmed.data.map((r) => toTransfer(r, addr, false))),
  ]);
  const list = [...u, ...c].filter((t): t is SymbolTransfer => t !== null);
  return list.slice(0, count);
}

/**
 * Transfers exchanged between the wallet and one counterparty (newest first): the ones the wallet
 * sent to it, the ones it sent to the wallet (when its public key is known) and, as a safety net,
 * whatever of the wallet's latest history involves it. Used by the send form to show whether the
 * typed address has been dealt with before.
 */
export async function fetchTransfersWith(
  myAddress: string,
  myPublicKey: string,
  counterparty: string,
  counterpartyPublicKey: string | null,
  limit = 20,
): Promise<SymbolTransfer[]> {
  const me = normalizeAddress(myAddress);
  const other = normalizeAddress(counterparty);
  const base = `type=${TX_TYPE_TRANSFER}&order=desc&pageSize=100&embedded=true`;
  const targeted = async (query: string): Promise<SymbolTransfer[]> => {
    try {
      const res = await nodeRequest<{ data: RawTx[] }>(`/transactions/confirmed?${query}&${base}`);
      const list = await Promise.all(res.data.map((r) => toTransfer(r, me, true)));
      return list.filter((t): t is SymbolTransfer => t !== null);
    } catch (e) {
      console.warn('Failed to load transfers with counterparty', e);
      return [];
    }
  };
  const [sent, received, recent] = await Promise.all([
    targeted(`signerPublicKey=${myPublicKey}&recipientAddress=${other}`),
    counterpartyPublicKey ? targeted(`signerPublicKey=${counterpartyPublicKey}&recipientAddress=${me}`) : Promise.resolve([] as SymbolTransfer[]),
    fetchTransfers(me, 100, true).catch(() => [] as SymbolTransfer[]),
  ]);
  const involves = (t: SymbolTransfer) => t.senderAddress === other || t.receiverAddress === other;
  const seen = new Set<string>();
  const out: SymbolTransfer[] = [];
  for (const t of [...sent, ...received, ...recent.filter(involves)]) {
    const key = t.hash || `${t.timestampMs}:${t.senderAddress}:${t.receiverAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, limit);
}

// --- sending ----------------------------------------------------------------------------
export interface FeeQuote {
  multiplier: number;
  size: number;
  fee: bigint; // atomic XYM
}

// Fee levels offered when sending: 'slow' pays the network minimum, 'standard' the median of
// recent blocks and 'fast' clearly more (so harvesters pick the transaction up sooner).
export type FeeSpeed = 'slow' | 'standard' | 'fast';
export const FEE_SPEEDS: FeeSpeed[] = ['slow', 'standard', 'fast'];

/** Fee multipliers for the three levels, from the node's recent-fee statistics (with a fallback). */
export async function feeMultipliers(): Promise<Record<FeeSpeed, number>> {
  let min = 100;
  let median = 100;
  let highest = 0;
  try {
    const f = await nodeRequest<{ medianFeeMultiplier?: number; minFeeMultiplier?: number; highestFeeMultiplier?: number }>('/network/fees/transaction');
    min = Math.max(f.minFeeMultiplier ?? 0, 1);
    median = Math.max(f.medianFeeMultiplier ?? 0, min);
    highest = f.highestFeeMultiplier ?? 0;
  } catch { /* defaults above */ }
  const standard = median;
  // At least double the standard, up to the busiest recent block (capped at 4x so one outlier
  // block cannot make the fast level absurdly expensive).
  const fast = Math.max(standard * 2, Math.min(highest, standard * 4));
  return { slow: min, standard, fast };
}

/** The fee of a transaction of `size` bytes at each of the three levels (one node request). */
export async function quoteFeesForSize(size: number): Promise<Record<FeeSpeed, FeeQuote>> {
  const multipliers = await feeMultipliers();
  const quote = (multiplier: number): FeeQuote => ({ multiplier, size, fee: BigInt(size) * BigInt(multiplier) });
  return { slow: quote(multipliers.slow), standard: quote(multipliers.standard), fast: quote(multipliers.fast) };
}

/** The fee of one transfer at each of the three levels (one node request). */
export async function quoteFees(mosaicCount: number, message: string | undefined, encrypted = false): Promise<Record<FeeSpeed, FeeQuote>> {
  return quoteFeesForSize(transferSize(mosaicCount, message, encrypted));
}

export async function quoteFee(mosaicCount: number, message: string | undefined, speed: FeeSpeed = 'standard', encrypted = false): Promise<FeeQuote> {
  return (await quoteFees(mosaicCount, message, encrypted))[speed];
}

export async function networkTimeMs(): Promise<number> {
  const cfg = getNetworkConfig();
  try {
    const res = await nodeRequest<{ communicationTimestamps: { receiveTimestamp: string } }>('/node/time');
    return Number(res.communicationTimestamps.receiveTimestamp);
  } catch {
    return Date.now() - cfg.epochAdjustment * 1000;
  }
}

export class SymbolSendError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Announces a signed transaction and waits briefly for the node's verdict (throws SymbolSendError). */
export async function announceSigned(signed: SignedTransaction): Promise<void> {
  try {
    await nodeRequest('/transactions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: signed.payload }),
    });
  } catch (e) {
    throw new SymbolSendError('announce_failed', (e as Error).message);
  }
  // Announcing only means the node accepted the packet; validation failures (insufficient
  // balance, non-transferable mosaic, ...) show up afterwards in the transaction status.
  const deadlineAt = Date.now() + 12000;
  while (Date.now() < deadlineAt) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const status = await nodeRequest<{ group: string; code: string }>(`/transactionStatus/${signed.hash}`);
      if (status.group === 'failed') throw new SymbolSendError(status.code);
      if (status.group === 'unconfirmed' || status.group === 'confirmed' || status.group === 'partial') break;
    } catch (e) {
      if (e instanceof SymbolSendError) throw e;
      // 404 = not seen yet; keep polling
    }
  }
}

export interface SendTransferInput {
  privateKey: string;
  publicKey: string;
  recipient: string;
  mosaics: MosaicAmount[];
  message?: string;
  /** Encrypt the message for the recipient (needs the recipient's public key to be on chain). */
  encrypt?: boolean;
  feeSpeed?: FeeSpeed;
}

export async function sendTransfer(input: SendTransferInput): Promise<{ hash: string }> {
  const cfg = getNetworkConfig();
  if (!decodeAddress(input.recipient)) throw new SymbolSendError('invalid_recipient');
  let encryptedMessage: Uint8Array | undefined;
  if (input.encrypt && input.message) {
    const { publicKey } = await fetchAccountPublicKey(input.recipient);
    if (!publicKey) throw new SymbolSendError('recipient_public_key_missing');
    encryptedMessage = encryptMessage(input.privateKey, publicKey, input.message);
  }
  const quote = await quoteFee(input.mosaics.length, input.message, input.feeSpeed ?? 'standard', encryptedMessage !== undefined);
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const signed = signTransfer(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    recipient: input.recipient,
    mosaics: input.mosaics,
    message: input.message,
    encryptedMessage,
    maxFee: quote.fee,
    deadline,
  });
  await announceSigned(signed);
  return { hash: signed.hash };
}

// --- mosaic creation ----------------------------------------------------------------------
export interface OwnedMosaic {
  id: string;
  symbol: string; // namespace name when one is linked, else the hex id
  supply: bigint; // atomic units
  supplyText: string; // plain decimal string
  divisibility: number;
  flags: number;
  duration: bigint; // blocks; 0n = never expires
}

/** Mosaics created by this address, newest first. */
export async function fetchOwnedMosaics(address: string): Promise<OwnedMosaic[]> {
  const res = await nodeRequest<{
    data: Array<{ mosaic: { id: string; supply: string; flags: number; divisibility: number; duration: string } }>;
  }>(`/mosaics?ownerAddress=${normalizeAddress(address)}&order=desc&pageSize=100`);
  const ids = res.data.map((d) => d.mosaic.id.toUpperCase());
  const infos = ids.length > 0 ? await getMosaicInfos(ids) : {};
  return res.data.map(({ mosaic }) => {
    const id = mosaic.id.toUpperCase();
    const supply = BigInt(mosaic.supply);
    return {
      id,
      symbol: infos[id]?.symbol ?? id,
      supply,
      supplyText: formatAtomic(supply, mosaic.divisibility),
      divisibility: mosaic.divisibility,
      flags: mosaic.flags,
      duration: BigInt(mosaic.duration),
    };
  });
}

/** What creating a mosaic costs on top of the transaction fee (atomic XYM; paid once, not refunded). */
export async function fetchMosaicRentalFee(): Promise<bigint> {
  try {
    const res = await nodeRequest<{ effectiveMosaicRentalFee?: string }>('/network/fees/rental');
    if (res.effectiveMosaicRentalFee) return BigInt(res.effectiveMosaicRentalFee);
  } catch { /* fall back to the network default below */ }
  return DEFAULT_MOSAIC_RENTAL_FEE;
}

/** Transaction fee (atomic XYM) of the mosaic-creation aggregate at the standard level. */
export async function quoteMosaicCreationFee(metadataValueLengths: number[] = []): Promise<FeeQuote> {
  const metadataSize = metadataValueLengths.reduce((sum, len) => sum + metadataEmbeddedSize('mosaic', len), 0);
  return (await quoteFeesForSize(MOSAIC_CREATION_SIZE + metadataSize)).standard;
}

export interface CreateMosaicInput {
  privateKey: string;
  publicKey: string;
  address: string; // the owner's address on the current network
  supply: bigint; // initial supply, atomic units
  divisibility: number;
  flags: number;
  durationBlocks: bigint; // 0n = never expires
  metadata?: MetadataItem[]; // optional entries set on the new mosaic in the same transaction
}

export async function createMosaic(input: CreateMosaicInput): Promise<{ hash: string; mosaicId: string }> {
  const cfg = getNetworkConfig();
  const multipliers = await feeMultipliers();
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const signed = signMosaicCreation(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    ownerAddress: input.address,
    networkByte: cfg.networkByte,
    nonce: newMosaicNonce(),
    divisibility: input.divisibility,
    flags: input.flags,
    duration: input.durationBlocks,
    supply: input.supply,
    feeMultiplier: multipliers.standard,
    deadline,
    metadata: input.metadata,
  });
  await announceSigned(signed);
  return { hash: signed.hash, mosaicId: signed.mosaicId };
}

// --- namespaces ---------------------------------------------------------------------------
export interface OwnedNamespace {
  id: string; // id of this level (16 hex chars)
  name: string; // full name, e.g. "company.team"
  depth: number; // 1 = root
  eternal: boolean; // never expires (only the network's own root namespaces)
  expired: boolean;
  expiresAtMs: number | null; // estimated; null when eternal
}

const BLOCK_TIME_MS = 30_000;
const ETERNAL_END_HEIGHT = 18446744073709551615n;

/** Namespaces owned by this address, sorted by full name. */
export async function fetchOwnedNamespaces(address: string): Promise<OwnedNamespace[]> {
  const addr = normalizeAddress(address);
  const [list, chain] = await Promise.all([
    nodeRequest<{
      data: Array<{
        namespace: { depth: number; level0: string; level1?: string; level2?: string; endHeight: string };
      }>;
    }>(`/namespaces?ownerAddress=${addr}&order=desc&pageSize=100`),
    nodeRequest<{ height: string }>('/chain/info'),
  ]);
  const height = BigInt(chain.height);
  const levelIds = (ns: { depth: number; level0: string; level1?: string; level2?: string }) =>
    [ns.level0, ns.level1, ns.level2].slice(0, ns.depth).map((id) => (id ?? '').toUpperCase());
  const allIds = [...new Set(list.data.flatMap((d) => levelIds(d.namespace)))].filter(Boolean);
  const names: Record<string, string> = {};
  if (allIds.length > 0) {
    const res = await nodeRequest<Array<{ id: string; name: string }>>('/namespaces/names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespaceIds: allIds }),
    });
    for (const n of res) names[n.id.toUpperCase()] = n.name;
  }
  return list.data
    .map(({ namespace: ns }): OwnedNamespace => {
      const ids = levelIds(ns);
      const end = BigInt(ns.endHeight);
      const eternal = end === ETERNAL_END_HEIGHT;
      return {
        id: ids[ids.length - 1],
        name: ids.map((id) => names[id] ?? id).join('.'),
        depth: ns.depth,
        eternal,
        expired: !eternal && height >= end,
        expiresAtMs: eternal ? null : Date.now() + Number(end - height) * BLOCK_TIME_MS,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface NamespaceRentalFees {
  childFee: bigint; // one-off, atomic XYM
  rootFeePerBlock: bigint; // atomic XYM per block
}

/** Namespace rental prices from the node; null when it cannot be reached. */
export async function fetchNamespaceRentalFees(): Promise<NamespaceRentalFees | null> {
  try {
    const res = await nodeRequest<{ effectiveChildNamespaceRentalFee?: string; effectiveRootNamespaceRentalFeePerBlock?: string }>('/network/fees/rental');
    if (res.effectiveChildNamespaceRentalFee === undefined || res.effectiveRootNamespaceRentalFeePerBlock === undefined) return null;
    return { childFee: BigInt(res.effectiveChildNamespaceRentalFee), rootFeePerBlock: BigInt(res.effectiveRootNamespaceRentalFeePerBlock) };
  } catch {
    return null;
  }
}

/** Transaction fee (atomic XYM) of registering a namespace called `name`, at the standard level. */
export async function quoteNamespaceRegistrationFee(name: string, metadataValueLengths: number[] = []): Promise<FeeQuote> {
  if (metadataValueLengths.length === 0) return (await quoteFeesForSize(namespaceRegistrationSize(name))).standard;
  // With metadata the registration travels inside an aggregate together with the entries.
  const size = AGGREGATE_BASE_SIZE + namespaceRegistrationEmbeddedSize(name)
    + metadataValueLengths.reduce((sum, len) => sum + metadataEmbeddedSize('namespace', len), 0);
  return (await quoteFeesForSize(size)).standard;
}

export interface RegisterNamespaceInput {
  privateKey: string;
  publicKey: string;
  address?: string; // the owner's address; required when `metadata` is given
  name: string; // this level's name only
  parentId?: string; // set for a child namespace
  durationBlocks?: bigint; // root namespaces only
  metadata?: MetadataItem[]; // optional entries set on the new namespace in the same transaction
}

export async function registerNamespace(input: RegisterNamespaceInput): Promise<{ hash: string; namespaceId: string }> {
  const cfg = getNetworkConfig();
  const multipliers = await feeMultipliers();
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const signed = signNamespaceRegistration(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    ownerAddress: input.address,
    networkByte: cfg.networkByte,
    name: input.name,
    parentId: input.parentId,
    duration: input.durationBlocks,
    feeMultiplier: multipliers.standard,
    deadline,
    metadata: input.metadata,
  });
  await announceSigned(signed);
  return { hash: signed.hash, namespaceId: signed.namespaceId };
}

// --- metadata -----------------------------------------------------------------------------
export interface MetadataEntry {
  key: string; // scoped metadata key, 16 hex chars
  value: Uint8Array;
  valueText: string | null; // the value as text when it is printable UTF-8
  valueHex: string;
}

/** Where metadata is attached: the account itself, one of its mosaics or one of its namespaces. */
export interface MetadataTargetRef {
  type: MetadataTargetType;
  address: string; // the owner's address (also the source of the entries we read and write)
  targetId?: string; // mosaic id / namespace id (16 hex chars); not used for the account
}

function metadataQuery(ref: MetadataTargetRef, extra = ''): string {
  const addr = normalizeAddress(ref.address);
  const id = ref.type === 'account' || !ref.targetId ? '' : `&targetId=${ref.targetId.toUpperCase()}`;
  return `/metadata?sourceAddress=${addr}&targetAddress=${addr}&metadataType=${METADATA_TYPE_CODE[ref.type]}${id}${extra}`;
}

function toMetadataEntry(raw: { scopedMetadataKey: string; value: string }): MetadataEntry {
  const value = hexToBytes(raw.value);
  return { key: raw.scopedMetadataKey.toUpperCase(), value, valueText: decodeValueText(value), valueHex: bytesToHex(value) };
}

type RawMetadataPage = { data: Array<{ metadataEntry: { scopedMetadataKey: string; value: string } }> };

/** Entries the owner has set on this target (only the owner's own entries; others' are not shown). */
export async function fetchMetadataEntries(ref: MetadataTargetRef): Promise<MetadataEntry[]> {
  const res = await nodeRequest<RawMetadataPage>(`${metadataQuery(ref, '&order=asc&pageSize=100')}`);
  return res.data.map((d) => toMetadataEntry(d.metadataEntry));
}

/** The current value stored under `key` (empty when the key has not been set yet). */
async function fetchMetadataValue(ref: MetadataTargetRef, key: bigint): Promise<Uint8Array> {
  const res = await nodeRequest<RawMetadataPage>(metadataQuery(ref, `&scopedMetadataKey=${keyToHex(key)}`));
  const entry = res.data[0]?.metadataEntry;
  return entry ? hexToBytes(entry.value) : new Uint8Array(0);
}

/** Transaction fee (atomic XYM) of setting the given values on one target, at the standard level. */
export async function quoteMetadataFee(type: MetadataTargetType, valueLengths: number[]): Promise<FeeQuote> {
  return (await quoteFeesForSize(metadataAggregateSize(type, valueLengths))).standard;
}

export interface SetMetadataInput {
  privateKey: string;
  publicKey: string;
  address: string; // the owner's address
  target: MetadataTarget;
  items: MetadataItem[];
}

/** Sets (or overwrites) metadata on the owner's own account, mosaic or namespace. */
export async function setMetadata(input: SetMetadataInput): Promise<{ hash: string }> {
  const cfg = getNetworkConfig();
  const ref: MetadataTargetRef = {
    type: input.target.type,
    address: input.address,
    targetId: input.target.type === 'mosaic' ? input.target.mosaicId : input.target.type === 'namespace' ? input.target.namespaceId : undefined,
  };
  // Overwriting an existing key needs its current value (the transaction carries old XOR new).
  const changes: MetadataChange[] = await Promise.all(input.items.map(async (item) => ({
    target: input.target,
    key: item.key,
    oldValue: await fetchMetadataValue(ref, item.key),
    newValue: item.value,
  })));
  const multipliers = await feeMultipliers();
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const signed = signMetadata(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    ownerAddress: input.address,
    networkByte: cfg.networkByte,
    changes,
    feeMultiplier: multipliers.standard,
    deadline,
  });
  await announceSigned(signed);
  return { hash: signed.hash };
}

// --- harvesting ---------------------------------------------------------------------------
export interface HarvestStatus {
  remotePublicKey: string | null; // linked remote account
  vrfPublicKey: string | null;
  nodePublicKey: string | null; // linked node
  /** All three links exist, i.e. the account is set up for delegated harvesting. */
  linked: boolean;
  /** Some links exist but not all (e.g. a half-finished setup); they can still be removed. */
  partial: boolean;
  xymBalance: bigint;
  minBalance: bigint; // atomic XYM needed to harvest
  importance: bigint; // raw importance, 0n = none yet
}

const DEFAULT_MIN_HARVESTER_BALANCE = 10_000_000_000n; // 10,000 XYM

// The node reports big numbers with ' separators ("10'000'000000").
function parseNetworkNumber(value: string | undefined): bigint | null {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, '');
  return digits === '' ? null : BigInt(digits);
}

/** XYM an account must hold to harvest (from /network/properties; 10,000 XYM when unavailable). */
export async function fetchMinHarvesterBalance(): Promise<bigint> {
  try {
    const res = await nodeRequest<{ chain?: { minHarvesterBalance?: string } }>('/network/properties');
    return parseNetworkNumber(res.chain?.minHarvesterBalance) ?? DEFAULT_MIN_HARVESTER_BALANCE;
  } catch {
    return DEFAULT_MIN_HARVESTER_BALANCE;
  }
}

/** Links, balance and importance of an account. An unknown account (never received anything) reads as empty. */
export async function fetchHarvestStatus(address: string): Promise<HarvestStatus> {
  const cfg = getNetworkConfig();
  const minBalance = await fetchMinHarvesterBalance();
  interface AccountInfo {
    importance?: string;
    supplementalPublicKeys?: { linked?: { publicKey?: string }; node?: { publicKey?: string }; vrf?: { publicKey?: string } };
    mosaics?: Array<{ id: string; amount: string }>;
  }
  let account = null as AccountInfo | null;
  try {
    const res = await nodeRequest<{ account: AccountInfo }>(`/accounts/${normalizeAddress(address)}`);
    account = res.account;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const keys = account?.supplementalPublicKeys;
  const remotePublicKey = keys?.linked?.publicKey?.toUpperCase() ?? null;
  const vrfPublicKey = keys?.vrf?.publicKey?.toUpperCase() ?? null;
  const nodePublicKey = keys?.node?.publicKey?.toUpperCase() ?? null;
  const count = [remotePublicKey, vrfPublicKey, nodePublicKey].filter((k) => k !== null).length;
  const xym = account?.mosaics?.find((m) => m.id.toUpperCase() === cfg.currencyMosaicId);
  return {
    remotePublicKey,
    vrfPublicKey,
    nodePublicKey,
    linked: count === 3,
    partial: count > 0 && count < 3,
    xymBalance: xym ? BigInt(xym.amount) : 0n,
    minBalance,
    importance: account?.importance ? BigInt(account.importance) : 0n,
  };
}

export interface HarvestNode {
  publicKey: string; // the node's public key (what the link and the delegation request use)
  name: string;
  host: string;
}

/** The node the wallet is currently connected to (its public key, for a one-tap choice). */
export async function fetchConnectedHarvestNode(): Promise<HarvestNode | null> {
  try {
    const url = await resolveNode();
    const info = await nodeRequest<{ nodePublicKey?: string; friendlyName?: string; host?: string }>('/node/info');
    if (!info.nodePublicKey) return null;
    return {
      publicKey: info.nodePublicKey.toUpperCase(),
      name: info.friendlyName || info.host || url,
      host: info.host || url.replace(/^https?:\/\//, ''),
    };
  } catch {
    return null;
  }
}

/** Public nodes from the statistics service that are peers (candidates for delegated harvesting). */
export async function fetchHarvestNodeCandidates(): Promise<HarvestNode[]> {
  const cfg = getNetworkConfig();
  try {
    const nodes = await fetchJson<Array<{
      roles?: number;
      friendlyName?: string;
      host?: string;
      nodePublicKey?: string;
      apiStatus?: { nodePublicKey?: string; isAvailable?: boolean };
    }>>(`${cfg.statisticsService}/nodes?filter=preferred&limit=60`, undefined, 8000);
    const seen = new Set<string>();
    const out: HarvestNode[] = [];
    for (const n of nodes) {
      const publicKey = (n.apiStatus?.nodePublicKey ?? n.nodePublicKey ?? '').toUpperCase();
      // roles is a bit field: 1 = peer, 2 = api. Only peers harvest.
      if (!/^[0-9A-F]{64}$/.test(publicKey) || ((n.roles ?? 1) & 1) === 0 || seen.has(publicKey)) continue;
      seen.add(publicKey);
      out.push({ publicKey, name: n.friendlyName || n.host || publicKey.slice(0, 8), host: n.host ?? '' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Transaction fees (atomic XYM, standard level) of the link aggregate and of the delegation request. */
export async function quoteHarvestFees(linkCount: number, withDelegation: boolean): Promise<{ links: FeeQuote; delegation: FeeQuote | null }> {
  const multipliers = await feeMultipliers();
  const quote = (size: number): FeeQuote => ({ multiplier: multipliers.standard, size, fee: BigInt(size) * BigInt(multipliers.standard) });
  return { links: quote(harvestLinkSize(linkCount)), delegation: withDelegation ? quote(harvestDelegationSize()) : null };
}

export interface StartHarvestingInput {
  privateKey: string;
  publicKey: string;
  nodePublicKey: string;
}

/**
 * Turns delegated harvesting on: links a new remote account, a new VRF account and the node, then
 * sends the node the encrypted request to harvest for us. The throw-away keys are not kept - the
 * node holds them, and later unlinking only needs the public keys that are on the chain.
 */
export async function startHarvesting(input: StartHarvestingInput): Promise<{ linkHash: string; delegationHash: string }> {
  const cfg = getNetworkConfig();
  const multipliers = await feeMultipliers();
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const remote = newHarvestKeyPair();
  const vrf = newHarvestKeyPair();
  const links = signHarvestLinks(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    links: [
      { kind: 'remote', publicKey: remote.publicKey, link: true },
      { kind: 'vrf', publicKey: vrf.publicKey, link: true },
      { kind: 'node', publicKey: input.nodePublicKey, link: true },
    ],
    feeMultiplier: multipliers.standard,
    deadline,
  });
  const delegation = signHarvestDelegation(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    nodePublicKey: input.nodePublicKey,
    remotePrivateKey: remote.privateKey,
    vrfPrivateKey: vrf.privateKey,
    feeMultiplier: multipliers.standard,
    deadline,
  });
  // The links go first: if the network refuses them (not enough XYM, already linked) the node
  // never receives the keys.
  await announceSigned(links);
  await announceSigned(delegation);
  return { linkHash: links.hash, delegationHash: delegation.hash };
}

export interface StopHarvestingInput {
  privateKey: string;
  publicKey: string;
  status: HarvestStatus; // the links to remove (read from the chain)
}

/** Turns harvesting off by unlinking every key that is currently linked. */
export async function stopHarvesting(input: StopHarvestingInput): Promise<{ hash: string }> {
  const cfg = getNetworkConfig();
  const links: HarvestLink[] = [];
  if (input.status.remotePublicKey) links.push({ kind: 'remote', publicKey: input.status.remotePublicKey, link: false });
  if (input.status.vrfPublicKey) links.push({ kind: 'vrf', publicKey: input.status.vrfPublicKey, link: false });
  if (input.status.nodePublicKey) links.push({ kind: 'node', publicKey: input.status.nodePublicKey, link: false });
  if (links.length === 0) throw new SymbolSendError('nothing_linked');
  const multipliers = await feeMultipliers();
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const signed = signHarvestLinks(input.privateKey, cfg.generationHash, {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    links,
    feeMultiplier: multipliers.standard,
    deadline,
  });
  await announceSigned(signed);
  return { hash: signed.hash };
}

// --- harvest rewards ----------------------------------------------------------------------
export interface HarvestReward {
  height: string;
  timestampMs: number | null; // null when the node did not report the block time
  amount: string; // XYM, plain decimal
  atomic: bigint;
}

const RECEIPT_TYPE_HARVEST_FEE = 8515; // 0x2143

/** Latest harvest rewards paid to this address (from the block statements), newest first. */
export async function fetchHarvestRewards(address: string, count: number): Promise<HarvestReward[]> {
  const cfg = getNetworkConfig();
  const addr = normalizeAddress(address);
  const res = await nodeRequest<{
    data: Array<{
      meta?: { timestamp?: string };
      statement: { height: string; receipts: Array<{ type: number; targetAddress?: string; mosaicId?: string; amount: string }> };
    }>;
  }>(`/statements/transaction?targetAddress=${addr}&receiptType=${RECEIPT_TYPE_HARVEST_FEE}&order=desc&pageSize=${Math.min(Math.max(count, 10), 100)}`);
  const rewards: HarvestReward[] = [];
  for (const entry of res.data) {
    let atomic = 0n;
    for (const r of entry.statement.receipts) {
      if (r.type !== RECEIPT_TYPE_HARVEST_FEE) continue;
      if (r.targetAddress && addressBytesToString(hexToBytes(r.targetAddress)) !== addr) continue;
      atomic += BigInt(r.amount);
    }
    if (atomic === 0n) continue;
    rewards.push({
      height: entry.statement.height,
      timestampMs: entry.meta?.timestamp !== undefined ? Number(entry.meta.timestamp) + cfg.epochAdjustment * 1000 : null,
      amount: formatAtomic(atomic, CURRENCY_DIVISIBILITY),
      atomic,
    });
  }
  return rewards.slice(0, count);
}

export function explorerNamespaceUrl(name: string): string {
  return `${getNetworkConfig().explorer}/namespaces/${name}`;
}

export function explorerTxUrl(hash: string): string {
  return `${getNetworkConfig().explorer}/transactions/${hash}`;
}

export function explorerAccountUrl(address: string): string {
  return `${getNetworkConfig().explorer}/accounts/${normalizeAddress(address)}`;
}

export function explorerMosaicUrl(id: string): string {
  return `${getNetworkConfig().explorer}/mosaics/${id}`;
}
