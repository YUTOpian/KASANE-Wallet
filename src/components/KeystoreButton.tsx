import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { useTranslation } from 'react-i18next';
import { addressOf, saveFile } from '../lib/paperWalletExport';
import { buildKeystore, buildPlainKeyFile, keystoreFilename, KEYSTORE_MIN_PASSWORD } from '../lib/keystore';
import { getNetwork } from '../lib/symbol/network';
import type { ChainKey } from '../lib/chain';

export interface KeystoreSource {
  chain: ChainKey;
  privateKey: string;
  publicKey: string;
}

// "Download keystore": a JSON file with the account's private key and public key. By default the private
// key is encrypted with a password chosen here (separate from the wallet password); the person can also
// choose a plain file, after a clear warning. Built on this device (see lib/keystore.ts).
export default function KeystoreButton({ source }: { source: KeystoreSource | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (source == null) return null;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setEncrypt(true);
    setPassword('');
    setConfirm('');
    setError('');
  };

  const onDownload = async () => {
    if (encrypt) {
      if (password.length < KEYSTORE_MIN_PASSWORD) {
        setError(t('wallet.keystore_password_short', { count: KEYSTORE_MIN_PASSWORD }));
        return;
      }
      if (password !== confirm) {
        setError(t('wallet.keystore_password_mismatch'));
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      const account = {
        chain: source.chain,
        network: getNetwork(),
        address: addressOf(source.chain, source.publicKey),
        privateKey: source.privateKey,
        publicKey: source.publicKey,
      };
      const text = encrypt ? await buildKeystore(account, password) : buildPlainKeyFile(account);
      await saveFile(new TextEncoder().encode(text), keystoreFilename(account, encrypt), 'application/json');
      setBusy(false);
      close();
    } catch (e) {
      // Never log the secret itself - only that something went wrong.
      console.error('KeystoreButton: failed to build the keystore', e instanceof Error ? e.message : 'unknown error');
      setError(t('wallet.keystore_failed'));
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, mx: 2 }}>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>{t('wallet.keystore_hint')}</Typography>
      <Button variant="outlined" color="primary" onClick={() => setOpen(true)} startIcon={<KeyOutlinedIcon />} sx={{ minWidth: 260 }}>
        {t('wallet.keystore_download')}
      </Button>

      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>{t('wallet.keystore_title')}</DialogTitle>
        <DialogContent>
          <FormControlLabel
            control={<Switch checked={encrypt} onChange={(e) => { setEncrypt(e.target.checked); setError(''); }} />}
            label={t('wallet.keystore_encrypt')}
            sx={{ mb: 1 }}
          />
          {encrypt ? (
            <>
              <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.keystore_ask_hint')}</Typography>
              <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.keystore_password_label')} value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} sx={{ mb: 2 }} />
              <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.keystore_password_confirm_label')} value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
              <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 2 }}>{t('wallet.keystore_note')}</Typography>
            </>
          ) : (
            <Alert severity="warning">{t('wallet.keystore_plain_warning')}</Alert>
          )}
          {error !== '' && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => { void onDownload(); }}
            disabled={busy || (encrypt && (password === '' || confirm === ''))}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {busy ? t('wallet.keystore_creating') : t('wallet.keystore_save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
