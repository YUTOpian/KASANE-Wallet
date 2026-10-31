// The recovery phrase typed on the import screen, handed to the next screen (profile name +
// password) in memory only. It is deliberately not put in the URL, the router state or the
// persisted store, so it never lands in browser history or storage; a page reload clears it
// (the next screen then sends the person back to the import screen).
// The same goes for the account read from a keystore file (a private key): see setPendingKeyImport.
import type { ChainKey } from './chain';
import type { KeystoreAccount } from './keystore';

/** チェーンごとに、プロファイル作成後すぐ表示するアカウントのインデックス。 */
export type ShownIndexes = Record<ChainKey, number[]>;

let pendingKey: KeystoreAccount | null = null;
let pending: { phrase: string; chain: ChainKey; shownIndexes: Record<ChainKey, number[]> } | null = null;

export function setPendingImport(phrase: string, chain: ChainKey): void {
  pendingKey = null;
  pending = { phrase, chain, shownIndexes: { symbol: [0], nem: [0] } };
}

/** アカウント選択画面で選んだインデックス（プロファイル作成後に最初から表示するもの。何も選ばなければ 0）。 */
export function setPendingShownIndexes(indexes: Record<ChainKey, number[]>): void {
  if (!pending) return;
  const clean = (list: number[]) => (list.length > 0 ? [...new Set(list)].sort((a, b) => a - b) : [0]);
  pending = { ...pending, shownIndexes: { symbol: clean(indexes.symbol), nem: clean(indexes.nem) } };
}

export function getPendingImport(): { phrase: string; chain: ChainKey; shownIndexes: Record<ChainKey, number[]> } | null {
  return pending;
}

/** キーストアファイルから読み込んだアカウント（秘密鍵つき）。次の画面（プロファイル名とパスワード）に、メモリ上だけで渡す。 */
export function setPendingKeyImport(account: KeystoreAccount): void {
  pending = null;
  pendingKey = account;
}

export function getPendingKeyImport(): KeystoreAccount | null {
  return pendingKey;
}

export function clearPendingImport(): void {
  pending = null;
  pendingKey = null;
}
