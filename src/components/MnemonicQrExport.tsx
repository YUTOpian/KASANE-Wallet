import { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import QrTextDialog from './QrTextDialog';
import { buildMnemonicQr, MNEMONIC_QR_MIN_PASSWORD } from '../lib/symbol/mnemonicQr';

/** "暗号化QRを作る": asks for a password for the QR itself, then shows the encrypted mnemonic QR (with a PNG download). */
export default function MnemonicQrExport({ mnemonic }: { mnemonic: string }) {
  const { t } = useTranslation();
  const [askOpen, setAskOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [qrText, setQrText] = useState('');

  const close = () => { setAskOpen(false); setPassword(''); setConfirm(''); setError(''); };

  const onMake = () => {
    if (password.length < MNEMONIC_QR_MIN_PASSWORD) {
      setError(t('wallet.mnemonic_qr_password_short', { count: MNEMONIC_QR_MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t('wallet.mnemonic_qr_password_mismatch'));
      return;
    }
    try {
      setQrText(buildMnemonicQr(mnemonic, password));
      close();
    } catch (e) {
      console.error('Failed to make the mnemonic QR', e);
      setError(t('wallet.mnemonic_qr_failed'));
    }
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5, px: 2 }}>
      <Button variant="outlined" color="primary" disabled={mnemonic === ''} onClick={() => setAskOpen(true)}>{t('wallet.mnemonic_qr_button')}</Button>

      <Dialog open={askOpen} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>{t('wallet.mnemonic_qr_title')}</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.mnemonic_qr_ask_hint')}</Typography>
          <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.mnemonic_qr_password_label')} value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} sx={{ mb: 2 }} />
          <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.mnemonic_qr_password_confirm_label')} value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
          {error !== '' && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={onMake} disabled={password === '' || confirm === ''}>{t('wallet.mnemonic_qr_make')}</Button>
        </DialogActions>
      </Dialog>

      <QrTextDialog
        open={qrText !== ''}
        title={t('wallet.mnemonic_qr_title')}
        hint={t('wallet.mnemonic_qr_hint')}
        text={qrText}
        note={t('wallet.mnemonic_qr_note')}
        onClose={() => setQrText('')}
      />
    </Box>
  );
}
