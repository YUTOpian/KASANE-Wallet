import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import MessageDialog from '../../components/MessageDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchBalances } from '../../lib/symbol/api';
import {
  fetchAccountPublicKey, fetchMultisigInfo, quoteMultisigCost, submitMultisig,
} from '../../lib/symbol/multisigApi';
import type { MultisigCost, MultisigInfo } from '../../lib/symbol/multisigApi';
import { MAX_MULTISIG_COSIGNERS, multisigModificationAggregateSize } from '../../lib/symbol/tx';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { useAppStore } from '../../store/appStore';
import { ConfirmScreen, CostBox, DoneScreen, addressPrefix, addressProblem, xymText } from './parts';
import type { ConfirmRow } from './parts';

type Step = 'form' | 'confirm' | 'done';

// 「マルチシグにする」 / 「マルチシグの設定変更」. Without ?account= the wallet's own account is
// converted; with ?account=<address> the cosigners / thresholds of a multisig account this wallet
// cosigns for are changed. Both travel as a bonded aggregate (the others have to sign).
export default function MultisigConvert() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);
  const editAddress = params.get('account') ? normalizeAddress(params.get('account')!) : null;
  const editing = editAddress !== null;

  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(true);
  const [walletAddress, setWalletAddress] = useState('');
  const [target, setTarget] = useState(''); // the account that becomes / is multisig
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [info, setInfo] = useState<MultisigInfo | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);
  const [blocked, setBlocked] = useState(''); // i18n key suffix of a reason the form cannot be used

  const [rows, setRows] = useState<string[]>(['']);
  const [removed, setRemoved] = useState<string[]>([]);
  const [approvalInput, setApprovalInput] = useState<number | null>(null); // null = everyone / unchanged
  const [removalInput, setRemovalInput] = useState<number | null>(null);

  const [cost, setCost] = useState<MultisigCost | null>(null);
  const [resultHash, setResultHash] = useState('');
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        setWalletAddress(wallet.address);
        const account = editAddress ?? wallet.address;
        setTarget(account);
        const [i, balances, key] = await Promise.all([
          fetchMultisigInfo(account),
          fetchBalances(wallet.address).catch(() => null),
          editing ? fetchAccountPublicKey(account) : Promise.resolve(wallet.publicKey),
        ]);
        if (cancelled) return;
        setInfo(i);
        setTargetKey(key);
        const xym = balances?.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        setXymBalance(balances ? (xym?.amount ?? 0n) : null);
        if (editing) {
          if (!i.cosignatories.includes(normalizeAddress(wallet.address))) setBlocked('err_not_cosigner');
          else if (key === null) setBlocked('err_no_public_key');
          setApprovalInput(i.minApproval);
          setRemovalInput(i.minRemoval);
        } else if (i.isMultisig) {
          setBlocked('is_multisig_note');
        }
        if (!editing) setShowWarning(!i.isMultisig);
      } catch (e) {
        console.error('Failed to load multisig info', e);
        setBlocked('load_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editAddress, editing, network]);

  // --- validation -----------------------------------------------------------------------
  const existing = info?.cosignatories ?? [];
  const remaining = existing.filter((a) => !removed.includes(a));
  const rowNorm = rows.map(normalizeAddress);
  const rowErrors = rows.map((text, i) => {
    if (text.trim() === '') return '';
    const problem = addressProblem(text);
    if (problem) return problem;
    if (rowNorm[i] === normalizeAddress(target)) return 'err_address_self';
    if (rowNorm.findIndex((a) => a === rowNorm[i]) !== i || remaining.includes(rowNorm[i])) return 'err_address_duplicate';
    return '';
  });
  const added = rowNorm.filter((_, i) => rows[i].trim() !== '' && rowErrors[i] === '');
  const total = remaining.length + added.length;
  const tooMany = total > MAX_MULTISIG_COSIGNERS;
  const maxMin = Math.max(total, 1);
  const clamp = (v: number | null) => (v === null ? maxMin : Math.min(Math.max(v, 1), maxMin));
  const approval = clamp(approvalInput);
  const removal = clamp(removalInput);
  const changed = added.length > 0 || removed.length > 0 || (info !== null && (approval !== info.minApproval || removal !== info.minRemoval));
  const hasRowError = rowErrors.some((e) => e !== '');
  const canContinue = !blocked && !loading && !hasRowError && !tooMany && total >= 1 && (editing ? changed : added.length >= 1) && (!editing || targetKey !== null);

  const change = useMemo(() => ({
    minApprovalDelta: approval - (info?.minApproval ?? 0),
    minRemovalDelta: removal - (info?.minRemoval ?? 0),
    additions: added,
    deletions: removed,
  }), [approval, removal, info, added, removed]);

  // Everyone who has to sign besides the wallet: new cosigners, or enough current ones.
  const cosignatureCount = Math.max(added.length, editing ? (info?.minApproval ?? 1) - 1 : 0, 1);
  const baseSize = multisigModificationAggregateSize(added.length + removed.length);
  useEffect(() => {
    let cancelled = false;
    setCost(null);
    quoteMultisigCost(baseSize, cosignatureCount, true)
      .then((c) => { if (!cancelled) setCost(c); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [baseSize, cosignatureCount, network]);
  const balanceShort = cost !== null && xymBalance !== null && xymBalance < cost.totalNeeded;

  const onSend = async (password: string) => {
    const wallet = await WalletsHelper.getActive();
    if (!wallet || targetKey === null) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    const sent = await submitMultisig({
      privateKey,
      publicKey: wallet.publicKey,
      inner: { kind: 'modification', accountPublicKey: targetKey, change },
      bonded: true,
      cosignatureCount,
    });
    setResultHash(sent.hash);
    setStep('done');
  };

  if (step === 'done') return <DoneScreen hash={resultHash} bonded />;

  if (step === 'confirm') {
    const list = (title: string, items: string[]): ConfirmRow[] => (items.length ? [{ label: title, value: items.join('\n') }] : []);
    const confirmRows: ConfirmRow[] = [
      { label: t('multisig.account_label'), value: target, big: true },
      { label: t('multisig.network_label'), value: `Symbol ${netCfg.label}` },
      ...list(t('multisig.item_add'), added),
      ...list(t('multisig.item_remove'), removed),
      { label: t('multisig.min_approval_label'), value: info && editing ? `${info.minApproval} → ${approval}` : `${approval}` },
      { label: t('multisig.min_removal_label'), value: info && editing ? `${info.minRemoval} → ${removal}` : `${removal}` },
      { label: t('multisig.total_after', { count: total }), value: [...remaining, ...added].join('\n') },
      { label: t('multisig.total_needed'), value: cost ? xymText(cost.totalNeeded) : t('multisig.cost_unavailable') },
    ];
    return <ConfirmScreen rows={confirmRows} onBack={() => setStep('form')} onPassword={onSend} />;
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {blocked && <Alert severity="warning" sx={{ mb: 2 }}>{t(`multisig.${blocked}`)}</Alert>}
        <Alert severity={editing ? 'info' : 'warning'} sx={{ mb: 2 }}>
          {editing ? t('multisig.edit_note') : (t('multisig.convert_warning', { returnObjects: true }) as string[]).map((l, i) => <span key={i}>{l}<br /></span>)}
        </Alert>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('multisig.account_label')}</Typography>
        <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>{target || walletAddress}</Typography>

        {editing && existing.length > 0 && (
          <>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('multisig.current_cosigners')}</Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 2 }}>
              {existing.map((a) => {
                const gone = removed.includes(a);
                return (
                  <Box key={a} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" onClick={() => setRemoved((r) => (gone ? r.filter((x) => x !== a) : [...r, a]))}
                      sx={{ flexGrow: 1, cursor: 'pointer', fontFamily: 'monospace', wordBreak: 'break-all', textDecoration: gone ? 'line-through' : 'none', color: gone ? 'text.disabled' : 'text.primary' }}>
                      {a}
                    </Typography>
                    {gone && <Chip size="small" color="error" label={t('multisig.will_remove')} />}
                  </Box>
                );
              })}
            </Box>
          </>
        )}

        <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{editing ? t('multisig.new_cosigners') : t('multisig.cosigners_label')}</Typography>
        {rows.map((text, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'flex-start' }}>
            <TextField
              label={t('multisig.cosigner_n', { n: i + 1 })}
              value={text}
              onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? e.target.value : x)))}
              error={rowErrors[i] !== ''}
              helperText={rowErrors[i] ? t(`multisig.${rowErrors[i]}`) : t('multisig.address_hint', { prefix: addressPrefix() })}
              fullWidth
              slotProps={{ htmlInput: { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } }}
            />
            {rows.length > 1 && (
              <IconButton aria-label={t('multisig.remove_row')} onClick={() => setRows((r) => r.filter((_, j) => j !== i))} sx={{ mt: 1 }}>
                <DeleteOutlinedIcon />
              </IconButton>
            )}
          </Box>
        ))}
        <Button startIcon={<AddIcon />} onClick={() => setRows((r) => [...r, ''])} disabled={total >= MAX_MULTISIG_COSIGNERS} sx={{ mb: 2 }}>
          {t('multisig.add_cosigner')}
        </Button>
        {tooMany && <Alert severity="error" sx={{ mb: 2 }}>{t('multisig.err_too_many', { max: MAX_MULTISIG_COSIGNERS })}</Alert>}

        <Typography variant="body2" sx={{ mb: 1 }}>{t('multisig.total_after', { count: total })}</Typography>
        <TextField select label={t('multisig.min_approval_label')} value={approval} onChange={(e) => setApprovalInput(Number(e.target.value))} fullWidth sx={{ mb: 2 }}>
          {Array.from({ length: maxMin }, (_, k) => k + 1).map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
        </TextField>
        <TextField select label={t('multisig.min_removal_label')} value={removal} onChange={(e) => setRemovalInput(Number(e.target.value))} fullWidth sx={{ mb: 1 }}>
          {Array.from({ length: maxMin }, (_, k) => k + 1).map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
        </TextField>
        {editing && !changed && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('multisig.err_no_change')}</Typography>}

        <CostBox cost={cost} hasBalanceShort={balanceShort} />
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>
          {t('multisig.go_confirm')}
        </Button>
      </Box>
      <MessageDialog
        open={showWarning}
        title={t('multisig.convert_title')}
        texts={t('multisig.convert_warning', { returnObjects: true }) as string[]}
        onClose={() => setShowWarning(false)}
      />
    </Box>
  );
}
