// NEM offline transactions: a transfer signed on a device with no network, carried to a device that is online, and
// announced there.
//
// What is carried is exactly what NIS1's POST /transaction/announce takes, `{ "data": "<hex>", "signature": "<hex>" }`
// (`data` is the serialized transaction, which holds the signer's public key). That body is also what NanoWallet's
// offline transaction holds, so it can be read here as it is. KASANE's own QR wraps it in the same envelope as its Symbol
// QR codes (lib/symbol/kasaneQr.ts), with its own kind, so a scanner can tell it from a Symbol one and refuse another network:
//   { "kasane": 1, "kind": "nem_signed", "network_id": 104, "data": { "data": "<hex>", "signature": "<hex>" } }
//
// Nothing here is trusted. `readNemTransfer` reads what the transaction does from the bytes themselves (never from the
// QR's own claims), and the screens check the signature with the signer's public key before offering to send it.
// This file imports no SDK: it only builds / validates JSON and reads bytes.
import { NEM_EPOCH_SECONDS, NEM_TX_TYPE_TRANSFER } from './constants';

export const NEM_SIGNED_QR_KIND = 'nem_signed';
const KASANE_QR_VERSION = 1;

const HEX = /^[0-9a-fA-F]+$/;
const SIGNATURE_HEX_LENGTH = 128;
const MIN_DATA_HEX = 2 * 100; // the smallest NIS1 transfer (header + recipient + amount + no message) is 116 bytes

/** The body of POST /transaction/announce. */
export interface NemAnnounceBody {
  data: string; // upper-case hex of the serialized transaction
  signature: string; // upper-case hex, 64 bytes
}

const cleanHex = (s: string) => s.replace(/\s+/g, '').replace(/^0x/i, '');

export function nemHexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function asBody(value: unknown): NemAnnounceBody | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.data !== 'string' || typeof v.signature !== 'string') return null;
  const data = cleanHex(v.data);
  const signature = cleanHex(v.signature);
  if (data.length < MIN_DATA_HEX || data.length % 2 !== 0 || !HEX.test(data)) return null;
  if (signature.length !== SIGNATURE_HEX_LENGTH || !HEX.test(signature)) return null;
  return { data: data.toUpperCase(), signature: signature.toUpperCase() };
}

/** The signed transaction (the JSON body signNemTransfer returns) as KASANE's QR text. */
export function buildNemSignedQr(announceBody: string, networkByte: number): string {
  const body = asBody(JSON.parse(announceBody));
  if (body === null) throw new Error('nem offline: not a signed transaction');
  return JSON.stringify({ kasane: KASANE_QR_VERSION, kind: NEM_SIGNED_QR_KIND, network_id: networkByte, data: body });
}

export interface ParsedNemSigned {
  body: NemAnnounceBody;
  /** The network the QR says it is for (null for a bare announce body: the network byte in the transaction is used then). */
  networkId: number | null;
}

/** KASANE's NEM QR, or a bare announce body (`{"data","signature"}`, e.g. from NanoWallet). null when it is neither. */
export function parseNemSigned(text: string): ParsedNemSigned | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  const j = json as { kasane?: unknown; kind?: unknown; network_id?: unknown; data?: unknown };
  if (j.kasane !== undefined) {
    if (j.kasane !== KASANE_QR_VERSION || j.kind !== NEM_SIGNED_QR_KIND) return null;
    const body = asBody(j.data);
    return body ? { body, networkId: typeof j.network_id === 'number' ? j.network_id : null } : null;
  }
  const bare = asBody(json);
  return bare ? { body: bare, networkId: null } : null;
}

// --- reading the transaction -------------------------------------------------------------------------------------

