import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { Dialog, Box, IconButton, Typography, TextField, Button, InputAdornment } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { useTranslation } from 'react-i18next';
import { PinCodeHelper, WalletsHelper } from '../lib/storage';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/passwordPolicy';
import { useBlockBackNavigation } from '../lib/useBlockBackNavigation';
import MessageDialog from './MessageDialog';

type PasswordMode = 'check' | 'register';

interface PasswordDialogProps {
  open: boolean;
  // 'check'    - ask for the existing wallet password.
  // 'register' - set a new wallet password (typed twice, directly - no keypad).
  mode?: PasswordMode;
  // どのプロファイルのパスワードか（Wallet.profileKey）。パスワードはプロファイルごとに設定する。
  // 'check'    - 省略するとアクティブなウォレットのプロファイル。
  // 'register' - 省略すると「まだ作られていない新しいプロファイル」用で、入力を検証するだけ
  //              （保存は、プロファイルを作る側が addProfile で行う）。指定すると、そのプロファイルが
  //              旧バージョンの既定パスワードのままなので、新しいパスワードへ移行する。
  profileKey?: string;
  onClose: () => void;
  onPass: (password: string) => void;
  onCancel?: () => void;
  // true  - a small centred popup instead of the full-screen sheet. Tapping anywhere outside the
  //         popup (or Esc) dismisses it, same as the arrow-back of the full-screen version, and
  //         the browser back button is not blocked.
  popup?: boolean;
}

// Passwords are typed straight into a text field (never a numeric keypad). Registration needs at
// least this many characters; checking an existing password accepts anything, so a wallet that
// was protected by an older 6-digit PIN can still be unlocked with it.
export { MIN_PASSWORD_LENGTH } from '../lib/passwordPolicy';
// bcrypt (used for the saved check-hash in PinCodeHelper) only looks at the first 72 bytes, so a
// longer password would be only partly verified by the check step. Refuse it up front instead.
const MAX_PASSWORD_BYTES = 72;
// Consecutive wrong entries allowed at the "check" step before the dialog gives up and lets the
// person leave (the storage-backed lockout in PinCodeHelper still applies on top of this).
const MAX_ATTEMPTS = 3;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * The wallet-password dialog. Replaces the old 6-digit PIN keypad dialog: the password is typed
 * directly into a text field. Callers keep the same contract as before - onPass receives the
 * password, which is what wallet secrets are encrypted with (WalletsHelper.decryptKey etc.).
 *
 * Storage note: the saved check-hash, wrong-attempt counter and lockout still live in
 * PinCodeHelper under their original storage keys, so existing installs keep working (a wallet
 * set up with a 6-digit PIN just has a 6-character password now).
 */
