import { useEffect, useState } from 'react';
import { readSssAccount, sssState } from '../lib/sss';
import type { SssAccount, SssState } from '../lib/sss';

const POLL_MS = 1000;

interface SssSnapshot {
  state: SssState;
  account: SssAccount | null;
}

const sameAccount = (a: SssAccount | null, b: SssAccount | null) =>
  a === b || (a !== null && b !== null && a.publicKey === b.publicKey && a.networkType === b.networkType && a.name === b.name);

/**
 * SSS Extension の状態と、いま SSS で選ばれているアカウントを、リアルタイムで追いかける。
 * SSS の画面でアカウントを切り替えると、`window.SSS` の値が変わる（変わらない版では、再読み込みで反映される）。
 * 1秒ごとに読む（値を読むだけで軽い）ほか、タブに戻ってきたとき・フォーカスが戻ったときはすぐ読み直す。
 */
export function useSssAccount(): SssSnapshot {
  const [snap, setSnap] = useState<SssSnapshot>(() => ({ state: sssState(), account: readSssAccount() }));

  useEffect(() => {
    const read = () => {
      const next: SssSnapshot = { state: sssState(), account: readSssAccount() };
      setSnap((cur) => (cur.state === next.state && sameAccount(cur.account, next.account) ? cur : next));
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return snap;
}
