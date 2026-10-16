import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, CardActionArea, Chip, CircularProgress, Divider, Link, MenuItem, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { SxProps, Theme } from '@mui/material/styles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { useAddressBook } from '../../hooks/useAddressBook';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import {
  SymbolSendError, explorerAccountUrl, explorerTxUrl, fetchBalances, fetchMetadataEntries, fetchOwnedMosaics, fetchOwnedNamespaces,
  quoteMetadataFee, setMetadata,
} from '../../lib/symbol/api';
import type { MetadataEntry, MetadataTargetRef, OwnedMosaic, OwnedNamespace } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { MAX_METADATA_VALUE_BYTES, encodeValue, keyToHex, parseMetadataKey } from '../../lib/symbol/metadata';
import type { MetadataTargetType } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import type { AggregateSigner } from '../../lib/symbol/aggregate';
import {
  fetchMetadataFromOthers, groupBySource, quoteMetadataForOther, resolveMetadataOwnerInput, setMetadataForOther,
} from '../../lib/symbol/metadataOther';
import type { MetadataOtherQuote, OtherMetadataResult } from '../../lib/symbol/metadataOther';
import type { MetadataTarget } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { showTxNotice } from '../../store/txNoticeStore';

const TYPES: MetadataTargetType[] = ['account', 'mosaic', 'namespace'];

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown, forOther = false): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Mosaic_Expired' || code === 'Failure_Namespace_Expired') return { kind: 'expired', detail };
  if (forOther && code === 'Failure_Core_Missing_Required_Signature') return { kind: 'missing_signature', detail };
  if (code === 'Failure_Mosaic_Owner_Conflict' || code === 'Failure_Namespace_Owner_Conflict' || code === 'Failure_Core_Missing_Required_Signature') {
    return { kind: 'owner', detail };
  }
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

type Step = 'form' | 'confirm';

interface MetadataEditorProps {
  /** Shown inside another screen (a dialog) instead of as a screen of its own: no full-height layout. */
  embedded?: boolean;
  /** The target kind is fixed (its selector is hidden), e.g. the mosaic screen only sets mosaic metadata. */
  lockedType?: MetadataTargetType;
  initialType?: MetadataTargetType;
  initialTargetId?: string;
  /** Embedded only: dismisses the host (the dialog). */
  onClose?: () => void;
  /** The account that sets the metadata (and pays for it). Omitted = the active account. */
  account?: Wallet;
  /** Called after the metadata has been sent, so the host can reload what it shows. */
  onSent?: () => void;
}

