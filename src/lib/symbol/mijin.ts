// mijin v2 (Catapult) connection. Unlike Symbol mainnet / testnet, a mijin chain is a private deployment:
// its generation hash, epoch and currency mosaic are not fixed, so they are read from a node the person
// enters (設定 > ノード) and kept in the app store (MijinParams, see network.ts).
// mijin is not a choice in the network picker: the app moves to it when the connected node turns out to be a
// mijin v2 node (detectNodeNetwork), and back to Symbol mainnet / testnet when a Symbol node is connected.
import { NETWORKS } from './constants';
import type { MijinParams } from './network';
import { isAllowedNodeUrl } from '../nodePolicy';

export type MijinReadError =
  | 'invalid_url' // not an http(s) URL
  | 'insecure_url' // plain http:// to a machine outside this computer / local network (see lib/nodePolicy.ts)
  | 'unreachable' // no answer / not a Catapult REST gateway
  | 'unhealthy' // the node's API or database is down
  | 'not_mijin' // the node is neither Symbol mainnet / testnet nor a usable mijin v2 chain (reports something unusable)
  | 'properties_unreadable'; // /network/properties is not served, so the epoch / currency cannot be read

export class MijinReadFailure extends Error {
  readonly code: MijinReadError;
  constructor(code: MijinReadError) {
    super(code);
    this.code = code;
  }
}

const TIMEOUT_MS = 8000;

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** "0x6BED'913F'A202'23F8" -> "6BED913FA20223F8" (the form /network/properties reports ids in). */
export function cleanPropertyHex(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^0x/i, '').replace(/'/g, '').toUpperCase() : '';
}

/** "1573430400s" -> 1573430400 (seconds since the Unix epoch of the nemesis block). */
export function parseEpochAdjustment(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)s$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

export function normalizeNodeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** What a node turned out to be: Symbol mainnet / testnet, or a mijin v2 chain (with the parameters read from it). */
export type DetectedNode = { network: 'mainnet' | 'testnet' } | { network: 'mijin'; params: MijinParams };

/**
 * Finds out which network a node belongs to. The network picker has no mijin entry: connecting a node of a mijin v2
 * chain is what moves the app to mijin (and connecting a Symbol mainnet / testnet node moves it back).
 * Throws MijinReadFailure with the reason. `explorer` is carried over from the previous setup (a node cannot tell it).
 */
export async function detectNodeNetwork(rawUrl: string, explorer = ''): Promise<DetectedNode> {
  const url = normalizeNodeUrl(rawUrl);
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new MijinReadFailure('invalid_url');
  if (!isAllowedNodeUrl(url)) throw new MijinReadFailure('insecure_url');

  let info: { networkGenerationHashSeed?: string; networkIdentifier?: number };
  let health: { status?: { apiNode?: string; db?: string } };
  try {
    [info, health] = await Promise.all([
      getJson<{ networkGenerationHashSeed?: string; networkIdentifier?: number }>(`${url}/node/info`),
      getJson<{ status?: { apiNode?: string; db?: string } }>(`${url}/node/health`),
    ]);
  } catch {
    throw new MijinReadFailure('unreachable');
  }
  if (health.status?.apiNode !== 'up' || health.status?.db !== 'up') throw new MijinReadFailure('unhealthy');

  const generationHash = (info.networkGenerationHashSeed ?? '').toUpperCase();
  const networkByte = info.networkIdentifier;
  // Symbol mainnet / testnet are known by both their generation hash and network byte.
  for (const key of ['mainnet', 'testnet'] as const) {
    if (generationHash === NETWORKS[key].generationHash && networkByte === NETWORKS[key].networkByte) return { network: key };
  }

  const publicBytes: number[] = [NETWORKS.mainnet.networkByte, NETWORKS.testnet.networkByte];
  if (!/^[0-9A-F]{64}$/.test(generationHash) || typeof networkByte !== 'number' || networkByte < 1 || networkByte > 255 || publicBytes.includes(networkByte)) {
    throw new MijinReadFailure('not_mijin');
  }
  // The same hash as Symbol mainnet / testnet under another network byte is not a chain this wallet knows.
  if (generationHash === NETWORKS.mainnet.generationHash || generationHash === NETWORKS.testnet.generationHash) throw new MijinReadFailure('not_mijin');

  let props: { network?: { epochAdjustment?: string }; chain?: { currencyMosaicId?: string } };
  try {
    props = await getJson(`${url}/network/properties`);
  } catch {
    throw new MijinReadFailure('properties_unreadable');
  }
  const epochAdjustment = parseEpochAdjustment(props.network?.epochAdjustment);
  const currencyMosaicId = cleanPropertyHex(props.chain?.currencyMosaicId);
  if (epochAdjustment === null || !/^[0-9A-F]{16}$/.test(currencyMosaicId)) throw new MijinReadFailure('properties_unreadable');

  return { network: 'mijin', params: { networkByte, generationHash, epochAdjustment, currencyMosaicId, explorer: explorer.trim().replace(/\/+$/, '') } };
}

/** Reads the parameters of a mijin v2 chain from one of its nodes; a Symbol mainnet / testnet node is refused ('not_mijin'). */
export async function readMijinNode(rawUrl: string, explorer = ''): Promise<MijinParams> {
  const detected = await detectNodeNetwork(rawUrl, explorer);
  if (detected.network !== 'mijin') throw new MijinReadFailure('not_mijin');
  return detected.params;
}
