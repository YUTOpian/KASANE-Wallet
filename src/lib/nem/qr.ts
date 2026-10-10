// QR formats of the NEM wallets (NanoWallet / NEM mobile wallets):
//   {"v":2,"type":1,"data":{"name":"...","addr":"N..."}}                       account / address
//   {"v":2,"type":2,"data":{"addr":"N...","amount":<micro XEM>,"msg":"...","name":"..."}}   invoice
// v is 2 on mainnet and 1 on testnet. A plain address is accepted as well.
import { formatAtomic } from '../symbol/amount';
import { getNetwork } from '../symbol/network';
import { NEM_CURRENCY_DIVISIBILITY } from './constants';
import { isValidNemAddress, normalizeNemAddress } from './crypto';

export interface NemScannedPayment {
  address: string; // normalized base32 address
  amount?: string; // decimal XEM, when the code carries one
  message?: string;
}

export function buildNemAddressQr(address: string, name = ''): string {
  return JSON.stringify({
    v: getNetwork() === 'mainnet' ? 2 : 1,
    type: 1,
    data: { name, addr: normalizeNemAddress(address) },
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
      const json = JSON.parse(text) as { type?: number; data?: { addr?: string; amount?: number | string; msg?: string } };
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
      return { address };
    } catch {
      return null;
    }
  }
  return null;
}
