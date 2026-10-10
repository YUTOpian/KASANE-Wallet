import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Divider, FormControlLabel, MenuItem, Switch, TextField, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import MetadataEntriesEditor from '../../components/MetadataEntriesEditor';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, createMosaic, explorerTxUrl, fetchBalances, fetchMosaicRentalFee, quoteMosaicCreationFee,
} from '../../lib/symbol/api';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { activeDrafts, draftValueLengths, draftsToItems, draftsValid } from '../../lib/symbol/metadata';
import type { MetadataDraft } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  BLOCKS_PER_DAY, MAX_MOSAIC_DIVISIBILITY, MAX_MOSAIC_SUPPLY, MOSAIC_FLAG_REVOKABLE, MOSAIC_FLAG_RESTRICTABLE,
  MOSAIC_FLAG_SUPPLY_MUTABLE, MOSAIC_FLAG_TRANSFERABLE,
} from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { MOSAIC_FLAG_LABELS, groupDigits } from './mosaicFlags';

const MAX_DAYS = 3650; // the network's longest mosaic duration

// Keep only what a decimal amount can contain: digits and a single '.', limited to `decimals`
// places. A comma (some keyboards) is accepted as the decimal point.
function sanitizeAmount(raw: string, decimals: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = s.split('.');
  if (frac !== undefined) s = decimals > 0 ? `${whole}.${frac.slice(0, decimals)}` : whole;
  return s;
}

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm' | 'done';
type Cost = { rental: bigint; fee: bigint } | null | 'loading';
type Loadable = bigint | null | 'loading';

