import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, explorerAccountUrl, fetchConnectedHarvestNode, fetchHarvestNodeCandidates,
  fetchHarvestStatus, quoteHarvestFees, startHarvesting, stopHarvesting,
} from '../../lib/symbol/api';
import type { HarvestNode, HarvestStatus } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { useAppStore } from '../../store/appStore';

type Action = 'start' | 'stop';
type NodeMode = 'list' | 'manual';

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Link_Already_Linked') return { kind: 'already_linked', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

const shortKey = (key: string) => `${key.slice(0, 8)}…${key.slice(-8)}`;

// 「ハーベスト」: delegated (remote) harvesting settings. Shows whether the active wallet's account
// is linked to a harvesting node and lets it start or stop harvesting.
export default function HarvestSettings() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);

  const [address, setAddress] = useState('');
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

  // costs
  const [startFee, setStartFee] = useState<bigint | null>(null);
  const [stopFee, setStopFee] = useState<bigint | null>(null);

  // action
  const [action, setAction] = useState<Action | null>(null);
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
  const nodeKey = nodeMode === 'manual' ? (manualValid ? manualKey.trim().toUpperCase() : '') : selectedKey;
  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const balanceShort = status !== null && status.xymBalance < status.minBalance;

  // --- start / stop ---------------------------------------------------------------------------
  const ask = (next: Action) => {
    setAction(next);
    setShowConfirm(true);
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
      if (action === 'start') {
        await startHarvesting({ privateKey, publicKey: wallet.publicKey, nodePublicKey: nodeKey });
        setDone({ action });
      } else {
        // Re-read the links right before signing so exactly what is on the chain gets removed.
        const latest = await fetchHarvestStatus(wallet.address);
        await stopHarvesting({ privateKey, publicKey: wallet.publicKey, status: latest });
        setDone({ action });
      }
      load();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setWorking(false);
    }
  };

  const errorTitle = sendError ? t(`harvest.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`harvest.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // --- rendering --------------------------------------------------------------------------------
  const stateChip = status === null ? null : status.linked
    ? <Chip color="success" label={t('harvest.state_on')} />
    : status.partial
      ? <Chip color="warning" label={t('harvest.state_partial')} />
      : <Chip variant="outlined" label={t('harvest.state_off')} />;

  const statusRows = status === null ? [] : [
    { label: t('harvest.balance'), value: xym(status.xymBalance) },
    { label: t('harvest.min_balance'), value: xym(status.minBalance) },
    ...(status.nodePublicKey ? [{ label: t('harvest.linked_node'), value: shortKey(status.nodePublicKey) }] : []),
    ...(status.remotePublicKey ? [{ label: t('harvest.linked_remote'), value: shortKey(status.remotePublicKey) }] : []),
  ];

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {loading ? (
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
          <>
            {/* status */}
            <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <AgricultureOutlinedIcon color="primary" />
                <Typography sx={{ fontWeight: 'bold', flexGrow: 1 }}>{t('harvest.status_title')}</Typography>
                {stateChip}
              </Box>
              {statusRows.map((r, i) => (
                <Box key={r.label}>
                  {i > 0 && <Divider />}
                  <Typography variant="body2" sx={{ py: 0.75, wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
                </Box>
              ))}
              {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('harvest.balance_short', { amount: xym(status.minBalance) })}</Alert>}
              {status.linked && <Alert severity="info" sx={{ mt: 1.5 }}>{t('harvest.activation_note')}</Alert>}
              {status.partial && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('harvest.partial_note')}</Alert>}
            </Box>

            {/* on: stop */}
            {(status.linked || status.partial) && (
              <Box sx={{ mt: 2 }}>
                <Button
                  variant="contained"
                  color="primary"
                  size="large"
                  fullWidth
                  disabled={working}
                  onClick={() => ask('stop')}
                  startIcon={<LockOutlinedIcon />}
                  sx={{ py: 1.25 }}
                >
                  {working ? t('harvest.stopping') : t('harvest.stop_button')}
                </Button>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>
                  {t('harvest.tx_fee')}: {stopFee === null ? t('harvest.cost_loading') : xym(stopFee)}
                </Typography>
                <Button href={explorerAccountUrl(address)} target="_blank" rel="noopener" fullWidth sx={{ mt: 1 }}>
                  {t('harvest.view_account')}
                </Button>
              </Box>
            )}

            {/* off: start */}
            {needsNode && (
              <Box sx={{ mt: 2 }}>
                <Alert severity="info" sx={{ mb: 2 }}>{t('harvest.about')}</Alert>

                <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('harvest.node_label')}</Typography>
                <ToggleButtonGroup
                  exclusive
                  fullWidth
                  color="primary"
                  value={nodeMode}
                  onChange={(_, v: NodeMode | null) => { if (v) setNodeMode(v); }}
                  sx={{ mb: 2 }}
                >
                  <ToggleButton value="list">{t('harvest.node_from_list')}</ToggleButton>
                  <ToggleButton value="manual">{t('harvest.node_manual')}</ToggleButton>
                </ToggleButtonGroup>

                {nodeMode === 'list' ? (
                  nodesLoading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={22} /></Box>
                  ) : options.length === 0 ? (
                    <Alert severity="warning" sx={{ mb: 2 }}>{t('harvest.no_nodes')}</Alert>
                  ) : (
                    <TextField
                      select
                      label={t('harvest.node_select')}
                      value={selectedKey}
                      onChange={(e) => setSelectedKey(e.target.value)}
                      helperText={t('harvest.node_hint')}
                      fullWidth
                      sx={{ mb: 2 }}
                    >
                      {options.map((n) => (
                        <MenuItem key={n.publicKey} value={n.publicKey}>
                          {n.publicKey === connected?.publicKey ? `${n.name} (${t('harvest.connected')})` : n.name}
                        </MenuItem>
                      ))}
                    </TextField>
                  )
                ) : (
                  <TextField
                    label={t('harvest.node_key_label')}
                    value={manualKey}
                    onChange={(e) => setManualKey(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64))}
                    error={manualKey !== '' && !manualValid}
                    helperText={manualKey !== '' && !manualValid ? t('harvest.node_key_invalid') : t('harvest.node_key_hint')}
                    fullWidth
                    slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
                    sx={{ mb: 2 }}
                  />
                )}

                <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
                  <Typography variant="body2">
                    {t('harvest.tx_fee')}: {startFee === null ? t('harvest.cost_loading') : xym(startFee)}
                  </Typography>
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('harvest.cost_hint')}</Typography>
                </Box>

                <Button
                  variant="contained"
                  color="primary"
                  size="large"
                  fullWidth
                  disabled={working || nodeKey === ''}
                  onClick={() => ask('start')}
                  startIcon={<LockOutlinedIcon />}
                  sx={{ py: 1.25, mt: 2 }}
                >
                  {working ? t('harvest.starting') : t('harvest.start_button')}
                </Button>
              </Box>
            )}
          </>
        )}
      </Box>

      <MessageDialog
        open={showConfirm}
        selectable
        title={action === 'stop' ? t('harvest.stop_confirm_title') : t('harvest.start_confirm_title')}
        texts={t(action === 'stop' ? 'harvest.stop_confirm_message' : 'harvest.start_confirm_message', { returnObjects: true }) as string[]}
        onClose={() => { setShowConfirm(false); setShowPasswordDialog(true); }}
        onCancel={() => { setShowConfirm(false); setAction(null); }}
      />
      <PasswordDialog
        open={showPasswordDialog}
        mode="check"
        onClose={() => { setShowPasswordDialog(false); }}
        onPass={(password) => { setShowPasswordDialog(false); onPassed(password); }}
        onCancel={() => setAction(null)}
      />
      <MessageDialog
        open={done !== null}
        title={done?.action === 'stop' ? t('harvest.done_stop_title') : t('harvest.done_start_title')}
        texts={t(done?.action === 'stop' ? 'harvest.done_stop_message' : 'harvest.done_start_message', { returnObjects: true }) as string[]}
        onClose={() => setDone(null)}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} variant="error" title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Box>
  );
}
