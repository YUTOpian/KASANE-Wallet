import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SymbolSendError } from '../../lib/symbol/api';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { isHttpsUrl, nemExplorerAccountUrl } from '../../lib/nem/api';
import { nemAddressFromPublicKey } from '../../lib/nem/crypto';
import { NEM_MIN_HARVEST_VESTED } from '../../lib/nem/constants';
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

type Action = 'activate' | 'deactivate' | 'start' | 'stop';
type NodeMode = 'list' | 'manual';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Typography variant="body2" component="div" sx={{ py: 0.4, wordBreak: 'break-all' }}>
      <Box component="span" sx={{ color: 'text.secondary' }}>{label}: </Box>{children}
    </Typography>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 2.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
      {children}
    </Box>
  );
}

// NEM 「ハーベスト」（委任ハーベスト）: 1. リモートアカウントを有効化（重要性転送）→ 2. ノードにハーベストを任せる。
// 公式 NEM Nano Wallet の「リモートアカウントの管理」と同じ流れ。
export default function NemHarvest() {
  const { t } = useTranslation();
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

  const remoteChip = (() => {
    const map: Record<string, { label: string; color: 'default' | 'success' | 'warning' }> = {
      INACTIVE: { label: t('nemharvest.remote_inactive'), color: 'default' },
      ACTIVATING: { label: t('nemharvest.remote_activating'), color: 'warning' },
      ACTIVE: { label: t('nemharvest.remote_active'), color: 'success' },
      DEACTIVATING: { label: t('nemharvest.remote_deactivating'), color: 'warning' },
      REMOTE: { label: t('nemharvest.remote_remote'), color: 'default' },
      UNKNOWN: { label: t('nemharvest.unknown'), color: 'default' },
    };
    const m = map[remoteStatus] ?? map.UNKNOWN;
    return <Chip size="small" label={m.label} color={m.color} />;
  })();

  if (loading && !state) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress color="primary" /></Box>;
  }

  if (!wallet) {
    return <Box sx={{ px: 3, py: 4 }}><Typography>{t('nemharvest.no_wallet')}</Typography></Box>;
  }

  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
      <Alert severity="info" sx={{ mb: 1 }}>{t('nemharvest.about')}</Alert>

      {failed && (
        <Alert severity="warning" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={() => void load()}>{t('nemharvest.retry')}</Button>}>
          {t('nemharvest.load_failed')}
        </Alert>
      )}

      <Section title={t('nemharvest.status_title')}>
        <Row label={t('nemharvest.account')}><Box component="span" sx={mono}>{wallet.address}</Box></Row>
        {state && (
          <>
            <Row label={t('nemharvest.balance')}>{nemXem(state.balance)}</Row>
            <Row label={t('nemharvest.vested')}>{nemXem(state.vestedBalance)}</Row>
            <Row label={t('nemharvest.min_vested')}>{nemXem(NEM_MIN_HARVEST_VESTED)}</Row>
            <Row label={t('nemharvest.harvested_blocks')}>{state.harvestedBlocks}</Row>
          </>
        )}
        <Row label={t('nemharvest.remote_status')}>{remoteChip}</Row>
        <Row label={t('nemharvest.remote_address')}>
          {remoteAddress ? <Box component="span" sx={mono}>{remoteAddress}</Box> : t('nemharvest.remote_address_unknown')}
        </Row>
        <Row label={t('nemharvest.node_status')}>
          {nodeStatus === 'UNLOCKED' ? t('nemharvest.node_running') : nodeStatus === 'LOCKED' ? t('nemharvest.node_stopped') : t('nemharvest.unknown')}
        </Row>
        {vestedShort && (
          <Typography variant="body2" sx={{ mt: 1, color: 'warning.main', fontWeight: 'bold' }}>
            {t('nemharvest.vested_short', { amount: nemXem(NEM_MIN_HARVEST_VESTED) })}
          </Typography>
        )}
        <Box sx={{ mt: 1 }}>
          <Button size="small" href={nemExplorerAccountUrl(wallet.address)} target="_blank" rel="noopener">{t('nemharvest.view_account')}</Button>
          <Button size="small" onClick={() => { void load(); void loadNode(); }}>{t('nemharvest.reload')}</Button>
        </Box>
      </Section>

      <Section title={t('nemharvest.step1_title')}>
        <Typography variant="body2" sx={{ mb: 1 }}>{t('nemharvest.step1_about')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>
          {t('nemharvest.fee')}: {nemXem(NEM_IMPORTANCE_TRANSFER_FEE)}
        </Typography>
        {remoteStatus === 'ACTIVATING' || remoteStatus === 'DEACTIVATING' ? (
          <Alert severity="info">{t('nemharvest.waiting_note')}</Alert>
        ) : remoteStatus === 'ACTIVE' ? (
          <>
            {nodeStatus === 'UNLOCKED' && <Alert severity="info" sx={{ mb: 1 }}>{t('nemharvest.deactivate_note')}</Alert>}
            <Button variant="outlined" color="primary" fullWidth disabled={!canDeactivate || busy} onClick={() => ask('deactivate')}>
              {t('nemharvest.deactivate_button')}
            </Button>
          </>
        ) : (
          <Button variant="contained" color="primary" fullWidth disabled={!canActivate || busy} onClick={() => ask('activate')}>
            {t('nemharvest.activate_button')}
          </Button>
        )}
      </Section>

      <Section title={t('nemharvest.step2_title')}>
        <Typography variant="body2" sx={{ mb: 1.5 }}>{t('nemharvest.step2_about')}</Typography>

        <ToggleButtonGroup exclusive fullWidth size="small" color="primary" value={nodeMode} onChange={(_, v: NodeMode | null) => { if (v) setNodeMode(v); }} sx={{ mb: 1.5 }}>
          <ToggleButton value="list">{t('nemharvest.node_from_list')}</ToggleButton>
          <ToggleButton value="manual">{t('nemharvest.node_manual')}</ToggleButton>
        </ToggleButtonGroup>

        {nodeMode === 'list' ? (
          candidates.length === 0 ? (
            <Alert severity="warning">{t('nemharvest.no_nodes')}</Alert>
          ) : (
            <TextField select fullWidth size="small" label={t('nemharvest.node_select')} value={candidates.includes(nodeSelect) ? nodeSelect : ''} onChange={(e) => setNodeSelect(e.target.value)}>
              {candidates.map((c) => <MenuItem key={c} value={c} sx={mono}>{c}</MenuItem>)}
            </TextField>
          )
        ) : (
          <TextField
            fullWidth size="small" label={t('nemharvest.node_url_label')} value={nodeManual} onChange={(e) => setNodeManual(e.target.value)}
            error={nodeManual !== '' && !nodeValid} helperText={nodeManual !== '' && !nodeValid ? t('nemharvest.node_url_invalid') : t('nemharvest.node_url_hint')}
          />
        )}

        {slots && (
          <Typography variant="body2" sx={{ mt: 1.5, color: slotsFull ? 'warning.main' : 'text.secondary' }}>
            {slotsFull ? t('nemharvest.slots_full') : t('nemharvest.slots', { free: Math.max(slots.max - slots.used, 0), max: slots.max })}
          </Typography>
        )}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemharvest.node_hint')}</Typography>

        {remoteStatus !== 'ACTIVE' && <Alert severity="info" sx={{ mt: 1.5 }}>{t('nemharvest.need_active')}</Alert>}

        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          <Button variant="contained" color="primary" fullWidth disabled={!canStart || busy} onClick={() => ask('start')}>{t('nemharvest.start_button')}</Button>
          <Button variant="outlined" color="primary" fullWidth disabled={!canStop || busy} onClick={() => ask('stop')}>{t('nemharvest.stop_button')}</Button>
        </Box>
        {busy && <Typography variant="body2" sx={{ mt: 1.5, textAlign: 'center' }}>{t('nemharvest.working')}</Typography>}
      </Section>

      <MessageDialog
        open={pending !== null && !confirmed}
        title={pending ? t(`nemharvest.confirm_${pending}_title`) : ''}
        texts={confirmTexts}
        selectable
        onClose={() => setConfirmed(true)}
        onCancel={() => setPending(null)}
      />
      <PasswordDialog open={pending !== null && confirmed} mode="check" onClose={() => { setConfirmed(false); setPending(null); }} onPass={onPassed} />
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
