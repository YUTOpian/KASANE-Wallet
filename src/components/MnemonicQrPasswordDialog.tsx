import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { decryptMnemonic } from '../lib/symbol/mnemonicQr';

interface Props {
  /** The encrypted QR that was read; the dialog is open while this is set. */
  qr: { ciphertext: string; salt: string } | null;
  onClose: () => void;
  onDecrypted: (mnemonic: string) => void;
}

/** Asks for the password of an encrypted mnemonic QR and decrypts it. */
export default function MnemonicQrPasswordDialog({ qr, onClose, onDecrypted }: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  useEffect(() => { setPassword(''); setWrong(false); }, [qr]);

  const onSubmit = async () => {
    if (!qr || password === '') return;
    setBusy(true);
    setWrong(false);
    try {
      const phrase = await decryptMnemonic(qr, password);
      if (phrase === null) setWrong(true);
      else onDecrypted(phrase);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={qr !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('wallet.import_qr_password_title')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.import_qr_password_hint')}</Typography>
        <TextField
          fullWidth
          autoFocus
          type="password"
          autoComplete="off"
          label={t('wallet.mnemonic_qr_password_label')}
          value={password}
          onChange={(e) => { setPassword(e.target.value); setWrong(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSubmit(); }}
        />
        {wrong && <Alert severity="error" sx={{ mt: 2 }}>{t('wallet.import_qr_wrong_password')}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={() => { void onSubmit(); }} disabled={busy || password === ''}>{busy ? t('wallet.import_qr_decrypting') : t('wallet.import_qr_decrypt')}</Button>
      </DialogActions>
    </Dialog>
  );
}
