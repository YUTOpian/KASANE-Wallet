import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { useTranslation } from 'react-i18next';
import { saveFile } from '../lib/paperWalletExport';
import { getNetworkConfig } from '../lib/symbol/network';
import { buildWlt, wltFilename, WLT_MIN_PASSWORD } from '../lib/nem/wlt';

export interface WltSource {
  /** Default wallet name written into the file. */
  name: string;
  privateKey: string;
  publicKey: string;
}

// "Export wallet file (.wlt)": the NEM wallet file of the official NEM wallet, so the account can be read back
// there. The private key is sealed with a password chosen here (separate from the KASANE wallet password).
// Built on this device (see lib/nem/wlt.ts) - NEM accounts only.
export default function WltButton({ source }: { source: WltSource | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (source == null) return null;

  const openDialog = () => {
    setName(source.name);
    setOpen(true);
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setName('');
    setPassword('');
    setConfirm('');
    setError('');
  };

  const onDownload = async () => {
    if (name.trim() === '') {
      setError(t('wallet.wlt_name_required'));
      return;
    }
    if (password.length < WLT_MIN_PASSWORD) {
      setError(t('wallet.wlt_password_short', { count: WLT_MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t('wallet.wlt_password_mismatch'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const text = buildWlt({ name, privateKey: source.privateKey, publicKey: source.publicKey, networkByte: getNetworkConfig().networkByte }, password);
      await saveFile(new TextEncoder().encode(text), wltFilename(name), 'application/octet-stream');
      setBusy(false);
      close();
    } catch (e) {
      // Never log the secret itself - only that something went wrong.
      console.error('WltButton: failed to build the wallet file', e instanceof Error ? e.message : 'unknown error');
      setError(t('wallet.wlt_failed'));
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, mx: 2 }}>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>{t('wallet.wlt_hint')}</Typography>
      <Button variant="outlined" color="primary" onClick={openDialog} startIcon={<FileDownloadOutlinedIcon />} sx={{ minWidth: 260 }}>
        {t('wallet.wlt_download')}
      </Button>

      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>{t('wallet.wlt_title')}</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.wlt_ask_hint')}</Typography>
          <TextField fullWidth label={t('wallet.wlt_name_label')} value={name} onChange={(e) => { setName(e.target.value); setError(''); }} sx={{ mb: 2 }} />
          <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.wlt_password_label')} value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} sx={{ mb: 2 }} />
          <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.wlt_password_confirm_label')} value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
          <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 2 }}>{t('wallet.wlt_note')}</Typography>
          {error !== '' && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => { void onDownload(); }}
            disabled={busy || name.trim() === '' || password === '' || confirm === ''}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {busy ? t('wallet.keystore_creating') : t('wallet.keystore_save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
