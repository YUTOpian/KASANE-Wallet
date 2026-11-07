import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { WalletsHelper } from '../lib/storage';
import { useAppStore } from '../store/appStore';

// 直近に確かめた結果。画面を移るたびに「署名が要る機能のボタンが一瞬だけ出る」のを避けるため、
// 次のフックはまずこの値から始める（読み込みが終わればすぐ正しい値に直る）。
let lastKnown = { watchOnly: false, ledger: false, sss: false };

function useActiveKind(): { watchOnly: boolean; ledger: boolean; sss: boolean } {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { pathname } = useLocation();
  const [kind, setKind] = useState(lastKnown);

  useEffect(() => {
    let cancelled = false;
    Promise.all([WalletsHelper.isActiveWatchOnly(), WalletsHelper.isActiveLedger(), WalletsHelper.isActiveSss()])
      .then(([watchOnly, ledger, sss]) => {
        lastKnown = { watchOnly, ledger, sss };
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

/** いま使っているプロファイルが SSS Extension か。署名は拡張で行い、秘密鍵・パスワード・バックアップは無い。 */
export function useSssProfile(): boolean {
  return useActiveKind().sss;
}

/**
 * 「この端末に秘密鍵が無い」プロファイルか（閲覧用・Ledger・SSS Extension）。秘密鍵をパスワードで開いて署名する
 * 機能（Ledger には未対応のもの）や、秘密鍵・バックアップの表示を出さない判断に使う。
 */
// `sssOk` を true にすると、SSS Extension のプロファイルは「署名できる」側に数える（SSS で署名できる機能の画面用）。
export function useNoKey(sssOk = false): boolean {
  const k = useActiveKind();
  return k.watchOnly || k.ledger || (k.sss && !sssOk);
}
