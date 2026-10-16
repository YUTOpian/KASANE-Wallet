import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useAddressBookStore } from '../store/addressBookStore';
import { WalletsHelper } from '../lib/storage';
import { blockedAddresses, plainAddress, trustOf } from '../lib/addressBook';
import { parseWatchAddress } from '../lib/watchAddress';
import type { AddressBookEntry, Trust } from '../lib/addressBook';

/** アドレス帳を（まだなら）読み込んで、その内容を返す。 */
export function useAddressBook() {
  const entries = useAddressBookStore((s) => s.entries);
  const loaded = useAddressBookStore((s) => s.loaded);
  const load = useAddressBookStore((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  return { entries, loaded };
}

/** 自分のアカウント（選んでいるチェーン・ネットワークのもの）のアドレス。署名依頼の送信者が「自分」かの判定に使う。 */
export function useOwnAddresses(): ReadonlySet<string> {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const [own, setOwn] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wallets = await WalletsHelper.gets();
        const set = new Set<string>();
        for (const w of wallets) {
          if (w.chain !== chain) continue;
          try { if (w.address) set.add(plainAddress(w.address)); } catch { /* 住所を作れないアカウントは飛ばす */ }
        }
        if (!cancelled) setOwn(set);
      } catch (e) {
        console.warn('Failed to read own addresses', e);
      }
    })();
    return () => { cancelled = true; };
  }, [chain, network]);
  return own;
}

/** あるアドレスが、アドレス帳でどう扱われているか（自分 / ホワイトリスト / 連絡先 / ブラックリスト / 未登録）。 */
export function useTrust(address: string): { trust: Trust; entry: AddressBookEntry | null; loaded: boolean } {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { entries, loaded } = useAddressBook();
  const own = useOwnAddresses();
  return useMemo(() => {
    // 画面に出ているアドレスと保存したアドレスを同じ形（正規の形）にそろえてから比べる。
    const canonical = address ? (parseWatchAddress(address)?.address ?? address) : '';
    const result = canonical ? trustOf(entries, chain, network, canonical, own) : { trust: 'unknown' as Trust, entry: null };
    return { ...result, loaded };
  }, [entries, chain, network, address, own, loaded]);
}

/** 履歴から隠すアドレス（設定でオンのときだけ中身がある）。 */
export function useBlockedAddresses(): ReadonlySet<string> {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const hide = useAddressBookStore((s) => s.hideBlocked);
  const { entries } = useAddressBook();
  const own = useOwnAddresses();
  return useMemo(() => (hide ? blockedAddresses(entries, chain, network, own) : new Set<string>()), [hide, entries, chain, network, own]);
}