// 「メタデータ」: attach key/value metadata to the wallet's own address, to a mosaic it created or to a
// namespace it registered. Used as the /metadata screen, and embedded in the mosaic screen's dialog.
export function MetadataEditor({ embedded = false, lockedType, initialType, initialTargetId, onClose, account, onSent }: MetadataEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');

  // target
  const [type, setType] = useState<MetadataTargetType>(lockedType ?? initialType ?? 'account');
  const [targetId, setTargetId] = useState((initialTargetId ?? '').toUpperCase());
  const [address, setAddress] = useState(''); // the wallet's own address (the source of the entries)
  // Whose address / mosaic / namespace gets the metadata: the wallet's own, or another account's (needs its co-signature).
  const [ownerMode, setOwnerMode] = useState<'self' | 'other'>('self');
  const [otherInput, setOtherInput] = useState('');
  const [otherState, setOtherState] = useState<
    { status: 'idle' | 'loading' } | { status: 'ok'; owner: AggregateSigner; alias?: string } | { status: 'error'; error: string }
  >({ status: 'idle' });
  const { entries: contacts } = useAddressBook();
  const [mosaics, setMosaics] = useState<OwnedMosaic[]>([]);
  const [namespaces, setNamespaces] = useState<OwnedNamespace[]>([]);
  const [fetchingTargets, setFetchingTargets] = useState(true);

  // existing entries of the target
  const [entries, setEntries] = useState<MetadataEntry[] | 'loading' | 'failed'>('loading');
  const [reloadTick, setReloadTick] = useState(0);
  // entries other accounts have attached to the same target (read-only)
  const [others, setOthers] = useState<OtherMetadataResult | 'loading' | 'failed'>('loading');

  // form
  const [keyText, setKeyText] = useState('');
  const [valueText, setValueText] = useState('');

  // cost / balance
  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [otherQuote, setOtherQuote] = useState<MetadataOtherQuote | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  // confirm / done
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The wallet's address and its XYM balance (it pays the fee, and the hash lock for another account's metadata).
  useEffect(() => {
    let cancelled = false;
    setXymBalance(null);
    (async () => {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet || cancelled) return;
      setAddress(wallet.address);
      const balances = await fetchBalances(wallet.address).catch(() => null);
      if (cancelled || !balances) return;
      const xymBalanceEntry = balances.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
      setXymBalance(xymBalanceEntry?.amount ?? 0n);
    })();
    return () => { cancelled = true; };
  }, [network, account]);

  // Another account typed in: an address, a namespace alias or a public key, resolved to the account that must co-sign.
  useEffect(() => {
    if (ownerMode !== 'other') return undefined;
    const raw = otherInput.trim();
    if (raw === '' || address === '') {
      setOtherState({ status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setOtherState({ status: 'loading' });
    const timer = setTimeout(() => {
      resolveMetadataOwnerInput(raw, address).then((res) => {
        if (cancelled) return;
        setOtherState(res.ok ? { status: 'ok', owner: res.owner, alias: res.alias } : { status: 'error', error: res.error });
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ownerMode, otherInput, address, network]);

  const other: AggregateSigner | null = ownerMode === 'other' && otherState.status === 'ok' ? otherState.owner : null;
  // The account the metadata is attached to (the owner of the mosaic / namespace).
  const ownerAddress = ownerMode === 'other' ? (other?.address ?? '') : address;

  // The mosaics / namespaces that account owns (the possible targets).
  useEffect(() => {
    let cancelled = false;
    setMosaics([]);
    setNamespaces([]);
    if (ownerAddress === '') {
      setFetchingTargets(false);
      return undefined;
    }
    setFetchingTargets(true);
    (async () => {
      try {
        const [ownedMosaics, ownedNamespaces] = await Promise.all([
          fetchOwnedMosaics(ownerAddress).catch(() => [] as OwnedMosaic[]),
          fetchOwnedNamespaces(ownerAddress).catch(() => [] as OwnedNamespace[]),
        ]);
        if (cancelled) return;
        setMosaics(ownedMosaics);
        setNamespaces(ownedNamespaces);
      } finally {
        if (!cancelled) setFetchingTargets(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ownerAddress, network]);
  const loadingTargets = fetchingTargets || (ownerAddress === '' && (ownerMode === 'self' || otherState.status === 'loading'));

  // Expired namespaces cannot take metadata.
  const usableNamespaces = useMemo(() => namespaces.filter((n) => !n.expired), [namespaces]);

  // Keep the selected id valid for the selected type (the id from the link is kept when it exists).
  useEffect(() => {
    if (type === 'mosaic') setTargetId((cur) => (mosaics.some((m) => m.id === cur) ? cur : (mosaics[0]?.id ?? '')));
    else if (type === 'namespace') setTargetId((cur) => (usableNamespaces.some((n) => n.id === cur) ? cur : (usableNamespaces[0]?.id ?? '')));
    else setTargetId('');
  }, [type, mosaics, usableNamespaces]);

  const target: MetadataTargetRef | null = useMemo(() => {
    if (ownerAddress === '') return null;
    // For another account's target only the entries this wallet set (as the source) are read and replaced.
    const sourceAddress = ownerMode === 'other' ? address : undefined;
    if (type === 'account') return { type, address: ownerAddress, sourceAddress };
    return targetId === '' ? null : { type, address: ownerAddress, sourceAddress, targetId };
  }, [type, ownerAddress, ownerMode, address, targetId]);

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

  // Entries attached by accounts other than this wallet (the wallet's own ones are listed above). Display only.
  useEffect(() => {
    if (target === null || address === '') {
      setOthers({ entries: [], truncated: false });
      return undefined;
    }
    let cancelled = false;
    setOthers('loading');
    fetchMetadataFromOthers(target, [address])
      .then((res) => { if (!cancelled) setOthers(res); })
      .catch(() => { if (!cancelled) setOthers('failed'); });
    return () => { cancelled = true; };
  }, [target, address, network, reloadTick]);
  const othersGroups = useMemo(() => (typeof others === 'string' ? [] : groupBySource(others.entries)), [others]);
  // A source that is in the address book is shown by its name (and flagged when it is on the trust / block list).
  const contactOf = (source: string) => contacts.find((c) => c.chain === 'symbol' && c.network === network && normalizeAddress(c.address) === source);

  // --- validation -------------------------------------------------------------------------
  const key = parseMetadataKey(keyText);
  const keyHex = key === null ? null : keyToHex(key);
  const valueBytes = encodeValue(valueText);
  const valueTooLong = valueBytes.length > MAX_METADATA_VALUE_BYTES;
  const existing = keyHex !== null && typeof entries !== 'string' ? entries.find((e) => e.key === keyHex) : undefined;
  const unchanged = existing !== undefined && sameBytes(existing.value, valueBytes);
  const valueError = valueTooLong ? t('metadata.draft_error_value_too_long') : unchanged ? t('metadata.unchanged') : '';
  const canContinue = target !== null && key !== null && valueText !== '' && !valueTooLong && !unchanged && (ownerMode === 'self' || other !== null);

  // Transaction fee depends on the value's size (the larger of the old and the new one). For another account's
  // metadata the aggregate is bonded: room for the owner's cosignatures, plus a hash lock deposit.
  const valueLength = valueBytes.length;
  const existingLength = existing?.value.length ?? 0;
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    setOtherQuote(null);
    const length = Math.max(valueLength, existingLength);
    if (ownerMode === 'other') {
      if (other === null) return undefined;
      quoteMetadataForOther(type, [length], other)
        .then((q) => { if (!cancelled) { setOtherQuote(q); setTxFee(q.fee); } })
        .catch(() => { /* shown as unavailable */ });
    } else {
      quoteMetadataFee(type, [length])
        .then((q) => { if (!cancelled) setTxFee(q.fee); })
        .catch(() => { /* shown as unavailable */ });
    }
    return () => { cancelled = true; };
  }, [type, valueLength, existingLength, network, ownerMode, other]);

  // The hash lock deposit and its fee are paid from the wallet too, on top of the aggregate's fee.
  const lockTotal = otherQuote === null ? 0n : otherQuote.lockAmount + otherQuote.lockFee;
  const balanceShort = txFee !== null && xymBalance !== null && xymBalance < txFee + lockTotal;
  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = txFee === null ? t('metadata.cost_unavailable') : xym(txFee);

  const targetName = type === 'account'
    ? ownerAddress
    : type === 'mosaic'
      ? (mosaics.find((m) => m.id === targetId)?.symbol ?? targetId)
      : (usableNamespaces.find((n) => n.id === targetId)?.name ?? targetId);

  // --- sending ----------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (target === null || key === null) return;
    setSending(true);
    try {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const metadataTarget: MetadataTarget = type === 'account'
        ? { type: 'account' }
        : type === 'mosaic' ? { type: 'mosaic', mosaicId: targetId } : { type: 'namespace', namespaceId: targetId };
      if (ownerMode === 'other') {
        // Another account's target: a bonded aggregate (hash lock first); the owner co-signs it afterwards.
        if (other === null) return;
        const sent = await setMetadataForOther({
          privateKey,
          publicKey: wallet.publicKey,
          address: wallet.address,
          owner: other,
          target: metadataTarget,
          items: [{ key, value: valueBytes }],
        });
        notifyDone(sent.hash, sent.bonded);
        onAnother();
        onSent?.();
        return;
      }
      const sent = await setMetadata({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        target: metadataTarget,
        items: [{ key, value: valueBytes }],
      });
      notifyDone(sent.hash, false);
      onAnother();
      onSent?.();
    } catch (error) {
      setSendError(classifyError(error, ownerMode === 'other'));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else if (embedded) onClose?.();
    else navigate(-1);
  };

  // A screen fills the window; the embedded editor only takes the height of its content.
  const rootSx: SxProps<Theme> = embedded
    ? { display: 'flex', flexDirection: 'column' }
    : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };

  // 送信の結果は完了画面ではなくトーストで知らせ、入力は空に戻す（onAnother）。
  function notifyDone(hash: string, bonded: boolean) {
    const lines = t(bonded ? 'metadata.done_bonded_message' : 'metadata.done_message', { returnObjects: true }) as string[];
    showTxNotice({
      lines: bonded ? [...lines, t('metadata.done_bonded_hint')] : lines,
      explorerUrl: explorerTxUrl(hash),
      explorerLabel: t('metadata.view_explorer'),
    });
  }

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

  // ============================ confirm ============================
  if (step === 'confirm') {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('metadata.target_label'), value: `${t(`metadata.type_${type}`)}\n${targetName}`, big: true },
      ...(ownerMode === 'other' && other !== null ? [{
        label: t('metadata.owner_row'),
        value: `${other.address}${otherState.status === 'ok' && otherState.alias ? `\n@${otherState.alias}` : ''}`,
      }] : []),
      { label: t('send.network'), value: `${netCfg.key === 'mijin' ? '' : 'Symbol '}${netCfg.label}` },
      { label: t('metadata.key_label'), value: keyHex !== null && keyText.trim() !== keyHex ? `${keyText.trim()}\n(${keyHex})` : (keyHex ?? '') },
      { label: t('metadata.value_label'), value: valueText },
      ...(existing !== undefined ? [{ label: t('metadata.overwrite_label'), value: existing.valueText ?? existing.valueHex }] : []),
      { label: t('metadata.tx_fee'), value: feeText },
      ...(otherQuote !== null && otherQuote.bonded ? [
        { label: t('metadata.lock_amount'), value: t('metadata.lock_amount_hint', { amount: xym(otherQuote.lockAmount) }) },
        { label: t('metadata.lock_fee'), value: xym(otherQuote.lockFee) },
        { label: t('metadata.cosign_row'), value: t('metadata.cosign_row_value') },
      ] : []),
    ];
    return (
      <Box sx={rootSx}>
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
          texts={t(otherQuote?.bonded ? 'metadata.confirm_dialog_message_other' : 'metadata.confirm_dialog_message', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('metadata.sending') : t(otherQuote?.bonded ? 'metadata.confirm_ready_other' : 'metadata.confirm_ready')}</Typography>
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
              {t(otherQuote?.bonded ? 'metadata.confirm_password_other' : 'metadata.confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPasswordDialog} mode="check" popup profileKey={account?.profileKey} onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  const noTarget = !loadingTargets && (ownerMode === 'self' || other !== null) && ((type === 'mosaic' && mosaics.length === 0) || (type === 'namespace' && usableNamespaces.length === 0));
  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t(ownerMode === 'other' ? 'metadata.caution_other' : 'metadata.caution_owner')}</Alert>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('metadata.who_label')}</Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          color="primary"
          value={ownerMode}
          onChange={(_, v: 'self' | 'other' | null) => { if (v) setOwnerMode(v); }}
          sx={{ mb: 2 }}
        >
          <ToggleButton value="self">{t('metadata.owner_self')}</ToggleButton>
          <ToggleButton value="other">{t('metadata.owner_other')}</ToggleButton>
        </ToggleButtonGroup>
        {ownerMode === 'other' && (
          <Box sx={{ mb: 2 }}>
            <TextField
              label={t('metadata.other_address_label')}
              value={otherInput}
              onChange={(e) => setOtherInput(e.target.value)}
              error={otherState.status === 'error'}
              helperText={
                otherState.status === 'error' ? t(`metadata.other_error_${otherState.error}`)
                  : otherState.status === 'loading' ? t('metadata.other_resolving')
                    : otherState.status === 'ok'
                      ? [
                        otherState.alias ? `@${otherState.alias}` : '',
                        otherState.owner.selfSufficient ? t('metadata.other_self_sufficient')
                          : t(otherState.owner.multisig ? 'metadata.other_ready_multisig' : 'metadata.other_ready', { count: otherState.owner.cosignatures }),
                      ].filter(Boolean).join(' / ')
                      : t('metadata.other_address_hint')
              }
              fullWidth
              slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
              sx={{ mb: 1.5 }}
            />
            {contacts.some((c) => c.chain === 'symbol' && c.network === network) && (
              <TextField
                select
                size="small"
                label={t('metadata.other_pick_contact')}
                value=""
                onChange={(e) => setOtherInput(e.target.value)}
                fullWidth
              >
                {contacts.filter((c) => c.chain === 'symbol' && c.network === network).map((c) => (
                  <MenuItem key={`${c.network}:${c.address}`} value={c.address}>{c.name}</MenuItem>
                ))}
              </TextField>
            )}
            {other !== null && (
              <Typography variant="body2" sx={{ mt: 1.5, wordBreak: 'break-all', fontFamily: 'monospace' }}>{other.address}</Typography>
            )}
          </Box>
        )}

        {lockedType === undefined && (
          <>
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
          </>
        )}

        {loadingTargets && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>
        )}
        {type === 'account' && ownerMode === 'self' && address !== '' && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>{address}</Typography>
        )}
        {noTarget && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {type === 'mosaic' ? t(ownerMode === 'other' ? 'metadata.no_mosaic_other' : 'metadata.no_mosaic') : t(ownerMode === 'other' ? 'metadata.no_namespace_other' : 'metadata.no_namespace')}
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
            <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t(ownerMode === 'other' ? 'metadata.existing_title_other' : 'metadata.existing_title')}</Typography>
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
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t(ownerMode === 'other' ? 'metadata.existing_hint_other' : 'metadata.existing_hint')}</Typography>
              </Box>
            )}
          </>
        )}

        {target !== null && (
          <>
            <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t('metadata.others_title')}</Typography>
            {others === 'loading' ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}><CircularProgress size={22} /></Box>
            ) : others === 'failed' ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('metadata.others_load_failed')}</Typography>
            ) : othersGroups.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('metadata.others_empty')}</Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 1.5 }}>
                <Alert severity="warning">{t('metadata.others_caution')}</Alert>
                {othersGroups.map((group) => {
                  const contact = contactOf(group.source);
                  const isOwner = ownerMode === 'other' && group.source === normalizeAddress(ownerAddress);
                  return (
                    <Card key={group.source} variant="outlined">
                      <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('metadata.others_source')}</Typography>
                          {contact && <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{contact.name}</Typography>}
                          {contact?.list === 'black' && <Chip size="small" color="error" label={t('metadata.others_black')} />}
                          {contact?.list === 'white' && <Chip size="small" color="success" variant="outlined" label={t('metadata.others_white')} />}
                          {isOwner && <Chip size="small" color="primary" variant="outlined" label={t('metadata.others_owner')} />}
                        </Box>
                        <Link
                          href={explorerAccountUrl(group.source)}
                          target="_blank"
                          rel="noopener"
                          underline="hover"
                          sx={{ display: 'block', fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}
                        >
                          {group.source}
                        </Link>
                      </Box>
                      {group.entries.map((e) => (
                        <Box key={e.key} sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }}>
                          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontFamily: 'monospace' }}>{e.key}</Typography>
                          <Typography sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>
                            {e.valueText ?? `0x${e.valueHex}`}
                          </Typography>
                        </Box>
                      ))}
                    </Card>
                  );
                })}
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('metadata.others_hint')}{others.truncated ? ` ${t('metadata.others_truncated')}` : ''}
                </Typography>
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
          {otherQuote?.bonded && (
            <>
              <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all', mt: 0.5 }}>{t('metadata.lock_amount')}: {xym(otherQuote.lockAmount)}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{t('metadata.lock_fee')}: {xym(otherQuote.lockFee)}</Typography>
            </>
          )}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t(otherQuote?.bonded ? 'metadata.cost_hint_other' : 'metadata.cost_hint')}</Typography>
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

// The /metadata screen. Other screens used to link here with ?type=mosaic|namespace&id=<hex id>.
export default function MetadataPage() {
  const [params] = useSearchParams();
  const typeParam = params.get('type');
  return (
    <MetadataEditor
      initialType={TYPES.find((x) => x === typeParam)}
      initialTargetId={params.get('id') ?? ''}
    />
  );
}
