import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { WalletsHelper } from '../lib/storage';
import { useAppStore } from '../store/appStore';

// 直近に確かめた結果。画面を移るたびに「署名が要る機能のボタンが一瞬だけ出る」のを避けるため、
// 次のフックはまずこの値から始める（読み込みが終わればすぐ正しい値に直る）。
let lastKnown = { watchOnly: false, ledger: false };

function useActiveKind(): { watchOnly: boolean; ledger: boolean } {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { pathname } = useLocation();
  const [kind, setKind] = useState(lastKnown);

  useEffect(() => {
    let cancelled = false;
    Promise.all([WalletsHelper.isActiveWatchOnly(), WalletsHelper.isActiveLedger()])
      .then(([watchOnly, ledger]) => {
        lastKnown = { watchOnly, ledger };
        if (!cancelled) setKind(lastKnown);
      })
      .catch((e) => console.error('Failed to check the profile kind', e));
    return () => { cancelled = true; };
  }, [chain, network, pathname]);

  return kind;
}

/**
 * いま使っているプロファイルが「閲覧用」（アドレスだけを登録したもの）か。
 * 閲覧用では、署名が要る機能（送金・作成・登録・設定・バックアップなど）は画面に出さない。
 * チェーン・ネットワークの切り替えや画面の移動のたびに確かめ直す。
 */
export function useWatchOnly(): boolean {
  return useActiveKind().watchOnly;
}

/** いま使っているプロファイルが Ledger か。署名はデバイスで行い、秘密鍵・パスワード・バックアップは無い。 */
export function useLedgerProfile(): boolean {
  return useActiveKind().ledger;
}

/**
 * 「この端末に秘密鍵が無い」プロファイルか（閲覧用または Ledger）。秘密鍵をパスワードで開いて署名する
 * 機能（Ledger には未対応のもの）や、秘密鍵・バックアップの表示を出さない判断に使う。
 */
export function useNoKey(): boolean {
  const k = useActiveKind();
  return k.watchOnly || k.ledger;
}
