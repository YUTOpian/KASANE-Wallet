// Reads a scanned / pasted code (address, QR, payment URI, transaction URI) and puts the recipient,
// amount, mosaic and message into the send form's store. Shared by the camera scanner and the
// "load a URI" dialog of the send form.
import type { TFunction } from 'i18next';
import { useAppStore } from '../store/appStore';
import { parseScanned } from './symbol/qr';
import type { ScannedPayment } from './symbol/qr';
import { isTransactionUri } from './symbol/txUri';
import { getMosaicInfos } from './symbol/api';
import { formatAtomic } from './symbol/amount';
import { addressNetworkByte } from './symbol/crypto';
import { getNetworkConfig } from './symbol/network';
import { chainMeta, getChain } from './chain';
import { parseNemScanned } from './nem/qr';
import { decodeNemAddress } from './nem/crypto';
import { activeNetworkByte, activeNetworkLabel } from './chainApi';

export type ScanFailure = 'invalid' | 'uri_unsupported' | 'wrong_network' | 'multiple_mosaics' | 'encrypted_message';
export type ApplyScannedResult = { ok: true } | { ok: false; reason: ScanFailure };

/** The message to show for a failed scan. */
export function scanFailureMessage(reason: ScanFailure, t: TFunction): string {
  switch (reason) {
    case 'wrong_network': return t('send.wrong_network_address', { chain: chainMeta().name, network: activeNetworkLabel() });
    case 'uri_unsupported': return t('txuri.unsupported');
    case 'multiple_mosaics': return t('txuri.multiple_mosaics');
    case 'encrypted_message': return t('txuri.encrypted_message');
    default: return t('common.invalid_address');
  }
}

export async function applyScannedText(decoded: string): Promise<ApplyScannedResult> {
  // NEM codes (plain address / account QR / invoice QR) carry an address and optionally an XEM amount.
  const nemMode = getChain() === 'nem';
  const parsed = nemMode ? parseNemScanned(decoded) : parseScanned(decoded);
  if (parsed === null) {
    // A transaction URI that is not a plain transfer (or has no usable data) gets its own explanation.
    return { ok: false, reason: !nemMode && isTransactionUri(decoded) ? 'uri_unsupported' : 'invalid' };
  }
  const cfg = getNetworkConfig();
  // Symbol QR codes can name a mosaic; NEM codes carry XEM only.
  const symbolPayment: ScannedPayment | null = nemMode ? null : (parsed as ScannedPayment);
  if (symbolPayment?.unsupported) return { ok: false, reason: symbolPayment.unsupported };
  if (symbolPayment?.generationHash && symbolPayment.generationHash.toUpperCase() !== cfg.generationHash.toUpperCase()) {
    return { ok: false, reason: 'wrong_network' };
  }
  const scannedByte = nemMode ? decodeNemAddress(parsed.address)?.[0] : addressNetworkByte(parsed.address);
  if (scannedByte !== activeNetworkByte()) return { ok: false, reason: 'wrong_network' };

  const s = useAppStore.getState();
  s.setReceiverAddress(parsed.address);
  s.setSendMessage(parsed.message ?? '');
  s.setSendAmount('');
  s.setSendMosaicId(symbolPayment?.mosaicId ?? '');
  s.setSendExtraMosaics([]);
  if (parsed.amount) {
    try {
      if (parsed.amount.startsWith('atomic:') && symbolPayment) {
        // Transaction-request QR / transaction URI: the amount is in atomic units, so the mosaic's divisibility is needed.
        const id = (symbolPayment.mosaicId ?? cfg.currencyMosaicId).toUpperCase();
        const info = (await getMosaicInfos([id]))[id];
        s.setSendAmount(formatAtomic(BigInt(parsed.amount.slice('atomic:'.length)), info?.divisibility ?? 0));
      } else {
        s.setSendAmount(parsed.amount);
      }
    } catch (e) {
      console.error('Could not resolve the scanned amount, keeping the address only', e);
    }
  }
  // A transaction carrying several mosaics: the others become further lines of the form.
  if (symbolPayment?.extraMosaics?.length) {
    try {
      const ids = symbolPayment.extraMosaics.map((m) => m.id.toUpperCase());
      const infos = await getMosaicInfos(ids);
      s.setSendExtraMosaics(symbolPayment.extraMosaics.map((m, i) => ({
        id: ids[i],
        amount: formatAtomic(BigInt(m.amount.slice('atomic:'.length)), infos[ids[i]]?.divisibility ?? 0),
      })));
    } catch (e) {
      console.error('Could not resolve the scanned extra mosaics', e);
      return { ok: false, reason: 'invalid' };
    }
  }
  return { ok: true };
}
