// 署名ボタンを押した時点で「この依頼の送信者はブラックリストか」「中身に危険な点はないか」を調べる（画面の表示とは別に、押した瞬間の最新の状態で）。
import { WalletsHelper } from './storage';
import { plainAddress, trustOf } from './addressBook';
import type { Trust } from './addressBook';
import { getChain } from './chain';
import { parseWatchAddress } from './watchAddress';
import { analyzeSignRisks } from './signRisk';
import type { SignRisk } from './signRisk';
import type { PartialItem } from './symbol/multisigApi';
import { useAddressBookStore } from '../store/addressBookStore';
import { useAppStore } from '../store/appStore';

/** アドレス帳と自分のアカウントを読み込んで、「このアドレスはどう扱われているか」を返す関数を作る。 */
async function loadTrustResolver(): Promise<(address: string) => Trust> {
  const store = useAddressBookStore.getState();
  await store.load();
  const own = new Set<string>();
  try {
    for (const w of await WalletsHelper.gets()) {
      if (w.chain === getChain() && w.address) own.add(plainAddress(w.address));
    }
  } catch (e) {
    console.warn('Failed to read own addresses', e);
  }
  return (address: string): Trust => {
    const parsed = parseWatchAddress(address);
    if (!parsed) return 'unknown';
    return trustOf(useAddressBookStore.getState().entries, parsed.chain, parsed.network, parsed.address, own).trust;
  };
}

export async function checkSignerTrust(address: string): Promise<Trust> {
  return (await loadTrustResolver())(address);
}

/** 署名依頼の中身の危険警告（送金先・連署者に追加されるアドレスなど）。いちばん重いものが先頭。 */
export async function checkSignRisks(items: readonly PartialItem[]): Promise<SignRisk[]> {
  return analyzeSignRisks(items, await loadTrustResolver());
}

/**
 * 設定「未知のアドレスからの署名依頼」が「許可しない」のとき、アドレス帳に無い送信者の依頼には署名できない。
 * （ブラックリストは、これまでどおり確認ダイアログで続行できる。連絡先・ホワイトリスト・自分は常に署名できる。）
 */
export function isUnknownSignerDenied(trust: Trust): boolean {
  return trust === 'unknown' && !useAppStore.getState().allowUnknownSigners;
}
