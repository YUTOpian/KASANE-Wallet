import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert, Box, Button, CircularProgress, IconButton, MenuItem, Tab, Tabs, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, explorerAccountUrl, fetchConnectedHarvestNode, fetchHarvestNodeCandidates,
  changeHarvestKeys, changeVotingKeys, checkHarvestNode, fetchHarvestNodeByUrl, fetchHarvestStatus, normalizeNodeUrl, quoteHarvestFees, resendHarvestDelegation, startHarvesting, stopHarvesting,
} from '../../lib/symbol/api';
import type { HarvestLink } from '../../lib/symbol/tx';
import { unlinksStillMatch } from '../../lib/symbol/votingKeys';
import type { VotingLink } from '../../lib/symbol/votingKeys';
import type { FeeSpeed, HarvestNode, HarvestNodeCheck, HarvestStatus } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { hasBlocking, planAccountChecks, planNodeChecks } from '../../lib/symbol/harvestEligibility';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import EligibilityList from './EligibilityList';
import HarvestBlocksPanel from './HarvestBlocksPanel';
import KeyLinkPanel from './KeyLinkPanel';
import ResendDelegationPanel from './ResendDelegationPanel';
import type { ResendRequest } from './ResendDelegationPanel';
import type { KeyChangeRequest } from './KeyLinkPanel';
import type { VotingChangeRequest } from './VotingKeyPanel';

