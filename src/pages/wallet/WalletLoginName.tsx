import { useEffect, useState, type FormEvent } from 'react';
import { Box, TextField, Button, Typography, IconButton, InputAdornment } from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import { MIN_PASSWORD_LENGTH } from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { profileAccounts } from '../../lib/accounts';
import { clearPendingImport, getPendingImport } from '../../lib/pendingImport';
import { useAppStore } from '../../store/appStore';

// Second step of importing a recovery phrase: set the profile name, the name of the index-0 wallet and
// the password (typed twice), then create the profile from the phrase typed on the previous screen.
export default function WalletLoginName() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setAppChain = useAppStore((s) => s.setChain);
  const [name, setName] = useState('');
  const [indexZeroName, setIndexZeroName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showText, setShowText] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [errorOn, setErrorOn] = useState<'password' | 'confirm'>('password');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // The phrase only lives in memory: after a reload (or when opened directly) start over at the import screen.
  const hasPending = getPendingImport() !== null;
  useEffect(() => {
    if (!hasPending) navigate('/wallet/login/import', { replace: true });
  }, [hasPending, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const pending = getPendingImport();
    if (busy || !pending || name.length === 0) return;
    setFieldError('');
    setErrorOn('password');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(t('common.password_too_short', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      setFieldError(t('common.password_too_long'));
      return;
    }
    if (password !== confirm) {
      setErrorOn('confirm');
      setFieldError(t('common.password_mismatch'));
      return;
    }
    setBusy(true);
    try {
      // Let the busy state paint before the (heavy) key derivation.
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Accounts at index 0..N-1 are derived up front, same as for a newly created profile.
      const accounts = profileAccounts(pending.phrase); // Symbol and NEM accounts of the same phrase
      const wallets = await WalletsHelper.createProfileWithMnemonic(name, pending.phrase, password, accounts, indexZeroName.trim());
      // 選んだインデックスは最初から表示する（残りは、これまでどおりウォレット切り替え画面で表示できる）。
      // インデックス 0 も必須ではない：選ばれなかったものは非表示にする（何も選ばなければ 0 が選ばれている）。
      for (const wallet of wallets) {
        if (wallet.accountIndex !== null) wallet.hidden = !pending.shownIndexes[wallet.chain].includes(wallet.accountIndex);
      }
      // 最初に開くのは、選んだチェーンの、表示されている中でいちばん小さいインデックス。
      const active = wallets
        .filter((w) => w.chain === pending.chain && !w.hidden)
        .sort((a, b) => (a.accountIndex ?? 0) - (b.accountIndex ?? 0))[0] ?? wallets[0];
      await WalletsHelper.addProfile(wallets, active.id, password);
      setAppChain(pending.chain);
      clearPendingImport();
      navigate('/wallet/login/end');
    } catch {
      setErrorMessage(t('wallet.invalid_mnemonic'));
      setBusy(false);
    }
  };

  const canSubmit = !busy && hasPending && name.length > 0 && password.length > 0 && confirm.length > 0;

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
    <KasaneStage back="/wallet/login/accounts" title={t('wallet.login_name_title')} maxWidth={440} panel>
      <Box component="form" onSubmit={onSubmit} noValidate sx={{ width: '100%', mt: 2 }}>
        <Typography align="center" sx={{ mx: 2 }}>
          {(t('wallet.login_name_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          <TextField id="name" fullWidth autoFocus label={t('wallet.name_input')} value={name} onChange={(e) => setName(e.target.value)} />

          <TextField
            id="indexZeroName"
            fullWidth
            label={t('wallet.name_index0_input')}
            helperText={t('wallet.name_index0_hint')}
            value={indexZeroName}
            onChange={(e) => setIndexZeroName(e.target.value)}
          />

          <Typography align="center" sx={{ fontWeight: 'bold', mt: 1 }}>
            {t('common.password_settings')}
          </Typography>
          <TextField
            fullWidth
            type={showText ? 'text' : 'password'}
            label={t('common.password_label_new')}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setFieldError(''); }}
            autoComplete="new-password"
            error={!!fieldError && errorOn === 'password'}
            helperText={t('common.password_hint', { count: MIN_PASSWORD_LENGTH })}
            slotProps={{ input: { endAdornment: visibilityToggle } }}
          />
          <TextField
            fullWidth
            type={showText ? 'text' : 'password'}
            label={t('common.password_label_confirm')}
            value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setFieldError(''); }}
            autoComplete="new-password"
            error={!!fieldError && errorOn === 'confirm'}
          />

          {fieldError && (
            <Typography color="error" variant="body2" role="alert" align="center">
              {fieldError}
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, pb: 3 }}>
          <Button type="submit" variant="contained" color="primary" size="large" disabled={!canSubmit} sx={{ minWidth: 160 }}>
            OK
          </Button>
        </Box>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
