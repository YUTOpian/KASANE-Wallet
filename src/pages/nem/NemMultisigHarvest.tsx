import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, FormControlLabel, IconButton, MenuItem, Switch, Tab, Tabs, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { SymbolSendError } from '../../lib/symbol/api';
import { fetchNemXemBalance, isHttpsUrl, nemExplorerAccountUrl } from '../../lib/nem/api';
import { NEM_CURRENCY_DIVISIBILITY, NEM_MIN_HARVEST_VESTED } from '../../lib/nem/constants';
import { nemAddressFromPublicKey, normalizeNemAddress } from '../../lib/nem/crypto';
import {
  cleanNemNodeUrl, fetchNemHarvestState, fetchNemNodeSlots, fetchNemRemoteHarvestStatus, loadNemHarvestNode, nemHarvestNodeCandidates,
  saveNemHarvestNode, startNemHarvesting, stopNemHarvesting,
} from '../../lib/nem/harvest';
import type { NemHarvestState, NemNodeSlots, NemRemoteHarvestStatus } from '../../lib/nem/harvest';
import { fetchNemMultisigInfo, sendNemMultisigWrapped } from '../../lib/nem/multisigApi';
import type { NemMultisigInfo } from '../../lib/nem/multisigApi';
import {
  checkNemCustomRemoteKey, deriveNemMultisigRemoteAccount, fetchNemIsActivator, loadNemMultisigRemote, planNemCustomRemote, planNemMultisigHarvest,
  saveNemMultisigRemote,
} from '../../lib/nem/multisigHarvest';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { NEM_IMPORTANCE_TRANSFER_FEE, NEM_MULTISIG_WRAPPER_FEE } from '../../lib/nem/tx';
import { formatAtomic } from '../../lib/symbol/amount';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import { classifyNemMultisigError } from './multisigParts';
import { nemXem } from './parts';
import NemHarvestBlocksPanel from './NemHarvestBlocksPanel';

type Action = 'activate' | 'deactivate' | 'start' | 'stop' | 'check' | 'reveal';
type NodeMode = 'list' | 'manual';
type MainTab = 'remote' | 'node' | 'status' | 'keys' | 'stats';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;
const REVEAL_MS = 60_000; // how long the remote private key stays on screen

