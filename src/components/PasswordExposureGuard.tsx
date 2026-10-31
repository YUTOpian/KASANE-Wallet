import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import MessageDialog from './MessageDialog';
import { useTranslation } from 'react-i18next';
import { WalletsHelper, PinCodeHelper } from '../lib/storage';

// この2画面は、ガードが検出した問題をまさに直す画面なので、ここからはリダイレクトしない。
const PASSWORD_REQUIRED_PATH = '/wallet/password-required';

type GuardState = 'checking' | 'ok' | 'exposed' | 'error';

// 画面ごとにガードが作られ直すので、直前の確認で問題なしだった場合は、再確認のあいだも画面を出したままにする
// （画面が移るたびに空白が挟まらないように）。再確認で問題が見つかれば、そのとき移す。
let lastState: GuardState = 'checking';

/**
 * 画面を開くたびに、いまのプロファイルの保護状態を確認し、問題があれば直す画面へ移す。
 *
 * - exposed: 本当のパスワードがまだ無い（旧ビルドが固定の既定パスワードで暗号化したまま）。
 *            /wallet/password-required でパスワードを設定させる。
 * - 旧形式（現在の形式でない暗号文）のプロファイルは、移行せずに deleteLegacyProfiles で強制的に消す。
 *
 * 確認そのものが失敗したとき（ストレージの読み取りエラー）は、通さずに止めて再試行を求める（fail-closed）。
 * 以前はそのまま通していたが、そうすると「確認できなかった」状態で保護の薄い画面が開いてしまう。
 * 最初の確認が終わるまでは、画面を出さない（旧形式のまま一瞬でも開かないようにする）。
 */
export default function PasswordExposureGuard({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { t } = useTranslation();
  const [state, setState] = useState<GuardState>(lastState === 'ok' ? 'ok' : 'checking');
  const [retry, setRetry] = useState(0);
  // 旧形式のプロファイルを強制削除した件数（0 なら通知しない）。
  const [purged, setPurged] = useState(0);
  const onFixScreen = location.pathname === PASSWORD_REQUIRED_PATH;

  useEffect(() => {
    if (onFixScreen) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // 旧形式（CryptoJS）のプロファイルは、移行せずに強制的に消す。
        const removedCount = await WalletsHelper.deleteLegacyProfiles();
        if (removedCount > 0 && !cancelled) {
          setPurged((n) => n + removedCount);
        }
        const activeWallet = await WalletsHelper.getActiveAny();
        let next: GuardState = 'ok';
        if (activeWallet != null) {
          // 閲覧用・Ledger・SSS のプロファイルは守る秘密（鍵）がこの端末に無いので、パスワードは要らない。
          const keyless = activeWallet.keyless;
          if (!keyless) {
            if (!(await PinCodeHelper.hasSavedCode(activeWallet.profileKey))) {
              next = 'exposed';
            }
          }
        }
        lastState = next;
        if (!cancelled) {
          setState(next);
        }
      } catch (e) {
        console.error('PasswordExposureGuard: failed to check wallet/password state', e);
        lastState = 'error';
        if (!cancelled) {
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname, onFixScreen, retry]);

  if (onFixScreen) {
    return <>{children}</>;
  }
  const purgedDialog = (
    <MessageDialog
      open={purged > 0}
      variant="error"
      title={t('wallet.legacy_purged_title')}
      texts={(t('wallet.legacy_purged_message', { returnObjects: true }) as string[])}
      onClose={() => setPurged(0)}
    />
  );
  if (state === 'exposed') {
    return <Navigate to={PASSWORD_REQUIRED_PATH} replace state={{ from: location.pathname }} />;
  }
  if (state === 'error') {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography sx={{ mb: 2 }}>{t('wallet.guard_check_failed')}</Typography>
        <Button variant="contained" onClick={() => { setState('checking'); setRetry((n) => n + 1); }}>
          {t('wallet.guard_retry')}
        </Button>
      </Box>
    );
  }
  if (state === 'checking') {
    return null;
  }
  return <>{children}{purgedDialog}</>;
}
