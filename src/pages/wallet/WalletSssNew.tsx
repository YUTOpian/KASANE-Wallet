import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { isSssAutoAdd, setSssAutoAdd } from '../../lib/sss';
import { useSssAccount } from '../../hooks/useSssAccount';
import { useAppStore } from '../../store/appStore';

// 新規プロファイル →「SSS Extension」。拡張が持っている公開鍵だけを読み、秘密鍵・ニーモニック・パスワードはこの端末に残さない。
// SSS でアカウントを切り替えると、この画面の表示もすぐ切り替わる（useSssAccount が追いかける）。
export default function WalletSssNew() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setAppChain = useAppStore((s) => s.setChain);
  const setAppNetwork = useAppStore((s) => s.setNetwork);
  const { state, account } = useSssAccount();
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(isSssAutoAdd());
  const [errorMessage, setErrorMessage] = useState('');

  const publicKey = account?.publicKey ?? '';
  // 名前は、SSS のアカウント名を初期値にする（自分で直したら、切り替えても上書きしない）。
  useEffect(() => {
    if (!nameEdited) setName(account?.name ?? '');
  }, [account?.name, publicKey, nameEdited]);
  // 表示中のアカウントが、すでにプロファイルにあるか。
  useEffect(() => {
    let cancelled = false;
    setAdded(false);
    if (publicKey !== '') {
      WalletsHelper.hasSssProfile(publicKey).then((has) => { if (!cancelled) setAdded(has); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [publicKey]);

  const onAdd = async () => {
    if (!account || busy) return;
    setBusy(true);
    try {
      await WalletsHelper.addSssProfile(name.trim() || t('sss.default_name'), account.publicKey, true);
      setAppChain('symbol');
      // SSS がテストネットのアカウントなら、アプリも合わせる（署名できるのは、アプリと SSS のネットワークが同じときだけ）。
      setAppNetwork(account.network);
      navigate('/top', { replace: true });
    } catch (err) {
      console.error('Failed to create the SSS profile', err);
      setErrorMessage(t('sss.create_failed'));
      setBusy(false);
    }
  };

  // 連携できていない（SSS が無い・このページが許可されていない）ときは、SSS の文字を出さずに戻す。
  if (state !== 'ready') return <Navigate to="/wallet/new" replace />;

  return (
    <KasaneStage back="/wallet/new" title={t('sss.create_title')} maxWidth={560} panel>
      <Box sx={{ width: '100%', mt: 2 }}>
        <Typography align="center" sx={{ mx: 2, lineHeight: 1.8 }}>
          {(t('sss.create_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 3 }}>
          {account === null && <Alert severity="info">{t('sss.status_no_account')}</Alert>}

          {account && (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 2, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary">{t('sss.current_account')}</Typography>
              <Typography sx={{ fontWeight: 600 }}>{account.name || t('sss.default_name')}</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all', mt: 0.5 }}>{account.address}</Typography>
              <Typography variant="caption" color="text.secondary">{t(account.network === 'mainnet' ? 'sss.network_mainnet' : 'sss.network_testnet')}</Typography>
            </Box>
          )}

          {account && !added && (
            <TextField fullWidth label={t('wallet.name_input')} value={name} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} />
          )}
          {account && added && <Alert severity="success">{t('sss.already_added')}</Alert>}

          <FormControlLabel
            control={<Switch checked={auto} onChange={(e) => { setAuto(e.target.checked); setSssAutoAdd(e.target.checked); }} />}
            label={<Typography variant="body2">{t('sss.auto_add_label')}</Typography>}
          />
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, pb: 3 }}>
          <Button variant="contained" color="primary" size="large" disabled={!account || busy || (!added && name.trim().length === 0)}
            onClick={() => void onAdd()} sx={{ minWidth: 200 }}>
            {added ? t('sss.use_button') : t('sss.create_button')}
          </Button>
          <Typography variant="caption" color="text.secondary" align="center" sx={{ mt: 1.5, mx: 2, lineHeight: 1.7 }}>
            {t('sss.create_note')}
          </Typography>
        </Box>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
