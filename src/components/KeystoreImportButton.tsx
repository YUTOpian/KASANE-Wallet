import { useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from './ErrorSnackbar';
import { KEYSTORE_MAX_FILE_CHARS, peekKeystore, readKeystore } from '../lib/keystore';
import type { KeystoreAccount, KeystoreHeader } from '../lib/keystore';
import { CHAINS } from '../lib/chain';
import { NETWORKS } from '../lib/symbol/constants';
import { prettyAddress } from '../lib/symbol/crypto';
import { prettyNemAddress } from '../lib/nem/crypto';

interface Props {
  /** Called with the account (private key included) once the file has been read and its key and address agree. */
  onLoaded: (account: KeystoreAccount) => void;
  /** Show the one-line explanation under the button (default: yes). */
  hint?: boolean;
  variant?: 'text' | 'outlined';
}

/**
 * "キーストアファイルから読み込む": picks a keystore file written by this wallet (バックアップ → キーストア) and reads it.
 *  - encrypted file: asks for the keystore's password, shows which account it holds;
 *  - plain key file (private key in the clear): warns first, and reads it only after the person confirms.
 * The file's text and the password live in this component's state only until the dialog closes.
 */
export default function KeystoreImportButton({ onLoaded, hint = true, variant = 'outlined' }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<{ text: string; header: KeystoreHeader } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pickError, setPickError] = useState('');

  const close = () => {
    setFile(null);
    setPassword('');
    setError('');
  };

  const onPicked = async (picked: File | undefined) => {
    if (!picked) return;
    try {
      if (picked.size > KEYSTORE_MAX_FILE_CHARS * 4) throw new Error('invalid_keystore');
      const text = await picked.text();
      const header = peekKeystore(text);
      setPassword('');
      setError('');
      setFile({ text, header });
    } catch {
      setPickError(t('wallet.keystore_invalid_file'));
    }
  };

  const load = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const account = await readKeystore(file.text, file.header.encrypted ? password : '');
      close();
      onLoaded(account);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(t(code === 'wrong_password' ? 'wallet.keystore_wrong_password' : code === 'key_mismatch' ? 'wallet.keystore_key_mismatch' : 'wallet.keystore_invalid_file'));
    } finally {
      setBusy(false);
    }
  };

  const header = file?.header ?? null;
  const address = header ? (header.chain === 'nem' ? prettyNemAddress(header.address) : prettyAddress(header.address)) : '';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* No `accept`: iOS greys out files it does not know the extension of. */}
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ''; void onPicked(picked); }}
      />
      <Button variant={variant} startIcon={<UploadFileOutlinedIcon />} onClick={() => inputRef.current?.click()}>
        {t('wallet.keystore_import_button')}
      </Button>
      {hint && (
        <Typography variant="caption" color="text.secondary" align="center" sx={{ mt: 0.5 }}>{t('wallet.keystore_import_hint')}</Typography>
      )}

      <Dialog open={header !== null} onClose={busy ? undefined : close} maxWidth="xs" fullWidth>
        <DialogTitle>{header?.encrypted === false ? t('wallet.keystore_plain_title') : t('wallet.keystore_open_title')}</DialogTitle>
        <DialogContent>
          {header?.encrypted === false && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {(t('wallet.keystore_plain_message', { returnObjects: true }) as string[]).map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </Alert>
          )}
          {header && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {t('wallet.keystore_open_message', { chain: CHAINS[header.chain].name, network: NETWORKS[header.network].label })}
              </Typography>
              <Typography variant="body2" sx={{ mb: 1, wordBreak: 'break-all', fontFamily: 'monospace' }}>{address}</Typography>
            </>
          )}
          {header?.encrypted && (
            <TextField
              fullWidth
              autoFocus
              type="password"
              autoComplete="off"
              label={t('wallet.keystore_password_label')}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && password !== '') void load(); }}
              error={error !== ''}
              helperText={error !== '' ? error : ' '}
              sx={{ mt: 1 }}
            />
          )}
          {header?.encrypted === false && error !== '' && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          {header?.encrypted === false ? (
            <Button variant="contained" color="warning" onClick={() => { void load(); }} disabled={busy}>{t('wallet.keystore_plain_confirm')}</Button>
          ) : (
            <Button variant="contained" onClick={() => { void load(); }} disabled={busy || password === ''}>
              {busy ? t('wallet.import_qr_decrypting') : t('wallet.import_qr_decrypt')}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <ErrorSnackbar message={pickError} onClose={() => setPickError('')} />
    </Box>
  );
}
