// Reading and writing the QR / URI formats Symbol wallets exchange.
//   - plain address text (with or without hyphens)
//   - Symbol QR v3 JSON: type 0 = address, 1 = account, 2 = contact (public key), 3 = transaction request
//   - web+symbol://request?recipient=...&amount=...&mosaicId=...&message=... payment URIs
//   - web+symbol://transaction?data=<hex>&type=...&generationHash=... transaction URIs (transfers only)
import { addressFromPublicKey, decodeAddress, addressBytesToString, isValidAddress, normalizeAddress } from './crypto';
import { getNetworkConfig } from './network';
import { parseTransferPayload, serializeUnsignedTransfer } from './tx';
import type { MosaicAmount } from './tx';
import type { ParsedTransfer } from './tx';
import { isTransactionUri, parseTransactionUri, TRANSFER_TX_TYPE } from './txUri';

export interface ScannedPayment {
  address: string; // normalized base32 address
  amount?: string; // decimal amount of `mosaicId` (human units), when the code carries one
  mosaicId?: string; // 16 hex chars; absent = XYM
  message?: string;
  // Mosaics after the first one when the code is a transaction carrying several; amounts are `atomic:<n>`.
  extraMosaics?: Array<{ id: string; amount: string }>;
  // Set when the code is a serialized transaction (transaction URI / request QR) naming a network.
  generationHash?: string;
  // Things the send form cannot carry over; the caller must refuse rather than silently drop them.
  unsupported?: 'multiple_mosaics' | 'encrypted_message';
}

/** Address QR (type 0) as produced by the official Symbol wallets. */
export function buildAddressQr(address: string, name = ''): string {
  const cfg = getNetworkConfig();
  return JSON.stringify({
    v: 3,
    type: 0,
    network_id: cfg.networkByte,
    chain_id: cfg.generationHash,
    data: { name, addr: normalizeAddress(address) },
  });
}

/**
 * Account-info QR: {"v":3,"type":1,"network_id":..,"chain_id":..,"data":{"name":..,"publicKey":..}}
 * (type 1 of the official symbol-qr-library; public information only, never the private key).
 */
export function buildAccountInfoQr(publicKey: string, name = ''): string {
  const cfg = getNetworkConfig();
  return JSON.stringify({
    v: 3,
    type: 1,
    network_id: cfg.networkByte,
    chain_id: cfg.generationHash,
    data: { name, publicKey: publicKey.toUpperCase() },
  });
}

// The payer is unknown when an invoice is made, so the transaction carries an all-zero signer key (as the
// official wallets' invoice QR does); whoever scans it fills in their own account and fee.
const UNKNOWN_SIGNER = '0'.repeat(64);
export const INVOICE_LIFETIME_MS = 2n * 60n * 60n * 1000n;

/**
 * Invoice / payment-request QR in the official Symbol wallets' format: Symbol QR v3, type 3 (transaction
 * request) whose payload is the unsigned transfer to `recipient`, so the scanner opens it prefilled with the
 * recipient, mosaics (atomic amounts) and plain message.
 */
export function buildInvoiceQr(p: { recipient: string; mosaics: MosaicAmount[]; message?: string }): string {
  const cfg = getNetworkConfig();
  const payload = serializeUnsignedTransfer({
    signerPublicKey: UNKNOWN_SIGNER,
    networkByte: cfg.networkByte,
    recipient: normalizeAddress(p.recipient),
    mosaics: p.mosaics,
    message: p.message,
    maxFee: 0n,
    deadline: BigInt(Date.now() - cfg.epochAdjustment * 1000) + INVOICE_LIFETIME_MS,
  });
  return JSON.stringify({ v: 3, type: 3, network_id: cfg.networkByte, chain_id: cfg.generationHash, data: { payload } });
}

function addressOrNull(text: string | undefined): string | null {
  if (!text) return null;
  const n = normalizeAddress(text);
  return isValidAddress(n) ? n : null;
}

/** Turns a serialized transfer into the payment the send form can show. */
function paymentFromTransfer(parsed: ParsedTransfer, generationHash?: string): ScannedPayment | null {
  const address = addressBytesToString(parsed.recipient);
  if (!decodeAddress(address)) return null;
  const first = parsed.mosaics[0];
  return {
    address,
    mosaicId: first?.id,
    // Raw atomic amount: the caller converts it using the mosaic's divisibility.
    amount: first ? `atomic:${first.amount.toString()}` : undefined,
    message: parsed.message || undefined,
    generationHash,
    extraMosaics: parsed.mosaics.length > 1 ? parsed.mosaics.slice(1).map((m) => ({ id: m.id, amount: `atomic:${m.amount.toString()}` })) : undefined,
    unsupported: parsed.encryptedMessage ? 'encrypted_message' : undefined,
  };
}

export function parseScanned(raw: string): ScannedPayment | null {
  const text = raw.trim();

  const direct = addressOrNull(text);
  if (direct) return { address: direct };

  if (isTransactionUri(text)) {
    const uri = parseTransactionUri(text);
    if (!uri || (uri.type !== 0 && uri.type !== TRANSFER_TX_TYPE)) return null;
    const parsed = parseTransferPayload(uri.payload);
    return parsed ? paymentFromTransfer(parsed, uri.generationHash) : null;
  }

  if (/^web\+symbol:\/\/request/i.test(text)) {
    try {
      const url = new URL(text.replace(/^web\+symbol:/i, 'https:'));
      const address = addressOrNull(url.searchParams.get('recipient') ?? undefined);
      if (!address) return null;
      const amount = url.searchParams.get('amount') ?? undefined;
      const mosaicId = url.searchParams.get('mosaicId') ?? undefined;
      const message = url.searchParams.get('message') ?? undefined;
      return { address, amount: amount || undefined, mosaicId: mosaicId?.toUpperCase(), message: message || undefined };
    } catch {
      return null;
    }
  }

  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text) as { type?: number; chain_id?: string; data?: Record<string, string> };
      const data = json.data ?? {};
      if (json.type === 0 || json.type === 1) {
        const address = addressOrNull(data.addr) ?? (data.publicKey ? safeAddress(data.publicKey) : null);
        return address ? { address } : null;
      }
      if (json.type === 2 && data.publicKey) {
        const address = safeAddress(data.publicKey);
        return address ? { address } : null;
      }
      if (json.type === 3 && data.payload) {
        const parsed = parseTransferPayload(data.payload);
        return parsed ? paymentFromTransfer(parsed, json.chain_id) : null; // chain_id = generation hash, so another network's request is refused
      }
    } catch {
      return null;
    }
  }
  return null;
}

function safeAddress(publicKey: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) return null;
  return addressFromPublicKey(publicKey, getNetworkConfig().networkByte);
}