export interface NemTransferSummary {
  /** 0x101 for a transfer. Only transfers are read in full; anything else has `transfer` null. */
  typeValue: number;
  version: number;
  networkByte: number;
  signerPublicKey: string; // upper-case hex
  fee: bigint; // micro-XEM
  timestampMs: number;
  deadlineMs: number;
  transfer: {
    recipient: string; // base32, 40 characters
    /** What goes to the recipient: for a version 2 transfer the multiplier has been applied to every mosaic. XEM is "nem:xem". */
    mosaics: Array<{ id: string; quantity: bigint }>;
    /** null = no message. `text` is null for an encrypted one (only the recipient can read it). */
    message: { encrypted: boolean; text: string | null; bytes: number } | null;
  } | null;
}

class Reader {
  private offset = 0;
  private bytes: Uint8Array;
  private view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error('nem payload: truncated');
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  /** A u32 length followed by that many bytes. */
  sized(max = 4096): Uint8Array {
    const n = this.u32();
    if (n > max) throw new Error('nem payload: field too long');
    return this.take(n);
  }
  get done() {
    return this.offset === this.bytes.length;
  }
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const MULTIPLIER_ONE = 1_000_000n;

/**
 * Reads a serialized NIS1 transaction (the announce body's `data`). The header is read for every type; a transfer
 * (version 1 or 2) is read in full. Throws when the bytes are not a well-formed transaction.
 */
export function readNemTransfer(dataHex: string): NemTransferSummary {
  const hex = cleanHex(dataHex);
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error('nem payload: not hex');
  const r = new Reader(nemHexToBytes(hex));
  const typeValue = r.u32();
  const versionField = r.u32();
  const version = versionField & 0xffff;
  const networkByte = (versionField >>> 24) & 0xff;
  const timestamp = r.u32();
  const signer = r.sized(32);
  if (signer.length !== 32) throw new Error('nem payload: bad signer key');
  const fee = r.u64();
  const deadline = r.u32();
  const summary: NemTransferSummary = {
    typeValue,
    version,
    networkByte,
    signerPublicKey: toHex(signer),
    fee,
    timestampMs: (timestamp + NEM_EPOCH_SECONDS) * 1000,
    deadlineMs: (deadline + NEM_EPOCH_SECONDS) * 1000,
    transfer: null,
  };
  if (typeValue !== NEM_TX_TYPE_TRANSFER || (version !== 1 && version !== 2)) return summary;

  const recipient = ascii(r.sized(64));
  if (!/^[A-Z2-7]{40}$/.test(recipient)) throw new Error('nem payload: bad recipient');
  const amount = r.u64();

  let message: NonNullable<NemTransferSummary['transfer']>['message'] = null;
  const messageField = r.u32();
  if (messageField > 0) {
    const messageType = r.u32();
    const payload = r.sized(1024);
    if (messageType === 1) {
      let text: string | null = null;
      // A plain message is text. (A payload that is not valid UTF-8 is shown as not readable rather than guessed at.)
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch { text = null; }
      message = { encrypted: false, text, bytes: payload.length };
    } else if (messageType === 2) {
      message = { encrypted: true, text: null, bytes: payload.length };
    } else {
      throw new Error('nem payload: unknown message type');
    }
  }

  let mosaics: Array<{ id: string; quantity: bigint }>;
  if (version === 1) {
    mosaics = [{ id: 'nem:xem', quantity: amount }];
  } else {
    // Version 2: `amount` is a multiplier (1,000,000 = x1) of every attached quantity. No mosaics at all = plain XEM.
    const count = r.u32();
    if (count > 64) throw new Error('nem payload: too many mosaics');
    mosaics = [];
    for (let i = 0; i < count; i++) {
      const struct = new Reader(r.sized(1024));
      const idStruct = new Reader(struct.sized(512));
      const namespace = ascii(idStruct.sized(256));
      const name = ascii(idStruct.sized(256));
      const quantity = struct.u64();
      mosaics.push({ id: `${namespace}:${name}`, quantity: (quantity * amount) / MULTIPLIER_ONE });
    }
    if (mosaics.length === 0) mosaics = [{ id: 'nem:xem', quantity: amount }];
  }
  if (!r.done) throw new Error('nem payload: trailing bytes');
  summary.transfer = { recipient, mosaics, message };
  return summary;
}
