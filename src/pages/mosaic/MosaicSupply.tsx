import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Divider, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, changeMosaicSupply, explorerTxUrl, fetchBalances, fetchMosaicRows, quoteMosaicSupplyChangeFee,
} from '../../lib/symbol/api';
import type { MosaicRow } from '../../lib/symbol/api';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { getNetworkConfig } from '../../lib/symbol/network';
import { isSupplyMutableMine, supplyAfter, supplyBlockedReason, validateSupplyChange } from '../../lib/symbol/mosaicSupply';
import { MAX_MOSAIC_SUPPLY } from '../../lib/symbol/tx';
import type { SupplyAction } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from './mosaicFlags';

// Keep only what a decimal amount can contain: digits and a single '.', limited to `decimals` places.
function sanitizeAmount(raw: string, decimals: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = s.split('.');
  if (frac !== undefined) s = decimals > 0 ? `${whole}.${frac.slice(0, decimals)}` : whole;
  return s;
}

// Maps the node's status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Mosaic_Supply_Immutable' || code === 'Failure_Mosaic_Modification_Disallowed') return { kind: 'not_allowed', detail: code };
  if (code === 'Failure_Mosaic_Supply_Negative' || code === 'Failure_Mosaic_Supply_Exceeded' || code === 'Failure_Mosaic_Invalid_Supply_Change_Amount') return { kind: 'amount', detail: code };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm';

interface MosaicSupplyProps {
  /** Mosaic to select first (the 供給量変更 button of a row on the held list). */
  initialMosaicId?: string;
  /** Shown inside a dialog (the mosaic list's supply button): no page title of its own. */
  embedded?: boolean;
  /** Called after the change was sent (the dialog closes and the list reloads). */
  onDone?: () => void;
}

