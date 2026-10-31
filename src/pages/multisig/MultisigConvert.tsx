import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, Typography } from '@mui/material';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import MessageDialog from '../../components/MessageDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchBalances } from '../../lib/symbol/api';
import {
  fetchAccountPublicKey, fetchCosignedAccounts, fetchCosignerGraph, fetchMaxMultisigDepth, quoteMultisigCost, submitMultisig,
} from '../../lib/symbol/multisigApi';
import type { MultisigCost } from '../../lib/symbol/multisigApi';
import { MAX_MULTISIG_DEPTH, depthAfterChange, mergeGraphs, missingSignatures, modificationCosignatures, planApproval } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import { MAX_MULTISIG_COSIGNERS, multisigModificationAggregateSize } from '../../lib/symbol/tx';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { useAppStore } from '../../store/appStore';
import { ConfirmScreen, CostBox, Field, FormRow, SectionCard, ValueBox, addressPrefix, addressProblem, mono, xymText } from './parts';
import type { ConfirmRow } from './parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { explorerTxUrl } from '../../lib/symbol/api';

type Step = 'form' | 'confirm';

// 「マルチシグにする」 / 「マルチシグの設定変更」. Without ?account= the wallet's own account is
// converted; with ?account=<address> the cosigners / thresholds of a multisig account this wallet
// cosigns for are changed. Both travel as a bonded aggregate (the others have to sign).
// マルチレベルマルチシグ: a cosigner may itself be a multisig account. It then signs through its own cosigners, so their
// signatures are the ones that are counted (for the fee) and collected.
function MultisigConvert({ onSent }: SentProps) {
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
  const [graph, setGraph] = useState<MultisigGraph | null>(null); // the cosigner tree of the target (マルチレベルマルチシグ)
  const [levelsAbove, setLevelsAbove] = useState(0); // multisig accounts above the target (it cosigns for them)
  const [ancestors, setAncestors] = useState<string[]>([]); // every account the target cosigns for, at any depth
  const [maxDepth, setMaxDepth] = useState(MAX_MULTISIG_DEPTH);
  const [addedGraph, setAddedGraph] = useState<MultisigGraph>(new Map()); // the cosigner trees of the addresses typed in
  const [addedLoading, setAddedLoading] = useState(false);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);
  const [blocked, setBlocked] = useState(''); // i18n key suffix of a reason the form cannot be used

  const [rows, setRows] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [approvalInput, setApprovalInput] = useState<number | null>(null); // null = everyone / unchanged
  const [removalInput, setRemovalInput] = useState<number | null>(null);

  const [cost, setCost] = useState<MultisigCost | null>(null);
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
        const [g, balances, key, above, depth] = await Promise.all([
          fetchCosignerGraph(account),
          fetchBalances(wallet.address).catch(() => null),
          editing ? fetchAccountPublicKey(account) : Promise.resolve(wallet.publicKey),
          fetchCosignedAccounts(account).catch(() => []),
          fetchMaxMultisigDepth(),
        ]);
        if (cancelled) return;
        const i = g.get(normalizeAddress(account));
        if (!i) throw new Error('no_info');
        setGraph(g);
        setLevelsAbove(Math.max(0, ...above.map((a) => a.level)));
        setAncestors(above.map((a) => a.info.address));
        setMaxDepth(depth);
        setTargetKey(key);
        const xym = balances?.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        setXymBalance(balances ? (xym?.amount ?? 0n) : null);
        if (editing) {
          // The wallet may cosign through other multisig accounts (マルチレベルマルチシグ), so any depth counts.
          if (!planApproval(g, account, wallet.address).eligible) setBlocked('err_not_cosigner');
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
  const info = graph?.get(normalizeAddress(target)) ?? null;
  const existing = info?.cosignatories ?? [];
  const remaining = existing.filter((a) => !removed.includes(a));
  const rowNorm = rows.map(normalizeAddress);
  const rowErrors = rows.map((text, i) => {
    if (text.trim() === '') return '';
    const problem = addressProblem(text);
    if (problem) return problem;
    if (rowNorm[i] === normalizeAddress(target)) return 'err_address_self';
    if (rowNorm.findIndex((a) => a === rowNorm[i]) !== i || remaining.includes(rowNorm[i])) return 'err_address_duplicate';
    // An account the target cosigns for (at any depth) cannot become its cosigner: the tree would loop.
    if (ancestors.includes(rowNorm[i])) return 'err_cosigner_loop';
    return '';
  });
  const added = rowNorm.filter((_, i) => rows[i].trim() !== '' && rowErrors[i] === '');
  const total = remaining.length + added.length;
  const tooMany = total > MAX_MULTISIG_COSIGNERS;

  // The cosigner trees of the addresses typed in: whether each is a multisig account decides who has to sign for it.
  const addedKey = added.join(',');
  useEffect(() => {
    const missing = added.filter((a) => !addedGraph.has(a));
    if (missing.length === 0) { setAddedLoading(false); return undefined; }
    let cancelled = false;
    setAddedLoading(true);
    Promise.all(missing.map((a) => fetchCosignerGraph(a).catch(() => null)))
      .then((gs) => {
        if (cancelled) return;
        setAddedGraph((cur) => mergeGraphs(cur, ...gs.filter((g): g is MultisigGraph => g !== null)));
        setAddedLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the addresses typed in
  }, [addedKey, network]);
  const allGraph = useMemo(() => (graph ? mergeGraphs(graph, addedGraph) : addedGraph), [graph, addedGraph]);
  const addedMultisig = added.filter((a) => allGraph.get(a)?.isMultisig);
  const nestedAfter = addedMultisig.length > 0 || remaining.some((a) => allGraph.get(a)?.isMultisig);
  // Nesting is limited: this account, its cosigners' own cosigners, … and the accounts it cosigns for all count.
  const depth = depthAfterChange(allGraph, [...remaining, ...added], levelsAbove);
  const tooDeep = !addedLoading && depth > maxDepth;
  const maxMin = Math.max(total, 1);
  const clamp = (v: number | null) => (v === null ? maxMin : Math.min(Math.max(v, 1), maxMin));
  const approval = clamp(approvalInput);
  const removal = clamp(removalInput);
  const changed = added.length > 0 || removed.length > 0 || (info !== null && (approval !== info.minApproval || removal !== info.minRemoval));
  const hasRowError = rowErrors.some((e) => e !== '');
  const canContinue = !blocked && !loading && !addedLoading && !hasRowError && !tooMany && !tooDeep && total >= 1 && (editing ? changed : added.length >= 1) && (!editing || targetKey !== null);

  const change = useMemo(() => ({
    minApprovalDelta: approval - (info?.minApproval ?? 0),
    minRemovalDelta: removal - (info?.minRemoval ?? 0),
    additions: added,
    deletions: removed,
  }), [approval, removal, info, added, removed]);

  // Everyone who has to sign besides the wallet: enough of the account's current cosigners (when it already is multisig)
  // AND every cosigner being added (they opt in). A multisig cosigner signs through its own cosigners, so those count.
  const othersNeeded = modificationCosignatures(allGraph, editing ? target : null, added, walletAddress);
  const cosignatureCount = Math.max(othersNeeded, 1);
  const signaturesNeeded = othersNeeded + 1; // including this wallet
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
    showTxNotice({ lines: t('multisig.done_bonded', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('multisig.view_explorer') });
    onSent();
  };

  if (step === 'confirm') {
    const list = (title: string, items: string[]): ConfirmRow[] => (items.length ? [{ label: title, value: items.join('\n') }] : []);
    const confirmRows: ConfirmRow[] = [
      { label: t('multisig.account_label'), value: target, big: true },
      { label: t('multisig.network_label'), value: `${netCfg.key === 'mijin' ? '' : 'Symbol '}${netCfg.label}` },
      ...list(t('multisig.item_add'), added.map((a) => (allGraph.get(a)?.isMultisig ? `${a}\n${t('multisig.cosigner_is_multisig', { approval: allGraph.get(a)!.minApproval, count: allGraph.get(a)!.cosignatories.length })}` : a))),
      ...list(t('multisig.item_remove'), removed),
      { label: t('multisig.min_approval_label'), value: info && editing ? `${info.minApproval} → ${approval}` : `${approval}` },
      { label: t('multisig.min_removal_label'), value: info && editing ? `${info.minRemoval} → ${removal}` : `${removal}` },
      { label: t('multisig.total_after', { count: total }), value: [...remaining, ...added].join('\n') },
      ...(nestedAfter ? [{ label: t('multisig.multilevel_signatures_row'), value: t('multisig.multilevel_signatures_value', { count: signaturesNeeded }) }] : []),
      { label: t('multisig.total_needed'), value: cost ? xymText(cost.totalNeeded) : t('multisig.cost_unavailable') },
    ];
    return <ConfirmScreen rows={confirmRows} onBack={() => setStep('form')} onPassword={onSend} />;
  }

  const selectOptions = Array.from({ length: maxMin }, (_, k) => k + 1).map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>);
  const addressInput = { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } as const;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {blocked && <Alert severity="warning" sx={{ mb: 2 }}>{t(`multisig.${blocked}`)}</Alert>}
        <Alert severity={editing ? 'info' : 'warning'} sx={{ mb: 2 }}>
          {editing ? t('multisig.edit_note') : (t('multisig.convert_warning', { returnObjects: true }) as string[]).map((l, i) => <span key={i}>{l}<br /></span>)}
        </Alert>

        <SectionCard title={t('multisig.manage_title')}>
          <FormRow label={t('multisig.op_type_label')}>
            <Typography>{editing ? t('multisig.op_edit') : t('multisig.op_convert')}</Typography>
          </FormRow>
          <FormRow label={editing ? t('multisig.account_label') : t('multisig.convert_account_label')}>
            <ValueBox>{target || walletAddress}</ValueBox>
          </FormRow>

          <FormRow label={t('multisig.cosigners_label')} top>
            {editing && existing.length > 0 && (
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>{t('multisig.current_cosigners')}</Typography>
                {existing.map((a) => {
                  const gone = removed.includes(a);
                  return (
                    <Box key={a} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
                      <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0, textDecoration: gone ? 'line-through' : 'none', color: gone ? 'text.disabled' : 'text.primary', ...mono }}>
                        {a}
                      </Typography>
                      {graph?.get(a)?.isMultisig && <Chip size="small" variant="outlined" color="primary" label={t('multisig.multilevel_chip', { approval: graph.get(a)!.minApproval, count: graph.get(a)!.cosignatories.length })} />}
                      {gone && <Chip size="small" color="error" label={t('multisig.will_remove')} />}
                      <IconButton
                        size="small"
                        aria-label={gone ? t('multisig.undo_remove') : t('multisig.remove_row')}
                        onClick={() => setRemoved((r) => (gone ? r.filter((x) => x !== a) : [...r, a]))}
                      >
                        {gone ? <UndoIcon fontSize="small" /> : <DeleteOutlinedIcon fontSize="small" />}
                      </IconButton>
                    </Box>
                  );
                })}
              </Box>
            )}

            {remaining.length === 0 && rows.length === 0 && !loading && (
              <Typography variant="body2" sx={{ textAlign: 'center', color: 'text.secondary', py: 1.5 }}>{t('multisig.no_cosigners')}</Typography>
            )}

            {rows.map((text, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'flex-start' }}>
                <Field
                  ariaLabel={t('multisig.cosigner_n', { n: i + 1 })}
                  placeholder={t('multisig.cosigner_n', { n: i + 1 })}
                  value={text}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? e.target.value : x)))}
                  error={rowErrors[i] !== ''}
                  helperText={rowErrors[i] ? t(`multisig.${rowErrors[i]}`) : rowNorm[i] && allGraph.get(rowNorm[i])?.isMultisig
                    ? t('multisig.added_is_multisig', {
                      approval: allGraph.get(rowNorm[i])!.minApproval,
                      count: allGraph.get(rowNorm[i])!.cosignatories.length,
                      needed: missingSignatures(allGraph, rowNorm[i], new Set([normalizeAddress(walletAddress)])),
                    })
                    : t('multisig.address_hint', { prefix: addressPrefix() })}
                  htmlInput={addressInput}
                />
                <IconButton aria-label={t('multisig.remove_row')} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                  <DeleteOutlinedIcon />
                </IconButton>
              </Box>
            ))}

            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.5 }}>
              <Button startIcon={<AddCircleIcon />} onClick={() => setRows((r) => [...r, ''])} disabled={total >= MAX_MULTISIG_COSIGNERS}>
                {t('multisig.add_cosigner')}
              </Button>
            </Box>
            {tooMany && <Alert severity="error" sx={{ mt: 1.5 }}>{t('multisig.err_too_many', { max: MAX_MULTISIG_COSIGNERS })}</Alert>}
            {tooDeep && <Alert severity="error" sx={{ mt: 1.5 }}>{t('multisig.err_too_deep', { max: maxDepth })}</Alert>}
            {nestedAfter && !tooDeep && <Alert severity="info" sx={{ mt: 1.5 }}>{t('multisig.multilevel_edit_note')}</Alert>}
            <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.secondary', mt: 0.5 }}>{t('multisig.total_after', { count: total })}</Typography>
          </FormRow>

          <FormRow label={t('multisig.f_min_approval')} hint={t('multisig.hint_min_approval')}>
            <Field select ariaLabel={t('multisig.f_min_approval')} value={approval} onChange={(e) => setApprovalInput(Number(e.target.value))}>{selectOptions}</Field>
          </FormRow>
          <FormRow label={t('multisig.f_min_removal')} hint={t('multisig.hint_min_removal')}>
            <Field select ariaLabel={t('multisig.f_min_removal')} value={removal} onChange={(e) => setRemovalInput(Number(e.target.value))}>{selectOptions}</Field>
          </FormRow>
          {editing && !changed && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('multisig.err_no_change')}</Typography>}

          <FormRow label={t('multisig.f_fee')}>
            <Typography>{cost ? xymText(cost.aggregateFee.fee) : t('multisig.cost_unavailable')}</Typography>
          </FormRow>
        </SectionCard>

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

export default withFormReset<object>(MultisigConvert);