// モザイクの作成: 入力 → 確認（パスワード）→ 送信。
export default function MosaicCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');

  // form
  const [supplyText, setSupplyText] = useState('');
  const [divisibility, setDivisibility] = useState(0);
  const [supplyMutable, setSupplyMutable] = useState(false);
  const [transferable, setTransferable] = useState(true);
  const [restrictable, setRestrictable] = useState(false);
  const [revokable, setRevokable] = useState(false);
  const [unlimited, setUnlimited] = useState(true);
  const [daysText, setDaysText] = useState('');

  const [metadataDrafts, setMetadataDrafts] = useState<MetadataDraft[]>([]);

  // cost / balance
  const [rental, setRental] = useState<Loadable>('loading');
  const [txFee, setTxFee] = useState<Loadable>('loading');
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  // confirm / done
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [result, setResult] = useState<{ hash: string; mosaicId: string } | null>(null);

  // Rental fee and the XYM balance (to warn when it will not cover the cost).
  useEffect(() => {
    let cancelled = false;
    setRental('loading');
    setXymBalance(null);
    (async () => {
      try {
        const fee = await fetchMosaicRentalFee();
        if (!cancelled) setRental(fee);
      } catch {
        if (!cancelled) setRental(null);
      }
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

  // The transaction fee grows with the metadata rows, so it is quoted again when their sizes change.
  const metadataLengths = draftValueLengths(metadataDrafts);
  const metadataLengthsKey = metadataLengths.join(',');
  useEffect(() => {
    let cancelled = false;
    setTxFee('loading');
    quoteMosaicCreationFee(metadataLengthsKey === '' ? [] : metadataLengthsKey.split(',').map(Number))
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { if (!cancelled) setTxFee(null); });
    return () => { cancelled = true; };
  }, [metadataLengthsKey, network]);

  const cost: Cost = rental === 'loading' || txFee === 'loading' ? 'loading' : rental === null || txFee === null ? null : { rental, fee: txFee };

  // --- validation -------------------------------------------------------------------------
  const supplyAtomic = supplyText === '' ? null : parseDecimal(supplyText, divisibility);
  const supplyTooLarge = supplyAtomic !== null && supplyAtomic > MAX_MOSAIC_SUPPLY;
  const supplyValid = supplyAtomic !== null && supplyAtomic > 0n && !supplyTooLarge;
  const supplyError = supplyText === '' ? '' : supplyTooLarge
    ? t('mosaic.supply_too_large', { max: groupDigits(formatAtomic(MAX_MOSAIC_SUPPLY, divisibility)) })
    : supplyValid ? '' : t('mosaic.invalid_supply');

  const daysNumber = /^\d+$/.test(daysText) ? Number(daysText) : NaN;
  const daysValid = unlimited || (daysNumber >= 1 && daysNumber <= MAX_DAYS);
  const daysError = unlimited || daysText === '' || daysValid ? '' : t('mosaic.invalid_days');

  const metadataValid = draftsValid(metadataDrafts);
  const canContinue = supplyValid && daysValid && metadataValid;

  const flags =
    (supplyMutable ? MOSAIC_FLAG_SUPPLY_MUTABLE : 0) |
    (transferable ? MOSAIC_FLAG_TRANSFERABLE : 0) |
    (restrictable ? MOSAIC_FLAG_RESTRICTABLE : 0) |
    (revokable ? MOSAIC_FLAG_REVOKABLE : 0);
  const durationBlocks = unlimited || !daysValid ? 0n : BigInt(daysNumber) * BigInt(BLOCKS_PER_DAY);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const total = cost !== null && cost !== 'loading' ? cost.rental + cost.fee : null;
  const balanceShort = total !== null && xymBalance !== null && xymBalance < total;

  const onChangeDivisibility = (value: number) => {
    setDivisibility(value);
    setSupplyText((text) => sanitizeAmount(text, value));
  };

  // --- creating ---------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (supplyAtomic === null || !supplyValid) {
      setErrorMessage(t('mosaic.invalid_supply'));
      return;
    }
    setCreating(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const created = await createMosaic({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        supply: supplyAtomic,
        divisibility,
        flags,
        durationBlocks,
        metadata: draftsToItems(metadataDrafts),
      });
      setResult(created);
      setStep('done');
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setCreating(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate('/mosaic');
  };

  const errorTitle = sendError ? t(`mosaic.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`mosaic.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  const optionRows = [
    { checked: supplyMutable, set: setSupplyMutable, label: 'mosaic.supply_mutable_label', desc: 'mosaic.supply_mutable_desc' },
    { checked: transferable, set: setTransferable, label: 'mosaic.transferable_label', desc: 'mosaic.transferable_desc' },
    { checked: restrictable, set: setRestrictable, label: 'mosaic.restrictable_label', desc: 'mosaic.restrictable_desc' },
    { checked: revokable, set: setRevokable, label: 'mosaic.revokable_label', desc: 'mosaic.revokable_desc' },
  ];

  const costText = (pick: (c: { rental: bigint; fee: bigint }) => bigint) =>
    cost === 'loading' ? t('mosaic.cost_loading') : cost === null ? t('mosaic.cost_unavailable') : xym(pick(cost));

  // ============================ done ============================
  if (step === 'done') {
    return (
      <Box sx={{ minHeight: '100vh' }}>
        <Box sx={{ width: '100%', px: { xs: 3, md: 5 }, py: 4, boxSizing: 'border-box', textAlign: 'center' }}>
          <Typography sx={{ fontSize: 'x-large', color: 'primary.main', mb: 2 }}>
            {(t('mosaic.done_message', { returnObjects: true }) as string[]).map((line, i) => (
              <span key={i}>{line}<br /></span>
            ))}
          </Typography>
          {result && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('mosaic.id_label')}</Typography>
              <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{result.mosaicId}</Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/mosaic', { replace: true })}>
              {t('mosaic.to_list')}
            </Button>
            <Button variant="outlined" fullWidth onClick={() => navigate('/metadata?type=mosaic', { replace: true })}>
              {t('metadata.to_metadata')}
            </Button>
            {result && (
              <Button href={explorerTxUrl(result.hash)} target="_blank" rel="noopener" variant="contained" fullWidth>
                {t('mosaic.view_explorer')}
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  // ============================ confirm ============================
  if (step === 'confirm') {
    const enabled = MOSAIC_FLAG_LABELS.filter((f) => (flags & f.mask) !== 0).map((f) => t(f.labelKey));
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('mosaic.initial_supply'), value: groupDigits(supplyText), big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('mosaic.divisibility_label'), value: String(divisibility) },
      { label: t('mosaic.options_title'), value: enabled.length > 0 ? enabled.join('・') : t('mosaic.off') },
      { label: t('mosaic.duration_label'), value: unlimited ? t('mosaic.duration_unlimited') : t('mosaic.duration_days', { days: daysNumber }) },
      ...(activeDrafts(metadataDrafts).length > 0
        ? [{ label: t('metadata.optional_title'), value: activeDrafts(metadataDrafts).map((d) => `${d.key.trim()}: ${d.value}`).join('\n') }]
        : []),
      { label: t('mosaic.rental_fee'), value: costText((c) => c.rental) },
      { label: t('mosaic.tx_fee'), value: costText((c) => c.fee) },
      { label: t('mosaic.total'), value: total !== null ? xym(total) : costText((c) => c.rental + c.fee) },
    ];
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back="/mosaic/create" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {rows.map((row, i) => (
              <Box key={row.label}>
                {i > 0 && <Divider />}
                <Box sx={{ py: 2 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                  <Typography sx={{ fontSize: row.big ? '1.6rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                    {row.value}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 2 }}>{t('mosaic.caution_immutable')}</Typography>
        </Box>

        <MessageDialog
          open={showCaution}
          title={t('mosaic.confirm_title')}
          texts={t('mosaic.confirm_dialog_message', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{creating ? t('mosaic.creating') : t('mosaic.confirm_ready')}</Typography>
            <Button
              variant="contained"
              color="primary"
              size="large"
              fullWidth
              disabled={creating}
              onClick={() => setShowPasswordDialog(true)}
              startIcon={<LockOutlinedIcon />}
              sx={{ py: 1.5 }}
            >
              {t('mosaic.confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPasswordDialog} mode="check" onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} back="/mosaic" />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('mosaic.caution_immutable')}</Alert>

        <TextField
          label={t('mosaic.initial_supply')}
          placeholder={t('mosaic.initial_supply_placeholder')}
          value={supplyText}
          onChange={(e) => setSupplyText(sanitizeAmount(e.target.value, divisibility))}
          error={supplyError !== ''}
          helperText={supplyError || undefined}
          fullWidth
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          sx={{ mb: 2 }}
        />

        <TextField
          select
          label={t('mosaic.divisibility')}
          value={divisibility}
          onChange={(e) => onChangeDivisibility(Number(e.target.value))}
          helperText={t('mosaic.divisibility_hint')}
          fullWidth
          sx={{ mb: 3 }}
        >
          {Array.from({ length: MAX_MOSAIC_DIVISIBILITY + 1 }, (_, d) => (
            <MenuItem key={d} value={d}>{d}</MenuItem>
          ))}
        </TextField>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('mosaic.options_title')}</Typography>
        {optionRows.map((o) => (
          <Box key={o.label} sx={{ mb: 1 }}>
            <FormControlLabel
              control={<Switch checked={o.checked} onChange={(e) => o.set(e.target.checked)} />}
              label={t(o.label)}
            />
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ml: 6, mt: -0.5 }}>{t(o.desc)}</Typography>
          </Box>
        ))}

        <Typography sx={{ fontWeight: 'bold', mt: 3, mb: 0.5 }}>{t('mosaic.duration_title')}</Typography>
        <FormControlLabel
          control={<Switch checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />}
          label={t('mosaic.unlimited_label')}
        />
        {!unlimited && (
          <TextField
            label={t('mosaic.days_label')}
            value={daysText}
            onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))}
            error={daysError !== ''}
            helperText={daysError || t('mosaic.days_hint')}
            fullWidth
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            sx={{ mt: 1 }}
          />
        )}

        <MetadataEntriesEditor drafts={metadataDrafts} onChange={setMetadataDrafts} />

        <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('mosaic.cost_title')}</Typography>
          {[
            { label: t('mosaic.rental_fee'), value: costText((c) => c.rental) },
            { label: t('mosaic.tx_fee'), value: costText((c) => c.fee) },
            { label: t('mosaic.total'), value: costText((c) => c.rental + c.fee), bold: true },
          ].map((r) => (
            <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
          ))}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('mosaic.cost_hint')}</Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('mosaic.xym_short_warning')}</Alert>}
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Box>
          <Button
            variant="contained"
            color="primary"
            size="large"
            fullWidth
            disabled={!canContinue}
            onClick={() => { setStep('confirm'); setShowCaution(true); }}
            sx={{ py: 1.5 }}
          >
            {t('mosaic.go_confirm')}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
