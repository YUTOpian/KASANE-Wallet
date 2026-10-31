import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, InputAdornment, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import { changeNemMosaicSupply, fetchNemCreatedMosaics, fetchNemMosaicEditState, fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import type { NemMosaicEditState, NemOwnedMosaic } from '../../lib/nem/api';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { nemSupplyAfter, validateNemSupplyChange } from '../../lib/nem/mosaicSupply';
import type { NemSupplyAction } from '../../lib/nem/mosaicSupply';
import { NEM_MAX_MOSAIC_INITIAL_SUPPLY, NEM_PROVISION_TX_FEE } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from '../mosaic/mosaicFlags';
import { ConfirmRows, classifyNemError, nemXem } from './parts';
import { supplyWithDecimals } from './mosaicLayout';

type Step = 'form' | 'confirm';

interface NemMosaicSupplyProps {
  /** Mosaic to select first (the 供給量を変更 button of a row on the list). */
  initialMosaicId?: string;
  /** Called after the change was sent (the dialog closes and the list reloads). */
  onDone?: () => void;
}

// NEM 「供給量の変更」(NanoWallet の「モザイク供給量を変更」と同じ): 自分が作った、供給量の変更を許可したモザイクの供給量を増やす（作成）/ 減らす（削除）。
// 入力 → 確認（パスワード）→ 送信。送信後はフォームが空に戻る。
function NemMosaicSupply({ initialMosaicId, onDone, onSent }: NemMosaicSupplyProps & SentProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [loadState, setLoadState] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [mosaics, setMosaics] = useState<NemOwnedMosaic[]>([]);
  const [mosaicId, setMosaicId] = useState('');
  const [info, setInfo] = useState<NemMosaicEditState | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [action, setAction] = useState<NemSupplyAction>('increase');
  const [deltaText, setDeltaText] = useState('');
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The mosaics this wallet created whose supply may change.
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const [created, balance] = await Promise.all([
          fetchNemCreatedMosaics(wallet.address),
          fetchNemXemBalance(wallet.address).catch(() => null),
        ]);
        if (cancelled) return;
        const usable = created.filter((m) => m.supplyMutable);
        setMosaics(usable);
        setMosaicId(usable.find((m) => m.id === initialMosaicId)?.id ?? usable[0]?.id ?? '');
        setXemBalance(balance);
        setLoadState('ready');
      } catch (e) {
        console.error('Failed to load mosaics', e);
        if (!cancelled) setLoadState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [network, reloadKey]);

  // The supply now and what the creator holds, for the chosen mosaic.
  useEffect(() => {
    setInfo(null);
    setDeltaText('');
    if (mosaicId === '') return undefined;
    let cancelled = false;
    setInfoLoading(true);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const state = await fetchNemMosaicEditState(wallet.address, mosaicId);
        if (!cancelled) setInfo(state);
      } catch (e) {
        console.error('Failed to load the mosaic supply', e);
      } finally {
        if (!cancelled) setInfoLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mosaicId, network]);

  const divisibility = info?.definition.divisibility ?? 0;
  const current = info?.supply ?? null;
  const creatorWhole = info?.creatorBalance != null ? info.creatorBalance / 10n ** BigInt(divisibility) : null;
  const delta = /^\d+$/.test(deltaText) ? BigInt(deltaText) : null;
  const problem = current === null ? 'invalid' : validateNemSupplyChange({ current, creatorWhole, action, delta });
  const after = current !== null && delta !== null && problem === null ? nemSupplyAfter(current, action, delta) : current;
  const problemText = deltaText === '' || problem === null || (problem === 'invalid' && current === null) ? ''
    : problem === 'invalid' ? t('nemmosaic.supply_invalid')
      : problem === 'over_max' ? t('nemmosaic.supply_over_max', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) })
        : problem === 'too_much' ? t('nemmosaic.supply_too_much')
          : t('nemmosaic.supply_not_held', { held: groupDigits((creatorWhole ?? 0n).toString()) });
  const balanceShort = xemBalance !== null && xemBalance < NEM_PROVISION_TX_FEE;
  const canContinue = info !== null && current !== null && problem === null && !infoLoading;
  const actionLabel = action === 'increase' ? t('nemmosaic.supply_create') : t('nemmosaic.supply_delete');
  const show = (whole: bigint | null) => (whole === null ? '–' : supplyWithDecimals(whole.toString(), divisibility));

  const onPassed = async (password: string) => {
    if (!info || delta === null) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await changeNemMosaicSupply({ privateKey, publicKey: wallet.publicKey, mosaicId, action, delta });
      showTxNotice({ lines: t('nemmosaic.supply_done_message', { returnObjects: true }) as string[], explorerUrl: sent.hash ? nemExplorerTxUrl(sent.hash) : undefined, explorerLabel: t('nemmosaic.view_explorer') });
      onDone?.();
      onSent();
    } catch (error) {
      setSendError(classifyNemError(error, 'MOSAIC'));
    } finally {
      setSending(false);
    }
  };

  const errorTitle = sendError ? t(`nemmosaic.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemmosaic.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];
  const rootSx = { flexGrow: 1, display: 'flex', flexDirection: 'column' } as const;

  if (loadState !== 'ready') {
    return (
      <Box sx={{ ...rootSx, px: { xs: 2, md: 4 }, py: 4, textAlign: 'center' }}>
        {loadState === 'loading' ? <CircularProgress size={26} sx={{ mx: 'auto' }} /> : (
          <>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemmosaic.load_failed')}</Typography>
            <Button variant="outlined" onClick={() => setReloadKey((k) => k + 1)} sx={{ mx: 'auto' }}>{t('nemmosaic.retry')}</Button>
          </>
        )}
      </Box>
    );
  }

  if (mosaics.length === 0) {
    return (
      <Box sx={{ ...rootSx, px: { xs: 2, md: 4 }, py: 3 }}>
        <Alert severity="info">{t('nemmosaic.supply_none')}</Alert>
      </Box>
    );
  }

  if (step === 'confirm' && current !== null && delta !== null && after !== null) {
    const rows = [
      { label: t('nemmosaic.id_label'), value: mosaicId, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      { label: t('nemmosaic.supply_now'), value: show(current) },
      { label: t('nemmosaic.supply_type'), value: actionLabel },
      { label: t('nemmosaic.supply_delta'), value: `${action === 'increase' ? '+' : '-'}${groupDigits(delta.toString())}` },
      { label: t('nemmosaic.supply_after'), value: show(after) },
      { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => setStep('form')} back="/mosaic" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>
        <MessageDialog open={showCaution} title={t('nemmosaic.supply_confirm_title')} texts={t('nemmosaic.supply_confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('nemmosaic.supply_sending') : t('nemmosaic.supply_confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemmosaic.supply_confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // Symbol の供給量変更と同じ並び: 1列、枠線つきの入力欄、増やす／減らすはトグル、変更後と手数料は枠で囲む。
  const decreaseHint = action === 'decrease' && creatorWhole !== null ? t('nemmosaic.supply_decrease_hint', { held: groupDigits(creatorWhole.toString()) }) : undefined;
  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemmosaic.supply_intro')}</Alert>

        <TextField select label={t('nemmosaic.supply_select')} value={mosaicId} onChange={(e) => setMosaicId(e.target.value)} fullWidth sx={{ mb: 2 }}>
          {mosaics.map((m) => <MenuItem key={m.id} value={m.id}>{m.id}</MenuItem>)}
        </TextField>

        {infoLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={22} /></Box>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 0.75, mb: 2, fontSize: 14 }}>
            <Box sx={{ color: 'text.secondary' }}>{t('nemmosaic.supply_now')}</Box>
            <Box sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{show(current)}</Box>
            <Box sx={{ color: 'text.secondary' }}>{t('mosaic.supply_held')}</Box>
            <Box sx={{ wordBreak: 'break-all' }}>{show(creatorWhole)}</Box>
            <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_divisibility')}</Box>
            <Box>{info ? divisibility : '–'}</Box>
          </Box>
        )}
        {!infoLoading && info === null && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemmosaic.edit_load_failed')}</Alert>}
        {!infoLoading && info !== null && current === null && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemmosaic.supply_unknown')}</Alert>}

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemmosaic.supply_type')}</Typography>
        <ToggleButtonGroup
          exclusive fullWidth size="small" color="primary" value={action} sx={{ mb: 2 }}
          onChange={(_, v: NemSupplyAction | null) => { if (v) setAction(v); }}
        >
          <ToggleButton value="increase">{t('nemmosaic.supply_create')}</ToggleButton>
          <ToggleButton value="decrease">{t('nemmosaic.supply_delete')}</ToggleButton>
        </ToggleButtonGroup>

        <TextField
          label={t('nemmosaic.supply_delta')}
          value={deltaText}
          onChange={(e) => setDeltaText(e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''))}
          error={problemText !== ''}
          helperText={problemText || decreaseHint || t('nemmosaic.supply_delta_hint')}
          fullWidth
          slotProps={{ htmlInput: { inputMode: 'numeric' }, input: { endAdornment: <InputAdornment position="end"><Typography sx={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'text.secondary' }}>{mosaicId}</Typography></InputAdornment> } }}
          sx={{ mb: 2 }}
        />

        {current !== null && delta !== null && problem === null && (
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemmosaic.supply_after')}</Typography>
            <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem', wordBreak: 'break-all' }}>{show(after)}</Typography>
          </Box>
        )}

        <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('nemmosaic.tx_fee')}: <span style={{ fontWeight: 'normal' }}>{nemXem(NEM_PROVISION_TX_FEE)}</span></Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('nemmosaic.xem_short_warning')}</Alert>}
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('nemmosaic.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}

export default withFormReset<NemMosaicSupplyProps>(NemMosaicSupply);