// 「供給量の変更」: モザイク画面の行のボタンから開くポップアップ。自分が作成した「供給量の変更を許可」のモザイクを増減する（単独のトランザクション）。
// 入力 → 確認（パスワード）→ 送信。アグリゲートの中でも同じ変更ができる（アグリゲート画面）。
function MosaicSupply({ initialMosaicId, embedded, onDone, onSent }: MosaicSupplyProps & SentProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [rows, setRows] = useState<MosaicRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mosaicId, setMosaicId] = useState(initialMosaicId ?? '');
  const [action, setAction] = useState<SupplyAction>('increase');
  const [amountText, setAmountText] = useState('');

  const [fee, setFee] = useState<bigint | null | 'loading'>('loading');
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The mosaics this wallet created with the supply-mutable option (expired ones cannot change).
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadFailed(false);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        const all = wallet ? await fetchMosaicRows(wallet.address) : [];
        if (!cancelled) setRows(all.filter(isSupplyMutableMine));
      } catch (e) {
        console.error('Failed to load mosaics', e);
        if (!cancelled) { setRows([]); setLoadFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // Transaction fee, and the XYM balance (to warn when it will not cover the fee).
  useEffect(() => {
    let cancelled = false;
    setFee('loading');
    setXymBalance(null);
    quoteMosaicSupplyChangeFee().then((q) => { if (!cancelled) setFee(q.fee); }).catch(() => { if (!cancelled) setFee(null); });
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const balances = await fetchBalances(wallet.address);
        const xym = balances.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        if (!cancelled) setXymBalance(xym?.amount ?? 0n);
      } catch { /* the warning is optional */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const selected = useMemo(() => (rows ?? []).find((r) => r.id === mosaicId) ?? (rows ?? [])[0], [rows, mosaicId]);
  const div = selected?.divisibility ?? 0;

  const blocked = selected ? supplyBlockedReason(selected) : null;
  const delta = selected && amountText !== '' ? parseDecimal(amountText, div) : null;
  const problem = selected && amountText !== '' ? validateSupplyChange(selected, action, delta) : null;
  const canContinue = selected !== undefined && blocked === null && amountText !== '' && problem === null && delta !== null;
  const after = selected && delta !== null && problem === null ? supplyAfter(selected.supply, action, delta) : null;

  const fmt = (v: bigint) => groupDigits(formatAtomic(v, div));
  const xym = (v: bigint) => `${formatAtomic(v, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = fee === 'loading' ? t('mosaic.cost_loading') : fee === null ? t('mosaic.cost_unavailable') : xym(fee);
  const feeShort = typeof fee === 'bigint' && xymBalance !== null && xymBalance < fee;

  const problemText = problem === null ? '' : problem === 'invalid' ? t('mosaic.supply_invalid')
    : problem === 'too_much' ? t('mosaic.supply_too_much', { max: selected ? fmt(selected.amount) : '' })
      : t('mosaic.supply_over_max', { max: groupDigits(formatAtomic(MAX_MOSAIC_SUPPLY, div)) });

  const onPassed = async (password: string) => {
    if (!selected || delta === null || problem !== null || blocked !== null) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await changeMosaicSupply({ privateKey, publicKey: wallet.publicKey, mosaicId: selected.id, action, delta });
      showTxNotice({ lines: t('mosaic.supply_done_message', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('mosaic.view_explorer') });
      onDone?.();
      onSent();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const errorTitle = sendError ? t(`mosaic.supply_error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`mosaic.supply_error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  const rootSx = { flexGrow: 1, display: 'flex', flexDirection: 'column' } as const;

  // ============================ confirm ============================
  if (step === 'confirm' && selected && delta !== null && after !== null) {
    const confirmRows: { label: string; value: string; big?: boolean }[] = [
      { label: t('mosaic.supply_pick'), value: `${selected.name ?? selected.id}${selected.name ? `\n${selected.id}` : ''}` },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('mosaic.supply_action'), value: `${action === 'increase' ? t('mosaic.supply_increase') : t('mosaic.supply_decrease')}  ${action === 'increase' ? '+' : '−'}${fmt(delta)}`, big: true },
      { label: t('mosaic.supply_current'), value: fmt(selected.supply) },
      { label: t('mosaic.supply_after'), value: fmt(after), big: true },
      { label: t('mosaic.tx_fee'), value: feeText },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => setStep('form')} back="/mosaic" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {confirmRows.map((row, i) => (
              <Box key={row.label}>
                {i > 0 && <Divider />}
                <Box sx={{ py: 2 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                  <Typography sx={{ fontSize: row.big ? '1.4rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                    {row.value}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
          {after === 0n && <Alert severity="warning" sx={{ mt: 2 }}>{t('mosaic.supply_to_zero_warning')}</Alert>}
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 2 }}>{t('mosaic.supply_caution')}</Typography>
        </Box>

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('mosaic.supply_sending') : t('mosaic.supply_confirm_ready')}</Typography>
            <Button
              variant="contained" color="primary" size="large" fullWidth disabled={sending}
              onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}
            >
              {t('mosaic.supply_confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {!embedded && <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('mosaic.supply_title')}</Typography>}
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('mosaic.supply_intro')}<br />{t('mosaic.supply_rule_hint')}
        </Alert>

        {rows === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : loadFailed ? (
          <Alert severity="error">{t('mosaic.load_failed')}</Alert>
        ) : rows.length === 0 || !selected ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('mosaic.supply_none')}</Typography>
        ) : (
          <>
            <TextField
              select label={t('mosaic.supply_pick')} value={selected.id} fullWidth sx={{ mb: 2 }}
              onChange={(e) => { setMosaicId(e.target.value); setAmountText(''); }}
            >
              {rows.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {r.name ? `${r.name} (${r.id})` : r.id}
                </MenuItem>
              ))}
            </TextField>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 0.75, mb: 2, fontSize: 14 }}>
              <Box sx={{ color: 'text.secondary' }}>{t('mosaic.supply_current')}</Box>
              <Box sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{fmt(selected.supply)}</Box>
              <Box sx={{ color: 'text.secondary' }}>{t('mosaic.supply_held')}</Box>
              <Box sx={{ wordBreak: 'break-all' }}>{fmt(selected.amount)}</Box>
              <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_divisibility')}</Box>
              <Box>{selected.divisibility}</Box>
            </Box>

            {blocked !== null && <Alert severity="warning" sx={{ mb: 2 }}>{t(`mosaic.supply_${blocked}`)}</Alert>}

            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('mosaic.supply_action')}</Typography>
            <ToggleButtonGroup
              exclusive fullWidth size="small" color="primary" value={action} sx={{ mb: 2 }}
              onChange={(_, v: SupplyAction | null) => { if (v) setAction(v); }}
            >
              <ToggleButton value="increase">{t('mosaic.supply_increase')}</ToggleButton>
              <ToggleButton value="decrease">{t('mosaic.supply_decrease')}</ToggleButton>
            </ToggleButtonGroup>

            <TextField
              label={t('mosaic.supply_amount')}
              placeholder={t('mosaic.supply_amount_placeholder')}
              value={amountText}
              onChange={(e) => setAmountText(sanitizeAmount(e.target.value, div))}
              error={problemText !== ''}
              helperText={problemText || undefined}
              disabled={blocked !== null}
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{ mb: 2 }}
            />

            {after !== null && (
              <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('mosaic.supply_after')}</Typography>
                <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem', wordBreak: 'break-all' }}>{fmt(after)}</Typography>
                {after === 0n && <Alert severity="warning" sx={{ mt: 1 }}>{t('mosaic.supply_to_zero_warning')}</Alert>}
              </Box>
            )}

            <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('mosaic.supply_fee_title')}: <span style={{ fontWeight: 'normal' }}>{feeText}</span></Typography>
              {feeShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('mosaic.supply_fee_short_warning')}</Alert>}
            </Box>
          </>
        )}
      </Box>

      {rows !== null && rows.length > 0 && selected && (
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>
            {t('mosaic.supply_go_confirm')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default withFormReset<MosaicSupplyProps>(MosaicSupply);
