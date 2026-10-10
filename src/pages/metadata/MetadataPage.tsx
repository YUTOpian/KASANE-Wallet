import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, CardActionArea, CircularProgress, Divider, MenuItem, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, explorerTxUrl, fetchBalances, fetchMetadataEntries, fetchOwnedMosaics, fetchOwnedNamespaces,
  quoteMetadataFee, setMetadata,
} from '../../lib/symbol/api';
import type { MetadataEntry, MetadataTargetRef, OwnedMosaic, OwnedNamespace } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { MAX_METADATA_VALUE_BYTES, encodeValue, keyToHex, parseMetadataKey } from '../../lib/symbol/metadata';
import type { MetadataTargetType } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import type { MetadataTarget } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';

const TYPES: MetadataTargetType[] = ['account', 'mosaic', 'namespace'];

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Mosaic_Expired' || code === 'Failure_Namespace_Expired') return { kind: 'expired', detail };
  if (code === 'Failure_Mosaic_Owner_Conflict' || code === 'Failure_Namespace_Owner_Conflict' || code === 'Failure_Core_Missing_Required_Signature') {
    return { kind: 'owner', detail };
  }
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

type Step = 'form' | 'confirm' | 'done';

// 「メタデータ」: attach key/value metadata to the wallet's own address, to a mosaic it created or to a
// namespace it registered. Other screens link here with ?type=mosaic|namespace&id=<hex id>.
export default function MetadataPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');

  // target
  const typeParam = params.get('type');
  const [type, setType] = useState<MetadataTargetType>(TYPES.find((x) => x === typeParam) ?? 'account');
  const [targetId, setTargetId] = useState((params.get('id') ?? '').toUpperCase());
  const [address, setAddress] = useState('');
  const [mosaics, setMosaics] = useState<OwnedMosaic[]>([]);
  const [namespaces, setNamespaces] = useState<OwnedNamespace[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(true);

  // existing entries of the target
  const [entries, setEntries] = useState<MetadataEntry[] | 'loading' | 'failed'>('loading');
  const [reloadTick, setReloadTick] = useState(0);

  // form
  const [keyText, setKeyText] = useState('');
  const [valueText, setValueText] = useState('');

  // cost / balance
  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  // confirm / done
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [resultHash, setResultHash] = useState('');

  // The wallet's address, the mosaics / namespaces it owns (the possible targets) and the XYM balance.
  useEffect(() => {
    let cancelled = false;
    setLoadingTargets(true);
    setMosaics([]);
    setNamespaces([]);
    setXymBalance(null);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        setAddress(wallet.address);
        const [ownedMosaics, ownedNamespaces, balances] = await Promise.all([
          fetchOwnedMosaics(wallet.address).catch(() => [] as OwnedMosaic[]),
          fetchOwnedNamespaces(wallet.address).catch(() => [] as OwnedNamespace[]),
          fetchBalances(wallet.address).catch(() => null),
        ]);
        if (cancelled) return;
        setMosaics(ownedMosaics);
        setNamespaces(ownedNamespaces);
        if (balances) {
          const xym = balances.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
          setXymBalance(xym?.amount ?? 0n);
        }
      } finally {
        if (!cancelled) setLoadingTargets(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // Expired namespaces cannot take metadata.
  const usableNamespaces = useMemo(() => namespaces.filter((n) => !n.expired), [namespaces]);

  // Keep the selected id valid for the selected type (the id from the link is kept when it exists).
  useEffect(() => {
    if (type === 'mosaic') setTargetId((cur) => (mosaics.some((m) => m.id === cur) ? cur : (mosaics[0]?.id ?? '')));
    else if (type === 'namespace') setTargetId((cur) => (usableNamespaces.some((n) => n.id === cur) ? cur : (usableNamespaces[0]?.id ?? '')));
    else setTargetId('');
  }, [type, mosaics, usableNamespaces]);

  const target: MetadataTargetRef | null = useMemo(() => {
    if (address === '') return null;
    if (type === 'account') return { type, address };
    return targetId === '' ? null : { type, address, targetId };
  }, [type, address, targetId]);

  // Entries already set on the selected target.
  useEffect(() => {
    if (target === null) {
      setEntries([]);
      return undefined;
    }
    let cancelled = false;
    setEntries('loading');
    fetchMetadataEntries(target)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch(() => { if (!cancelled) setEntries('failed'); });
    return () => { cancelled = true; };
  }, [target, network, reloadTick]);

  // --- validation -------------------------------------------------------------------------
  const key = parseMetadataKey(keyText);
  const keyHex = key === null ? null : keyToHex(key);
  const valueBytes = encodeValue(valueText);
  const valueTooLong = valueBytes.length > MAX_METADATA_VALUE_BYTES;
  const existing = keyHex !== null && typeof entries !== 'string' ? entries.find((e) => e.key === keyHex) : undefined;
  const unchanged = existing !== undefined && sameBytes(existing.value, valueBytes);
  const valueError = valueTooLong ? t('metadata.draft_error_value_too_long') : unchanged ? t('metadata.unchanged') : '';
  const canContinue = target !== null && key !== null && valueText !== '' && !valueTooLong && !unchanged;

  // Transaction fee depends on the value's size (the larger of the old and the new one).
  const valueLength = valueBytes.length;
  const existingLength = existing?.value.length ?? 0;
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    quoteMetadataFee(type, [Math.max(valueLength, existingLength)])
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [type, valueLength, existingLength, network]);

  const balanceShort = txFee !== null && xymBalance !== null && xymBalance < txFee;
  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = txFee === null ? t('metadata.cost_unavailable') : xym(txFee);

  const targetName = type === 'account'
    ? address
    : type === 'mosaic'
      ? (mosaics.find((m) => m.id === targetId)?.symbol ?? targetId)
      : (usableNamespaces.find((n) => n.id === targetId)?.name ?? targetId);

  // --- sending ----------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (target === null || key === null) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const metadataTarget: MetadataTarget = type === 'account'
        ? { type: 'account' }
        : type === 'mosaic' ? { type: 'mosaic', mosaicId: targetId } : { type: 'namespace', namespaceId: targetId };
      const sent = await setMetadata({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        target: metadataTarget,
        items: [{ key, value: valueBytes }],
      });
      setResultHash(sent.hash);
      setStep('done');
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate(-1);
  };

  const onAnother = () => {
    setKeyText('');
    setValueText('');
    setReloadTick((n) => n + 1);
    setStep('form');
  };

  const errorTitle = sendError ? t(`metadata.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`metadata.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // ============================ done ============================
  if (step === 'done') {
    return (
      <Box sx={{ minHeight: '100vh' }}>
        <Box sx={{ width: '100%', px: { xs: 3, md: 5 }, py: 4, boxSizing: 'border-box', textAlign: 'center' }}>
          <Typography sx={{ fontSize: 'x-large', color: 'primary.main', mb: 2 }}>
            {(t('metadata.done_message', { returnObjects: true }) as string[]).map((line, i) => (
              <span key={i}>{line}<br /></span>
            ))}
          </Typography>
          <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all', mb: 3 }}>{targetName}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Button variant="contained" color="primary" fullWidth onClick={onAnother}>
              {t('metadata.set_another')}
            </Button>
            <Button href={explorerTxUrl(resultHash)} target="_blank" rel="noopener" variant="contained" fullWidth>
              {t('metadata.view_explorer')}
            </Button>
          </Box>
        </Box>
      </Box>
    );
  }

  // ============================ confirm ============================
  if (step === 'confirm') {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('metadata.target_label'), value: `${t(`metadata.type_${type}`)}\n${targetName}`, big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('metadata.key_label'), value: keyHex !== null && keyText.trim() !== keyHex ? `${keyText.trim()}\n(${keyHex})` : (keyHex ?? '') },
      { label: t('metadata.value_label'), value: valueText },
      ...(existing !== undefined ? [{ label: t('metadata.overwrite_label'), value: existing.valueText ?? existing.valueHex }] : []),
      { label: t('metadata.tx_fee'), value: feeText },
    ];
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back="/metadata" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {rows.map((row, i) => (
              <Box key={row.label}>
                {i > 0 && <Divider />}
                <Box sx={{ py: 2 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                  <Typography sx={{ fontSize: row.big ? '1.2rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                    {row.value}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        <MessageDialog
          open={showCaution}
          title={t('metadata.confirm_title')}
          texts={t('metadata.confirm_dialog_message', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('metadata.sending') : t('metadata.confirm_ready')}</Typography>
            <Button
              variant="contained"
              color="primary"
              size="large"
              fullWidth
              disabled={sending}
              onClick={() => setShowPasswordDialog(true)}
              startIcon={<LockOutlinedIcon />}
              sx={{ py: 1.5 }}
            >
              {t('metadata.confirm_password')}
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
  const noTarget = !loadingTargets && ((type === 'mosaic' && mosaics.length === 0) || (type === 'namespace' && usableNamespaces.length === 0));
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('metadata.caution_owner')}</Alert>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('metadata.target_label')}</Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          color="primary"
          value={type}
          onChange={(_, v: MetadataTargetType | null) => { if (v) setType(v); }}
          sx={{ mb: 2 }}
        >
          {TYPES.map((x) => <ToggleButton key={x} value={x}>{t(`metadata.type_${x}`)}</ToggleButton>)}
        </ToggleButtonGroup>

        {loadingTargets && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>
        )}
        {type === 'account' && address !== '' && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>{address}</Typography>
        )}
        {noTarget && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {type === 'mosaic' ? t('metadata.no_mosaic') : t('metadata.no_namespace')}
          </Alert>
        )}
        {type === 'mosaic' && mosaics.length > 0 && (
          <TextField select label={t('metadata.mosaic_label')} value={targetId} onChange={(e) => setTargetId(e.target.value)} fullWidth sx={{ mb: 2 }}>
            {mosaics.map((m) => (
              <MenuItem key={m.id} value={m.id}>{m.symbol === m.id ? m.id : `${m.symbol} (${m.id})`}</MenuItem>
            ))}
          </TextField>
        )}
        {type === 'namespace' && usableNamespaces.length > 0 && (
          <TextField select label={t('metadata.namespace_label')} value={targetId} onChange={(e) => setTargetId(e.target.value)} fullWidth sx={{ mb: 2 }}>
            {usableNamespaces.map((n) => <MenuItem key={n.id} value={n.id}>{n.name}</MenuItem>)}
          </TextField>
        )}

        {target !== null && (
          <>
            <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t('metadata.existing_title')}</Typography>
            {entries === 'loading' ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}><CircularProgress size={22} /></Box>
            ) : entries === 'failed' ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('metadata.load_failed')}</Typography>
            ) : entries.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('metadata.existing_empty')}</Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5 }}>
                {entries.map((e) => (
                  <Card key={e.key} variant="outlined">
                    <CardActionArea
                      disabled={e.valueText === null}
                      onClick={() => { setKeyText(e.key); setValueText(e.valueText ?? ''); }}
                      sx={{ px: 2, py: 1 }}
                    >
                      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontFamily: 'monospace' }}>{e.key}</Typography>
                      <Typography sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{e.valueText ?? `0x${e.valueHex}`}</Typography>
                    </CardActionArea>
                  </Card>
                ))}
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('metadata.existing_hint')}</Typography>
              </Box>
            )}
          </>
        )}

        <Typography sx={{ fontWeight: 'bold', mt: 2, mb: 1 }}>{t('metadata.new_title')}</Typography>
        <TextField
          label={t('metadata.key_label')}
          value={keyText}
          onChange={(e) => setKeyText(e.target.value)}
          helperText={keyHex !== null ? t('metadata.key_resolved', { hex: keyHex }) : t('metadata.key_hint')}
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          sx={{ mb: 2 }}
        />
        <TextField
          label={t('metadata.value_label')}
          value={valueText}
          onChange={(e) => setValueText(e.target.value)}
          error={valueError !== ''}
          helperText={valueError || t('metadata.value_bytes', { bytes: valueLength, max: MAX_METADATA_VALUE_BYTES })}
          fullWidth
          multiline
          minRows={3}
          sx={{ mb: 2 }}
        />
        {existing !== undefined && !unchanged && (
          <Alert severity="warning" sx={{ mb: 2 }}>{t('metadata.will_overwrite')}</Alert>
        )}

        <Box sx={{ mt: 1, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{t('metadata.tx_fee')}: {feeText}</Typography>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('metadata.cost_hint')}</Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('metadata.xym_short_warning')}</Alert>}
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button
          variant="contained"
          color="primary"
          size="large"
          fullWidth
          disabled={!canContinue}
          onClick={() => { setStep('confirm'); setShowCaution(true); }}
          sx={{ py: 1.5 }}
        >
          {t('metadata.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}
