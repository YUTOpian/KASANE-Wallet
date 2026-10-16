import type { MosaicBalance } from './symbol/api';
import { fetchChainBalances, nativeAssetId, nativeIcon } from './chainApi';
import { getChain } from './chain';

// One mosaic the active wallet can send. The native currency (XYM) is always first.
export type AssetOption = MosaicBalance;

/**
 * What the wallet can put in a transfer. NEM: XEM plus every mosaic it holds whose definition could be
 * read (divisibility and supply are needed to send the right quantity and fee) and that it may send.
 * `purpose: 'invoice'` keeps NEM to XEM only: the NEM invoice QR format carries an XEM amount alone.
 */
export async function loadSendAssets(walletAddress: string, purpose: 'send' | 'invoice' = 'send'): Promise<AssetOption[]> {
  const list = await fetchChainBalances(walletAddress);
  if (getChain() !== 'nem') return list;
  if (purpose === 'invoice') return list.slice(0, 1);
  return list.filter((o, i) => i === 0 || (o.supply !== undefined && o.transferable));
}

export function assetIcon(option: AssetOption): string | null {
  return option.id === nativeAssetId() ? nativeIcon() : null;
}

/** Whether `option` is the mosaic the store's sendMosaicId points at ('' = XYM). */
export function isSelectedAsset(option: AssetOption, sendMosaicId: string): boolean {
  const id = sendMosaicId === '' ? nativeAssetId() : sendMosaicId;
  return option.id.toUpperCase() === id.toUpperCase();
}
