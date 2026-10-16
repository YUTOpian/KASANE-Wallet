// Reads what other Symbol tools hand over, so it can be used in 「署名・連署QR」 / 「オフライン連署」 like KASANE's own QR:
//   - a serialized transaction as plain hex (symbol-cli's "Payload", symbol-sdk's `tx.serialize()`, a REST payload),
//     with or without 0x, spaces or line breaks, or pasted together with its "Payload:" label
//   - JSON that holds it: `{"payload":"<hex>"}` (the REST announce body; symbol-cli / SDK / wallet exports also
//     nest it, e.g. `{"signedTransaction":{"payload":"<hex>","hash":"..."}}`, `{"transactionPayload":"<hex>"}`)
//   - a cosignature as the REST announce body: `{"parentHash","signature","signerPublicKey","version"}`
//   - a bare 64-digit hash, as a cosign request (the contents then come from the node, so only the online screen takes it)
// Nothing here is trusted: the kind comes from the transaction type in the bytes, the hash is recomputed from them
// (a "hash" in the JSON is ignored), and the network comes from the network byte. A payload names no chain, so it is
// taken to belong to the network the wallet is on when the network byte matches (the screens re-check it anyway).
import { models } from 'symbol-sdk/symbol';
import { facadeFor, hexToBytes, isSupportedNetworkByte } from './crypto';
import { TX_TYPE_AGGREGATE_BONDED } from './constants';
import type { ParsedKasaneQr } from './kasaneQr';
import { parseKasaneQr } from './kasaneQr';
import { getNetworkConfig } from './network';

const PAYLOAD_KEYS = ['payload', 'transactionPayload', 'serializedTransaction', 'signedTransaction', 'transaction'];
const HEX = /^[0-9a-fA-F]+$/;
const MIN_PAYLOAD_HEX = 2 * 120; // the smallest transaction header is 128 bytes

const cleanHex = (s: string) => s.replace(/\s+/g, '').replace(/^0x/i, '');

/** Finds a payload string in parsed JSON (a few levels deep, under the usual key names). */
function findPayload(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== 'object' || depth > 3) return null;
  const obj = value as Record<string, unknown>;
  for (const key of PAYLOAD_KEYS) {
    const v = obj[key];
    if (typeof v === 'string') {
      const h = cleanHex(v);
      if (h.length >= MIN_PAYLOAD_HEX && h.length % 2 === 0 && HEX.test(h)) return h;
    } else if (v !== undefined) {
      const inner = findPayload(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function fromPayload(hex: string): ParsedKasaneQr | null {
  let tx: ReturnType<typeof models.TransactionFactory.deserialize>;
  let networkByte: number;
  let type: number;
  try {
    tx = models.TransactionFactory.deserialize(hexToBytes(hex));
    const loose = tx as unknown as { network: { value: number } | number; type: { value: number } };
    networkByte = typeof loose.network === 'number' ? loose.network : loose.network.value;
    type = loose.type.value;
  } catch {
    return null;
  }
  if (!isSupportedNetworkByte(networkByte)) return null;
  const cfg = getNetworkConfig();
  let hash: string;
  try {
    hash = facadeFor(networkByte).hashTransaction(tx).toString().toUpperCase();
  } catch {
    return null;
  }
  const upper = hex.toUpperCase();
  // The network the payload names is kept as it is, so a payload of another network is refused by the caller.
  const chainId = networkByte === cfg.networkByte ? cfg.generationHash.toUpperCase() : null;
  const qr = type === TX_TYPE_AGGREGATE_BONDED
    ? ({ kind: 'cosign_request', hash, payload: upper } as const)
    : ({ kind: 'signed', payload: upper, hash } as const);
  return { qr, networkId: networkByte, chainId };
}

/** Reads a payload, a JSON that holds one, a cosignature body or a hash. null when it is none of these. */
export function parseExternalPayload(text: string): ParsedKasaneQr | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const cfg = getNetworkConfig();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const first = Array.isArray(json) ? json[0] : json;
    const found = findPayload(first);
    if (found) return fromPayload(found);
    const d = first as Record<string, unknown> | null;
    if (d !== null && typeof d === 'object' && typeof d.parentHash === 'string' && typeof d.signature === 'string' && typeof d.signerPublicKey === 'string') {
      // The REST announce body of a cosignature names no network: it is taken to be this one (the signature check is on the hash).
      return parseKasaneQr(JSON.stringify({
        kasane: 1,
        kind: 'cosignature',
        network_id: cfg.networkByte,
        chain_id: cfg.generationHash,
        data: { parentHash: d.parentHash, signerPublicKey: d.signerPublicKey, signature: d.signature, version: typeof d.version === 'string' || typeof d.version === 'number' ? String(d.version) : '0' },
      }));
    }
    return null;
  }

  // Hex, possibly after a label such as "Payload:" (copied from a terminal).
  const labelled = /payload\W{0,4}((?:0x)?[0-9a-fA-F\s]{240,})/i.exec(trimmed);
  const hex = cleanHex(labelled ? labelled[1] : trimmed);
  if (HEX.test(hex)) {
    if (hex.length === 64) {
      // A bare hash: a request to cosign it, the contents read from a node.
      return { qr: { kind: 'cosign_request', hash: hex.toUpperCase() }, networkId: cfg.networkByte, chainId: cfg.generationHash.toUpperCase() };
    }
    if (hex.length >= MIN_PAYLOAD_HEX && hex.length % 2 === 0) return fromPayload(hex);
  }
  return null;
}

/** KASANE's own QR / JSON first, then what other Symbol tools produce. */
export function parseAnyInput(text: string): ParsedKasaneQr | null {
  return parseKasaneQr(text) ?? parseExternalPayload(text);
}
