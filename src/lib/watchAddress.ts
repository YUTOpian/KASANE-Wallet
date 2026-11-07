// 閲覧用プロファイル：アドレスだけを入力して残高・履歴などを見るためのアドレス判定。
// Symbol（39文字）と NEM（40文字）は長さで見分け、先頭の文字（N / T）でネットワークを判定する。
import type { ChainKey } from './chain';
import type { SymbolNetwork } from './symbol/constants';
import { addressBytesToString, decodeAddress } from './symbol/crypto';
import { MIJIN_NETWORK_BYTE, MIJIN_TEST_NETWORK_BYTE } from './symbol/constants';
import { getNetworkConfig } from './symbol/network';
import { decodeNemAddress, normalizeNemAddress } from './nem/crypto';

export interface WatchAddress {
  chain: ChainKey;
  network: SymbolNetwork;
  /** ハイフン・空白なしの大文字。 */
  address: string;
}

const NETWORK_BY_BYTE: Record<number, SymbolNetwork> = { 0x68: 'mainnet', 0x98: 'testnet' };
// Symbol only: mijin v2 (Catapult) addresses - 0x60 "M...", 0x90 "S...", or whatever byte the person's node reported. NEM has no mijin v2.
const symbolNetworkOfByte = (byte: number): SymbolNetwork | null =>
  NETWORK_BY_BYTE[byte] ?? (byte === MIJIN_NETWORK_BYTE || byte === MIJIN_TEST_NETWORK_BYTE || byte === getNetworkConfig('mijin').networkByte ? 'mijin' : null);

/** 入力されたアドレスを判定する。Symbol / NEM のどちらでもなければ（チェックサムも見る）null。 */
export function parseWatchAddress(input: string): WatchAddress | null {
  const symbolBytes = decodeAddress(input);
  const symbolNetwork = symbolBytes ? symbolNetworkOfByte(symbolBytes[0]) : null;
  if (symbolBytes && symbolNetwork) {
    // 末尾の文字には使われないビットがある（39文字=195ビット、アドレスは192ビット）ので、保存・比較は正規の形に揃える。
    return { chain: 'symbol', network: symbolNetwork, address: addressBytesToString(symbolBytes) };
  }
  const nemBytes = decodeNemAddress(input);
  if (nemBytes && NETWORK_BY_BYTE[nemBytes[0]]) {
    return { chain: 'nem', network: NETWORK_BY_BYTE[nemBytes[0]], address: normalizeNemAddress(input) };
  }
  return null;
}

/** 20バイトのハッシュ部分（ネットワークが違っても同じアカウントなら同じ）。同じアドレスの重複登録の判定用。 */
export function addressBody(chain: ChainKey, address: string): string {
  const bytes = chain === 'nem' ? decodeNemAddress(address) : decodeAddress(address);
  return bytes ? Array.from(bytes.subarray(1, 21)).map((b) => b.toString(16).padStart(2, '0')).join('') : '';
}
