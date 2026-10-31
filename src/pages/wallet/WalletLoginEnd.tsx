import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WalletsHelper } from '../../lib/storage';
import { markBackupDone } from '../../lib/onboarding';
import SafeStorageNotice from '../../components/SafeStorageNotice';

// After an import: the safe-storage notice, then Home. No 戻る here - the profile is already saved, and the
// previous screens (name / password) would start the import over.
export default function WalletLoginEnd() {
  const navigate = useNavigate();
  const [walletId, setWalletId] = useState<string | null>(null);
  useEffect(() => {
    (async () => { setWalletId((await WalletsHelper.getActive())?.id ?? null); })();
  }, []);
  return <SafeStorageNotice exportWalletId={walletId} onDone={async () => {
    // An imported profile came from its phrase / key, so there is nothing new to back up.
    try { markBackupDone((await WalletsHelper.getActive())?.profileKey ?? ''); } catch { /* reminder stays */ }
    navigate('/top', { replace: true });
  }} />;
}
