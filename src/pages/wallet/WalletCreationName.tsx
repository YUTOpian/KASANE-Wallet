import { useState, type FormEvent } from 'react';
import { Box, TextField, Button, Typography, IconButton, InputAdornment, Link as MuiLink } from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import { MIN_PASSWORD_LENGTH } from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { MnemonicHelper } from '../../lib/symbol/hd';
import { profileAccounts } from '../../lib/accounts';
import ChainPicker from '../../components/ChainPicker';
import { useAppStore } from '../../store/appStore';
import type { ChainKey } from '../../lib/chain';

export default function WalletCreationName() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const currentChain = useAppStore((s) => s.chain);
  const setAppChain = useAppStore((s) => s.setChain);
  // 新しいプロファイルで最初に開くチェーン（Symbol / NEM）。作成が成功したときにアプリの現在のチェーンにする。
  const [selectedChain, setSelectedChain] = useState<ChainKey>(currentChain);
  const [walletName, setWalletName] = useState('');
  // インデックス 0 のウォレットにつける名前（任意）。
  const [indexZeroName, setIndexZeroName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  // パスワードはプロファイルごとに設定する。新しいプロファイルには、この画面で新しいパスワードを
  // 2回入力して設定する（ほかのプロファイルのパスワードとは別）。
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showText, setShowText] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [errorOn, setErrorOn] = useState<'password' | 'confirm'>('password');
  const [busy, setBusy] = useState(false);

  // パスワードの設定が済んだあとに呼ばれる。`pin` はこの新しいプロファイルを守るパスワード。
  // 新規プロファイルは、必ず新しく生成したニーモニックと紐づく。そのニーモニックから
  // インデックス 0〜N-1 のアカウントをあらかじめ導出して保存しておくので、あとから「ウォレット切り替え」
  // で別のインデックスのアカウントを選ぶときには、パスワードの入力も設定も要らない。
  const onPinReady = async (pin: string) => {
    try {
      // busy 表示が先に描画されるよう、重い導出の前に1回だけ描画を譲る。
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 保存・ニーモニック表示画面（チェーンごとの案内文）に進む前に、選んだチェーンに切り替える。
      setAppChain(selectedChain);
      const phrase = MnemonicHelper.generate();
      const accounts = profileAccounts(phrase); // Symbol and NEM accounts of the same phrase
      const wallets = await WalletsHelper.createProfileWithMnemonic(walletName, phrase, pin, accounts, indexZeroName.trim());
      const first = wallets[0];
      await WalletsHelper.addProfile(wallets, first.id, pin);
      // `pin` はURLではなくルーターの state で渡す（ニーモニック表示画面で3回目のパスワード入力を
      // 求めずに、生成したばかりのニーモニックを復号して表示するため）。
      navigate(`/wallet/creation/mnemonic?id=${first.id}`, { state: { pin } });
    } catch (e) {
      // Never let an unexpected error leave the OK button looking like it did nothing.
      setErrorMessage(t('wallet.creation_failed'));
      setBusy(false);
    }
  };

  // 名前・パスワードを検証して、ウォレット（プロファイル）を作る。
  const createWallet = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || walletName.length === 0) {
      return;
    }
    setFieldError('');
    setErrorOn('password');
    setBusy(true);

    // register
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(t('common.password_too_short', { count: MIN_PASSWORD_LENGTH }));
      setBusy(false);
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      setFieldError(t('common.password_too_long'));
      setBusy(false);
      return;
    }
    if (password !== confirm) {
      setErrorOn('confirm');
      setFieldError(t('common.password_mismatch'));
      setBusy(false);
      return;
    }
    await onPinReady(password);
  };

  const canSubmit = !busy && walletName.length > 0 && password.length > 0 && confirm.length > 0;

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
    <KasaneStage back="/wallet/new" title={t('wallet.name_title')} maxWidth={440}>
      <Box component="form" onSubmit={createWallet} noValidate sx={{ width: '100%' }}>
        <Box sx={{ mt: 3 }}>
          <ChainPicker value={selectedChain} onChange={setSelectedChain} />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          <TextField
            id="walletName"
            fullWidth
            autoFocus
            label={t('wallet.name_input')}
            value={walletName}
            onChange={(e) => setWalletName(e.target.value)}
          />

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

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3 }}>
          <Button type="submit" variant="contained" color="primary" size="large" disabled={!canSubmit} sx={{ minWidth: 160 }}>
            OK
          </Button>
        </Box>

        <Typography align="center" variant="caption" sx={{ display: 'block', mt: 4, pb: 3 }}>
          {t('common.privacy_policy_caution')}<br />
          <MuiLink component={Link} to="/" underline="always">{t('common.privacy_policy')}</MuiLink>
        </Typography>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
