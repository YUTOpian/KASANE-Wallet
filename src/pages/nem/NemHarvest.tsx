import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, MenuItem, Tab, Tabs, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SymbolSendError } from '../../lib/symbol/api';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { isHttpsUrl, nemExplorerAccountUrl } from '../../lib/nem/api';
import { nemAddressFromPublicKey } from '../../lib/nem/crypto';
import { NEM_CURRENCY_DIVISIBILITY, NEM_MIN_HARVEST_VESTED } from '../../lib/nem/constants';
import { formatAtomic } from '../../lib/symbol/amount';
import {
  cleanNemNodeUrl, deriveNemRemoteAccount, fetchNemHarvestState, fetchNemNodeSlots, fetchNemRemoteHarvestStatus,
  loadNemHarvestNode, nemHarvestNodeCandidates, saveNemHarvestNode, sendNemImportanceTransfer, startNemHarvesting,
  stopNemHarvesting,
} from '../../lib/nem/harvest';
import type { NemHarvestState, NemNodeSlots, NemRemoteHarvestStatus } from '../../lib/nem/harvest';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { NEM_IMPORTANCE_TRANSFER_FEE } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { nemXem } from './parts';
import NemHarvestBlocksPanel from './NemHarvestBlocksPanel';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';

type Action = 'activate' | 'deactivate' | 'start' | 'stop';
type NodeMode = 'list' | 'manual';
type MainTab = 'remote' | 'node' | 'status' | 'stats';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