type Action = 'start' | 'stop' | 'keys' | 'voting' | 'resend' | 'reveal';
type NodeMode = 'list' | 'url' | 'manual';
type MainTab = 'delegated' | 'keylink' | 'stats';

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Link_Already_Linked') return { kind: 'already_linked', detail };
  if (code === 'delegation_keys_mismatch' || code === 'not_linked') return { kind: 'resend_keys', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

const shortKey = (key: string) => `${key.slice(0, 8)}…${key.slice(-8)}`;

// 「ハーベスト」: delegated (remote) harvesting settings. Shows whether the active wallet's account
// is linked to a harvesting node and lets it start or stop harvesting.
export default function HarvestSettings() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);

  const [address, setAddress] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [status, setStatus] = useState<HarvestStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // node choice
  const [connected, setConnected] = useState<HarvestNode | null>(null);
  const [candidates, setCandidates] = useState<HarvestNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodeMode, setNodeMode] = useState<NodeMode>('list');
  const [selectedKey, setSelectedKey] = useState('');
  const [manualKey, setManualKey] = useState('');
  const [urlText, setUrlText] = useState('');
  // The node found at the typed URL: its public key is read from /node/info.
  const [urlNode, setUrlNode] = useState<HarvestNode | 'loading' | { error: string } | null>(null);
  // What was found out about the chosen node (null: nothing chosen / not checkable yet).
  const [nodeCheck, setNodeCheck] = useState<HarvestNodeCheck | 'loading' | null>(null);

  // tabs: 「デリゲートハーベスティング」 / 「キーリンク」 / 「ハーベスト統計」
  const [tab, setTab] = useState<MainTab>('delegated');

  // costs
  const [startFee, setStartFee] = useState<bigint | null>(null);
  const [stopFee, setStopFee] = useState<bigint | null>(null);

  // action
  const [action, setAction] = useState<Action | null>(null);
  // キーリンク: the links (and unlinks) of the individual keys waiting for the confirmation / password.
  const [keyChange, setKeyChange] = useState<HarvestLink[] | null>(null);
  const [keyFeeSpeed, setKeyFeeSpeed] = useState<FeeSpeed>(() => useAppStore.getState().defaultFeeSpeed);
  // 投票鍵: the voting key links (and unlinks) waiting for the confirmation / password.
  const [votingChange, setVotingChange] = useState<VotingLink[] | null>(null);
  // 委任リクエストの再送: the typed keys (or "use the kept ones") waiting for the confirmation / password (held only until sent).
  const [resendKeys, setResendKeys] = useState<ResendRequest | null>(null);
  // This wallet kept the remote / VRF private keys of the start (encrypted); and the keys while they are shown to be written down.
  const [hasStoredKeys, setHasStoredKeys] = useState(false);
  const [revealed, setRevealed] = useState<{ remotePrivateKey: string; vrfPrivateKey: string } | null>(null);
  const [resendNonce, setResendNonce] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [working, setWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [done, setDone] = useState<{ action: Action } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) {
        setStatus(null);
        return;
      }
      setAddress(wallet.address);
      setPublicKey(wallet.publicKey);
      setHasStoredKeys(wallet.encryptedHarvestKeys !== '');
      setStatus(await fetchHarvestStatus(wallet.address));
    } catch (e) {
      console.error('Failed to load harvest status', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the links belong to one network).
  useEffect(() => {
    load();
  }, [load, network]);

  // Look the typed URL up (after a short pause) to get the node's public key.
  const urlValid = normalizeNodeUrl(urlText) !== null;
  useEffect(() => {
    if (nodeMode !== 'url') return undefined;
    setUrlNode(null);
    if (!urlValid) return undefined;
    let cancelled = false;
    setUrlNode('loading');
    const timer = setTimeout(() => {
      fetchHarvestNodeByUrl(urlText)
        .then((node) => { if (!cancelled) setUrlNode(node); })
        .catch((e) => { if (!cancelled) setUrlNode({ error: e instanceof Error ? e.message : 'unreachable' }); });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [urlText, urlValid, nodeMode, network]);

  // Nodes to choose from; only needed while harvesting is off.
  const needsNode = status !== null && !status.linked && !status.partial;
  useEffect(() => {
    if (!needsNode) return;
    let cancelled = false;
    setNodesLoading(true);
    (async () => {
      const [current, list] = await Promise.all([fetchConnectedHarvestNode(), fetchHarvestNodeCandidates()]);
      if (cancelled) return;
      setConnected(current);
      setCandidates(list);
      setSelectedKey((prev) => prev || current?.publicKey || list[0]?.publicKey || '');
      if (!current && list.length === 0) setNodeMode('manual');
      setNodesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [needsNode, network]);

  // Transaction fees (shown before signing).
  useEffect(() => {
    let cancelled = false;
    setStartFee(null);
    setStopFee(null);
    (async () => {
      try {
        const [start, stop] = await Promise.all([quoteHarvestFees(3, true), quoteHarvestFees(3, false)]);
        if (cancelled) return;
        setStartFee(start.links.fee + (start.delegation?.fee ?? 0n));
        setStopFee(stop.links.fee);
      } catch { /* shown as unavailable */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // The list shown in the picker: the node we are connected to first, then the others.
  const options = useMemo(() => {
    const rest = candidates.filter((c) => c.publicKey !== connected?.publicKey);
    return connected ? [connected, ...rest] : rest;
  }, [candidates, connected]);

  const manualValid = /^[0-9a-fA-F]{64}$/.test(manualKey.trim());
  const urlKey = urlNode !== null && typeof urlNode === 'object' && 'publicKey' in urlNode ? urlNode.publicKey : '';
  const nodeKey = nodeMode === 'manual' ? (manualValid ? manualKey.trim().toUpperCase() : '') : nodeMode === 'url' ? urlKey : selectedKey;
  // The node object behind the choice (a node picked from the list or found by URL has a REST address to ask; a typed key has none).
  const chosenNode = useMemo<HarvestNode | null>(() => {
    if (nodeKey === '') return null;
    if (nodeMode === 'url') return urlNode !== null && typeof urlNode === 'object' && 'publicKey' in urlNode ? urlNode : null;
    if (nodeMode === 'list') return options.find((n) => n.publicKey === selectedKey) ?? null;
    return null;
  }, [nodeKey, nodeMode, urlNode, options, selectedKey]);
  useEffect(() => {
    if (nodeKey === '') { setNodeCheck(null); return undefined; }
    let cancelled = false;
    setNodeCheck('loading');
    checkHarvestNode(chosenNode, nodeKey)
      .then((c) => { if (!cancelled) setNodeCheck(c); })
      .catch(() => { if (!cancelled) setNodeCheck(null); });
    return () => { cancelled = true; };
  }, [chosenNode, nodeKey, network]);
  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const balanceShort = status !== null && status.xymBalance < status.minBalance;
  // Starting needs the minimum balance AND enough XYM left to pay the start fee (the quote may be unavailable: then the minimum alone is checked).
  const startRequired = status !== null ? status.minBalance + (startFee ?? 0n) : 0n;
  const startShort = status !== null && status.xymBalance < startRequired;
  // 開始前の資格チェック: the account (balance range, importance) and the chosen node.
  const accountChecks = status === null ? [] : planAccountChecks({ balance: status.xymBalance, min: status.minBalance, max: status.maxBalance, importance: status.importance });
  const nodeChecks = nodeCheck === null || nodeCheck === 'loading' ? [] : planNodeChecks(nodeCheck);
  const checkBlocked = hasBlocking(accountChecks) || hasBlocking(nodeChecks);

  // --- start / stop ---------------------------------------------------------------------------
  const ask = (next: Action) => {
    setAction(next);
    setShowConfirm(true);
  };
  const askKeys = (request: KeyChangeRequest) => {
    setKeyChange(request.links);
    setKeyFeeSpeed(request.feeSpeed);
    ask('keys');
  };
  const askVoting = (request: VotingChangeRequest) => {
    setVotingChange(request.links);
    ask('voting');
  };
  const askResend = (request: ResendRequest) => {
    setResendKeys(request);
    ask('resend');
  };
  // Showing the kept keys needs only the password (no confirmation of a transaction).
  const askReveal = () => {
    setAction('reveal');
    setShowPasswordDialog(true);
  };

  const onPassed = async (password: string) => {
    if (!action) return;
    setWorking(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      if (action === 'reveal') {
        const keys = await WalletsHelper.loadHarvestKeys(wallet.id, password);
        if (!keys) {
          setErrorMessage(t('harvest.reveal_failed'));
          return;
        }
        setRevealed({ remotePrivateKey: keys.remotePrivateKey, vrfPrivateKey: keys.vrfPrivateKey });
        return;
      }
      if (action === 'start') {
        // The throw-away keys are kept (encrypted with this password) so the request can be sent again later.
        await startHarvesting({
          privateKey, publicKey: wallet.publicKey, nodePublicKey: nodeKey,
          keyStore: { save: (keys) => WalletsHelper.saveHarvestKeys(wallet.id, keys, password), discard: () => WalletsHelper.clearHarvestKeys(wallet.id) },
        });
        setDone({ action });
      } else if (action === 'keys') {
        if (!keyChange) return;
        // The unlink of a key must name what is linked now: check the chain once more right before signing.
        const latest = await fetchHarvestStatus(wallet.address);
        const stale = keyChange.some((l) => {
          const now = l.kind === 'remote' ? latest.remotePublicKey : l.kind === 'vrf' ? latest.vrfPublicKey : latest.nodePublicKey;
          return !l.link && now?.toUpperCase() !== l.publicKey.toUpperCase();
        });
        if (stale) {
          setStatus(latest);
          setErrorMessage(t('harvest.keys_changed'));
          return;
        }
        await changeHarvestKeys({ privateKey, publicKey: wallet.publicKey, links: keyChange, feeSpeed: keyFeeSpeed });
        // The kept private keys belong to the old remote / VRF keys: forget them when one of those changed.
        if (keyChange.some((l) => l.kind === 'remote' || l.kind === 'vrf')) await WalletsHelper.clearHarvestKeys(wallet.id);
        setDone({ action });
      } else if (action === 'voting') {
        if (!votingChange) return;
        // An unlink must name the key and the epochs exactly as they are on the chain: check once more right before signing.
        const latest = await fetchHarvestStatus(wallet.address);
        if (!unlinksStillMatch(latest.votingKeys, votingChange)) {
          setStatus(latest);
          setErrorMessage(t('harvest.keys_changed'));
          return;
        }
        await changeVotingKeys({ privateKey, publicKey: wallet.publicKey, links: votingChange });
        setDone({ action });
      } else if (action === 'resend') {
        if (!resendKeys) return;
        // The keys must fit the keys linked on the chain now: check once more right before signing.
        const latest = await fetchHarvestStatus(wallet.address);
        let keys: { remotePrivateKey: string; vrfPrivateKey: string } | null = null;
        if (resendKeys.source === 'typed') keys = resendKeys;
        else keys = await WalletsHelper.loadHarvestKeys(wallet.id, password);
        if (!keys) throw new SymbolSendError('delegation_keys_mismatch', 'no_keys');
        await resendHarvestDelegation({ privateKey, publicKey: wallet.publicKey, remotePrivateKey: keys.remotePrivateKey, vrfPrivateKey: keys.vrfPrivateKey, status: latest });
        if (resendKeys.source === 'typed') setResendNonce((n) => n + 1); // a new panel: the typed private keys are gone from the screen
        setDone({ action });
      } else {
        // Re-read the links right before signing so exactly what is on the chain gets removed.
        const latest = await fetchHarvestStatus(wallet.address);
        await stopHarvesting({ privateKey, publicKey: wallet.publicKey, status: latest });
        await WalletsHelper.clearHarvestKeys(wallet.id); // nothing is linked any more: the kept keys are of no use
        setDone({ action });
      }
      load();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      // The private keys of a resend are not kept once the attempt is over (the typed fields stay until the panel is renewed).
      setResendKeys(null);
      setWorking(false);
    }
  };

  // Cancelling a resend must not leave the private keys behind in memory.
  const cancelAction = () => {
    setAction(null);
    setResendKeys(null);
  };

  // The confirmation of a key change lists exactly what will be linked / unlinked.
  const keysConfirmTexts = keyChange === null ? [] : [
    ...keyChange.map((l) => t(l.link ? 'harvest.keys_line_link' : 'harvest.keys_line_unlink', { kind: t(`harvest.keys_kind_${l.kind}`), key: shortKey(l.publicKey) })),
    ...(t('harvest.keys_confirm_message', { returnObjects: true }) as string[]),
  ];

  // The confirmation of a voting key change lists exactly what will be linked / unlinked, with the epochs.
  const votingConfirmTexts = votingChange === null ? [] : [
    ...votingChange.map((l) => t(l.link ? 'harvest.voting_line_link' : 'harvest.voting_line_unlink', { key: shortKey(l.publicKey), start: l.startEpoch, end: l.endEpoch })),
    ...(t('harvest.voting_confirm_message', { returnObjects: true }) as string[]),
  ];

  // The confirmation of a resend names the node the request goes to (the keys themselves are never shown).
  const resendConfirmTexts = [
    ...(status?.nodePublicKey ? [t('harvest.resend_line_node', { key: shortKey(status.nodePublicKey) })] : []),
    ...(t('harvest.resend_confirm_message', { returnObjects: true }) as string[]),
  ];

  const errorTitle = sendError ? t(`harvest.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`harvest.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // --- rendering --------------------------------------------------------------------------------
  const stateColor = status === null ? 'text.disabled' : status.linked ? 'success.main' : status.partial ? 'warning.main' : 'error.main';
  const stateText = status === null ? '' : status.linked ? t('harvest.status_on') : status.partial ? t('harvest.status_partial') : t('harvest.status_off');

  const stat = (title: string, content: ReactNode) => (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{title}</Typography>
      <Box sx={{ minHeight: 48, display: 'flex', alignItems: 'center' }}>{content}</Box>
    </Box>
  );
  const bigNumber = (text: string) => (
    <Typography sx={{ fontSize: { xs: '1.6rem', md: '2.2rem' }, lineHeight: 1.1, color: 'primary.main', wordBreak: 'break-all' }}>{text}</Typography>
  );

  const detailRows = status === null ? [] : [
    { label: t('harvest.balance'), value: xym(status.xymBalance) },
    { label: t('harvest.min_balance'), value: xym(status.minBalance) },
    ...(status.nodePublicKey ? [{ label: t('harvest.linked_node'), value: shortKey(status.nodePublicKey) }] : []),
    ...(status.remotePublicKey ? [{ label: t('harvest.linked_remote'), value: shortKey(status.remotePublicKey) }] : []),
  ];

  const mainCard = status !== null && (
    <SectionCard sx={{ px: { xs: 2, md: 3 }, pt: 0 }}>
      <Tabs value={tab} onChange={(_, v: MainTab) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tab value="delegated" label={t('harvest.tab_delegated')} />
        <Tab value="keylink" label={t('harvest.tab_keylink')} />
        <Tab value="stats" label={t('harvest.tab_stats')} />
      </Tabs>

      {tab === 'stats' ? (
        <HarvestBlocksPanel status={status} address={address} publicKey={publicKey} />
      ) : tab === 'keylink' ? (
        <KeyLinkPanel status={status} ownPublicKey={publicKey} busy={working} hasStored={hasStoredKeys} onRequest={askKeys} onVotingRequest={askVoting} onReveal={askReveal} />
      ) : (
        <>

      {needsNode && startShort
        ? <Alert severity="warning" sx={{ mb: 2 }}>{t('harvest.start_balance_short', { min: xym(status.minBalance), fee: startFee === null ? '–' : xym(startFee), total: xym(startRequired) })}</Alert>
        : balanceShort && <Alert severity="warning" sx={{ mb: 2 }}>{t('harvest.balance_short', { amount: xym(status.minBalance) })}</Alert>}
      {status.linked && <Alert severity="info" sx={{ mb: 2 }}>{t('harvest.activation_note')}</Alert>}
      {status.partial && <Alert severity="warning" sx={{ mb: 2 }}>{t('harvest.partial_note')}</Alert>}

      {needsNode && <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('harvest.about')}</Typography>}
      {needsNode && status && (
        <EligibilityList
          title={t('harvest.check_account_title')}
          items={accountChecks}
          values={{ balance: xym(status.xymBalance), min: xym(status.minBalance), max: xym(status.maxBalance) }}
        />
      )}

      <FormRow label={t('harvest.sender_label')}>
        <ValueBox>{address}</ValueBox>
      </FormRow>

      {needsNode ? (
        <>
          <FormRow label={t('harvest.node_label')}>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color="primary"
              value={nodeMode}
              onChange={(_, v: NodeMode | null) => { if (v) setNodeMode(v); }}
            >
              <ToggleButton value="list">{t('harvest.node_from_list')}</ToggleButton>
              <ToggleButton value="url">{t('harvest.node_url')}</ToggleButton>
              <ToggleButton value="manual">{t('harvest.node_manual')}</ToggleButton>
            </ToggleButtonGroup>
          </FormRow>
          <FormRow label={nodeMode === 'list' ? t('harvest.node_select') : nodeMode === 'url' ? t('harvest.node_url_label') : t('harvest.node_key_label')} top>
            {nodeMode === 'list' ? (
              nodesLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}><CircularProgress size={22} /></Box>
              ) : options.length === 0 ? (
                <Alert severity="warning">{t('harvest.no_nodes')}</Alert>
              ) : (
                <Field select ariaLabel={t('harvest.node_select')} value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} helperText={t('harvest.node_hint')}>
                  {options.map((n) => (
                    <MenuItem key={n.publicKey} value={n.publicKey}>
                      {n.publicKey === connected?.publicKey ? `${n.name} (${t('harvest.connected')})` : n.name}
                    </MenuItem>
                  ))}
                </Field>
              )
            ) : nodeMode === 'url' ? (
              <>
                <Field
                  ariaLabel={t('harvest.node_url_label')}
                  placeholder={t('harvest.node_url_placeholder')}
                  value={urlText}
                  onChange={(e) => setUrlText(e.target.value.trim())}
                  error={urlText !== '' && !urlValid}
                  helperText={urlText !== '' && !urlValid ? t('harvest.node_url_invalid') : t('harvest.node_url_hint')}
                  htmlInput={{ inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                />
                {urlNode === 'loading' && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}><CircularProgress size={16} /><Typography variant="caption">{t('harvest.node_url_checking')}</Typography></Box>}
                {urlNode !== null && typeof urlNode === 'object' && 'error' in urlNode && (
                  <Alert severity="warning" sx={{ mt: 1 }}>{t(`harvest.node_url_err_${urlNode.error}`)}</Alert>
                )}
                {urlNode !== null && typeof urlNode === 'object' && 'publicKey' in urlNode && (
                  <Alert severity="success" sx={{ mt: 1, wordBreak: 'break-all' }}>
                    {urlNode.name}<br />{shortKey(urlNode.publicKey)}
                  </Alert>
                )}
              </>
            ) : (
              <Field
                ariaLabel={t('harvest.node_key_label')}
                value={manualKey}
                onChange={(e) => setManualKey(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64))}
                error={manualKey !== '' && !manualValid}
                helperText={manualKey !== '' && !manualValid ? t('harvest.node_key_invalid') : t('harvest.node_key_hint')}
                htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
              />
            )}
          </FormRow>
          {nodeCheck === 'loading' && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}><CircularProgress size={16} /><Typography variant="caption">{t('harvest.check_node_checking')}</Typography></Box>}
          <EligibilityList title={t('harvest.check_node_title')} items={nodeChecks} values={{}} />
          <FormRow label={t('harvest.tx_fee')} top>
            <Typography>{startFee === null ? t('harvest.cost_loading') : xym(startFee)}</Typography>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('harvest.cost_hint')}</Typography>
          </FormRow>
          <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
            <Button
              variant="contained"
              color="primary"
              size="large"
              fullWidth
              disabled={working || nodeKey === '' || startShort || checkBlocked}
              onClick={() => ask('start')}
              startIcon={<LockOutlinedIcon />}
              sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}
            >
              {working ? t('harvest.starting') : t('harvest.start_button')}
            </Button>
          </Box>
        </>
      ) : (
        <>
          {detailRows.map((r) => (
            <FormRow key={r.label} label={r.label}>
              <ValueBox>{r.value}</ValueBox>
            </FormRow>
          ))}
          <FormRow label={t('harvest.tx_fee')}>
            <Typography>{stopFee === null ? t('harvest.cost_loading') : xym(stopFee)}</Typography>
          </FormRow>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
            <Button href={explorerAccountUrl(address)} target="_blank" rel="noopener" sx={{ px: { md: 3 } }}>
              {t('harvest.view_account')}
            </Button>
            <Button
              variant="contained"
              color="primary"
              size="large"
              disabled={working}
              onClick={() => ask('stop')}
              startIcon={<LockOutlinedIcon />}
              sx={{ py: 1.25, px: { md: 4 } }}
            >
              {working ? t('harvest.stopping') : t('harvest.stop_button')}
            </Button>
          </Box>
          {status.linked && <ResendDelegationPanel key={resendNonce} status={status} busy={working} hasStored={hasStoredKeys} onRequest={askResend} onReveal={askReveal} />}
        </>
      )}
        </>
      )}
    </SectionCard>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {loading && status === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={26} />
          </Box>
        ) : failed ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('harvest.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('harvest.retry')}</Button>
          </Box>
        ) : status === null ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('harvest.no_wallet')}</Typography>
        ) : (
          <Box>
            <Box sx={{ minWidth: 0 }}>
              {/* 状況 */}
              <SectionCard>
                <Box sx={{ display: 'flex', gap: 2 }}>
                  {stat(t('harvest.status_title'), (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Tooltip title={t('harvest.retry')}>
                        <span>
                          <IconButton color="primary" size="small" onClick={load} disabled={loading} aria-label={t('harvest.retry')}><RefreshIcon /></IconButton>
                        </span>
                      </Tooltip>
                      <Box component="span" sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: stateColor, flexShrink: 0 }} />
                      <Typography sx={{ color: 'primary.main' }}>{stateText}</Typography>
                    </Box>
                  ))}
                  {stat(t('harvest.balance'), bigNumber(formatAtomic(status.xymBalance, CURRENCY_DIVISIBILITY)))}
                </Box>
              </SectionCard>
              {mainCard}
            </Box>
          </Box>
        )}
      </Box>

      <MessageDialog
        open={showConfirm}
        selectable
        title={action === 'stop' ? t('harvest.stop_confirm_title') : action === 'resend' ? t('harvest.resend_confirm_title') : action === 'keys' ? t('harvest.keys_confirm_title') : action === 'voting' ? t('harvest.voting_confirm_title') : t('harvest.start_confirm_title')}
        texts={action === 'keys' ? keysConfirmTexts : action === 'voting' ? votingConfirmTexts : action === 'resend' ? resendConfirmTexts : t(action === 'stop' ? 'harvest.stop_confirm_message' : 'harvest.start_confirm_message', { returnObjects: true }) as string[]}
        onClose={() => { setShowConfirm(false); setShowPasswordDialog(true); }}
        onCancel={() => { setShowConfirm(false); cancelAction(); }}
      />
      <PasswordDialog
        open={showPasswordDialog}
        mode="check"
        popup
        onClose={() => { setShowPasswordDialog(false); }}
        onPass={(password) => { setShowPasswordDialog(false); onPassed(password); }}
        onCancel={cancelAction}
      />
      <MessageDialog
        open={done !== null}
        title={done?.action === 'stop' ? t('harvest.done_stop_title') : done?.action === 'resend' ? t('harvest.resend_done_title') : done?.action === 'keys' ? t('harvest.keys_done_title') : done?.action === 'voting' ? t('harvest.voting_done_title') : t('harvest.done_start_title')}
        texts={t(done?.action === 'stop' ? 'harvest.done_stop_message' : done?.action === 'resend' ? 'harvest.resend_done_message' : done?.action === 'keys' ? 'harvest.keys_done_message' : done?.action === 'voting' ? 'harvest.voting_done_message' : 'harvest.done_start_message', { returnObjects: true }) as string[]}
        onClose={() => setDone(null)}
      />
      <MessageDialog
        open={revealed !== null}
        title={t('harvest.reveal_title')}
        texts={revealed === null ? [] : [
          t('harvest.reveal_remote_line', { key: revealed.remotePrivateKey }),
          t('harvest.reveal_vrf_line', { key: revealed.vrfPrivateKey }),
          t('harvest.reveal_note'),
        ]}
        onClose={() => setRevealed(null)}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} variant="error" title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Box>
  );
}
