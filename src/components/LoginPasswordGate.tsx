import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { WalletsHelper } from '../lib/storage';
import { isLoginPasswordRequired, isLoginUnlocked, markLoginUnlocked } from '../lib/loginLock';
import PasswordDialog from './PasswordDialog';

// 画面ごとにゲートが作られ直すので、直前の確認で通した場合は、再確認のあいだも画面を出したままにする（空白が挟まらないように）。
let lastOpen = false;

/**
 * 「ログインのたびにパスワード入力を求める」を設定したプロファイルで、アプリを開いてから最初の画面に、
 * パスワードの入力を挟む。入力するまで中の画面は出さない（ダイアログは閉じられない）。
 * 設定していないプロファイル（既定）、閲覧用・Ledger のプロファイル（守る鍵が無い）では何もしない。
 */
export default function LoginPasswordGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  // 'checking': 確認中（画面は出さない） / 'ask': 入力が要る / 'open': 通す
  const [state, setState] = useState<'checking' | 'ask' | 'open'>(lastOpen ? 'open' : 'checking');
  const [profileKey, setProfileKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: 'ask' | 'open' = 'open';
      let key = '';
      try {
        const wallet = await WalletsHelper.getActiveAny();
        if (wallet && !wallet.keyless) {
          key = wallet.profileKey;
          if (isLoginPasswordRequired(key) && !isLoginUnlocked(key)) {
            next = 'ask';
          }
        }
      } catch (e) {
        // 確認できないときに、設定済みのロックを素通りさせない。
        console.error('LoginPasswordGate: failed to check login password setting', e);
        next = 'ask';
      }
      lastOpen = next === 'open';
      if (!cancelled) {
        setProfileKey(key);
        setState(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (state === 'open') {
    return <>{children}</>;
  }
  if (state === 'checking') {
    return null;
  }
  return (
    <PasswordDialog
      open
      mode="check"
      profileKey={profileKey || undefined}
      onClose={() => {}}
      onCancel={() => {}}
      onPass={() => {
        if (profileKey) markLoginUnlocked(profileKey);
        setState('open');
      }}
    />
  );
}
