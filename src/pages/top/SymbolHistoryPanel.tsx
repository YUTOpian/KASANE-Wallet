import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardActionArea, Chip, CircularProgress, IconButton, MenuItem, Tab, Tabs, TextField, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { chainExplorerAccountUrl, prettyChainAddress } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';
import {
  HISTORY_CATEGORIES, HISTORY_STATUSES, fetchHistoryPage, filterHistory, historyToCsv, isExpired,
} from '../../lib/symbol/history';
import type { DirectionFilter, HistoryCategory, HistoryItem, HistoryStatus } from '../../lib/symbol/history';

interface TabState {
  items: HistoryItem[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: boolean;
}
const emptyTab = (): TabState => ({ items: [], page: 0, hasMore: false, loading: false, loaded: false, error: false });

function whenText(item: HistoryItem): string {
  const ms = item.timestampMs ?? item.deadlineMs;
  return ms === null ? '' : new Date(ms).toLocaleString();
}

/**
 * Symbol history, shown inside Home's 取引履歴 section: every transaction type, confirmed / unconfirmed /
 * partial tabs, filters, reload, CSV export. (It used to be a page of its own, /transaction/list.)
 */
export default function SymbolHistoryPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [address, setAddress] = useState('');
  const [tab, setTab] = useState<HistoryStatus>('confirmed');
  const [tabs, setTabs] = useState<Record<HistoryStatus, TabState>>({ confirmed: emptyTab(), unconfirmed: emptyTab(), partial: emptyTab() });
  const [category, setCategory] = useState<HistoryCategory | 'all'>('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  // A newer request for the same tab (refresh, network switch) makes older answers stale.
  const generation = useRef(0);

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActive();
      generation.current += 1;
      setAddress(wallet?.address ?? '');
      setTabs({ confirmed: emptyTab(), unconfirmed: emptyTab(), partial: emptyTab() });
    })();
  }, [network]);

  // Latest tab state for callbacks (a setState updater cannot hand a value back to the caller).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const load = useCallback(async (status: HistoryStatus, reset: boolean) => {
    if (!address) return;
    const gen = generation.current;
    const page = reset ? 1 : tabsRef.current[status].page + 1;
    // A reload of a tab that already shows rows keeps them on screen until the new ones arrive.
    const keepRows = reset && tabsRef.current[status].items.length > 0;
    setTabs((prev) => ({ ...prev, [status]: { ...(reset && !keepRows ? emptyTab() : prev[status]), loading: true, error: false } }));
    try {
      const result = await fetchHistoryPage(address, status, page);
      if (gen !== generation.current) return;
      setTabs((prev) => ({
        ...prev,
        [status]: {
          items: reset ? result.items : [...prev[status].items, ...result.items],
          page,
          hasMore: result.hasMore,
          loading: false,
          loaded: true,
          error: false,
        },
      }));
    } catch (e) {
      console.warn('Failed to load history', e);
      if (gen !== generation.current) return;
      setTabs((prev) => ({ ...prev, [status]: { ...prev[status], loading: false, loaded: true, error: true } }));
    }
  }, [address]);

  // Load a tab the first time it is shown.
  useEffect(() => {
    if (address && !tabs[tab].loaded && !tabs[tab].loading) void load(tab, true);
  }, [address, tab, tabs, load]);

  // The node reported something for this account: every tab is out of date. Rows stay on screen;
  // the open tab reloads at once (through the effect above), the others when they are opened.
  const liveTick = useAppStore((s) => s.liveTick);
  useEffect(() => {
    if (liveTick === 0) return;
    generation.current += 1; // answers of requests started before the event are stale
    const stale = (tabState: TabState): TabState => ({ ...tabState, loaded: false, loading: false });
    setTabs((prev) => ({ confirmed: stale(prev.confirmed), unconfirmed: stale(prev.unconfirmed), partial: stale(prev.partial) }));
  }, [liveTick]);

  const current = tabs[tab];
  const visible = useMemo(() => filterHistory(current.items, category, direction), [current.items, category, direction]);

  const exportCsv = () => {
    const labels = {
      header: [
        t('history.csv_status'), t('history.csv_date'), t('history.csv_type'), t('history.csv_direction'),
        t('history.csv_signer'), t('history.csv_recipient'), t('history.csv_mosaics'), t('history.csv_message'),
        t('history.csv_fee'), t('history.csv_height'), t('history.csv_hash'),
      ],
      status: {
        confirmed: t('history.status_confirmed'), unconfirmed: t('history.status_unconfirmed'), partial: t('history.status_partial'),
      },
      direction: { incoming: t('history.direction_incoming'), outgoing: t('history.direction_outgoing') },
      type: (key: string) => t(`history.type.${key}`),
    };
    const csv = historyToCsv(visible, labels);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExplorer = () => {
    if (address) window.open(chainExplorerAccountUrl(address), '_blank', 'noopener,noreferrer');
  };

  const summary = (item: HistoryItem): string => {
    if (item.category === 'transfer') {
      if (item.encryptedMessage && item.mosaics.length === 0) return t('transaction.message_is_encrypted');
      const first = item.mosaics[0];
      if (!first) return '';
      const extra = item.mosaics.length > 1 ? ` (+${item.mosaics.length - 1})` : '';
      return `${item.isReception ? '+' : '-'}${first.amount} ${first.symbol}${extra}`;
    }
    return '';
  };

  return (
    <Box sx={{ pb: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, pt: 0.5 }}>
        <IconButton onClick={() => load(tab, true)} aria-label={t('history.reload')} color="primary" disabled={current.loading}>
          <RefreshIcon />
        </IconButton>
        <IconButton onClick={exportCsv} aria-label={t('history.export_csv')} color="primary" disabled={visible.length === 0}>
          <FileDownloadOutlinedIcon />
        </IconButton>
        <IconButton onClick={openExplorer} aria-label={t('common.view_on_explorer')} color="primary">
          <OpenInNewIcon />
        </IconButton>
      </Box>

      <Tabs value={tab} onChange={(_, v: HistoryStatus) => setTab(v)} variant="fullWidth">
        {HISTORY_STATUSES.map((s) => (
          <Tab key={s} value={s} label={t(`history.status_${s}`)} />
        ))}
      </Tabs>

      <Box sx={{ display: 'flex', gap: 1, px: 1.5, py: 1.5 }}>
        <TextField select size="small" fullWidth label={t('history.filter_type')} value={category} onChange={(e) => setCategory(e.target.value as HistoryCategory | 'all')}>
          <MenuItem value="all">{t('history.filter_all')}</MenuItem>
          {HISTORY_CATEGORIES.map((c) => (
            <MenuItem key={c} value={c}>{t(`history.category.${c}`)}</MenuItem>
          ))}
        </TextField>
        <TextField select size="small" fullWidth label={t('history.filter_direction')} value={direction} onChange={(e) => setDirection(e.target.value as DirectionFilter)}>
          <MenuItem value="all">{t('history.filter_all')}</MenuItem>
          <MenuItem value="incoming">{t('history.direction_incoming')}</MenuItem>
          <MenuItem value="outgoing">{t('history.direction_outgoing')}</MenuItem>
        </TextField>
      </Box>

      {current.error && (
        <Alert severity="error" sx={{ mx: 1.5, mb: 1 }}>{t('history.load_failed')}</Alert>
      )}

      {current.loading && current.items.length === 0 ? (
        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}><CircularProgress color="primary" /></Box>
      ) : visible.length === 0 ? (
        <Typography sx={{ mt: 3, textAlign: 'center', color: 'text.secondary', px: 2 }}>
          {current.items.length > 0 ? t('history.no_match') : t(`history.empty_${tab}`)}
        </Typography>
      ) : (
        <Box>
          {visible.map((item) => {
            const Icon = item.category !== 'transfer' ? DescriptionOutlinedIcon : item.isReception ? ArrowDownwardIcon : ArrowUpwardIcon;
            const peer = item.category === 'transfer' ? (item.isReception ? item.signerAddress : item.recipient) : item.signerAddress;
            return (
              <Card key={`${item.status}-${item.hash}`} sx={{ mx: 1, my: 0.5 }} elevation={0}>
                <CardActionArea onClick={() => navigate(`/transaction/view?hash=${item.hash}&status=${item.status}`)} sx={{ p: 1.25 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Icon fontSize="small" color={item.category === 'transfer' && item.isReception ? 'success' : 'action'} />
                    <Typography sx={{ fontWeight: 600, flexGrow: 1 }}>{t(`history.type.${item.typeKey}`)}</Typography>
                    {item.category === 'transfer' && item.encryptedMessage && (
                      <LockOutlinedIcon fontSize="small" color="primary" titleAccess={t('transaction.message_is_encrypted')} sx={{ fontSize: 18 }} />
                    )}
                    <Typography sx={{ fontWeight: 600 }}>{summary(item)}</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: 'break-all' }}>
                    {whenText(item)}{peer ? ` · ${peer.startsWith('@') ? peer : prettyChainAddress(peer)}` : ''}
                  </Typography>
                  {isExpired(item) && (
                    <Chip size="small" color="error" label={t('history.expired')} sx={{ mt: 0.5, mr: 0.5 }} />
                  )}
                  {item.category !== 'transfer' && !item.isOutgoing && (
                    <Chip size="small" label={t('history.involved')} sx={{ mt: 0.5 }} />
                  )}
                </CardActionArea>
              </Card>
            );
          })}
          {current.hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Button variant="outlined" onClick={() => load(tab, false)} disabled={current.loading}>
                {current.loading ? <CircularProgress size={18} /> : t('history.load_more')}
              </Button>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
