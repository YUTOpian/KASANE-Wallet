import { useMemo, useState, type FormEvent } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { parseWatchAddress } from '../../lib/watchAddress';
import { CHAINS } from '../../lib/chain';
import { NETWORKS } from '../../lib/symbol/constants';
import { prettyChainAddressOf } from '../../lib/watchAddressView';
import { useAppStore } from '../../store/appStore';

// 新規プロファイル →「閲覧用」。アドレスを入力して、そのアドレスの残高・モザイク・取引履歴を見るためのプロファイル。
// Symbol / NEM はアドレスの長さで、メインネット / テストネットは先頭の文字で自動判定する。
// 秘密鍵もパスワードも持たないので、送金などの署名が要る操作は画面に出ない。
export default function WalletWatchNew() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setAppChain = useAppStore((s) => s.setChain);
  const setAppNetwork = useAppStore((s) => s.setNetwork);
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const parsed = useMemo(() => (address.trim() === '' ? null : parseWatchAddress(address)), [address]);
  const showInvalid = address.trim() !== '' && parsed === null;
  const canSubmit = !busy && parsed !== null && name.trim().length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || parsed === null) return;
    setBusy(true);
    try {
      await WalletsHelper.addWatchProfile(name.trim(), parsed.chain, parsed.address);
      // 入力したアドレスのチェーン・ネットワークで開く（テストネットのアドレスなら、そのままテストネットの内容が見える）。
      setAppNetwork(parsed.network);
      setAppChain(parsed.chain);
      navigate('/top', { replace: true });
    } catch (err) {
      console.error('Failed to create the view-only profile', err);
      setErrorMessage(t('watch.create_failed'));
      setBusy(false);
    }
  };

  return (
    <KasaneStage back="/wallet/new" title={t('watch.create_title')} maxWidth={560} panel>
      <Box component="form" onSubmit={onSubmit} noValidate sx={{ width: '100%', mt: 2 }}>
        <Typography align="center" sx={{ mx: 2, lineHeight: 1.8 }}>
          {(t('watch.create_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          <TextField
            fullWidth
            autoFocus
            multiline
            minRows={2}
            label={t('watch.address_label')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            error={showInvalid}
            helperText={
              showInvalid
                ? t('watch.invalid')
                : parsed
                  ? t('watch.detected', { chain: CHAINS[parsed.chain].name, network: NETWORKS[parsed.network].label })
                  : t('watch.address_hint')
            }
            slotProps={{ htmlInput: { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } } }}
          />
          {parsed && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1, wordBreak: 'break-all', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
              {prettyChainAddressOf(parsed.chain, parsed.address)}
            </Typography>
          )}

          <TextField
            fullWidth
            label={t('wallet.name_input')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, pb: 3 }}>
          <Button type="submit" variant="contained" color="primary" size="large" disabled={!canSubmit} sx={{ minWidth: 160 }}>
            {t('watch.create_button')}
          </Button>
        </Box>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
