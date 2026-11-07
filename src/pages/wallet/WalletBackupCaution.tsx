import { useState } from 'react';
import { handOverPassword } from '../../lib/passedPassword';
import { Box, Button, Typography } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import PasswordDialog from '../../components/PasswordDialog';
import { PinCodeHelper, WalletsHelper } from '../../lib/storage';
import cautionIcon from '../../assets/icon_caution.png';

export default function WalletBackupCaution() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id') || '';
  // Optional override for where "←" and the eventual "完了" land - used when this screen
  // is reached from somewhere other than a specific wallet's own settings screen (e.g. the
  // app-wide Settings screen's "Backup" item, which has no wallet id in its URL).
  const back = searchParams.get('back') || '';
  // 'mnemonic' when reached from the app-wide Settings screen's バックアップ item (see
  // SettingsTop's goToBackup), 'key' when reached from a specific wallet's own settings
  // screen (see WalletSettings) - controls whether the next screen (WalletBackup) reveals
  // the private key or the recovery phrase.
  const mode = searchParams.get('mode') === 'mnemonic' ? 'mnemonic' : 'key';

  const backParam = back ? `&back=${encodeURIComponent(back)}` : '';
  const modeParam = mode === 'mnemonic' ? '&mode=mnemonic' : '';

  const cautionTitleKey = mode === 'mnemonic' ? 'wallet.mnemonic_caution_title' : 'wallet.key_caution_title';
  const cautionMessageLines = mode === 'mnemonic'
    ? [t('wallet.mnemonic_caution_message')]
    : (t('wallet.key_caution_message', { returnObjects: true }) as string[]);

  const [showPinDialog, setShowPinDialog] = useState(false);
  const [profileKey, setProfileKey] = useState('');
  const backupUrl = `/wallet/backup?id=${id}${backParam}${modeParam}`;

  // OK: ask for the wallet password in a popup, then go on to the screen that shows the secret.
  // The popup is dismissed by tapping outside it, which leaves this screen as it is.
  const onOk = async () => {
    try {
      const wallet = id.length === 0 ? await WalletsHelper.getActive() : await WalletsHelper.get(id);
      if (wallet && (await PinCodeHelper.hasSavedCode(wallet.profileKey))) {
        setProfileKey(wallet.profileKey);
        setShowPinDialog(true);
        return;
      }
    } catch (e) {
      console.error('WalletBackupCaution: could not prepare the password check', e);
    }
    // Nothing to check against (legacy wallet without a saved password, or no such wallet):
    // the next screen deals with it.
    navigate(backupUrl);
  };

  return (
    <KasaneStage
      back={back || `/wallet/settings?id=${id}`}
      title={mode === 'mnemonic' ? t('common.backup') : t('wallet.private_key_backup_title')}
    >
      <Box sx={{ mb: 5, mt: 1, lineHeight: 1.9 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 1 }}>
          <Box component="img" src={cautionIcon} sx={{ width: 16, height: 16 }} />
          <Typography sx={{ color: 'text.primary' }}>{t(cautionTitleKey)}</Typography>
        </Box>

        <Typography align="center" sx={{ mt: 1, mx: 1, color: 'text.primary', lineHeight: 1.9 }}>
          {cautionMessageLines.map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pb: 4 }}>
        <Button
          variant="contained" color="primary" size="large" sx={{ minWidth: 200 }}
          onClick={onOk}
        >
          OK
        </Button>
      </Box>

      <PasswordDialog
        popup
        open={showPinDialog}
        mode="check"
        profileKey={profileKey}
        onClose={() => setShowPinDialog(false)}
        // The password goes to the next screen through the router state (not the URL), so it
        // does not have to be typed a second time.
        onPass={(pin) => { handOverPassword(pin); navigate(backupUrl); }}
      />
    </KasaneStage>
  );
}
