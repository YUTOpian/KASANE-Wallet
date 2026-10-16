import { useMemo, useState, type FormEvent } from 'react';
import { Alert, Box, Button, CircularProgress, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { CHAINS } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { getNetworkConfig } from '../../lib/symbol/network';
import { LedgerError } from '../../lib/ledger/framing';
import type { LinkKind } from '../../lib/ledger/transport';
import { availableLedgerLinks, disconnectLedger, ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink, readLedgerAccount } from '../../lib/ledger/session';
import { useAppStore } from '../../store/appStore';

// 新規プロファイル →「Ledger」。デバイスの公開鍵だけを読み、秘密鍵・ニーモニック・パスワードはこの端末に残さない。
// チェーンごとにデバイスのアプリ（Symbol / NEM）が違うので、1回に1つのチェーンのプロファイルを作る。
// 最初のアカウント（インデックス 0）を表示し、続く数件は非表示で持つ（アカウント画面から表示できる）。
const ACCOUNTS_TO_READ = 5;

export default function WalletLedgerNew() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setAppChain = useAppStore((s) => s.setChain);
  const available = useMemo(() => availableLedgerLinks(), []);
  const [chain, setChain] = useState<ChainKey>('symbol');
  const [link, setLink] = useState<LinkKind | null>(preferredLedgerLink());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const canSubmit = !busy && link !== null && name.trim().length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || link === null) return;
    setBusy(true);
    try {
      // デバイスの選択は、このボタンを押した直後の処理の中で行う（ブラウザの決まり）。
      await ensureLedgerConnected(link);
      const networkByte = getNetworkConfig().networkByte;
      const accounts: Array<{ index: number; publicKey: string }> = [];
      for (let index = 0; index < ACCOUNTS_TO_READ; index += 1) {
        const account = await readLedgerAccount(chain, index, networkByte, false);
        accounts.push({ index, publicKey: account.publicKey });
      }
      await WalletsHelper.addLedgerProfile(name.trim(), chain, accounts);
      setAppChain(chain);
      navigate('/top', { replace: true });
    } catch (err) {
      console.error('Failed to create the Ledger profile', err);
      if (err instanceof LedgerError && err.kind === 'no_device') {
        // 選ぶ画面を閉じただけ：エラーにはしない。
        setBusy(false);
        return;
      }
      // 途中で失敗したときは、次の試行で選び直せるように接続を閉じる。
      await disconnectLedger().catch(() => undefined);
      setErrorMessage(t(ledgerErrorKey(err), { chain: CHAINS[chain].name }));
      setBusy(false);
    }
  };

  const linkLabel = (k: LinkKind) => t(`ledger.link_${k}`);

  return (
    <KasaneStage back="/wallet/new" title={t('ledger.create_title')} maxWidth={560} panel>
      <Box component="form" onSubmit={onSubmit} noValidate sx={{ width: '100%', mt: 2 }}>
        <Typography align="center" sx={{ mx: 2, lineHeight: 1.8 }}>
          {(t('ledger.create_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 3 }}>
          <Box>
            <Typography variant="body2" sx={{ mb: 0.75, fontWeight: 600 }}>{t('ledger.chain_label')}</Typography>
            <ToggleButtonGroup exclusive fullWidth size="small" value={chain} onChange={(_, v: ChainKey | null) => { if (v) setChain(v); }}>
              <ToggleButton value="symbol">{CHAINS.symbol.name}</ToggleButton>
              <ToggleButton value="nem">{CHAINS.nem.name}</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              {t('ledger.app_hint', { chain: CHAINS[chain].name })}
            </Typography>
          </Box>

          {available.length === 0 ? (
            <Alert severity="warning">{t('ledger.error_unsupported_browser')}</Alert>
          ) : (
            <Box>
              <Typography variant="body2" sx={{ mb: 0.75, fontWeight: 600 }}>{t('ledger.transport_label')}</Typography>
              <ToggleButtonGroup exclusive fullWidth size="small" value={link} onChange={(_, v: LinkKind | null) => { if (v) setLink(v); }}>
                {available.map((k) => <ToggleButton key={k} value={k}>{linkLabel(k)}</ToggleButton>)}
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {t('ledger.transport_hint')}
              </Typography>
            </Box>
          )}

          <TextField fullWidth label={t('wallet.name_input')} value={name} onChange={(e) => setName(e.target.value)} />
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, pb: 3 }}>
          <Button type="submit" variant="contained" color="primary" size="large" disabled={!canSubmit} sx={{ minWidth: 200 }}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            {busy ? t('ledger.connecting') : t('ledger.create_button')}
          </Button>
          <Typography variant="caption" color="text.secondary" align="center" sx={{ mt: 1.5, mx: 2, lineHeight: 1.7 }}>
            {t('ledger.create_note')}
          </Typography>
        </Box>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </KasaneStage>
  );
}
