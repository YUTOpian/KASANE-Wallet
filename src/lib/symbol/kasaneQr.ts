// QR codes for passing transactions between people and devices: a signed transaction, a request to
// cosign, a finished cosignature, and a multisig transfer template.
//
// These four are KASANE's own formats (the Symbol QR v3 types 0-3 stay exactly as lib/symbol/qr.ts reads
// them). They share one JSON envelope so a scanner can tell them apart and refuse another network:
//   { "kasane": 1, "kind": "...", "network_id": 104, "chain_id": "<generation hash>", "data": { ... } }
// What `data` holds is the standard Symbol material (serialized transaction hex, aggregate hash,
// cosignature fields), so it can be taken out and used by other tools.
//
// This file does no cryptography and imports no SDK: it only builds and validates the JSON.
import { getNetworkConfig } from './network';

export const KASANE_QR_VERSION = 1;

/** A QR / text longer than this is shown as text only (a low error-correction QR still scans at this size). */
export const KASANE_QR_MAX_LENGTH = 2000;

/** A transaction that is already signed, ready to be announced by whoever scans it. */
export interface SignedQr { kind: 'signed'; payload: string; hash: string }

/** A bonded aggregate waiting for cosignatures. `payload` is optional: without it the scanner looks the hash up on its node. */
export interface CosignRequestQr { kind: 'cosign_request'; hash: string; payload?: string }

/** One cosigner's signature over an aggregate's hash. */
export interface CosignatureQr { kind: 'cosignature'; parentHash: string; signerPublicKey: string; signature: string; version: string }

/** A transfer in the name of a multisig account (amounts are atomic units, as decimal strings) for a cosigner to start. */
export interface TemplateQr {
  kind: 'template';
  account: string; // the multisig account the transfer is made from (base32)
  recipient: string; // base32
  mosaics: Array<{ id: string; amount: string }>;
  message?: string;
}

export type KasaneQr = SignedQr | CosignRequestQr | CosignatureQr | TemplateQr;
export interface ParsedKasaneQr {
  qr: KasaneQr;
  networkId: number | null;
  chainId: string | null;
}

const HASH = /^[0-9a-fA-F]{64}$/;
const SIGNATURE = /^[0-9a-fA-F]{128}$/;
const ADDRESS = /^[A-Z2-7]{39}$/;
const MOSAIC_ID = /^[0-9a-fA-F]{16}$/;
const isEvenHex = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
const isHash = (s: unknown): s is string => typeof s === 'string' && HASH.test(s);
const normAddress = (s: string) => s.replace(/[-\s]/g, '').toUpperCase();

export function buildKasaneQr(qr: KasaneQr): string {
  const cfg = getNetworkConfig();
  let data: Record<string, unknown>;
  switch (qr.kind) {
    case 'signed':
      data = { payload: qr.payload.toUpperCase(), hash: qr.hash.toUpperCase() };
      break;
    case 'cosign_request':
      data = { hash: qr.hash.toUpperCase(), ...(qr.payload ? { payload: qr.payload.toUpperCase() } : {}) };
      break;
    case 'cosignature':
      data = {
        parentHash: qr.parentHash.toUpperCase(),
        signerPublicKey: qr.signerPublicKey.toUpperCase(),
        signature: qr.signature.toUpperCase(),
        version: qr.version,
      };
      break;
    case 'template':
      data = {
        account: normAddress(qr.account),
        recipient: normAddress(qr.recipient),
        mosaics: qr.mosaics.map((m) => ({ id: m.id.toUpperCase(), amount: m.amount })),
        ...(qr.message ? { message: qr.message } : {}),
      };
      break;
  }
  return JSON.stringify({ kasane: KASANE_QR_VERSION, kind: qr.kind, network_id: cfg.networkByte, chain_id: cfg.generationHash, data });
}

/** True when the text is one of these QR codes (so another screen can point the person to the right place). */
export function isKasaneQr(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  try {
    const json = JSON.parse(t) as { kasane?: unknown };
    return json !== null && typeof json === 'object' && json.kasane !== undefined;
  } catch {
    return false;
  }
}

/** Reads and validates the shape of one of these QR codes. null when it is not one or any field is malformed. */
export function parseKasaneQr(text: string): ParsedKasaneQr | null {
  let json: { kasane?: unknown; kind?: unknown; network_id?: unknown; chain_id?: unknown; data?: unknown };
  try {
    json = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || json.kasane !== KASANE_QR_VERSION) return null;
  const d = (json.data ?? null) as Record<string, unknown> | null;
  if (d === null || typeof d !== 'object') return null;
  const networkId = typeof json.network_id === 'number' ? json.network_id : null;
  const chainId = isHash(json.chain_id) ? json.chain_id.toUpperCase() : null;

  let qr: KasaneQr | null = null;
  switch (json.kind) {
    case 'signed':
      if (isEvenHex(d.payload) && isHash(d.hash)) qr = { kind: 'signed', payload: d.payload.toUpperCase(), hash: d.hash.toUpperCase() };
      break;
    case 'cosign_request':
      if (isHash(d.hash) && (d.payload === undefined || isEvenHex(d.payload))) {
        qr = { kind: 'cosign_request', hash: d.hash.toUpperCase(), payload: typeof d.payload === 'string' ? d.payload.toUpperCase() : undefined };
      }
      break;
    case 'cosignature':
      if (isHash(d.parentHash) && isHash(d.signerPublicKey) && typeof d.signature === 'string' && SIGNATURE.test(d.signature)) {
        qr = {
          kind: 'cosignature',
          parentHash: d.parentHash.toUpperCase(),
          signerPublicKey: d.signerPublicKey.toUpperCase(),
          signature: d.signature.toUpperCase(),
          version: typeof d.version === 'string' ? d.version : '0',
        };
      }
      break;
    case 'template': {
      const mosaics = Array.isArray(d.mosaics) ? d.mosaics as Array<{ id?: unknown; amount?: unknown }> : null;
      if (
        typeof d.account === 'string' && ADDRESS.test(normAddress(d.account))
        && typeof d.recipient === 'string' && ADDRESS.test(normAddress(d.recipient))
        && mosaics !== null && mosaics.length > 0
        && mosaics.every((m) => typeof m.id === 'string' && MOSAIC_ID.test(m.id) && typeof m.amount === 'string' && /^[0-9]+$/.test(m.amount) && BigInt(m.amount) > 0n)
        && (d.message === undefined || typeof d.message === 'string')
      ) {
        qr = {
          kind: 'template',
          account: normAddress(d.account),
          recipient: normAddress(d.recipient),
          mosaics: mosaics.map((m) => ({ id: String(m.id).toUpperCase(), amount: String(m.amount) })),
          message: typeof d.message === 'string' && d.message !== '' ? d.message : undefined,
        };
      }
      break;
    }
    default:
      break;
  }
  return qr ? { qr, networkId, chainId } : null;
}

/** null when the QR belongs to the network the wallet is on, else 'wrong_network'. A QR that names no network is refused too. */
export function networkProblem(parsed: ParsedKasaneQr): 'wrong_network' | null {
  const cfg = getNetworkConfig();
  if (parsed.networkId !== cfg.networkByte) return 'wrong_network';
  if (parsed.chainId === null || parsed.chainId !== cfg.generationHash.toUpperCase()) return 'wrong_network';
  return null;
}
