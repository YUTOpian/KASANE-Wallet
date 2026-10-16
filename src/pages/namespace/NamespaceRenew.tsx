import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, MenuItem, TextField, Typography } from '@mui/material';
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
  SymbolSendError, explorerTxUrl, fetchBalances, fetchNamespaceRentalFees, fetchOwnedNamespaces,
  quoteNamespaceRegistrationFee, registerNamespace,
} from '../../lib/symbol/api';
import type { NamespaceRentalFees, OwnedNamespace } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import {
  extendedExpiryMs, isExpiringSoon, isMaxedOut, isRenewableRoot, maxExtensionDays, remainingDays, validateRenewDays,
} from '../../lib/symbol/namespaceRenew';
import { getNetworkConfig } from '../../lib/symbol/network';
import { BLOCKS_PER_DAY, MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';

const DEFAULT_DAYS = 365;

// Maps the node's status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Namespace_Owner_Conflict') return { kind: 'taken', detail };
  if (code === 'Failure_Namespace_Invalid_Duration') return { kind: 'duration', detail: code };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm';

interface NamespaceRenewProps {
  /** Namespace to select first (the renew button of a row on the owned list). */
  initialNamespaceId?: string;
  /** Shown inside a dialog (the list's row button): no page title of its own. */
  embedded?: boolean;
  /** Called after the transaction was sent (the dialog closes and the list reloads). */
  onDone?: () => void;
}

// 「更新」: ネームスペース一覧の行のボタンから開くポップアップ。自分のルートネームスペースの期間を延ばす。
// Symbol に専用の更新トランザクションはなく、持ち主が同じ名前でルートをもう一度登録すると、今の期限に期間が足される。
// 入力 → 確認（パスワード）→ 送信。
function NamespaceRenew({ initialNamespaceId, onDone, onSent }: NamespaceRenewProps & SentProps) {
  const { t, i18n } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);
  const [nowMs] = useState(() => Date.now());

  const [step, setStep] = useState<Step>('form');
  const [roots, setRoots] = useState<OwnedNamespace[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nsId, setNsId] = useState(initialNamespaceId ?? '');
  const [daysText, setDaysText] = useState(String(DEFAULT_DAYS));

  const [fees, setFees] = useState<NamespaceRentalFees | null | 'loading'>('loading');
  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The roots the wallet owns (soonest expiry first), the rental price and the XYM balance.
  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setLoadFailed(false);
    setFees('loading');
    setXymBalance(null);
    (async () => {
      fetchNamespaceRentalFees().then((f) => { if (!cancelled) setFees(f); }).catch(() => { if (!cancelled) setFees(null); });
      try {
        const wallet = await WalletsHelper.getActive();
        const owned = wallet ? await fetchOwnedNamespaces(wallet.address) : [];
        if (cancelled) return;
        setRoots(owned.filter(isRenewableRoot).sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0)));
        if (wallet) {
          const balances = await fetchBalances(wallet.address).catch(() => null);
          const xym = balances?.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
          if (!cancelled && balances) setXymBalance(xym?.amount ?? 0n);
        }
      } catch (e) {
        console.error('Failed to load namespaces', e);
        if (!cancelled) { setRoots([]); setLoadFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const selected = useMemo(() => (roots ?? []).find((r) => r.id === nsId) ?? (roots ?? [])[0], [roots, nsId]);

  // Picking another root starts again from the usual period, or from what still fits.
  const defaultDaysFor = (r: OwnedNamespace) => {
    const max = maxExtensionDays(r, nowMs);
    return max < MIN_NAMESPACE_DAYS ? '' : String(Math.min(DEFAULT_DAYS, max));
  };
  useEffect(() => {
    if (selected) setDaysText(defaultDaysFor(selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // --- validation -------------------------------------------------------------------------
  const maxed = selected ? isMaxedOut(selected, nowMs) : false;
  const maxDays = selected ? maxExtensionDays(selected, nowMs) : 0;
  const problem = selected && !maxed && daysText !== '' ? validateRenewDays(selected, daysText, nowMs) : null;
  const daysValid = selected !== undefined && !maxed && daysText !== '' && problem === null;
  const daysNumber = daysValid ? Number(daysText) : 0;
  const problemText = problem === null ? ''
    : problem === 'invalid' ? t('namespace.renew_invalid_days')
      : problem === 'range' ? t('namespace.renew_range_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })
        : t('namespace.renew_over_max', { limit: MAX_NAMESPACE_DAYS, max: maxDays });

  // Transaction fee depends on the name's length (the same transaction as registering a root).
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    if (!selected) return undefined;
    quoteNamespaceRegistrationFee(selected.name, [])
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [selected?.name, network]);

  const durationBlocks = BigInt(daysNumber) * BigInt(BLOCKS_PER_DAY);
  const rentalFee: bigint | null = fees === 'loading' || fees === null || !daysValid ? null : fees.rootFeePerBlock * durationBlocks;
  const total = rentalFee !== null && txFee !== null ? rentalFee + txFee : null;
  const balanceShort = total !== null && xymBalance !== null && xymBalance < total;

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const costText = (value: bigint | null) => (!daysValid ? '-' : fees === 'loading' ? t('namespace.cost_loading') : value === null ? t('namespace.cost_unavailable') : xym(value));
  const date = (ms: number | null) => (ms === null ? '-' : new Date(ms).toLocaleDateString(i18n.language));
  const afterMs = selected && daysValid ? extendedExpiryMs(selected, daysNumber) : null;
  const left = selected ? remainingDays(selected, nowMs) : null;

  const canContinue = daysValid && !maxed;

  // --- sending ----------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (!selected || !daysValid) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await registerNamespace({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        name: selected.name,
        durationBlocks,
        metadata: [],
      });
      showTxNotice({ lines: t('namespace.renew_done_message', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('namespace.view_explorer') });
      onDone?.();
      onSent();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const errorTitle = sendError ? t(`namespace.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`namespace.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  const rootSx = { flexGrow: 1, display: 'flex', flexDirection: 'column' } as const;

  // ============================ confirm ============================
  if (step === 'confirm' && selected && daysValid) {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('namespace.table_name'), value: selected.name, big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('namespace.renew_current_expiry'), value: date(selected.expiresAtMs) },
      { label: t('namespace.renew_days_label'), value: t('namespace.days_value', { days: daysNumber }) },
      ...(afterMs !== null ? [{ label: t('namespace.renew_after_expiry'), value: date(afterMs) }] : []),
      { label: t('namespace.rental_fee'), value: costText(rentalFee) },
      { label: t('namespace.tx_fee'), value: txFee === null ? t('namespace.cost_unavailable') : xym(txFee) },
      { label: t('namespace.total'), value: costText(total) },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => setStep('form')} back="/namespace" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {rows.map((row, i) => (
              <Box key={row.label} sx={{ borderTop: i > 0 ? 1 : 0, borderColor: 'divider', py: 2 }}>
                <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                <Typography sx={{ fontSize: row.big ? '1.4rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                  {row.value}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>

        <MessageDialog
          open={showCaution}
          title={t('namespace.confirm_title')}
          texts={t('namespace.confirm_dialog_message', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('namespace.renew_sending') : t('namespace.renew_confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('namespace.renew_confirm_password')}
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
  const rootLabel = (r: OwnedNamespace) => {
    const days = remainingDays(r, nowMs);
    return `${r.name}  (${days === null ? t('namespace.expired') : t('namespace.renew_left', { days })})`;
  };

  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('namespace.renew_intro')}</Alert>

        {roots === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : loadFailed ? (
          <Alert severity="error">{t('namespace.load_failed')}</Alert>
        ) : roots.length === 0 || !selected ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('namespace.renew_none')}</Typography>
        ) : (
          <>
            <TextField select label={t('namespace.renew_pick')} value={selected.id} onChange={(e) => setNsId(e.target.value)} fullWidth sx={{ mb: 2 }}>
              {roots.map((r) => <MenuItem key={r.id} value={r.id}>{rootLabel(r)}</MenuItem>)}
            </TextField>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 0.75, mb: 2, fontSize: 14, alignItems: 'center' }}>
              <Box sx={{ color: 'text.secondary' }}>{t('namespace.renew_current_expiry')}</Box>
              <Box sx={{ fontWeight: 'bold' }}>
                {date(selected.expiresAtMs)}
                {selected.expired && <Chip size="small" color="error" variant="outlined" label={t('namespace.expired')} sx={{ ml: 1 }} />}
                {isExpiringSoon(selected, nowMs) && <Chip size="small" color="warning" variant="outlined" label={t('namespace.renew_soon')} sx={{ ml: 1 }} />}
              </Box>
              {left !== null && (
                <>
                  <Box />
                  <Box sx={{ color: 'text.secondary' }}>{t('namespace.renew_left', { days: left })}</Box>
                </>
              )}
            </Box>

            {selected.expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('namespace.renew_expired_warning')}</Alert>}
            {maxed && <Alert severity="warning" sx={{ mb: 2 }}>{t('namespace.renew_maxed')}</Alert>}

            <TextField
              label={t('namespace.renew_days_label')}
              value={daysText}
              onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))}
              error={problemText !== ''}
              helperText={problemText || t('namespace.renew_days_hint', { min: MIN_NAMESPACE_DAYS, max: Math.max(maxDays, MIN_NAMESPACE_DAYS) })}
              disabled={maxed}
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              sx={{ mb: 2 }}
            />

            {afterMs !== null && (
              <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('namespace.renew_after_expiry')}</Typography>
                <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem' }}>{date(afterMs)}</Typography>
              </Box>
            )}

            <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('namespace.cost_title')}</Typography>
              {[
                { label: t('namespace.rental_fee'), value: costText(rentalFee) },
                { label: t('namespace.tx_fee'), value: txFee === null ? t('namespace.cost_loading') : xym(txFee) },
                { label: t('namespace.total'), value: costText(total), bold: true },
              ].map((r) => (
                <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
              ))}
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('namespace.cost_hint')}</Typography>
              {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('namespace.xym_short_warning')}</Alert>}
            </Box>
          </>
        )}
      </Box>

      {roots !== null && roots.length > 0 && selected && (
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
            {t('namespace.go_confirm')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default withFormReset<NamespaceRenewProps>(NamespaceRenew);
