import { useEffect, useState } from 'react';
import { Avatar, Box, Button, Card, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PasswordDialog from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { NEM_ICON } from '../../lib/chainIcons';

interface NemSetupProps {
  // Called once the NEM accounts exist, so Home loads them.
  onDone: () => void;
}

// Shown on Home when NEM is selected but the active profile has no NEM account yet - a profile made
// before NEM support. Its NEM accounts are derived from the recovery phrase it already holds, which
// needs the profile's password once. A profile imported from private keys has no phrase to derive
// from; NEM accounts are added there by private key under アカウント.
export default function NemSetup({ onDone }: NemSetupProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Wallet | null>(null);
  const [canDerive, setCanDerive] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActiveAny();
      setProfile(wallet);
      setCanDerive(wallet !== null && (await WalletsHelper.getProfileMnemonicWallet(wallet.id)) !== null);
    })();
  }, []);

  const onPassword = async (password: string) => {
    setShowPassword(false);
    if (!profile) return;
    setBusy(true);
    try {
      // Deriving a few accounts takes a moment; let the busy state paint first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await WalletsHelper.addNemAccountsToProfile(profile.id, password);
      if (result === 'added' || result === 'exists') {
        onDone();
      } else if (result === 'wrong-password') {
        setErrorMessage(t('wallet.invalid_key'));
      } else {
        setErrorMessage(t('nem_setup.no_mnemonic'));
      }
    } catch (e) {
      console.error('Failed to set up NEM accounts', e);
      setErrorMessage(t('nem_setup.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, mt: 4 }}>
      <Card sx={{ px: 3, py: 4, textAlign: 'center' }}>
        <Avatar src={NEM_ICON} sx={{ width: 72, height: 72, mx: 'auto', bgcolor: 'transparent' }} />
        <Typography variant="h6" sx={{ fontWeight: 700, mt: 2 }}>{t('nem_setup.title')}</Typography>
        <Typography color="text.secondary" sx={{ mt: 1.5, lineHeight: 1.7 }}>
          {t(canDerive ? 'nem_setup.message' : 'nem_setup.no_mnemonic')}
        </Typography>
        {canDerive ? (
          <Button variant="contained" size="large" disabled={busy || !profile} onClick={() => setShowPassword(true)} sx={{ mt: 3 }}>
            {t('nem_setup.button')}
          </Button>
        ) : (
          <Button variant="contained" size="large" onClick={() => navigate('/account')} sx={{ mt: 3 }}>
            {t('nem_setup.import_button')}
          </Button>
        )}
      </Card>
      <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={onPassword} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
