import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Divider, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import MetadataEntriesEditor from '../../components/MetadataEntriesEditor';
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
import { activeDrafts, draftValueLengths, draftsToItems, draftsValid } from '../../lib/symbol/metadata';
import type { MetadataDraft } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  BLOCKS_PER_DAY, MAX_NAMESPACE_DAYS, MAX_NAMESPACE_DEPTH, MAX_NAMESPACE_NAME_LENGTH, MIN_NAMESPACE_DAYS,
  isValidNamespaceName,
} from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Namespace_Owner_Conflict' || code === 'Failure_Namespace_Root_Name_Reserved') return { kind: 'conflict', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm';
type Kind = 'root' | 'child';

interface NamespaceRegisterProps {
  /** Shown under the tabs of the namespace screen instead of as a screen of its own. */
  embedded?: boolean;
  /** Embedded: the kind comes from the tab (root / child), so its selector is hidden. */
  fixedKind?: Kind;
  /** Embedded: back to the list of owned namespaces. */
  onShowList?: () => void;
  /** Embedded: opens the metadata dialog for the namespace just registered. */
  onSetMetadata?: (namespaceId?: string) => void;
}

// ネームスペースの登録: 入力 → 確認（パスワード）→ 送信。ルートはレンタル期間つき、サブは親の下に作る。
function NamespaceRegister({ embedded = false, fixedKind, onShowList, onSent }: NamespaceRegisterProps & SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');

  // form
  const [kindState, setKind] = useState<Kind>('root');
  const kind: Kind = fixedKind ?? kindState;
  const [name, setName] = useState('');
  const [daysText, setDaysText] = useState('365');
  const [parents, setParents] = useState<OwnedNamespace[]>([]);
  const [parentId, setParentId] = useState('');
  const [metadataDrafts, setMetadataDrafts] = useState<MetadataDraft[]>([]);

  // cost / balance
  const [fees, setFees] = useState<NamespaceRentalFees | null | 'loading'>('loading');
  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  // confirm / done
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // Rental prices and the XYM balance (to warn when it will not cover them), plus the namespaces
  // the wallet already owns (the candidates for a sub-namespace's parent).
  useEffect(() => {
    let cancelled = false;
    setFees('loading');
    setXymBalance(null);
    setParents([]);
    setParentId('');
    (async () => {
      const rental = await fetchNamespaceRentalFees();
      if (!cancelled) setFees(rental);
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const [balances, owned] = await Promise.all([
          fetchBalances(wallet.address),
          fetchOwnedNamespaces(wallet.address).catch(() => [] as OwnedNamespace[]),
        ]);
        if (cancelled) return;
        const xym = balances.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        setXymBalance(xym?.amount ?? 0n);
        const usable = owned.filter((n) => n.depth < MAX_NAMESPACE_DEPTH && !n.expired);
        setParents(usable);
        setParentId(usable[0]?.id ?? '');
      } catch { /* the warning and the parent list are optional */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // --- validation -------------------------------------------------------------------------
  const nameValid = isValidNamespaceName(name);
  const nameError = name === '' || nameValid ? '' : t('namespace.invalid_name');
  const daysNumber = /^\d+$/.test(daysText) ? Number(daysText) : NaN;
  const daysValid = daysNumber >= MIN_NAMESPACE_DAYS && daysNumber <= MAX_NAMESPACE_DAYS;
  const daysError = daysText === '' || daysValid ? '' : t('namespace.invalid_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS });
  const parent = parents.find((p) => p.id === parentId);
  const metadataValid = draftsValid(metadataDrafts);
  const canContinue = nameValid && (kind === 'root' ? daysValid : parent !== undefined) && metadataValid;

  const fullName = kind === 'child' && parent ? `${parent.name}.${name}` : name;
  const durationBlocks = kind === 'root' && daysValid ? BigInt(daysNumber) * BigInt(BLOCKS_PER_DAY) : 0n;

  // Transaction fee depends on the name's length and on the metadata rows (sent in the same aggregate).
  const metadataLengthsKey = draftValueLengths(metadataDrafts).join(',');
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    quoteNamespaceRegistrationFee(nameValid ? name : 'a', metadataLengthsKey === '' ? [] : metadataLengthsKey.split(',').map(Number))
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [name, nameValid, metadataLengthsKey, network]);

  const rentalFee: bigint | null = fees === 'loading' || fees === null
    ? null
    : kind === 'root' ? fees.rootFeePerBlock * durationBlocks : fees.childFee;
  const total = rentalFee !== null && txFee !== null ? rentalFee + txFee : null;
  const balanceShort = total !== null && xymBalance !== null && xymBalance < total;

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const costText = (value: bigint | null) =>
    fees === 'loading' ? t('namespace.cost_loading') : value === null ? t('namespace.cost_unavailable') : xym(value);
  const rentalText = kind === 'root' && !daysValid ? '-' : costText(rentalFee);
  const totalText = kind === 'root' && !daysValid ? '-' : costText(total);

  // --- registering ------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    setRegistering(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const registered = await registerNamespace({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        name,
        parentId: kind === 'child' ? parentId : undefined,
        durationBlocks: kind === 'root' ? durationBlocks : undefined,
        metadata: draftsToItems(metadataDrafts),
      });
      showTxNotice({ lines: t('namespace.done_message', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(registered.hash), explorerLabel: t('namespace.view_explorer') });
      onSent();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setRegistering(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else if (embedded) onShowList?.();
    else navigate('/namespace');
  };

  // A screen fills the window; the embedded form grows to fill what is left under the tabs.
  const rootSx: SxProps<Theme> = embedded
    ? { flexGrow: 1, display: 'flex', flexDirection: 'column' }
    : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };

  const errorTitle = sendError ? t(`namespace.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`namespace.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // ============================ confirm ============================
  if (step === 'confirm') {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('namespace.full_name'), value: fullName, big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('namespace.type_label'), value: kind === 'root' ? t('namespace.type_root') : t('namespace.type_child') },
      ...(kind === 'root' ? [{ label: t('namespace.duration_label'), value: t('namespace.days_value', { days: daysNumber }) }] : []),
      ...(activeDrafts(metadataDrafts).length > 0
        ? [{ label: t('metadata.optional_title'), value: activeDrafts(metadataDrafts).map((d) => `${d.key.trim()}: ${d.value}`).join('\n') }]
        : []),
      { label: t('namespace.rental_fee'), value: rentalText },
      { label: t('namespace.tx_fee'), value: txFee === null ? t('namespace.cost_unavailable') : xym(txFee) },
      { label: t('namespace.total'), value: totalText },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={onBack} back="/namespace/register" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {rows.map((row, i) => (
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
        </Box>

        <MessageDialog
          open={showCaution}
          title={t('namespace.confirm_title')}
          texts={t('namespace.confirm_dialog_message', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{registering ? t('namespace.registering') : t('namespace.confirm_ready')}</Typography>
            <Button
              variant="contained"
              color="primary"
              size="large"
              fullWidth
              disabled={registering}
              onClick={() => setShowPasswordDialog(true)}
              startIcon={<LockOutlinedIcon />}
              sx={{ py: 1.5 }}
            >
              {t('namespace.confirm_password')}
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
  const costRows = [
    { label: t('namespace.rental_fee'), value: rentalText },
    { label: t('namespace.tx_fee'), value: txFee === null ? t('namespace.cost_loading') : xym(txFee) },
    { label: t('namespace.total'), value: totalText, bold: true },
  ];
  return (
    <Box sx={rootSx}>
      {!embedded && <BackButton onBack={onBack} back="/namespace" />}
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('namespace.caution_taken')}</Alert>

        {fixedKind === undefined && (
          <>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('namespace.type_label')}</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              color="primary"
              value={kind}
              onChange={(_, v: Kind | null) => { if (v) setKind(v); }}
              sx={{ mb: 2 }}
            >
              <ToggleButton value="root">{t('namespace.type_root')}</ToggleButton>
              <ToggleButton value="child">{t('namespace.type_child')}</ToggleButton>
            </ToggleButtonGroup>
          </>
        )}

        {kind === 'child' && (parents.length === 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>{t('namespace.no_parent')}</Alert>
        ) : (
          <TextField
            select
            label={t('namespace.parent_label')}
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            fullWidth
            sx={{ mb: 2 }}
          >
            {parents.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
          </TextField>
        ))}

        <TextField
          label={t('namespace.name_label')}
          placeholder={t('namespace.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, MAX_NAMESPACE_NAME_LENGTH))}
          error={nameError !== ''}
          helperText={nameError || t('namespace.name_hint')}
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          sx={{ mb: 2 }}
        />
        {name !== '' && nameValid && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all' }}>
            {t('namespace.full_name')}: <b>{fullName}</b>
          </Typography>
        )}

        {kind === 'root' && (
          <TextField
            label={t('namespace.days_label')}
            value={daysText}
            onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))}
            error={daysError !== ''}
            helperText={daysError || t('namespace.days_hint', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })}
            fullWidth
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            sx={{ mb: 2 }}
          />
        )}

        <MetadataEntriesEditor drafts={metadataDrafts} onChange={setMetadataDrafts} />

        <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('namespace.cost_title')}</Typography>
          {costRows.map((r) => (
            <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
          ))}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('namespace.cost_hint')}</Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('namespace.xym_short_warning')}</Alert>}
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
            {t('namespace.go_confirm')}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

export default withFormReset<NamespaceRegisterProps>(NamespaceRegister);
