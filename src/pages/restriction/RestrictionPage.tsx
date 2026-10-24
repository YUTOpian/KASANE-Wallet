import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, MenuItem, Tab, Tabs, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { useAddressBook } from '../../hooks/useAddressBook';
import { useNoKey } from '../../hooks/useWatchOnly';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import {
  SymbolSendError, explorerTxUrl, fetchAccountRestrictions, fetchBalances, getMosaicInfos, quoteAccountRestrictionFee,
  resolveRecipientInput, setAccountRestriction,
} from '../../lib/symbol/api';
import type { MosaicBalance } from '../../lib/symbol/api';
import { fetchAccountPublicKey, fetchCosignedAccounts, fetchCosignerGraph, quoteMultisigCost, submitMultisig } from '../../lib/symbol/multisigApi';
import { planApproval } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import type { MultisigCost } from '../../lib/symbol/multisigApi';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { normalizeAddress, prettyAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { parseRestrictionAddressInput } from '../../lib/symbol/restrictionAlias';
import type { RestrictionAddressResult } from '../../lib/symbol/restrictionAlias';
import {
  MAX_RESTRICTION_VALUES, OPERATION_RESTRICTION_TYPE, RESTRICTION_DIRECTIONS, RESTRICTION_KINDS, RESTRICTION_OPERATIONS,
  findList, lacksMultisigModification, operationCode, operationKey, parseRestrictionInput, resultingValues, validateChangeSet,
} from '../../lib/symbol/restrictions';
import type {
  RestrictionDirection, RestrictionInputError, RestrictionKind, RestrictionList, RestrictionMode, RestrictionRule,
} from '../../lib/symbol/restrictions';
import { multisigRestrictionAggregateSize } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { CostBox } from '../multisig/parts';
import { showTxNotice } from '../../store/txNoticeStore';

// The "own account" choice of the account picker (the other choices are multisig account addresses).
const OWN_ACCOUNT = 'own';

type Step = 'form' | 'confirm';

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Multisig_Operation_Prohibited_By_Account') return { kind: 'prohibited', detail: code };
  if (code === 'lock_timeout') return { kind: 'lock_timeout', detail };
  if (code.startsWith('Failure_RestrictionAccount_')) {
    const sub = code.slice('Failure_RestrictionAccount_'.length);
    if (sub === 'Redundant_Modification') return { kind: 'redundant', detail };
    if (sub === 'Invalid_Modification_Address') return { kind: 'own_address', detail };
    if (sub === 'Values_Count_Exceeded' || sub === 'Modification_Count_Exceeded') return { kind: 'too_many', detail };
    // The wallet's own restrictions (or the multisig account's) refuse the aggregate / the change itself.
    if (sub === 'Operation_Type_Prohibited' || sub === 'Address_Interaction_Prohibited') return { kind: 'blocked_by_restriction', detail: code };
    if (sub === 'Invalid_Restriction_Flags' || sub === 'Invalid_Modification' || sub === 'Modification_Operation_Type_Incompatible') {
      return { kind: 'conflict', detail };
    }
  }
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

// 「アカウント制限」: who the account may send to / receive from (addresses), which mosaics it may receive and which
// transaction types it may send - each as an allow list (only these) or a block list (all but these).
//
// 「アカウント」画面の中から使う（embedded）：選んだアカウント（wallet）の制限を編集し、そのアカウントのパスワード・鍵で署名する。
// wallet を渡さなければ、いま使っているアカウントが対象。
interface RestrictionPageProps {
  embedded?: boolean;
  wallet?: Wallet;
  // 以前は完了画面の「閉じる」で呼んでいた。いまは完了画面が無いので使わない（呼び出し側との互換のために残す）。
  onClose?: () => void;
}

export default function RestrictionPage({ embedded = false, wallet: targetWallet }: RestrictionPageProps = {}) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);
  const activeWatchOnly = useNoKey();
  const watchOnly = targetWallet ? Boolean(targetWallet.watchOnly || targetWallet.ledger) : activeWatchOnly;
  const targetWalletId = targetWallet?.id ?? '';
  const { entries: contacts } = useAddressBook();

  const [step, setStep] = useState<Step>('form');

  // what is being edited
  const [kind, setKind] = useState<RestrictionKind>('address');
  const [direction, setDirection] = useState<RestrictionDirection>('incoming');
  const rule: RestrictionRule = useMemo(
    () => ({ kind, direction: kind === 'address' ? direction : RESTRICTION_DIRECTIONS[kind][0] }),
    [kind, direction],
  );

  // The wallet, and the account being edited: the wallet itself, or a multisig account it cosigns for.
  const [walletAddress, setWalletAddress] = useState('');
  const [walletKey, setWalletKey] = useState('');
  const [cosignAccounts, setCosignAccounts] = useState<string[]>([]);
  const [target, setTarget] = useState(''); // '' = the wallet's own account
  const [multiGraph, setMultiGraph] = useState<MultisigGraph | null>(null); // the cosigner tree of the target (マルチレベルマルチシグ)
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [multiCost, setMultiCost] = useState<MultisigCost | null>(null);
  const isMulti = target !== '';
  const address = isMulti ? target : walletAddress;
  const publicKey = isMulti ? (targetKey ?? '') : walletKey;
  const multiInfo = multiGraph?.get(target) ?? null;
  // Complete only when the wallet's signature alone approves the account; otherwise the others still have to sign
  // (a cosigner that is itself a multisig account is approved by its own cosigners).
  const plan = multiGraph && walletAddress ? planApproval(multiGraph, target, walletAddress) : null;
  const bonded = plan ? !plan.selfSufficient : true;
  const cosignatureCount = Math.max(plan?.others ?? 1, 1);

  // what the node says the account has set
  const [lists, setLists] = useState<RestrictionList[] | 'loading' | 'failed'>('loading');
  const [reloadTick, setReloadTick] = useState(0);
  const [held, setHeld] = useState<MosaicBalance[]>([]);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);
  const [mosaicNames, setMosaicNames] = useState<Record<string, string>>({});

  // the change being staged: values to put on the list and values to take off it
  const [chosenMode, setChosenMode] = useState<RestrictionMode>('block');
  const [additions, setAdditions] = useState<string[]>([]);
  const [deletions, setDeletions] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<RestrictionInputError | 'already_listed' | null>(null);
  const [resolving, setResolving] = useState(false);
  // The alias a staged address was typed as (the list itself always gets the real address).
  const [aliasLabels, setAliasLabels] = useState<Record<string, string>>({});

  // cost
  const [txFee, setTxFee] = useState<bigint | null>(null);

  // confirm / done
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The wallet: its address, its XYM (it pays every fee and the hash lock) and the multisig accounts it cosigns for.
  useEffect(() => {
    let cancelled = false;
    setXymBalance(null);
    setCosignAccounts([]);
    (async () => {
      try {
        const wallet = targetWallet ?? await WalletsHelper.getActive();
        if (cancelled) return;
        if (!wallet) {
          setLists([]);
          return;
        }
        setWalletAddress(wallet.address);
        setWalletKey(wallet.publicKey);
        const [balances, own] = await Promise.all([
          fetchBalances(wallet.address).catch(() => null),
          fetchCosignedAccounts(wallet.address).catch(() => null),
        ]);
        if (cancelled) return;
        const cosigned = (own ?? []).map((c) => c.info.address);
        setCosignAccounts(cosigned);
        setTarget((cur) => (cosigned.includes(cur) ? cur : ''));
        if (balances) setXymBalance(balances.find((b) => b.id === netCfg.currencyMosaicId)?.amount ?? 0n);
      } catch (e) {
        console.error('Failed to load the account', e);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 対象はアカウントの id で見分ける（オブジェクトは再描画のたびに変わりうる）
  }, [network, netCfg.currencyMosaicId, targetWalletId]);

  // The mosaics the edited account holds (the choices when adding a mosaic).
  useEffect(() => {
    setHeld([]);
    if (address === '') return undefined;
    let cancelled = false;
    fetchBalances(address)
      .then((b) => { if (!cancelled) setHeld(b); })
      .catch(() => { /* the mosaic id can still be typed */ });
    return () => { cancelled = true; };
  }, [address, network]);

  // A multisig account: its thresholds (they decide complete vs bonded) and its public key (the aggregate is signed in its name).
  useEffect(() => {
    setMultiGraph(null);
    setTargetKey(null);
    if (!isMulti) return undefined;
    let cancelled = false;
    Promise.all([fetchCosignerGraph(target), fetchAccountPublicKey(target)])
      .then(([graph, key]) => {
        if (cancelled) return;
        setMultiGraph(graph);
        setTargetKey(key);
      })
      .catch((e) => console.error('Failed to load the multisig account', e));
    return () => { cancelled = true; };
  }, [isMulti, target, network]);

  // The restrictions the account has now.
  useEffect(() => {
    if (address === '') return undefined;
    let cancelled = false;
    setLists('loading');
    fetchAccountRestrictions(address)
      .then((l) => { if (!cancelled) setLists(l); })
      .catch(() => { if (!cancelled) setLists('failed'); });
    return () => { cancelled = true; };
  }, [address, network, reloadTick]);

  // Names for the mosaic ids shown (held mosaics are known already; the rest are asked from the node).
  useEffect(() => {
    const ids = new Set<string>(held.map((h) => h.id));
    if (typeof lists !== 'string') {
      for (const l of lists) if (l.rule.kind === 'mosaic') l.values.forEach((v) => ids.add(v));
    }
    additions.forEach((v) => { if (kind === 'mosaic') ids.add(v); });
    if (ids.size === 0) return undefined;
    let cancelled = false;
    getMosaicInfos([...ids])
      .then((infos) => {
        if (cancelled) return;
        setMosaicNames(Object.fromEntries(Object.entries(infos).map(([id, info]) => [id.toUpperCase(), info.symbol])));
      })
      .catch(() => { /* the ids are shown instead */ });
    return () => { cancelled = true; };
  }, [held, lists, additions, kind]);

  // Switching to another list (or account) drops what was staged for the previous one.
  useEffect(() => {
    setAdditions([]);
    setDeletions([]);
    setInput('');
    setInputError(null);
    setAliasLabels({});
  }, [kind, direction, network, target]);

  // Which list / account is being edited right now; an alias lookup that finishes after a switch is dropped.
  const editing = `${kind}|${direction}|${address}|${network}`;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const current = typeof lists === 'string' ? undefined : findList(lists, rule);
  const currentValues = useMemo(() => current?.values ?? [], [current]);
  // A list that already has values keeps its mode: the node refuses a block change on an allow list and vice versa.
  const mode: RestrictionMode = currentValues.length > 0 && current ? current.mode : chosenMode;
  const modeLocked = currentValues.length > 0;

  const contactName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) if (c.chain === 'symbol' && c.network === network) map.set(normalizeAddress(c.address), c.name);
    return map;
  }, [contacts, network]);
  const networkContacts = useMemo(
    () => contacts.filter((c) => c.chain === 'symbol' && c.network === network),
    [contacts, network],
  );

  // --- display helpers ---------------------------------------------------------------------
  const valueTitle = (k: RestrictionKind, value: string): string => {
    if (k === 'address') return prettyAddress(value);
    if (k === 'mosaic') return mosaicNames[value] && mosaicNames[value] !== value ? mosaicNames[value] : value;
    const key = operationKey(value);
    return key ? t(`restriction.ops.${key}`) : value;
  };
  const valueSub = (k: RestrictionKind, value: string): string => {
    if (k === 'address') {
      return [aliasLabels[value] ? `@${aliasLabels[value]}` : '', contactName.get(normalizeAddress(value)) ?? ''].filter(Boolean).join(' / ');
    }
    if (k === 'mosaic') return mosaicNames[value] && mosaicNames[value] !== value ? value : '';
    return operationKey(value) ? value : '';
  };
  const ruleLabel = (r: RestrictionRule, m: RestrictionMode): string => {
    const base = r.kind === 'address' ? `${t('restriction.kind_address')} (${t(`restriction.dir_${r.direction}`)})` : t(`restriction.kind_${r.kind}`);
    return `${base} - ${t(`restriction.mode_${m}`)}`;
  };

  // --- validation --------------------------------------------------------------------------
  const problem = validateChangeSet(rule, mode, currentValues, additions, deletions);
  const hasChanges = additions.length > 0 || deletions.length > 0;
  const canContinue = !watchOnly && problem === null && publicKey !== '' && !resolving && (!isMulti || multiInfo !== null);
  const resulting = resultingValues(currentValues, additions, deletions);
  const multiKeyMissing = isMulti && multiInfo !== null && targetKey === null;

  // Cost of the staged change.
  useEffect(() => {
    setTxFee(null);
    if (isMulti || (additions.length === 0 && deletions.length === 0)) return undefined;
    let cancelled = false;
    quoteAccountRestrictionFee(rule, additions.length, deletions.length)
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [isMulti, rule, additions.length, deletions.length, network]);

  // A multisig account: an aggregate with room for the cosignatures, plus the hash lock when others still have to sign.
  useEffect(() => {
    setMultiCost(null);
    if (!isMulti || multiInfo === null || (additions.length === 0 && deletions.length === 0)) return undefined;
    let cancelled = false;
    quoteMultisigCost(multisigRestrictionAggregateSize(rule.kind, additions.length, deletions.length), cosignatureCount, bonded)
      .then((c) => { if (!cancelled) setMultiCost(c); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [isMulti, multiInfo, rule.kind, additions.length, deletions.length, cosignatureCount, bonded, network]);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = txFee === null ? t('restriction.fee_unavailable') : xym(txFee);
  const balanceShort = isMulti
    ? multiCost !== null && xymBalance !== null && xymBalance < multiCost.totalNeeded
    : txFee !== null && xymBalance !== null && xymBalance < txFee;

  // --- staging -------------------------------------------------------------------------------
  const stage = async (raw: string) => {
    const startedFor = editingRef.current;
    let value: string;
    let alias: string | undefined;
    if (kind === 'address') {
      // A real address, or a namespace alias that is looked up now: the list gets the address the alias points to.
      setResolving(true);
      let parsed: RestrictionAddressResult;
      try {
        parsed = await parseRestrictionAddressInput(raw, { networkByte: netCfg.networkByte, ownAddress: address }, resolveRecipientInput);
      } finally {
        setResolving(false);
      }
      if (editingRef.current !== startedFor) return; // another list / account was opened meanwhile
      if (!parsed.ok) {
        setInputError(parsed.error);
        return;
      }
      value = parsed.value;
      alias = parsed.alias;
    } else {
      const parsed = parseRestrictionInput(kind, raw, { networkByte: netCfg.networkByte, ownAddress: address, mode });
      if (!parsed.ok) {
        setInputError(parsed.error);
        return;
      }
      value = parsed.value;
    }
    const alreadyThere = (currentValues.includes(value) && !deletions.includes(value)) || additions.includes(value);
    if (alreadyThere) {
      setInputError('already_listed');
      return;
    }
    // Adding a value that was marked for removal just cancels the removal.
    if (deletions.includes(value)) setDeletions((cur) => cur.filter((v) => v !== value));
    else setAdditions((cur) => [...cur, value]);
    if (alias) setAliasLabels((cur) => ({ ...cur, [value]: alias }));
    setInput('');
    setInputError(null);
  };

  const toggleDeletion = (value: string) => setDeletions((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));

  const inputErrorText = inputError === null ? '' : t(`restriction.input_error_${inputError}`);

  // Operations that can still be added (not listed yet; "change operation restrictions" can never be blocked).
  const operationChoices = RESTRICTION_OPERATIONS.filter((o) => {
    const code = operationCode(o.code);
    if (resulting.includes(code)) return false;
    return !(mode === 'block' && o.code === OPERATION_RESTRICTION_TYPE);
  });

  // --- sending ---------------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    setSending(true);
    try {
      const wallet = targetWallet ?? await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      if (isMulti) {
        // In the name of the multisig account: an aggregate this wallet signs (bonded when others still have to sign).
        if (targetKey === null || multiInfo === null) return;
        const sent = await submitMultisig({
          privateKey,
          publicKey: wallet.publicKey,
          inner: { kind: 'restriction', accountPublicKey: targetKey, rule, mode, additions, deletions },
          bonded,
          cosignatureCount,
        });
        notifyDone(sent.hash, true, sent.bonded);
        onAnother();
        return;
      }
      const sent = await setAccountRestriction({ privateKey, publicKey: wallet.publicKey, rule, mode, additions, deletions });
      notifyDone(sent.hash, false, false);
      onAnother();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  // 送信の結果は完了画面ではなくトーストで知らせ、入力は空に戻す（onAnother）。
  function notifyDone(hash: string, multi: boolean, bondedResult: boolean) {
    showTxNotice({
      lines: t(multi ? `restriction.done_multisig_${bondedResult ? 'bonded' : 'complete'}` : 'restriction.done_message', { returnObjects: true }) as string[],
      explorerUrl: explorerTxUrl(hash),
      explorerLabel: t('restriction.view_explorer'),
    });
  }

  const onAnother = () => {
    setAdditions([]);
    setDeletions([]);
    setInput('');
    setInputError(null);
    setAliasLabels({});
    setReloadTick((n) => n + 1);
    setStep('form');
  };

  const errorTitle = sendError ? t(`restriction.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`restriction.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // ============================ confirm ============================
  if (step === 'confirm') {
    const lines = (kindOfList: RestrictionKind, values: string[]) => values
      .map((v) => {
        const sub = valueSub(kindOfList, v);
        return sub ? `${valueTitle(kindOfList, v)}\n${sub}` : valueTitle(kindOfList, v);
      })
      .join('\n\n');
    const multiFeeRows: { label: string; value: string }[] = multiCost === null
      ? [{ label: t('restriction.tx_fee'), value: t('restriction.fee_unavailable') }]
      : [
        { label: t('restriction.tx_fee'), value: xym(multiCost.aggregateFee.fee) },
        ...(multiCost.bonded ? [
          { label: t('multisig.lock_fee'), value: xym(multiCost.lockFee) },
          { label: t('multisig.lock_amount'), value: xym(multiCost.lockAmount) },
        ] : []),
      ];
    const rows: { label: string; value: string; big?: boolean }[] = [
      ...(isMulti ? [{ label: t('restriction.confirm_account'), value: address, big: true }] : []),
      { label: t('restriction.confirm_rule'), value: ruleLabel(rule, mode), big: true },
      { label: t('send.network'), value: `${netCfg.key === 'mijin' ? '' : 'Symbol '}${netCfg.label}` },
      ...(additions.length > 0 ? [{ label: t('restriction.confirm_additions', { count: additions.length }), value: lines(kind, additions) }] : []),
      ...(deletions.length > 0 ? [{ label: t('restriction.confirm_deletions', { count: deletions.length }), value: lines(kind, deletions) }] : []),
      ...(isMulti ? [
        { label: t('restriction.confirm_signer'), value: walletAddress },
        { label: t('multisig.approval_row'), value: `${multiInfo?.minApproval ?? ''} / ${multiInfo?.cosignatories.length ?? ''}` },
        ...multiFeeRows,
      ] : [{ label: t('restriction.tx_fee'), value: feeText }]),
    ];
    return (
      <Box sx={{ minHeight: embedded ? undefined : '100vh', display: 'flex', flexDirection: 'column' }}>
        {embedded
          ? <Box sx={{ px: { xs: 2, md: 4 }, pt: 1 }}><Button color="inherit" startIcon={<ArrowBackIcon />} onClick={() => setStep('form')}>{t('common.back')}</Button></Box>
          : <BackButton onBack={() => setStep('form')} back="/account" />}
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
          title={t('restriction.confirm_title')}
          texts={t(isMulti ? `restriction.confirm_dialog_message_multisig_${bonded ? 'bonded' : 'complete'}` : 'restriction.confirm_dialog_message', { returnObjects: true, amount: multiCost ? xym(multiCost.lockAmount) : '' }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('restriction.sending') : t('restriction.confirm_ready')}</Typography>
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
              {t('restriction.confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPasswordDialog} mode="check" popup={embedded} profileKey={targetWallet?.profileKey} onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  const valueRow = (value: string, removable: boolean) => {
    const marked = deletions.includes(value);
    const sub = valueSub(kind, value);
    return (
      <Box key={value} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, opacity: marked ? 0.55 : 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ wordBreak: 'break-all', fontFamily: kind === 'operation' ? undefined : 'monospace', fontSize: '0.95rem', textDecoration: marked ? 'line-through' : 'none' }}>
            {valueTitle(kind, value)}
          </Typography>
          {sub !== '' && (
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', wordBreak: 'break-all' }}>{sub}</Typography>
          )}
        </Box>
        {marked && <Chip size="small" color="warning" variant="outlined" label={t('restriction.marked_remove')} />}
        {removable && (
          <Tooltip title={marked ? t('restriction.undo_remove') : t('restriction.remove_value')}>
            <IconButton size="small" color={marked ? 'primary' : 'default'} aria-label={marked ? t('restriction.undo_remove') : t('restriction.remove_value')} onClick={() => toggleDeletion(value)}>
              {marked ? <UndoIcon fontSize="small" /> : <DeleteOutlineIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
      </Box>
    );
  };

  return (
    <Box sx={{ minHeight: embedded ? undefined : '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: 'x-large', fontWeight: 'bold', mb: 1 }}>{t('restriction.title')}</Typography>
        <Alert severity="info" sx={{ mb: 2 }}>{t('restriction.intro')}</Alert>
        {watchOnly && <Alert severity="info" sx={{ mb: 2 }}>{t('restriction.watch_only')}</Alert>}
        {cosignAccounts.length > 0 && (
          <TextField
            select
            fullWidth
            size="small"
            label={t('restriction.account_label')}
            value={isMulti ? target : OWN_ACCOUNT}
            onChange={(e) => setTarget(e.target.value === OWN_ACCOUNT ? '' : e.target.value)}
            sx={{ mb: 2 }}
          >
            <MenuItem value={OWN_ACCOUNT}>{t('restriction.account_own')}</MenuItem>
            {cosignAccounts.map((a) => (
              <MenuItem key={a} value={a} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>
                {t('restriction.account_multisig', { address: a })}
              </MenuItem>
            ))}
          </TextField>
        )}
        {isMulti && !watchOnly && <Alert severity="info" sx={{ mb: 2 }}>{t('restriction.multisig_note')}</Alert>}
        {isMulti && multiKeyMissing && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.err_no_public_key')}</Alert>}
        {address !== '' && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>{address}</Typography>
        )}

        <Tabs
          value={kind}
          onChange={(_, v: RestrictionKind) => setKind(v)}
          variant="fullWidth"
          sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
        >
          {RESTRICTION_KINDS.map((k) => <Tab key={k} value={k} label={t(`restriction.kind_${k}`)} />)}
        </Tabs>

        {kind === 'address' && (
          <>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('restriction.direction_label')}</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              color="primary"
              value={direction}
              onChange={(_, v: RestrictionDirection | null) => { if (v) setDirection(v); }}
              sx={{ mb: 2 }}
            >
              {RESTRICTION_DIRECTIONS.address.map((d) => <ToggleButton key={d} value={d}>{t(`restriction.dir_${d}`)}</ToggleButton>)}
            </ToggleButtonGroup>
          </>
        )}

        {/* ---- what is set now ---- */}
        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('restriction.current_title')}</Typography>
        <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
          {lists === 'loading' ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}><CircularProgress size={22} /></Box>
          ) : lists === 'failed' ? (
            <>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('restriction.load_failed')}</Typography>
              <Button size="small" onClick={() => setReloadTick((n) => n + 1)}>{t('restriction.reload')}</Button>
            </>
          ) : current === undefined || currentValues.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('restriction.not_set')}</Typography>
          ) : (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Chip size="small" color={current.mode === 'allow' ? 'success' : 'error'} label={t(`restriction.mode_${current.mode}`)} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('restriction.value_count', { count: currentValues.length, max: MAX_RESTRICTION_VALUES })}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 0.5 }}>
                {t(`restriction.explain_${rule.kind}_${rule.direction}_${current.mode}`)}
              </Typography>
              <Divider />
              {currentValues.map((v, i) => (
                <Box key={v}>
                  {i > 0 && <Divider />}
                  {valueRow(v, !watchOnly)}
                </Box>
              ))}
            </>
          )}
        </Box>

        {/* ---- change it ---- */}
        {!watchOnly && lists !== 'loading' && lists !== 'failed' && (
          <>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('restriction.mode_label')}</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              color="primary"
              value={mode}
              disabled={modeLocked}
              onChange={(_, v: RestrictionMode | null) => { if (v) setChosenMode(v); }}
              sx={{ mb: 1 }}
            >
              <ToggleButton value="allow">{t('restriction.mode_allow')}</ToggleButton>
              <ToggleButton value="block">{t('restriction.mode_block')}</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              {modeLocked ? t('restriction.mode_locked_hint') : t(`restriction.explain_${rule.kind}_${rule.direction}_${mode}`)}
            </Typography>

            <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t(`restriction.add_title_${kind}`)}</Typography>

            {kind === 'operation' ? (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1 }}>
                <TextField
                  select
                  fullWidth
                  label={t('restriction.operation_label')}
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setInputError(null); }}
                >
                  {operationChoices.map((o) => (
                    <MenuItem key={o.code} value={operationCode(o.code)}>{t(`restriction.ops.${o.key}`)} ({operationCode(o.code)})</MenuItem>
                  ))}
                </TextField>
                <Button variant="contained" startIcon={<AddIcon />} disabled={input === ''} onClick={() => { void stage(input); }} sx={{ py: 1.8, flexShrink: 0 }}>
                  {t('restriction.add_button')}
                </Button>
              </Box>
            ) : (
              <>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1 }}>
                  <TextField
                    fullWidth
                    label={kind === 'address' ? t('restriction.address_label') : t('restriction.mosaic_label')}
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setInputError(null); }}
                    error={inputError !== null}
                    helperText={resolving ? t('restriction.alias_resolving') : inputErrorText || (kind === 'address' ? t('restriction.address_hint') : t('restriction.mosaic_hint'))}
                    slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
                  />
                  <Button variant="contained" startIcon={<AddIcon />} disabled={input.trim() === '' || resolving} onClick={() => { void stage(input); }} sx={{ py: 1.8, flexShrink: 0 }}>
                    {t('restriction.add_button')}
                  </Button>
                </Box>
                {kind === 'address' && networkContacts.length > 0 && (
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label={t('restriction.pick_contact')}
                    value=""
                    onChange={(e) => { setInput(e.target.value); setInputError(null); }}
                    sx={{ mb: 1 }}
                  >
                    {networkContacts.map((c) => <MenuItem key={c.id} value={c.address}>{c.name} ({prettyAddress(c.address).slice(0, 13)}...)</MenuItem>)}
                  </TextField>
                )}
                {kind === 'mosaic' && held.length > 0 && (
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label={t('restriction.pick_held_mosaic')}
                    value=""
                    onChange={(e) => { setInput(e.target.value); setInputError(null); }}
                    sx={{ mb: 1 }}
                  >
                    {held.map((h) => <MenuItem key={h.id} value={h.id}>{h.symbol === h.id ? h.id : `${h.symbol} (${h.id})`}</MenuItem>)}
                  </TextField>
                )}
              </>
            )}
            {kind === 'operation' && inputError !== null && (
              <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mb: 1 }}>{inputErrorText}</Typography>
            )}

            {additions.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('restriction.staged_additions', { count: additions.length })}</Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {additions.map((v) => (
                    <Chip
                      key={v}
                      color="primary"
                      variant="outlined"
                      label={valueTitle(kind, v).length > 28 ? `${valueTitle(kind, v).slice(0, 26)}...` : valueTitle(kind, v)}
                      onDelete={() => setAdditions((cur) => cur.filter((x) => x !== v))}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {problem !== null && problem !== 'no_changes' && (
              <Alert severity={problem === 'operation_lockout' ? 'error' : 'warning'} sx={{ mb: 2 }}>{t(`restriction.problem_${problem}`)}</Alert>
            )}
            {mode === 'allow' && currentValues.length === 0 && additions.length > 0 && problem === null && (
              <Alert severity="warning" sx={{ mb: 2 }}>{t(`restriction.caution_allow_${rule.kind}`)}</Alert>
            )}
            {isMulti && problem === null && lacksMultisigModification(rule, mode, resulting) && (
              <Alert severity="warning" sx={{ mb: 2 }}>{t('restriction.caution_multisig_modification')}</Alert>
            )}

            {isMulti ? (
              hasChanges && multiInfo !== null && <CostBox cost={multiCost} hasBalanceShort={balanceShort} />
            ) : (
              <Box sx={{ mt: 1, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>
                  {t('restriction.tx_fee')}: {hasChanges ? feeText : '-'}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('restriction.fee_hint')}</Typography>
                {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('restriction.xym_short_warning')}</Alert>}
              </Box>
            )}
          </>
        )}
      </Box>

      {!watchOnly && (
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
            {t('restriction.go_confirm')}
          </Button>
        </Box>
      )}
    </Box>
  );
}