// NEM 「マルチシグの委任ハーベスト」: the delegated harvesting of a multisig account this wallet cosigns for - the
// official NEM Nano Wallet's "Manage delegated account of multisignature accounts" screen.
//  1. 有効化: an importance transfer in the name of the multisig account (this wallet signs the wrapper; the
//     other cosigners sign it on the マルチシグ screen when more than one signature is needed).
//  2. ハーベスト開始: the remote account's private key goes to the chosen node.
export default function NemMultisigHarvest() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [walletId, setWalletId] = useState('');
  const [ownBalance, setOwnBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0); // bump to reload everything
  const [accounts, setAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState(normalizeNemAddress(params.get('account') ?? ''));
  const [info, setInfo] = useState<NemMultisigInfo | null>(null);
  const [state, setState] = useState<NemHarvestState | null>(null);

  // The remote account's public key: derived after the password, then remembered (it is not secret).
  const [remotePublicKey, setRemotePublicKey] = useState('');
  const [isActivator, setIsActivator] = useState<boolean | null>(null);

  const candidates = useMemo(() => nemHarvestNodeCandidates(), [network]);
  const [nodeMode, setNodeMode] = useState<NodeMode>('list');
  const [nodeSelect, setNodeSelect] = useState('');
  const [nodeManual, setNodeManual] = useState('');
  const [slots, setSlots] = useState<NemNodeSlots | null>(null);
  const [nodeStatus, setNodeStatus] = useState<NemRemoteHarvestStatus>('UNKNOWN');

  const [tab, setTab] = useState<MainTab>('remote');
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ ns: string; kind: string; detail: string } | null>(null);
  const [done, setDone] = useState<{ action: Action; waiting: boolean } | null>(null);
  // The remote account's private key, shown only on the 「委任鍵」 tab after the password. Kept in this state alone (never stored).
  const [revealed, setRevealed] = useState<{ account: string; privateKey: string } | null>(null);
  // A remote account named by its public key (the official wallet's 「カスタムされた公開鍵を使用」).
  const [customOn, setCustomOn] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [customIsActive, setCustomIsActive] = useState<boolean | null>(null); // NIS: is it the active remote account of this multisig account?

  const remoteAddress = remotePublicKey ? nemAddressFromPublicKey(remotePublicKey, netCfg.networkByte) : '';
  const node = nodeMode === 'manual' ? cleanNemNodeUrl(nodeManual) : nodeSelect;
  const nodeValid = isHttpsUrl(node);
  const nodeKeyId = `${walletId}.${account}`; // the node is remembered per wallet and multisig account
  const required = info ? (info.minCosignatories === 0 ? info.cosignatories.length : info.minCosignatories) : 0;

  const custom = useMemo(() => checkNemCustomRemoteKey(customInput, info?.publicKey ?? null), [customInput, info?.publicKey]);
  const customAddress = custom.valid ? nemAddressFromPublicKey(custom.key, netCfg.networkByte) : '';

  // The named remote account goes away with the account; and while deactivating, NIS is asked whether it is the active one.
  useEffect(() => { setCustomOn(false); setCustomInput(''); }, [walletId, account, network]);
  useEffect(() => {
    setCustomIsActive(null);
    if (!customOn || !customAddress || !account || state?.remoteStatus !== 'ACTIVE') return undefined;
    let cancelled = false;
    fetchNemIsActivator(customAddress, account).then((v) => { if (!cancelled) setCustomIsActive(v); });
    return () => { cancelled = true; };
  }, [customOn, customAddress, account, state?.remoteStatus, tick]);

  // This wallet and the multisig accounts it cosigns for.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const own = await fetchNemMultisigInfo(wallet.address);
        const balance = await fetchNemXemBalance(wallet.address).catch(() => null);
        if (cancelled) return;
        const list = own.multisigOf.map((a) => a.address);
        setWalletId(wallet.id);
        setOwnBalance(balance);
        setAccounts(list);
        setAccount((cur) => (list.includes(cur) ? cur : (list[0] ?? '')));
      } catch (e) {
        console.error('Failed to load the multisig accounts', e);
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network, tick]);

  // The chosen multisig account: its cosigners, balances and delegation state.
  useEffect(() => {
    if (!account) { setInfo(null); setState(null); return undefined; }
    let cancelled = false;
    Promise.all([fetchNemMultisigInfo(account), fetchNemHarvestState(account)])
      .then(([i, s]) => { if (!cancelled) { setInfo(i); setState(s); } })
      .catch((e) => { console.error('Failed to load the multisig account', e); if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [account, network, tick]);

  // The remote account remembered for this wallet and account (the derivation itself needs the password).
  useEffect(() => {
    setRemotePublicKey(walletId && account ? loadNemMultisigRemote(walletId, account) : '');
    setIsActivator(null);
  }, [walletId, account, network]);

  // The private key goes away with the account, the tab, the app going to the background, or after a minute.
  useEffect(() => { setRevealed(null); }, [walletId, account, network]);
  useEffect(() => { if (tab !== 'keys') setRevealed(null); }, [tab]);
  useEffect(() => {
    if (!revealed) return undefined;
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS);
    const onHidden = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener('visibilitychange', onHidden);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onHidden); };
  }, [revealed]);

  // Whether that remote account is the one that is active for the multisig account.
  useEffect(() => {
    if (!remoteAddress || !account) { setIsActivator(null); return undefined; }
    let cancelled = false;
    fetchNemIsActivator(remoteAddress, account).then((v) => { if (!cancelled) setIsActivator(v); });
    return () => { cancelled = true; };
  }, [remoteAddress, account, state?.remoteStatus, tick]);

  // The node chosen last time for this account (or the first candidate).
  useEffect(() => {
    if (!walletId || !account) return;
    const saved = loadNemHarvestNode(nodeKeyId);
    if (saved && !candidates.includes(saved)) {
      setNodeMode('manual');
      setNodeManual(saved);
    } else {
      setNodeMode('list');
      setNodeSelect(saved || candidates[0] || '');
    }
  }, [walletId, account, nodeKeyId, candidates]);

  // Slots, and the remote account's harvesting state, on the chosen node.
  const loadNode = useCallback(async () => {
    setSlots(null);
    setNodeStatus('UNKNOWN');
    if (!nodeValid) return;
    const [s, st] = await Promise.all([
      fetchNemNodeSlots(node),
      remoteAddress ? fetchNemRemoteHarvestStatus(node, remoteAddress) : Promise.resolve('UNKNOWN' as NemRemoteHarvestStatus),
    ]);
    setSlots(s);
    setNodeStatus(st);
  }, [node, nodeValid, remoteAddress]);

  useEffect(() => {
    const timer = setTimeout(() => { void loadNode(); }, 400);
    return () => clearTimeout(timer);
  }, [loadNode]);

  const remoteStatus = state?.remoteStatus ?? 'UNKNOWN';
  const slotsFull = slots !== null && slots.used >= slots.max && nodeStatus !== 'UNLOCKED';
  // The named remote account can be used while the account has none (to link one) or has one (to unlink it).
  const customEligible = !!info?.publicKey && (remoteStatus === 'INACTIVE' || remoteStatus === 'ACTIVE');
  const useCustom = customOn && customEligible;
  const customPlan = planNemCustomRemote({
    remoteStatus, vestedBalance: state?.vestedBalance ?? null, hasPublicKey: !!info?.publicKey, keyValid: custom.valid, isActiveRemote: customIsActive,
  });
  const plan = planNemMultisigHarvest({
    remoteStatus,
    vestedBalance: state?.vestedBalance ?? null,
    hasPublicKey: !!info?.publicKey,
    isActivator,
    nodeStatus,
    nodeValid,
    slotsFull,
    ownBalance,
    multisigBalance: state?.balance ?? null,
  });

  const ask = (action: Action) => {
    // Checking the remote account and showing its keys only need the password; the others are confirmed first.
    setConfirmed(action === 'check' || action === 'reveal');
    setPending(action);
  };

  const onPassed = async (password: string) => {
    const action = pending;
    setConfirmed(false);
    if (!action) return;
    setBusy(true);
    try {
      const w = await WalletsHelper.getActive();
      if (!w) return;
      const privateKey = await WalletsHelper.decryptKey(w.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const remote = deriveNemMultisigRemoteAccount(privateKey, account, netCfg.networkByte);
      saveNemMultisigRemote(w.id, account, remote.publicKey);
      setRemotePublicKey(remote.publicKey);
      if (action === 'check') {
        setTab('status');
        return;
      }
      if (action === 'reveal') {
        setRevealed({ account, privateKey: remote.privateKey });
        return;
      }
      let waiting = false;
      if (action === 'activate' || action === 'deactivate') {
        if (!info?.publicKey) throw new Error('no_public_key');
        let remoteToSend = remote.publicKey;
        if (useCustom) {
          if (!custom.valid) return;
          // Deactivating names the remote account in the transaction: NIS must say right now that this one is the active one.
          if (action === 'deactivate' && (await fetchNemIsActivator(customAddress, account)) !== true) throw new CheckError('custom_not_remote');
          remoteToSend = custom.key;
        } else if (action === 'deactivate' && (await fetchNemIsActivator(remote.address, account)) === false) {
          // Same for the one derived for this wallet.
          throw new CheckError('not_activator');
        }
        await sendNemMultisigWrapped(privateKey, w.publicKey, info.publicKey, { kind: 'importance', remotePublicKey: remoteToSend, activate: action === 'activate' });
        setCustomOn(false);
        setCustomInput('');
        waiting = required > 1;
      } else if (action === 'start') {
        await startNemHarvesting(node, remote.privateKey);
        saveNemHarvestNode(`${w.id}.${account}`, node);
      } else {
        await stopNemHarvesting(node, remote.privateKey);
      }
      setDone({ action, waiting });
      setTick((n) => n + 1);
      await loadNode();
    } catch (error) {
      setSendError(classify(error));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const passwordOnly = pending === 'check' || pending === 'reveal';
  const confirmTexts = pending && !passwordOnly
    ? (t(pending === 'activate' || pending === 'deactivate' ? `nemmsharvest.confirm_${pending}${useCustom ? '_custom' : ''}_message` : `nemharvest.confirm_${pending}_message`, {
      returnObjects: true, account, remote: customAddress,
    }) as string[])
    : [];
  const confirmTitle = pending && !passwordOnly ? t(`nemharvest.confirm_${pending}_title`) : '';
  const errorTitle = sendError ? t(`${sendError.ns}.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`${sendError.ns}.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  const running = nodeStatus === 'UNLOCKED';
  const stateColor = running || remoteStatus === 'ACTIVE' ? 'success.main'
    : remoteStatus === 'ACTIVATING' || remoteStatus === 'DEACTIVATING' ? 'warning.main'
      : remoteStatus === 'INACTIVE' ? 'error.main' : 'text.disabled';
  const remoteLabel: Record<string, string> = {
    INACTIVE: t('nemharvest.remote_inactive'),
    ACTIVATING: t('nemharvest.remote_activating'),
    ACTIVE: t('nemharvest.remote_active'),
    DEACTIVATING: t('nemharvest.remote_deactivating'),
    REMOTE: t('nemharvest.remote_remote'),
    UNKNOWN: t('nemharvest.unknown'),
  };
  const stateText = running ? t('nemharvest.node_running') : (remoteLabel[remoteStatus] ?? remoteLabel.UNKNOWN);
  const activatorText = isActivator === true ? t('nemmsharvest.activator_yes') : isActivator === false ? t('nemmsharvest.activator_no') : t('nemmsharvest.activator_unknown');

  const stat = (title: string, content: ReactNode) => (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{title}</Typography>
      <Box sx={{ minHeight: 48, display: 'flex', alignItems: 'center' }}>{content}</Box>
    </Box>
  );
  const bigNumber = (text: string) => (
    <Typography sx={{ fontSize: { xs: '1.6rem', md: '2.2rem' }, lineHeight: 1.1, color: 'primary.main', wordBreak: 'break-all' }}>{text}</Typography>
  );

  // The remote account has to be derived (password) before the screen can say anything about it.
  const checkButton = (
    <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
      <Button variant="outlined" color="primary" size="large" fullWidth disabled={busy || !account} onClick={() => ask('check')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
        {t('nemmsharvest.check_button')}
      </Button>
    </Box>
  );

  if (loading && !walletId) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress color="primary" /></Box>;
  }

  const startButtonRow = (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
      <Button variant="outlined" color="primary" size="large" disabled={!plan.canStop || busy} onClick={() => ask('stop')} sx={{ py: 1.25, px: { md: 4 } }}>{t('nemharvest.stop_button')}</Button>
      <Button variant="contained" color="primary" size="large" disabled={!plan.canStart || busy} onClick={() => ask('start')} sx={{ py: 1.25, px: { md: 4 } }}>{t('nemharvest.start_button')}</Button>
    </Box>
  );

  const remoteAddressRow = (
    <FormRow label={t('nemharvest.remote_address')}>
      <ValueBox>{remoteAddress || t('nemmsharvest.remote_unknown')}</ValueBox>
    </FormRow>
  );

  // Name the remote account by its public key (instead of the one derived for this wallet).
  const customIssueText = custom.issue === 'format' ? t('nemmsharvest.custom_format_error') : custom.issue === 'multisig_itself' ? t('nemmsharvest.custom_self_error') : '';
  const customBlock = customEligible ? (
    <Box sx={{ mt: 1.5 }}>
      <FormControlLabel control={<Switch checked={customOn} onChange={(e) => setCustomOn(e.target.checked)} disabled={busy} />} label={t('nemmsharvest.custom_switch')} />
      {customOn && (
        <>
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 1 }}>{t('nemmsharvest.custom_about')}</Typography>
          {remoteStatus === 'ACTIVE' && isActivator !== true && <Alert severity="info" sx={{ mb: 1 }}>{t('nemmsharvest.custom_takeover_hint')}</Alert>}
          <FormRow label={t('nemmsharvest.custom_public_label')} top>
            <Field
              ariaLabel={t('nemmsharvest.custom_public_label')}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              error={custom.issue !== null}
              helperText={customIssueText || undefined}
              htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
            />
          </FormRow>
          {customAddress && <FormRow label={t('nemharvest.remote_address')}><ValueBox>{customAddress}</ValueBox></FormRow>}
          {customAddress && remoteStatus === 'ACTIVE' && (
            <Typography variant="body2" sx={{ color: customIsActive === true ? 'success.main' : customIsActive === false ? 'error.main' : 'text.secondary', mt: 0.5 }}>
              {customIsActive === true ? t('nemmsharvest.custom_active_yes') : customIsActive === false ? t('nemmsharvest.custom_active_no') : t('nemmsharvest.custom_active_unknown')}
            </Typography>
          )}
        </>
      )}
    </Box>
  ) : null;

  // What the activate / deactivate area says: tied to the state of the multisig account's delegation.
  const remoteActions = (() => {
    if (!state || !info) return null;
    if (!info.publicKey) return <Alert severity="warning" sx={{ mt: 1 }}>{t('multisig.err_no_public_key')}</Alert>;
    if (remoteStatus === 'REMOTE') return <Alert severity="info" sx={{ mt: 1 }}>{t('nemmsharvest.is_remote_note')}</Alert>;
    if (remoteStatus === 'ACTIVATING' || remoteStatus === 'DEACTIVATING') return <Alert severity="info" sx={{ mt: 1 }}>{t('nemharvest.waiting_note')}</Alert>;
    if (remoteStatus === 'ACTIVE') {
      return (
        <>
          {isActivator === false && <Alert severity="info" sx={{ mt: 1 }}>{t('nemmsharvest.not_activator_note')}</Alert>}
          {isActivator === null && <Alert severity="info" sx={{ mt: 1 }}>{t('nemmsharvest.unknown_activator_note')}</Alert>}
          {running && <Alert severity="info" sx={{ mt: 1 }}>{t('nemharvest.deactivate_note')}</Alert>}
          {isActivator === null && !remoteAddress && checkButton}
          {customBlock}
          <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
            <Button variant="outlined" color="primary" size="large" fullWidth disabled={!(useCustom ? customPlan.canDeactivate : plan.canDeactivate) || busy} onClick={() => ask('deactivate')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
              {t('nemharvest.deactivate_button')}
            </Button>
          </Box>
        </>
      );
    }
    return (
      <>
        {customBlock}
        <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!(useCustom ? customPlan.canActivate : plan.canActivate) || busy} onClick={() => ask('activate')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
            {t('nemharvest.activate_button')}
          </Button>
        </Box>
      </>
    );
  })();

  const mainCard = (
    <SectionCard sx={{ px: { xs: 2, md: 3 }, pt: 0 }}>
      <Tabs value={tab} onChange={(_, v: MainTab) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tab value="remote" label={t('nemharvest.step1_title')} />
        <Tab value="node" label={t('nemharvest.step2_title')} />
        <Tab value="status" label={t('nemharvest.status_title')} />
        <Tab value="keys" label={t('nemmsharvest.tab_keys')} />
        <Tab value="stats" label={t('nemharvest.tab_stats')} />
      </Tabs>

      {tab === 'stats' ? (
        <NemHarvestBlocksPanel address={account} harvestedBlocks={state?.harvestedBlocks ?? null} />
      ) : tab === 'keys' ? (
        <>
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('nemmsharvest.keys_about')}</Typography>
          <Alert severity="warning" sx={{ mb: 2 }}>{t('nemmsharvest.keys_caution')}</Alert>
          <FormRow label={t('nemmsharvest.account_label')}><ValueBox>{account}</ValueBox></FormRow>
          {remoteAddressRow}
          <FormRow label={t('nemmsharvest.key_public')}>
            <ValueBox>{remotePublicKey || t('nemmsharvest.remote_unknown')}</ValueBox>
          </FormRow>
          <FormRow label={t('nemmsharvest.key_private')}>
            <ValueBox>
              <Box component="span" sx={{ ...mono, userSelect: 'text', color: revealed ? 'error.main' : 'text.secondary' }}>
                {revealed && revealed.account === account ? revealed.privateKey : t('nemmsharvest.key_hidden')}
              </Box>
            </ValueBox>
          </FormRow>
          {revealed && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('nemmsharvest.reveal_auto_hide')}</Typography>}
          <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
            {revealed ? (
              <Button variant="outlined" color="primary" size="large" fullWidth onClick={() => setRevealed(null)} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
                {t('nemmsharvest.hide_button')}
              </Button>
            ) : (
              <Button variant="contained" color="primary" size="large" fullWidth disabled={busy || !account} onClick={() => ask('reveal')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
                {t('nemmsharvest.reveal_button')}
              </Button>
            )}
          </Box>
        </>
      ) : tab === 'status' ? (
        <>
          <FormRow label={t('nemmsharvest.account_label')}><ValueBox>{account}</ValueBox></FormRow>
          {state && (
            <>
              <FormRow label={t('nemharvest.balance')}><ValueBox>{nemXem(state.balance)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.vested')}><ValueBox>{nemXem(state.vestedBalance)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.min_vested')}><ValueBox>{nemXem(NEM_MIN_HARVEST_VESTED)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.harvested_blocks')}><ValueBox>{state.harvestedBlocks}</ValueBox></FormRow>
            </>
          )}
          <FormRow label={t('nemharvest.remote_status')}><ValueBox>{remoteLabel[remoteStatus] ?? remoteLabel.UNKNOWN}</ValueBox></FormRow>
          {remoteAddressRow}
          <FormRow label={t('nemmsharvest.activator_label')}><ValueBox>{activatorText}</ValueBox></FormRow>
          <FormRow label={t('nemharvest.node_status')}>
            <ValueBox>{running ? t('nemharvest.node_running') : nodeStatus === 'LOCKED' ? t('nemharvest.node_stopped') : t('nemharvest.unknown')}</ValueBox>
          </FormRow>
          {!remoteAddress && <Alert severity="info" sx={{ mt: 1 }}>{t('nemmsharvest.check_hint')}</Alert>}
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
            <Button color="primary" disabled={busy || !account} onClick={() => ask('check')} sx={{ px: { md: 3 } }}>{t('nemmsharvest.check_button')}</Button>
            <Button href={nemExplorerAccountUrl(account)} target="_blank" rel="noopener" sx={{ px: { md: 3 } }}>{t('nemharvest.view_account')}</Button>
          </Box>
        </>
      ) : tab === 'remote' ? (
        <>
          {plan.vestedShort && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemharvest.vested_short', { amount: nemXem(NEM_MIN_HARVEST_VESTED) })}</Alert>}
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('nemmsharvest.step1_about')}</Typography>
          <FormRow label={t('nemmsharvest.account_label')}><ValueBox>{account}</ValueBox></FormRow>
          {!useCustom && remoteAddressRow}
          <FormRow label={t('nemmultisig.inner_fee_row')}><Typography>{nemXem(NEM_IMPORTANCE_TRANSFER_FEE)}</Typography></FormRow>
          <FormRow label={t('nemmultisig.wrapper_fee_row')}><Typography>{nemXem(NEM_MULTISIG_WRAPPER_FEE)}</Typography></FormRow>
          <FormRow label={t('multisig.approval_row')}><Typography>{info ? `${required} / ${info.cosignatories.length}` : '–'}</Typography></FormRow>
          {plan.ownShort && <Alert severity="warning" sx={{ mt: 1 }}>{t('nemmsharvest.own_short')}</Alert>}
          {plan.multisigShort && <Alert severity="warning" sx={{ mt: 1 }}>{t('nemmsharvest.multisig_short')}</Alert>}
          {remoteActions}
        </>
      ) : (
        <>
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('nemharvest.step2_about')}</Typography>
          {remoteStatus !== 'ACTIVE' && <Alert severity="info" sx={{ mb: 2 }}>{t('nemharvest.need_active')}</Alert>}
          {remoteStatus === 'ACTIVE' && isActivator === false && <Alert severity="info" sx={{ mb: 2 }}>{t('nemmsharvest.not_activator_note')}</Alert>}
          {remoteStatus === 'ACTIVE' && isActivator === null && <Alert severity="info" sx={{ mb: 2 }}>{t('nemmsharvest.unknown_activator_note')}</Alert>}
          {plan.vestedShort && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemharvest.vested_short', { amount: nemXem(NEM_MIN_HARVEST_VESTED) })}</Alert>}

          <FormRow label={t('nemharvest.node_label')}>
            <ToggleButtonGroup exclusive fullWidth size="small" color="primary" value={nodeMode} onChange={(_, v: NodeMode | null) => { if (v) setNodeMode(v); }}>
              <ToggleButton value="list">{t('nemharvest.node_from_list')}</ToggleButton>
              <ToggleButton value="manual">{t('nemharvest.node_manual')}</ToggleButton>
            </ToggleButtonGroup>
          </FormRow>
          <FormRow label={nodeMode === 'list' ? t('nemharvest.node_select') : t('nemharvest.node_url_label')} top>
            {nodeMode === 'list' ? (
              candidates.length === 0 ? (
                <Alert severity="warning">{t('nemharvest.no_nodes')}</Alert>
              ) : (
                <Field select ariaLabel={t('nemharvest.node_select')} value={candidates.includes(nodeSelect) ? nodeSelect : ''} onChange={(e) => setNodeSelect(e.target.value)} helperText={t('nemmsharvest.node_hint')}>
                  {candidates.map((c) => <MenuItem key={c} value={c} sx={mono}>{c}</MenuItem>)}
                </Field>
              )
            ) : (
              <Field
                ariaLabel={t('nemharvest.node_url_label')}
                value={nodeManual}
                onChange={(e) => setNodeManual(e.target.value)}
                error={nodeManual !== '' && !nodeValid}
                helperText={nodeManual !== '' && !nodeValid ? t('nemharvest.node_url_invalid') : t('nemharvest.node_url_hint')}
                htmlInput={{ inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
              />
            )}
          </FormRow>
          {slots && (
            <FormRow label={t('nemharvest.node_status')}>
              <Typography sx={{ color: slotsFull ? 'warning.main' : 'text.primary' }}>
                {slotsFull ? t('nemharvest.slots_full') : t('nemharvest.slots', { free: Math.max(slots.max - slots.used, 0), max: slots.max })}
              </Typography>
            </FormRow>
          )}
          {!remoteAddress && checkButton}
          {startButtonRow}
          {busy && <Typography variant="body2" sx={{ mt: 1.5, textAlign: 'center' }}>{t('nemharvest.working')}</Typography>}
        </>
      )}
    </SectionCard>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemmsharvest.about')}</Alert>

        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => setTick((n) => n + 1)}>{t('nemharvest.retry')}</Button>}>
            {t('nemharvest.load_failed')}
          </Alert>
        )}

        {!walletId && <Typography>{t('nemharvest.no_wallet')}</Typography>}
        {walletId && accounts.length === 0 && !loading && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.no_account')}</Alert>}

        {walletId && accounts.length > 0 && (
          <>
            {/* 対象のマルチシグアカウント */}
            <SectionCard>
              <FormRow label={t('nemmsharvest.account_label')}>
                <Field select ariaLabel={t('nemmsharvest.account_label')} value={account} onChange={(e) => setAccount(e.target.value)}>
                  {accounts.map((a) => <MenuItem key={a} value={a} sx={{ ...mono, whiteSpace: 'normal' }}>{a}</MenuItem>)}
                </Field>
              </FormRow>
              {info && (
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
                  {t('nemmultisig.threshold_text', { approval: required, count: info.cosignatories.length })}
                </Typography>
              )}
            </SectionCard>

            {/* 状況 */}
            <SectionCard>
              <Box sx={{ display: 'flex', gap: 2 }}>
                {stat(t('nemharvest.status_title'), (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Tooltip title={t('nemharvest.reload')}>
                      <span>
                        <IconButton color="primary" size="small" onClick={() => { setTick((n) => n + 1); void loadNode(); }} disabled={loading} aria-label={t('nemharvest.reload')}><RefreshIcon /></IconButton>
                      </span>
                    </Tooltip>
                    <Box component="span" sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: stateColor, flexShrink: 0 }} />
                    <Typography sx={{ color: 'primary.main' }}>{stateText}</Typography>
                  </Box>
                ))}
                {stat(t('nemharvest.balance'), bigNumber(state ? formatAtomic(state.balance, NEM_CURRENCY_DIVISIBILITY) : '–'))}
              </Box>
            </SectionCard>
            {mainCard}
          </>
        )}
      </Box>

      <MessageDialog
        open={pending !== null && !passwordOnly && !confirmed}
        title={confirmTitle}
        texts={confirmTexts}
        selectable
        onClose={() => setConfirmed(true)}
        onCancel={() => setPending(null)}
      />
      <PasswordDialog open={pending !== null && confirmed} mode="check" popup onClose={() => { setConfirmed(false); setPending(null); }} onPass={onPassed} />
      <MessageDialog
        open={done !== null}
        title={done ? t(`nemharvest.done_${done.action}_title`) : ''}
        texts={done ? (t(done.waiting ? 'nemmsharvest.done_waiting_message' : `nemharvest.done_${done.action}_message`, { returnObjects: true }) as string[]) : []}
        onClose={() => setDone(null)}
      />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} variant="error" onClose={() => setSendError(null)} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}

/** A check made just before sending failed; `kind` names the message that explains it (nemmsharvest.error_<kind>_*). */
class CheckError extends Error {
  kind: string;
  constructor(kind: string) { super(kind); this.kind = kind; }
}

// Maps a failure to the message set that explains it: a node problem (harvest), the multisig rules, or "not your remote account".
function classify(error: unknown): { ns: string; kind: string; detail: string } {
  if (error instanceof CheckError) return { ns: 'nemmsharvest', kind: error.kind, detail: '' };
  if (error instanceof Error && error.message === 'no_public_key') return { ns: 'nemmsharvest', kind: 'no_public_key', detail: '' };
  if (error instanceof SymbolSendError && ['node_unreachable', 'timeout', 'node_not_https'].includes(error.code)) {
    return { ns: 'nemharvest', kind: 'node', detail: error.message };
  }
  return { ns: 'nemmultisig', ...classifyNemMultisigError(error) };
}
