import { useState, type FormEvent } from 'react';
import { Box, TextField, Button, Typography, IconButton, InputAdornment } from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../../lib/passwordPolicy';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { MnemonicHelper } from '../../lib/symbol/hd';
import { getPendingCreation, setPendingCreation } from '../../lib/pendingCreation';
import ChainPicker from '../../components/ChainPicker';
import { useAppStore } from '../../store/appStore';
import type { ChainKey } from '../../lib/chain';

export default function WalletCreationName() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const currentChain = useAppStore((s) => s.chain);
  const setAppChain = useAppStore((s) => s.setChain);
  // 新しいプロファイルで最初に開くチェーン（Symbol / NEM）。作成が成功したときにアプリの現在のチェーンにする。
  // ニーモニック画面から戻ってきたときは、入力済みの内容をそのまま表示する（まだ端末には保存していない）。
  const draft = getPendingCreation();
  const [selectedChain, setSelectedChain] = useState<ChainKey>(draft?.chain ?? currentChain);
  const [walletName, setWalletName] = useState(draft?.name ?? '');
  // インデックス 0 のウォレットにつける名前（任意）。
  const [indexZeroName, setIndexZeroName] = useState(draft?.indexZeroName ?? '');
  const [errorMessage, setErrorMessage] = useState('');
  // パスワードはプロファイルごとに設定する。新しいプロファイルには、この画面で新しいパスワードを
  // 2回入力して設定する（ほかのプロファイルのパスワードとは別）。
  const [password, setPassword] = useState(draft?.password ?? '');
  const [confirm, setConfirm] = useState(draft?.password ?? '');
  const [showText, setShowText] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [errorOn, setErrorOn] = useState<'password' | 'confirm'>('password');
  const [busy, setBusy] = useState(false);

  // パスワードの設定が済んだあとに呼ばれる。`pin` はこの新しいプロファイルを守るパスワード。
  // ここでは端末に何も保存しない。ニーモニックを生成してメモリに持ち、ニーモニック画面の確認テストを
  // 通過したときに、はじめてプロファイル（インデックス 0〜N-1 のアカウント）を端末に保存する。
  const onPinReady = async (pin: string) => {
    try {
      // 保存・ニーモニック表示画面（チェーンごとの案内文）に進む前に、選んだチェーンに切り替える。
      setAppChain(selectedChain);
      // 戻ってきて同じ内容で進むときは、すでに控えたかもしれないので同じニーモニックを使う。
      const phrase = getPendingCreation()?.phrase ?? MnemonicHelper.generate();
      setPendingCreation({ chain: selectedChain, name: walletName, indexZeroName: indexZeroName.trim(), password: pin, phrase });
      navigate('/wallet/creation/mnemonic');
    } catch {
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
    const problem = passwordProblem(password);
    if (problem === 'too_short') {
      setFieldError(t('common.password_too_short', { count: MIN_PASSWORD_LENGTH }));
      setBusy(false);
      return;
    }
    if (problem === 'weak') {
      setFieldError(t('common.password_weak'));
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
    <KasaneStage onBack={() => navigate('/wallet/new', { replace: true })} back="/wallet/new" title={t('wallet.name_title')} maxWidth={440} panel>
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

      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
