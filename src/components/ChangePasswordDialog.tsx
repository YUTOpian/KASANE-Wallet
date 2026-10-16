import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { MIN_PASSWORD_LENGTH } from './PasswordDialog';
import { PinCodeHelper, WalletsHelper } from '../lib/storage';
import { clearHomeCache } from '../lib/homeCache';

const byteLength = (s: string) => new TextEncoder().encode(s).length;
// bcrypt (the saved check-hash) only reads the first 72 bytes - same limit as at registration.
const MAX_PASSWORD_BYTES = 72;

interface Props {
  open: boolean;
  profileKey: string;
  onClose: () => void;
  onChanged: () => void;
}

/** プロファイルのパスワードを変更するダイアログ（いまのパスワード → 新しいパスワード2回）。 */
export default function ChangePasswordDialog({ open, profileKey, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(''); };
  const close = () => { if (busy) return; reset(); onClose(); };

  const submit = async () => {
    if (busy) return;
    if (next.length < MIN_PASSWORD_LENGTH) { setError(t('common.password_too_short', { count: MIN_PASSWORD_LENGTH })); return; }
    if (byteLength(next) > MAX_PASSWORD_BYTES) { setError(t('common.password_too_long')); return; }
    if (next !== confirm) { setError(t('common.password_mismatch')); return; }
    if (next === current) { setError(t('wallet.change_password_same')); return; }
    setBusy(true);
    try {
      const result = await WalletsHelper.changeProfilePassword(profileKey, current, next);
      if (result === 'ok') {
        clearHomeCache();
        reset();
        onChanged();
        return;
      }
      if (result === 'wrong') {
        const remaining = await PinCodeHelper.getLockoutRemainingMs(profileKey);
        setError(remaining > 0
          ? (t('common.password_locked', { returnObjects: true, seconds: Math.ceil(remaining / 1000) }) as string[]).join(' ')
          : t('common.password_wrong'));
      } else {
        setError(t('wallet.change_password_error'));
      }
    } catch {
      setError(t('wallet.change_password_error'));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && current.length > 0 && next.length > 0 && confirm.length > 0;

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{t('wallet.change_password_title')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ lineHeight: 1.8, mb: 2 }}>
          {(t('wallet.change_password_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            type="password" label={t('wallet.change_password_current')} value={current}
            onChange={(e) => { setCurrent(e.target.value); setError(''); }}
            autoComplete="current-password" autoFocus fullWidth
          />
          <TextField
            type="password" label={t('common.password_label_new')} value={next}
            onChange={(e) => { setNext(e.target.value); setError(''); }}
            autoComplete="new-password" fullWidth
            helperText={t('common.password_hint', { count: MIN_PASSWORD_LENGTH })}
          />
          <TextField
            type="password" label={t('common.password_label_confirm')} value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setError(''); }}
            autoComplete="new-password" fullWidth
            error={!!error} helperText={error || undefined}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'center', gap: 2, pb: 2.5 }}>
        <Button variant="outlined" color="primary" disabled={busy} onClick={close}>CANCEL</Button>
        <Button variant="contained" color="primary" disabled={!canSubmit} onClick={submit}>{t('wallet.change_password_submit')}</Button>
      </DialogActions>
    </Dialog>
  );
}
