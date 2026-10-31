import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SafeStorageNotice from '../../components/SafeStorageNotice';
import { WalletsHelper } from '../../lib/storage';

// After the recovery phrase screen: the safe-storage notice, then Home. By this point the PIN is already set
// (WalletCreationName) and the phrase has been shown/confirmed (WalletCreationMnemonic).
export default function WalletCreationEnd() {
  const navigate = useNavigate();
  const [walletId, setWalletId] = useState<string | null>(null);
  useEffect(() => {
    (async () => { setWalletId((await WalletsHelper.getActive())?.id ?? null); })();
  }, []);
  return <SafeStorageNotice exportWalletId={walletId} onBack={() => navigate(-1)} onDone={() => navigate('/top', { replace: true })} />;
}
