// QR formats of the NEM wallets (NanoWallet / NEM mobile wallets):
//   {"v":2,"type":1,"data":{"name":"...","addr":"N..."}}                       account / address
//   {"v":2,"type":2,"data":{"addr":"N...","amount":<micro XEM>,"msg":"...","name":"..."}}   invoice (XEM only)
//   {"v":2,"type":4,"data":{"addr":"N...","mosaics":[{"name":"ns:mosaic","qty":<atomic>}],"msg":"...","name":"..."}}
//                                                                                         invoice with mosaics (NIP draft)
// v is 2 on mainnet and 1 on testnet. A plain address is accepted as well.
import { formatAtomic } from '../symbol/amount';
import { getNetwork } from '../symbol/network';
import { NEM_CURRENCY_DIVISIBILITY, NEM_NATIVE_ID } from './constants';
import { isValidNemAddress, normalizeNemAddress } from './crypto';

export interface NemScannedPayment {
  address: string; // normalized base32 address
  amount?: string; // decimal XEM, when the code carries one
  message?: string;
  /** Invoice with mosaics (type 4): every line in atomic units, XEM first. Absent for a plain XEM request. */
  mosaics?: NemInvoiceMosaic[];
}

/** One line of an invoice: a mosaic id ("namespace:name", "nem:xem" for XEM) and the amount in atomic units. */
export interface NemInvoiceMosaic {
  id: string;
  amount: bigint;
}

export function buildNemAddressQr(address: string, name = ''): string {
  return JSON.stringify({
    v: getNetwork() === 'mainnet' ? 2 : 1,
    type: 1,
    data: { name, addr: normalizeNemAddress(address) },
  });
}

/** Name printed into the invoice QR (NanoWallet writes "NanoWallet XEM invoice"). */
export const NEM_INVOICE_NAME = 'KASANE XEM invoice';
/** Name printed into an invoice QR that carries mosaics (type 4). */
export const NEM_MOSAIC_INVOICE_NAME = 'KASANE invoice';

/**
 * Invoice / payment-request QR.
 *  - XEM only: the NEM wallets' format (NanoWallet, NEM mobile wallets), readable by all of them:
 *      {"v":2,"type":2,"data":{"addr":"N...","amount":<micro XEM>,"msg":"...","name":"..."}}
 *  - with any other mosaic: the mosaic-capable type 4 of the NEM QR draft (NIP):
 *      {"v":2,"type":4,"data":{"addr":"N...","mosaics":[{"name":"ns:mosaic","qty":<atomic>}],"msg":"...","name":"..."}}
 *    Wallets that only know type 2 cannot read it.
 * Amounts are integers in atomic units (micro XEM for XEM) and `msg` is plain text. NEM has no deadline in this
 * format, so the request does not expire.
 */
export function buildNemInvoiceQr(p: { recipient: string; mosaics: NemInvoiceMosaic[]; message?: string }): string {
  const addr = normalizeNemAddress(p.recipient);
  if (!isValidNemAddress(addr)) throw new Error('invoice: invalid NEM address');
  if (p.mosaics.length === 0) throw new Error('invoice: no mosaic');
  const lines = p.mosaics.map((m) => ({ id: m.id.toLowerCase(), amount: m.amount }));
  for (const l of lines) {
    if (l.amount < 0n || l.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invoice: amount out of range');
  }
  const v = getNetwork() === 'mainnet' ? 2 : 1;
  const msg = p.message ?? '';
  if (lines.length === 1 && lines[0].id === NEM_NATIVE_ID) {
    return JSON.stringify({ v, type: 2, data: { addr, amount: Number(lines[0].amount), msg, name: NEM_INVOICE_NAME } });
  }
  return JSON.stringify({
    v,
    type: 4,
    data: { addr, mosaics: lines.map((l) => ({ name: l.id, qty: Number(l.amount) })), msg, name: NEM_MOSAIC_INVOICE_NAME },
  });
}

function addressOrNull(text: string | undefined): string | null {
  if (!text) return null;
  const n = normalizeNemAddress(text);
  return isValidNemAddress(n) ? n : null;
}

export function parseNemScanned(raw: string): NemScannedPayment | null {
  const text = raw.trim();

  const direct = addressOrNull(text);
  if (direct) return { address: direct };

  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text) as {
        type?: number;
        data?: { addr?: string; amount?: number | string; msg?: string; mosaics?: Array<{ name?: string; qty?: number | string }> };
      };
      const data = json.data ?? {};
      const address = addressOrNull(data.addr);
      if (!address) return null;
      if (json.type === 2) {
        let amount: string | undefined;
        if (data.amount !== undefined && data.amount !== '') {
          try {
            amount = formatAtomic(BigInt(data.amount), NEM_CURRENCY_DIVISIBILITY);
          } catch {
            amount = undefined;
          }
        }
        return { address, amount: amount && amount !== '0' ? amount : undefined, message: data.msg || undefined };
      }
      if (json.type === 4) return parseMosaicInvoice(address, data);
      return { address };
    } catch {
      return null;
    }
  }
  return null;
}

// Type 4 (invoice with mosaics): keeps the lines that name a well-formed mosaic with a positive integer quantity,
// XEM first. A single XEM line is the same as a type 2 invoice. A line that cannot be read is dropped rather than guessed.
const NEM_MOSAIC_ID = /^[a-z0-9_'-]+(\.[a-z0-9_'-]+)*:[a-z0-9_'-]+$/;

function parseMosaicInvoice(address: string, data: { msg?: string; mosaics?: Array<{ name?: string; qty?: number | string }> }): NemScannedPayment {
  const merged = new Map<string, bigint>();
  for (const m of data.mosaics ?? []) {
    const id = (m.name ?? '').trim().toLowerCase();
    if (!NEM_MOSAIC_ID.test(id)) continue;
    let qty: bigint;
    try {
      qty = BigInt(m.qty ?? 0);
    } catch {
      continue;
    }
    if (qty <= 0n) continue;
    merged.set(id, (merged.get(id) ?? 0n) + qty);
  }
  const lines: NemInvoiceMosaic[] = Array.from(merged, ([id, amount]) => ({ id, amount }))
    .sort((a, b) => Number(b.id === NEM_NATIVE_ID) - Number(a.id === NEM_NATIVE_ID));
  const message = data.msg || undefined;
  if (lines.length === 0) return { address, message };
  if (lines.length === 1 && lines[0].id === NEM_NATIVE_ID) return { address, amount: formatAtomic(lines[0].amount, NEM_CURRENCY_DIVISIBILITY), message };
  return { address, message, mosaics: lines };
}