// NEM 「ハーベスト」（委任ハーベスト）: 1. リモートアカウントを有効化（重要性転送）→ 2. ノードにハーベストを任せる。
// 公式 NEM Nano Wallet の「リモートアカウントの管理」と同じ流れ。
export default function NemHarvest() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [state, setState] = useState<NemHarvestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [done, setDone] = useState<Action | null>(null);

  const remoteAddress = wallet?.nemRemotePublicKey ? nemAddressFromPublicKey(wallet.nemRemotePublicKey, netCfg.networkByte) : '';
  const node = nodeMode === 'manual' ? cleanNemNodeUrl(nodeManual) : nodeSelect;
  const nodeValid = isHttpsUrl(node);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const w = await WalletsHelper.getActive();
      setWallet(w);
      if (!w) return;
      setState(await fetchNemHarvestState(w.address));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, network]);

  // The node chosen last time on this wallet (or the first candidate).
  useEffect(() => {
    if (!wallet) return;
    const saved = loadNemHarvestNode(wallet.id);
    if (saved && !candidates.includes(saved)) {
      setNodeMode('manual');
      setNodeManual(saved);
    } else {
      setNodeMode('list');
      setNodeSelect(saved || candidates[0] || '');
    }
  }, [wallet, candidates]);

  // Slots and the remote account's harvesting state on the node.
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
  const vestedShort = state !== null && state.vestedBalance < NEM_MIN_HARVEST_VESTED;
  const slotsFull = slots !== null && slots.used >= slots.max && nodeStatus !== 'UNLOCKED';
  const canActivate = remoteStatus === 'INACTIVE' && !vestedShort;
  const canDeactivate = remoteStatus === 'ACTIVE' && nodeStatus !== 'UNLOCKED';
  const canStart = remoteStatus === 'ACTIVE' && nodeValid && nodeStatus !== 'UNLOCKED' && !slotsFull;
  const canStop = remoteStatus === 'ACTIVE' && nodeValid && nodeStatus === 'UNLOCKED';

  const ask = (action: Action) => { setConfirmed(false); setPending(action); };

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
      const remote = deriveNemRemoteAccount(privateKey, netCfg.networkByte);
      if (action === 'activate' || action === 'deactivate') {
        await sendNemImportanceTransfer({ privateKey, publicKey: w.publicKey, remotePublicKey: remote.publicKey, activate: action === 'activate' });
        if (action === 'activate') await WalletsHelper.updateAccount(w.id, { nemRemotePublicKey: remote.publicKey });
      } else {
        if (action === 'start') {
          await startNemHarvesting(node, remote.privateKey);
          saveNemHarvestNode(w.id, node);
        } else {
          await stopNemHarvesting(node, remote.privateKey);
        }
        if (!w.nemRemotePublicKey) await WalletsHelper.updateAccount(w.id, { nemRemotePublicKey: remote.publicKey });
      }
      setDone(action);
      await load();
      await loadNode();
    } catch (error) {
      const code = error instanceof SymbolSendError ? error.code.toUpperCase() : '';
      const detail = error instanceof Error ? error.message : String(error);
      let kind = 'unknown';
      if (code.includes('INSUFFICIENT_BALANCE')) kind = 'insufficient_balance';
      else if (code.includes('DEADLINE') || code.includes('TIMESTAMP')) kind = 'deadline';
      else if (code.includes('WRONG_NETWORK')) kind = 'wrong_network';
      else if (code === 'NODE_UNREACHABLE' || code === 'TIMEOUT' || code === 'NODE_NOT_HTTPS') kind = 'node';
      setSendError({ kind, detail });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const confirmTexts = pending ? (t(`nemharvest.confirm_${pending}_message`, { returnObjects: true }) as string[]) : [];
  const errorTitle = sendError ? t(`nemharvest.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemharvest.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  // The status light: running / ready (green), waiting for the network (amber), not set up (red), unknown (grey).
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

  const stat = (title: string, content: ReactNode) => (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{title}</Typography>
      <Box sx={{ minHeight: 48, display: 'flex', alignItems: 'center' }}>{content}</Box>
    </Box>
  );
  const bigNumber = (text: string) => (
    <Typography sx={{ fontSize: { xs: '1.6rem', md: '2.2rem' }, lineHeight: 1.1, color: 'primary.main', wordBreak: 'break-all' }}>{text}</Typography>
  );

  if (loading && !state) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress color="primary" /></Box>;
  }

  if (!wallet) {
    return <Box sx={{ px: 3, py: 4 }}><Typography>{t('nemharvest.no_wallet')}</Typography></Box>;
  }

  const startButtonRow = (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
      <Button variant="outlined" color="primary" size="large" disabled={!canStop || busy} onClick={() => ask('stop')} sx={{ py: 1.25, px: { md: 4 } }}>{t('nemharvest.stop_button')}</Button>
      <Button variant="contained" color="primary" size="large" disabled={!canStart || busy} onClick={() => ask('start')} sx={{ py: 1.25, px: { md: 4 } }}>{t('nemharvest.start_button')}</Button>
    </Box>
  );

  const mainCard = (
    <SectionCard sx={{ px: { xs: 2, md: 3 }, pt: 0 }}>
      <Tabs value={tab} onChange={(_, v: MainTab) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tab value="remote" label={t('nemharvest.step1_title')} />
        <Tab value="node" label={t('nemharvest.step2_title')} />
        <Tab value="status" label={t('nemharvest.status_title')} />
        <Tab value="stats" label={t('nemharvest.tab_stats')} />
      </Tabs>

      {tab === 'stats' ? (
        <NemHarvestBlocksPanel address={wallet.address} harvestedBlocks={state?.harvestedBlocks ?? null} />
      ) : tab === 'status' ? (
        <>
          <FormRow label={t('nemharvest.account')}><ValueBox>{wallet.address}</ValueBox></FormRow>
          {state && (
            <>
              <FormRow label={t('nemharvest.balance')}><ValueBox>{nemXem(state.balance)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.vested')}><ValueBox>{nemXem(state.vestedBalance)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.min_vested')}><ValueBox>{nemXem(NEM_MIN_HARVEST_VESTED)}</ValueBox></FormRow>
              <FormRow label={t('nemharvest.harvested_blocks')}><ValueBox>{state.harvestedBlocks}</ValueBox></FormRow>
            </>
          )}
          <FormRow label={t('nemharvest.remote_status')}><ValueBox>{remoteLabel[remoteStatus] ?? remoteLabel.UNKNOWN}</ValueBox></FormRow>
          <FormRow label={t('nemharvest.remote_address')}>
            <ValueBox>{remoteAddress || t('nemharvest.remote_address_unknown')}</ValueBox>
          </FormRow>
          <FormRow label={t('nemharvest.node_status')}>
            <ValueBox>{running ? t('nemharvest.node_running') : nodeStatus === 'LOCKED' ? t('nemharvest.node_stopped') : t('nemharvest.unknown')}</ValueBox>
          </FormRow>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
            <Button href={nemExplorerAccountUrl(wallet.address)} target="_blank" rel="noopener" sx={{ px: { md: 3 } }}>{t('nemharvest.view_account')}</Button>
          </Box>
        </>
      ) : tab === 'remote' ? (
        <>
          {vestedShort && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemharvest.vested_short', { amount: nemXem(NEM_MIN_HARVEST_VESTED) })}</Alert>}
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('nemharvest.step1_about')}</Typography>
          <FormRow label={t('nemharvest.account')}><ValueBox>{wallet.address}</ValueBox></FormRow>
          <FormRow label={t('nemharvest.remote_address')}>
            <ValueBox>{remoteAddress || t('nemharvest.remote_address_unknown')}</ValueBox>
          </FormRow>
          <FormRow label={t('nemharvest.fee')}>
            <Typography>{nemXem(NEM_IMPORTANCE_TRANSFER_FEE)}</Typography>
          </FormRow>
          {remoteStatus === 'ACTIVATING' || remoteStatus === 'DEACTIVATING' ? (
            <Alert severity="info" sx={{ mt: 1 }}>{t('nemharvest.waiting_note')}</Alert>
          ) : remoteStatus === 'ACTIVE' ? (
            <>
              {running && <Alert severity="info" sx={{ mt: 1 }}>{t('nemharvest.deactivate_note')}</Alert>}
              <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
                <Button variant="outlined" color="primary" size="large" fullWidth disabled={!canDeactivate || busy} onClick={() => ask('deactivate')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
                  {t('nemharvest.deactivate_button')}
                </Button>
              </Box>
            </>
          ) : (
            <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
              <Button variant="contained" color="primary" size="large" fullWidth disabled={!canActivate || busy} onClick={() => ask('activate')} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 4 } }}>
                {t('nemharvest.activate_button')}
              </Button>
            </Box>
          )}
        </>
      ) : (
        <>
          <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2 }}>{t('nemharvest.step2_about')}</Typography>
          {remoteStatus !== 'ACTIVE' && <Alert severity="info" sx={{ mb: 2 }}>{t('nemharvest.need_active')}</Alert>}

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
                <Field select ariaLabel={t('nemharvest.node_select')} value={candidates.includes(nodeSelect) ? nodeSelect : ''} onChange={(e) => setNodeSelect(e.target.value)} helperText={t('nemharvest.node_hint')}>
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
          {startButtonRow}
          {busy && <Typography variant="body2" sx={{ mt: 1.5, textAlign: 'center' }}>{t('nemharvest.working')}</Typography>}
        </>
      )}
    </SectionCard>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemharvest.about')}</Alert>
        {/* マルチシグアカウントの委任ハーベストは別の画面（連署者のウォレットで行う）。 */}
        <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate('/multisig/harvest')}>{t('nemharvest.multisig_button')}</Button>}>
          {t('nemharvest.multisig_note')}
        </Alert>

        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => void load()}>{t('nemharvest.retry')}</Button>}>
            {t('nemharvest.load_failed')}
          </Alert>
        )}

        {/* 状況 */}
        <SectionCard>
          <Box sx={{ display: 'flex', gap: 2 }}>
            {stat(t('nemharvest.status_title'), (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Tooltip title={t('nemharvest.reload')}>
                  <span>
                    <IconButton color="primary" size="small" onClick={() => { void load(); void loadNode(); }} disabled={loading} aria-label={t('nemharvest.reload')}><RefreshIcon /></IconButton>
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
      </Box>

      <MessageDialog
        open={pending !== null && !confirmed}
        title={pending ? t(`nemharvest.confirm_${pending}_title`) : ''}
        texts={confirmTexts}
        selectable
        onClose={() => setConfirmed(true)}
        onCancel={() => setPending(null)}
      />
      <PasswordDialog open={pending !== null && confirmed} mode="check" popup onClose={() => { setConfirmed(false); setPending(null); }} onPass={onPassed} />
      <MessageDialog
        open={done !== null}
        title={done ? t(`nemharvest.done_${done}_title`) : ''}
        texts={done ? (t(`nemharvest.done_${done}_message`, { returnObjects: true }) as string[]) : []}
        onClose={() => setDone(null)}
      />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} variant="error" onClose={() => setSendError(null)} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
