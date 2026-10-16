// アポスティーユの履歴の保存先: この端末のブラウザ（アドレス帳などと同じ場所）。ネットワークごと（メインネット / テストネット）。
import localForage from 'localforage';
import { getNetwork } from '../symbol/network';
import { mergeNty } from './apostilleNty';
import type { ApostilleRecord } from './apostilleNty';

const keyFor = () => `APOSTILLE_NTY_${getNetwork().toUpperCase()}`;

export async function loadApostilles(): Promise<ApostilleRecord[]> {
  const stored = await localForage.getItem<ApostilleRecord[]>(keyFor());
  return Array.isArray(stored) ? stored : [];
}

/** Adds records (a transaction hash already stored is not added twice). Returns how many were new. */
export async function addApostilles(records: ApostilleRecord[]): Promise<number> {
  const { records: merged, added } = mergeNty(await loadApostilles(), records);
  await localForage.setItem(keyFor(), merged);
  return added;
}

export async function purgeApostilles(): Promise<void> {
  await localForage.removeItem(keyFor());
}
