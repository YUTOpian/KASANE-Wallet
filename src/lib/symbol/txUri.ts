// Transaction URI (the Symbol "web+symbol://transaction" scheme, as produced by the official wallets).
//   web+symbol://transaction?data=<serialized transaction, hex>&type=<transaction type, decimal>
//                           &generationHash=<network hash>&nodeUrl=<node, optional>
// `data` is the unsigned transaction. Opening a URI only fills in the send form; nothing is signed or
// sent until the person confirms it with their password.
import { getNetworkConfig } from './network';

export const TX_URI_PREFIX = 'web+symbol://transaction';
export const TRANSFER_TX_TYPE = 0x4154; // 16724

/** A URI no longer than this still fits comfortably in a (low error-correction) QR code. */
export const TX_URI_QR_MAX_LENGTH = 2000;

export interface TransactionUriParts {
  payload: string; // hex of the unsigned transaction
  type: number;
  generationHash?: string;
  nodeUrl?: string;
}

export function buildTransactionUri(p: TransactionUriParts): string {
  const q = new URLSearchParams();
  q.set('data', p.payload);
  q.set('type', String(p.type));
  q.set('generationHash', (p.generationHash ?? getNetworkConfig().generationHash).toUpperCase());
  if (p.nodeUrl) q.set('nodeUrl', p.nodeUrl);
  return `${TX_URI_PREFIX}?${q.toString()}`;
}

export function isTransactionUri(text: string): boolean {
  return /^web\+symbol:\/\/transaction(\?|$)/i.test(text.trim());
}

/** Reads the parts of a transaction URI; null when it has no usable `data`. */
export function parseTransactionUri(text: string): TransactionUriParts | null {
  const trimmed = text.trim();
  if (!isTransactionUri(trimmed)) return null;
  try {
    const url = new URL(trimmed.replace(/^web\+symbol:/i, 'https:'));
    const payload = (url.searchParams.get('data') ?? '').trim();
    if (!/^([0-9a-fA-F]{2})+$/.test(payload)) return null;
    const type = Number(url.searchParams.get('type') ?? '');
    return {
      payload,
      type: Number.isInteger(type) ? type : 0,
      generationHash: url.searchParams.get('generationHash')?.toUpperCase() || undefined,
      nodeUrl: url.searchParams.get('nodeUrl') || undefined,
    };
  } catch {
    return null;
  }
}
