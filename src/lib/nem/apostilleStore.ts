// アポスティーユの履歴の保存先: この端末のブラウザ（アドレス帳などと同じ場所）。チェーンごと・ネットワークごと（メインネット / テストネット）。
//   NEM の保存先の名前は、Symbol 版ができる前のまま（APOSTILLE_NTY_MAINNET）。Symbol は APOSTILLE_NTY_SYMBOL_MAINNET のように分ける。
import localForage from 'localforage';
import { getChain } from '../chain';
import type { ChainKey } from '../chain';
import { getNetwork } from '../symbol/network';
import { mergeNty } from './apostilleNty';
import type { ApostilleRecord } from './apostilleNty';

export function apostilleStoreKey(chain: ChainKey = getChain(), network: string = getNetwork()): string {
  return chain === 'symbol' ? `APOSTILLE_NTY_SYMBOL_${network.toUpperCase()}` : `APOSTILLE_NTY_${network.toUpperCase()}`;
}

export async function loadApostilles(): Promise<ApostilleRecord[]> {
  const stored = await localForage.getItem<ApostilleRecord[]>(apostilleStoreKey());
  return Array.isArray(stored) ? stored : [];
}

/** Adds records (a transaction hash already stored is not added twice). Returns how many were new. */
export async function addApostilles(records: ApostilleRecord[]): Promise<number> {
  const { records: merged, added } = mergeNty(await loadApostilles(), records);
  await localForage.setItem(apostilleStoreKey(), merged);
  return added;
}

export async function purgeApostilles(): Promise<void> {
  await localForage.removeItem(apostilleStoreKey());
}
