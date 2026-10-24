import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Select, Switch, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import { buildReport, clearLog, filterLog, formatTime, getLogEntries, log, subscribeLog } from '../../lib/diagnostics';
import type { LogLevel } from '../../lib/diagnostics';
import { getConnectedNode, nodeRequest as symbolRequest, resolveNode, testNode } from '../../lib/symbol/api';
import { nodeRequest as nemRequest, resolveNemNode } from '../../lib/nem/api';
import { saveTextFile } from '../../lib/saveTextFile';

const LEVEL_COLOR: Record<LogLevel, string> = { debug: 'text.disabled', info: 'text.primary', warn: 'warning.main', error: 'error.main' };

/** 診断コンソール: the app's recent log (node requests, switches, errors), with what to copy when asking for help. */
export default function DiagnosticsPage() {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const language = useAppStore((s) => s.language);
  const customNode = useAppStore((s) => s.customNodes[s.network]);
  const entries = useSyncExternalStore(subscribeLog, getLogEntries);
  const [level, setLevel] = useState<LogLevel>('info');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const box = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(() => filterLog(entries, level, query), [entries, level, query]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  const header = (): Array<[string, string]> => [
    ['time', new Date().toISOString()],
    ['chain / network', `${chain} / ${network}`],
    ['node', chain === 'symbol' ? (getConnectedNode() || customNode || 'auto') : 'auto'],
    ['language', language],
    ['online', String(navigator.onLine)],
    ['userAgent', navigator.userAgent],
  ];
  const report = () => buildReport(header(), shown);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setNotice(t('settings.diag_copied'));
    } catch {
      setNotice(t('settings.diag_copy_failed'));
    }
  };
  const download = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveTextFile(report(), `kasane-diagnostics-${stamp}.txt`, 'text/plain')
  };

  // 接続を確認: finds / tests the node of the selected chain and asks it for the chain height; every step is logged.
  const checkConnection = async () => {
    setChecking(true);
    log('info', 'check', `connection check started (${chain} ${network})`);
    try {
      if (chain === 'symbol') {
        const url = await resolveNode();
        const tested = await testNode(url, network);
        log(tested.ok ? 'info' : 'error', 'check', `${url}: ${tested.ok ? `healthy, ${tested.detail}` : 'unhealthy or on another network'}`);
        const info = await symbolRequest<{ height: string }>('/chain/info');
        log('info', 'check', `chain height ${info.height}`);
      } else {
        const url = await resolveNemNode();
        log('info', 'check', `using ${url}`);
        const info = await nemRequest<{ height: number }>('/chain/height');
        log('info', 'check', `chain height ${info.height}`);
      }
      log('info', 'check', 'connection check finished: OK');
    } catch (e) {
      log('error', 'check', `connection check failed: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', px: { xs: 2, md: 3 }, pb: 3 }}>
      <Typography sx={{ m: 1, mt: 3, fontWeight: 700 }}>{t('settings.diag_title')}</Typography>
      <Typography variant="caption" sx={{ px: 1, color: 'text.secondary' }}>{t('settings.diag_hint')}</Typography>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mt: 1.5, px: 1 }}>
        <Select size="small" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} inputProps={{ 'aria-label': t('settings.diag_level') }} sx={{ minWidth: 150 }}>
          <MenuItem value="debug">{t('settings.diag_level_debug')}</MenuItem>
          <MenuItem value="info">{t('settings.diag_level_info')}</MenuItem>
          <MenuItem value="warn">{t('settings.diag_level_warn')}</MenuItem>
          <MenuItem value="error">{t('settings.diag_level_error')}</MenuItem>
        </Select>
        <TextField size="small" placeholder={t('settings.diag_search')} value={query} onChange={(e) => setQuery(e.target.value)} sx={{ flexGrow: 1, minWidth: 140 }} />
        <FormControlLabel control={<Switch size="small" checked={follow} onChange={(e) => setFollow(e.target.checked)} />} label={<Typography sx={{ fontSize: 13 }}>{t('settings.diag_follow')}</Typography>} />
      </Box>

      <Box
        ref={box}
        sx={{ mt: 1.5, mx: 1, height: '50vh', minHeight: 240, overflow: 'auto', bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 1, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
      >
        {shown.length === 0 && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('settings.diag_empty')}</Typography>}
        {shown.map((e) => (
          <Box key={e.id} sx={{ display: 'flex', gap: 1, color: LEVEL_COLOR[e.level], wordBreak: 'break-all' }}>
            <span style={{ flexShrink: 0, opacity: 0.7 }}>{formatTime(e.time)}</span>
            <span style={{ flexShrink: 0, minWidth: 54 }}>[{e.source}]</span>
            <span>{e.message}</span>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5, px: 1 }}>
        <Button variant="contained" onClick={checkConnection} disabled={checking}>{t('settings.diag_check')}</Button>
        <Button variant="outlined" onClick={copy} disabled={shown.length === 0}>{t('settings.diag_copy')}</Button>
        <Button variant="outlined" onClick={download} disabled={shown.length === 0}>{t('settings.diag_download')}</Button>
        <Button variant="text" color="error" onClick={clearLog} disabled={entries.length === 0}>{t('settings.diag_clear')}</Button>
      </Box>
      {notice && <Alert severity="info" onClose={() => setNotice('')} sx={{ mt: 1.5, mx: 1 }}>{notice}</Alert>}
      <Alert severity="warning" sx={{ mt: 1.5, mx: 1 }}>{t('settings.diag_privacy')}</Alert>
    </Box>
  );
}
