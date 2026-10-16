import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, List, ListItem,
  ListItemButton, ListItemText, Radio, Switch, TextField, Typography, FormControlLabel,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { checkNode, diagnoseSymbolNodes, isNodeSwitched, resolveNode, testNode } from '../lib/symbol/api';
import type { NodeDiagnosis } from '../lib/symbol/api';
import { NETWORKS } from '../lib/symbol/constants';
import { MijinReadFailure, normalizeNodeUrl, readMijinNode } from '../lib/symbol/mijin';

type TestState = NodeDiagnosis | 'loading';

/**
 * ノード管理 (Symbol): the registered nodes of the selected network - pick one, add (after a
 * connection test), delete, test one or all - and the switch that moves to another node by itself
 * when the picked one stops answering. "自動選択" (nothing picked) is always available.
 */
export default function SymbolNodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const selected = useAppStore((s) => s.customNodes[s.network]);
  const saved = useAppStore((s) => s.symbolNodeLists?.[s.network]);
  const autoSwitch = useAppStore((s) => s.autoSwitchNode);
  const setCustomNode = useAppStore((s) => s.setCustomNode);
  const addNode = useAppStore((s) => s.addSymbolNode);
  const removeNode = useAppStore((s) => s.removeSymbolNode);
  const setAutoSwitch = useAppStore((s) => s.setAutoSwitchNode);
  const mijinParams = useAppStore((s) => s.mijinParams);
  const setMijinParams = useAppStore((s) => s.setMijinParams);
  // mijin v2: the connection section (node URL -> the chain's parameters) comes first; until it is done there is no node list.
  const isMijin = network === 'mijin';
  const needsSetup = isMijin && !mijinParams;
  const [mijinUrl, setMijinUrl] = useState('');
  const [mijinExplorer, setMijinExplorer] = useState('');
  const [mijinBusy, setMijinBusy] = useState(false);
  const [mijinError, setMijinError] = useState('');
  const [mijinDone, setMijinDone] = useState(false);

  // A node picked before the list existed is shown (and kept) in the list too.
  const nodes = useMemo(() => Array.from(new Set([...(selected ? [selected] : []), ...(saved ?? [])])), [selected, saved]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<NodeDiagnosis[] | 'loading' | null>(null);
  const [connected, setConnected] = useState('');
  const [switched, setSwitched] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnected('');
    (async () => {
      try {
        const url = await resolveNode();
        if (cancelled) return;
        setConnected(url);
        setSwitched(isNodeSwitched());
      } catch {
        if (!cancelled) setConnected('');
      }
    })();
    return () => { cancelled = true; };
  }, [open, network, selected, autoSwitch]);

  useEffect(() => {
    if (!open || !isMijin) return;
    setMijinUrl(selected || saved[0] || '');
    setMijinExplorer(mijinParams?.explorer ?? '');
    setMijinError('');
    setMijinDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isMijin]);

  const connectMijin = async () => {
    const url = normalizeNodeUrl(mijinUrl);
    setMijinBusy(true);
    setMijinError('');
    setMijinDone(false);
    try {
      const params = await readMijinNode(url, mijinExplorer);
      setMijinParams(params);
      addNode('mijin', url);
      setCustomNode('mijin', url);
      setMijinUrl(url);
      setMijinDone(true);
    } catch (e) {
      setMijinError(t(`settings.mijin_err_${e instanceof MijinReadFailure ? e.code : 'unreachable'}`));
    }
    setMijinBusy(false);
  };

  useEffect(() => {
    // Test results and candidates belong to the network they were run on.
    setTests({});
    setCandidates(null);
    setError('');
  }, [network]);

  const runTest = async (url: string) => {
    setTests((prev) => ({ ...prev, [url]: 'loading' }));
    const result = await testNode(url, network);
    setTests((prev) => ({ ...prev, [url]: result }));
  };
  const runTestAll = () => { nodes.forEach((url) => void runTest(url)); };

  const onAdd = async (raw: string) => {
    const url = raw.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) { setError(t('settings.node_invalid_url')); return; }
    if (nodes.includes(url)) { setError(t('settings.snode_exists')); return; }
    setAdding(true);
    setError('');
    const ok = await checkNode(url, network);
    setAdding(false);
    if (!ok) { setError(t('settings.node_check_failed', { chain: 'Symbol', network: NETWORKS[network].label })); return; }
    addNode(network, url);
    setInput('');
    void runTest(url);
  };

  const loadCandidates = async () => {
    setCandidates('loading');
    try { setCandidates(await diagnoseSymbolNodes()); } catch { setCandidates([]); }
  };

  const statusText = (url: string) => {
    const r = tests[url];
    if (!r) return '';
    if (r === 'loading') return '…';
    return r.ok ? `✓ ${r.detail}` : `✗ ${t('settings.snode_ng')}`;
  };
  const statusColor = (url: string) => {
    const r = tests[url];
    return r && r !== 'loading' ? (r.ok ? 'success.main' : 'error.main') : 'text.secondary';
  };
  const inUse = (url: string) => connected === url;

  return (
    <Dialog open={open} onClose={() => !adding && onClose()} fullWidth maxWidth="xs">
      <DialogTitle>{t('settings.snode_title')} ({NETWORKS[network].label})</DialogTitle>
      <DialogContent sx={{ px: 1 }}>
        {isMijin && (
          <Box sx={{ px: 2, pb: 1.5 }}>
            <Typography sx={{ fontWeight: 'bold', fontSize: 14, mb: 0.5 }}>{t('settings.mijin_title')}</Typography>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
              {t(needsSetup ? 'settings.mijin_setup_required' : 'settings.mijin_desc')}
            </Typography>
            {mijinParams && (
              <Box sx={{ fontSize: 12, mb: 1, wordBreak: 'break-all', color: 'text.secondary' }}>
                <div>{t('settings.mijin_info_network')}: 0x{mijinParams.networkByte.toString(16).toUpperCase().padStart(2, '0')}</div>
                <div>{t('settings.mijin_info_hash')}: {mijinParams.generationHash}</div>
                <div>{t('settings.mijin_info_currency')}: {mijinParams.currencyMosaicId}</div>
              </Box>
            )}
            <TextField
              size="small" fullWidth label={t('settings.mijin_node_label')} placeholder="https://example.com:3001"
              value={mijinUrl} onChange={(e) => { setMijinUrl(e.target.value); setMijinError(''); setMijinDone(false); }} disabled={mijinBusy}
              slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
            />
            <TextField
              size="small" fullWidth sx={{ mt: 1 }} label={t('settings.mijin_explorer_label')} placeholder="https://"
              helperText={t('settings.mijin_explorer_hint')}
              value={mijinExplorer} onChange={(e) => { setMijinExplorer(e.target.value); setMijinDone(false); }} disabled={mijinBusy}
              slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
            />
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('settings.mijin_https_note')}</Typography>
            <Button variant="contained" sx={{ mt: 1 }} onClick={connectMijin} disabled={mijinBusy || mijinUrl.trim() === ''}>
              {mijinBusy ? <CircularProgress size={20} /> : t('settings.mijin_connect')}
            </Button>
            {mijinError && <Alert severity="error" sx={{ mt: 1 }}>{mijinError}</Alert>}
            {mijinDone && <Alert severity="success" sx={{ mt: 1 }}>{t('settings.mijin_connected')}</Alert>}
          </Box>
        )}
        {needsSetup ? null : (<>
        <Box sx={{ px: 2, pb: 1, fontSize: 'small', wordBreak: 'break-all' }}>
          <Box component="span" sx={{ color: 'text.secondary' }}>{t('settings.node_current')}: </Box>
          {connected || t('settings.node_connecting')}
          {connected && switched && <Box component="span" sx={{ color: 'warning.main' }}> ({t('settings.snode_switched_badge')})</Box>}
        </Box>
        <List dense disablePadding>
          {!isMijin && (
            <ListItemButton onClick={() => setCustomNode(network, '')} selected={selected === ''}>
              <Radio edge="start" checked={selected === ''} tabIndex={-1} disableRipple />
              <ListItemText primary={t('settings.node_auto')} secondary={t('settings.snode_auto_desc')} />
            </ListItemButton>
          )}
          {nodes.length === 0 && (
            <Typography variant="caption" sx={{ display: 'block', px: 2, py: 1, color: 'text.secondary' }}>{t('settings.snode_empty')}</Typography>
          )}
          {nodes.map((url) => (
            <ListItem
              key={url}
              disablePadding
              secondaryAction={
                <Box sx={{ display: 'flex' }}>
                  <IconButton size="small" aria-label={t('settings.snode_test')} onClick={() => runTest(url)}><NetworkCheckIcon fontSize="small" /></IconButton>
                  <IconButton size="small" aria-label={t('settings.snode_delete')} onClick={() => removeNode(network, url)}><DeleteOutlineIcon fontSize="small" /></IconButton>
                </Box>
              }
            >
              <ListItemButton onClick={() => setCustomNode(network, url)} selected={selected === url} sx={{ pr: 11 }}>
                <Radio edge="start" checked={selected === url} tabIndex={-1} disableRipple />
                <ListItemText
                  primary={url.replace(/^https?:\/\//, '')}
                  secondary={[inUse(url) ? t('settings.node_in_use') : '', statusText(url)].filter(Boolean).join(' / ') || undefined}
                  slotProps={{ primary: { sx: { wordBreak: 'break-all', fontSize: 13 } }, secondary: { sx: { color: statusColor(url), fontSize: 12 } } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        <Box sx={{ px: 2, pt: 1 }}>
          <Button size="small" variant="outlined" onClick={runTestAll} disabled={nodes.length === 0}>{t('settings.snode_test_all')}</Button>
        </Box>

        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ px: 2 }}>
          <Typography sx={{ fontWeight: 'bold', fontSize: 14, mb: 0.5 }}>{t('settings.snode_add_label')}</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder="https://example.com:3001"
              value={input}
              onChange={(e) => { setInput(e.target.value); setError(''); }}
              disabled={adding}
              slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
            />
            <Button variant="contained" onClick={() => onAdd(input)} disabled={adding || input.trim() === ''} sx={{ whiteSpace: 'nowrap' }}>
              {adding ? <CircularProgress size={20} /> : t('settings.snode_add')}
            </Button>
          </Box>
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
          {!isMijin && (<Box sx={{ mt: 1.5 }}>
            <Button size="small" variant="text" onClick={loadCandidates} disabled={candidates === 'loading'}>
              {candidates === 'loading' ? <CircularProgress size={18} /> : t('settings.snode_public')}
            </Button>
            {Array.isArray(candidates) && (
              <Box sx={{ mt: 0.5, maxHeight: 200, overflowY: 'auto' }}>
                {candidates.length === 0 && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.node_candidates_none')}</Typography>}
                {candidates.filter((d) => d.ok && !nodes.includes(d.url)).map((d) => (
                  <Box
                    key={d.url}
                    onClick={() => addNode(network, d.url)}
                    sx={{ display: 'flex', gap: 1, fontSize: 12, py: 0.5, cursor: 'pointer', color: 'success.main', wordBreak: 'break-all' }}
                  >
                    <span>＋</span>
                    <span style={{ flexGrow: 1 }}>{d.url.replace('https://', '')}</span>
                    <span>{d.detail}</span>
                  </Box>
                ))}
              </Box>
            )}
          </Box>)}
        </Box>

        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ px: 2 }}>
          <FormControlLabel
            control={<Switch checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />}
            label={t('settings.snode_auto_switch')}
          />
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('settings.snode_auto_switch_hint')}</Typography>
        </Box>
        </>)}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={adding}>{t('common.done')}</Button>
      </DialogActions>
    </Dialog>
  );
}
