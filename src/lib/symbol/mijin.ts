// mijin v2 (Catapult) connection. Unlike Symbol mainnet / testnet, a mijin chain is a private deployment:
// its generation hash, epoch and currency mosaic are not fixed, so they are read from a node the person
// enters (설정 > ノード) and kept in the app store (MijinParams, see network.ts).
import { MIJIN_NETWORK_BYTE, NETWORKS } from './constants';
import type { MijinParams } from './network';

export type MijinReadError =
  | 'invalid_url' // not an http(s) URL
  | 'unreachable' // no answer / not a Catapult REST gateway
  | 'unhealthy' // the node's API or database is down
  | 'not_mijin' // the node belongs to Symbol mainnet / testnet (or reports something unusable)
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

/**
 * Reads the parameters of the chain a node belongs to. Throws MijinReadFailure with the reason.
 * `explorer` is carried over from the previous setup (it is not something a node can tell).
 */
export async function readMijinNode(rawUrl: string, explorer = ''): Promise<MijinParams> {
  const url = normalizeNodeUrl(rawUrl);
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new MijinReadFailure('invalid_url');

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
  const publicBytes: number[] = [NETWORKS.mainnet.networkByte, NETWORKS.testnet.networkByte];
  if (!/^[0-9A-F]{64}$/.test(generationHash) || typeof networkByte !== 'number' || networkByte < 1 || networkByte > 255 || publicBytes.includes(networkByte)) {
    throw new MijinReadFailure('not_mijin');
  }
  // The same hash as Symbol mainnet / testnet would mean a mirror of the public chains, not mijin.
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

  return { networkByte, generationHash, epochAdjustment, currencyMosaicId, explorer: explorer.trim().replace(/\/+$/, '') };
}

/** Whether `byte` is a network byte mijin v2 uses by default (0x60 mijin / 0x90 mijin-test). */
export function isMijinByte(byte: number): boolean {
  return byte === MIJIN_NETWORK_BYTE || byte === 0x90;
}