export default function PasswordDialog({ open, mode = 'check', profileKey, onClose, onPass, onCancel, popup = false }: PasswordDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showText, setShowText] = useState(false);
  const [fieldError, setFieldError] = useState('');
  // Which field the error belongs to (so only that one is outlined red).
  const [errorOn, setErrorOn] = useState<'password' | 'confirm'>('password');
  const [busy, setBusy] = useState(false);
  const [showRegistrationInfo, setShowRegistrationInfo] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [checkErrorCount, setCheckErrorCount] = useState(0);
  const [showCheckFailedLimit, setShowCheckFailedLimit] = useState(false);
  // Milliseconds left of a storage-backed lockout (see PinCodeHelper.check); 0 = not locked.
  const [lockoutRemainingMs, setLockoutRemainingMs] = useState(0);

  // While open, block the browser/hardware back so password entry can't be bypassed by backing
  // out. The in-app arrow-back below still works via cancel() (which calls bypassNext() first).
  const { bypassNext } = useBlockBackNavigation(open && !popup);

  // 確認の対象のプロファイル。明示されていなければ、いまアクティブなウォレットのプロファイル。
  const resolveProfileKey = useCallback(async (): Promise<string> => {
    if (profileKey) {
      return profileKey;
    }
    return (await WalletsHelper.getActiveAny())?.profileKey ?? '';
  }, [profileKey]);

  const reset = useCallback(() => {
    setPassword('');
    setConfirm('');
    setShowText(false);
    setFieldError('');
    setErrorOn('password');
    setBusy(false);
    setCheckErrorCount(0);
  }, []);

  useEffect(() => {
    if (open) {
      setShowRegistrationInfo(mode === 'register');
      reset();
      resolveProfileKey()
        .then((key) => PinCodeHelper.getLockoutRemainingMs(key))
        .then(setLockoutRemainingMs);
    } else {
      setLockoutRemainingMs(0);
    }
  }, [open, mode, reset, resolveProfileKey]);

  // Ticks the lockout countdown down once a second so the field re-enables itself on expiry.
  useEffect(() => {
    if (!open || lockoutRemainingMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      setLockoutRemainingMs((prev) => Math.max(prev - 1000, 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [open, lockoutRemainingMs > 0]);

  const closeView = (finalPassword: string) => {
    onClose();
    onPass(finalPassword);
    reset();
  };

  const cancel = () => {
    // Some callers' onCancel (e.g. WalletDelete's) itself navigates backwards - let that one
    // intentional navigation through instead of it being caught by our own blocker.
    bypassNext();
    onClose();
    onCancel?.();
    reset();
  };

  const submitCheck = async () => {
    const key = await resolveProfileKey();
    const remaining = await PinCodeHelper.getLockoutRemainingMs(key);
    if (remaining > 0) {
      setPassword('');
      setLockoutRemainingMs(remaining);
      return;
    }
    if (await PinCodeHelper.check(key, password)) {
      closeView(password);
      return;
    }
    setPassword('');
    const next = checkErrorCount + 1;
    setCheckErrorCount(next);
    // The third wrong try also starts the storage-backed lockout; show it right away.
    PinCodeHelper.getLockoutRemainingMs(key).then(setLockoutRemainingMs);
    if (next >= MAX_ATTEMPTS) {
      setShowCheckFailedLimit(true);
    } else {
      setFieldError(t('common.password_wrong'));
    }
  };

  const submitRegister = async () => {
    const problem = passwordProblem(password);
    if (problem === 'too_short') {
      setFieldError(t('common.password_too_short', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (problem === 'weak') {
      setFieldError(t('common.password_weak'));
      return;
    }
    if (byteLength(password) > MAX_PASSWORD_BYTES) {
      setFieldError(t('common.password_too_long'));
      return;
    }
    if (password !== confirm) {
      setErrorOn('confirm');
      setFieldError(t('common.password_mismatch'));
      return;
    }
    if (!profileKey) {
      // 新しいプロファイル用：ここでは検証だけ。保存は、プロファイルを作る側（addProfile）が行う。
      setShowSuccess(true);
      return;
    }
    // 旧バージョンの既定パスワードで暗号化されたプロファイルを、新しいパスワードへ移行する。
    // 失敗した場合に check-hash だけ更新してしまうと復号できなくなるので、先に結果を確認する。
    if (await WalletsHelper.encryptProfile(profileKey, PinCodeHelper.defaultPin, password)) {
      await PinCodeHelper.setForProfile(profileKey, password);
      setShowSuccess(true);
    } else {
      cancel();
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || lockoutRemainingMs > 0) {
      return;
    }
    setFieldError('');
    setErrorOn('password');
    setBusy(true);
    try {
      if (mode === 'check') {
        await submitCheck();
      } else {
        await submitRegister();
      }
    } finally {
      setBusy(false);
    }
  };

  const locked = lockoutRemainingMs > 0;
  const isRegister = mode === 'register';
  const canSubmit = !busy && !locked && password.length > 0 && (!isRegister || confirm.length > 0);

  const visibilityToggle = (
    <InputAdornment position="end">
      <IconButton
        aria-label={showText ? t('common.password_hide') : t('common.password_show')}
        onClick={() => setShowText((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        edge="end"
      >
        {showText ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
      </IconButton>
    </InputAdornment>
  );

  return (
    // onClose fires for a click on the backdrop (outside the popup) and for Esc: both cancel.
    <Dialog fullScreen={!popup} fullWidth={popup} maxWidth={popup ? 'xs' : false} open={open} onClose={cancel}>
      <Box sx={{ bgcolor: 'background.default', minHeight: popup ? undefined : '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', pt: popup ? 3 : 2, pb: popup ? 3 : 0 }}>
        {!popup && (
          <IconButton onClick={cancel} aria-label={t('common.close')} sx={{ alignSelf: 'flex-start', ml: 1 }}>
            <ArrowBackIcon />
          </IconButton>
        )}

        <Box component="form" onSubmit={onSubmit} noValidate sx={{ width: '100%', maxWidth: 420, px: 3, mt: popup ? 0 : 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography align="center" sx={{ fontWeight: 'bold', fontSize: 'large' }}>
            {isRegister ? t('common.password_settings') : t('common.password_label_check')}
          </Typography>

          <TextField
            autoFocus
            fullWidth
            type={showText ? 'text' : 'password'}
            label={isRegister ? t('common.password_label_new') : t('common.password_label')}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setFieldError(''); }}
            disabled={locked}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            error={!!fieldError && errorOn === 'password'}
            helperText={isRegister ? t('common.password_hint', { count: MIN_PASSWORD_LENGTH }) : undefined}
            slotProps={{ input: { endAdornment: visibilityToggle } }}
          />

          {isRegister && (
            <TextField
              fullWidth
              type={showText ? 'text' : 'password'}
              label={t('common.password_label_confirm')}
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setFieldError(''); }}
              autoComplete="new-password"
              error={!!fieldError && errorOn === 'confirm'}
            />
          )}

          {fieldError && (
            <Typography color="error" variant="body2" role="alert" align="center">
              {fieldError}
            </Typography>
          )}

          {locked && (
            <Typography variant="body2" align="center" sx={{ opacity: 0.85 }}>
              {(t('common.password_locked', { returnObjects: true, seconds: Math.ceil(lockoutRemainingMs / 1000) }) as string[]).join(' ')}
            </Typography>
          )}

          <Button type="submit" variant="contained" size="large" fullWidth disabled={!canSubmit} sx={{ py: 1.4 }}>
            {isRegister ? t('common.password_set') : t('common.ok')}
          </Button>
        </Box>
      </Box>

      <MessageDialog
        open={showRegistrationInfo}
        title={t('common.password_settings')}
        texts={t('common.password_registration_message', { returnObjects: true }) as string[]}
        onClose={() => setShowRegistrationInfo(false)}
      />
      <MessageDialog
        open={showSuccess}
        title={t('common.success')}
        texts={t('common.password_registration_complete', { returnObjects: true }) as string[]}
        onClose={() => { setShowSuccess(false); closeView(password); }}
      />
      {/* MAX_ATTEMPTS wrong entries at the "check" step - give up and leave, same as tapping the
          arrow-back, instead of leaving the person stuck retrying forever. */}
      <MessageDialog
        open={showCheckFailedLimit}
        title={t('common.error')}
        texts={t('common.password_check_failed_limit', { returnObjects: true }) as string[]}
        onClose={() => { setShowCheckFailedLimit(false); cancel(); }}
        variant="error"
      />
    </Dialog>
  );
}
