import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../lib/storage';
import { isLoginPasswordRequired, isLoginUnlocked, markLoginUnlocked } from '../lib/loginLock';
import PasswordDialog from './PasswordDialog';

// パスワードを忘れたときの抜け道の行き先。ここではパスワードを求めない（プロファイルの名前が見えるだけで、残高などは出ない）。
// ここから同じプロファイルのホームなどへ進めば、そこで改めて求められる。別のプロファイルを選べば、そちらの設定に従う。
const UNGATED_PATHS = new Set(['/wallet/select']);

// 画面ごとにゲートが作られ直すので、直前の確認で通した場合は、再確認のあいだも画面を出したままにする（空白が挟まらないように）。
let lastOpen = false;

/**
 * 「ログインのたびにパスワード入力を求める」を設定したプロファイルで、アプリを開いてから最初の画面に、
 * パスワードの入力を挟む。入力するまで中の画面は出さない（ダイアログは閉じられない）。
 * 設定していないプロファイル（既定）、閲覧用・Ledger のプロファイル（守る鍵が無い）では何もしない。
 */
export default function LoginPasswordGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const ungated = UNGATED_PATHS.has(location.pathname);
  // 'checking': 確認中（画面は出さない） / 'ask': 入力が要る / 'open': 通す
  const [state, setState] = useState<'checking' | 'ask' | 'open'>(lastOpen ? 'open' : 'checking');
  const [profileKey, setProfileKey] = useState('');

  useEffect(() => {
    if (ungated) {
      // 抜けてきたあと、次の画面が（別のプロファイルを選んだ場合を含め）直前の確認の結果で開いてしまわないよう、確認し直しにしておく。
      lastOpen = false;
      setState('checking');
      return;
    }
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
  }, [location.pathname, ungated]);

  if (state === 'open' || ungated) {
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
      // 戻る矢印・「パスワードを忘れた」ボタン・入力ミスの上限に達したとき: プロファイル選択へ抜ける（パスワードは通らない）。
      onCancel={() => navigate('/wallet/select', { replace: true })}
      cancelLabel={t('wallet.login_password_forgot')}
      onPass={() => {
        if (profileKey) markLoginUnlocked(profileKey);
        setState('open');
      }}
    />
  );
}
