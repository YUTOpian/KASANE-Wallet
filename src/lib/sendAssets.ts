import type { MosaicBalance } from './symbol/api';
import { fetchChainBalances, nativeAssetId, nativeIcon } from './chainApi';
import { getChain } from './chain';

// One mosaic the active wallet can send. The native currency (XYM) is always first.
export type AssetOption = MosaicBalance;

export async function loadSendAssets(walletAddress: string): Promise<AssetOption[]> {
  const list = await fetchChainBalances(walletAddress);
  // NEM transfers carry XEM only for now, so other NEM mosaics are not offered.
  return getChain() === 'nem' ? list.slice(0, 1) : list;
}

export function assetIcon(option: AssetOption): string | null {
  return option.id === nativeAssetId() ? nativeIcon() : null;
}

/** Whether `option` is the mosaic the store's sendMosaicId points at ('' = XYM). */
export function isSelectedAsset(option: AssetOption, sendMosaicId: string): boolean {
  const id = sendMosaicId === '' ? nativeAssetId() : sendMosaicId;
  return option.id.toUpperCase() === id.toUpperCase();
}
