import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { WalletsHelper, PinCodeHelper } from '../lib/storage';

// The one screen this guard must never redirect away from - it's where the exposure it
// detects actually gets fixed. Every other route is fair game to redirect from.
const PASSWORD_REQUIRED_PATH = '/wallet/password-required';

/**
 * Since the fix in WalletCreationName.tsx, no *new* wallet is ever
 * created without a real password already confirmed - PinCodeHelper.defaultPin (a fixed,
 * publicly-known placeholder baked into the shipped source) is only ever used to migrate
 * a wallet left over from an older build that still predates that fix.
 *
 * But until now, that migration only happened if the person happened to land on a screen
 * that offers to set a password (Settings, etc.) -
 * nothing stopped them from using the app itself (viewing balances, generating a receive
 * QR, ...) with that wallet still sitting behind the known constant. This guard closes
 * that gap at the routing layer: on every navigation, it checks whether the active wallet
 * has no real password behind it yet and, if so, redirects to a dedicated screen that forces
 * password registration (see WalletPasswordRequired.tsx) before letting the person reach anything
 * else, no matter which URL they land on.
 *
 * Deliberately fails open (renders children) on a storage read error - this is a
 * defense-in-depth backstop for a state that normal usage no longer produces, not the
 * only thing standing between an attacker and the wallet, so a transient storage glitch
 * shouldn't lock the person out of their own app.
 */
export default function PasswordExposureGuard({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [exposed, setExposed] = useState(false);

  useEffect(() => {
    if (location.pathname === PASSWORD_REQUIRED_PATH) {
      // Already headed to the fix - nothing to detect or redirect here.
      setExposed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const activeWallet = await WalletsHelper.getActiveAny();
        // 閲覧用・Ledger のプロファイルは守る秘密（鍵）がこの端末に無いので、パスワードは要らない。
        const hasSavedCode = activeWallet != null && (activeWallet.watchOnly || activeWallet.ledger || await PinCodeHelper.hasSavedCode(activeWallet.profileKey));
        if (!cancelled) {
          setExposed(activeWallet != null && !hasSavedCode);
        }
      } catch (e) {
        console.error('PasswordExposureGuard: failed to check wallet/password state', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (exposed) {
    return <Navigate to={PASSWORD_REQUIRED_PATH} replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
