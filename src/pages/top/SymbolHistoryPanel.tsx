import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, MenuItem, Tab, Tabs, TextField, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { chainExplorerAccountUrl } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';
import HarvestHistory from './HarvestHistory';
import HistoryList from './HistoryList';
import { useBlockedAddresses } from '../../hooks/useAddressBook';
import { plainAddress } from '../../lib/addressBook';
import {
  HISTORY_CATEGORIES, HISTORY_STATUSES, fetchHistoryPageWithMultisig, filterHistory, historyToCsv,
} from '../../lib/symbol/history';
import { fetchCosignedAccounts } from '../../lib/symbol/multisigApi';
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

/**
 * Symbol history, shown inside Home's 履歴 section: one row of tabs — 承認済み / 未承認 / 署名待ち (every transaction
 * type, filters, reload, CSV export) and, after them, ハーベスト (the harvest rewards).
 * (The transactions used to be a page of its own, /transaction/list; the harvest rewards a ribbon of Home.)
 */
export default function SymbolHistoryPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  // 設定「マルチシグ口座の取引を表示」: also list the transactions of the multisig accounts this wallet cosigns.
  const showMultisig = useAppStore((s) => s.showMultisigHistory);

  const [address, setAddress] = useState('');
  // The harvest list loads only when its tab is shown.
  const [tabOrHarvest, setTab] = useState<HistoryStatus | 'harvest'>('confirmed');
  // mijin has no harvesting, so it has no ハーベスト tab either.
  const isHarvest = network !== 'mijin' && tabOrHarvest === 'harvest';
  // The transaction tab whose state is used (the harvest tab keeps the last one, which is never loaded for it).
  const tab: HistoryStatus = tabOrHarvest === 'harvest' ? 'confirmed' : tabOrHarvest;
  const [tabs, setTabs] = useState<Record<HistoryStatus, TabState>>({ confirmed: emptyTab(), unconfirmed: emptyTab(), partial: emptyTab() });
  const [category, setCategory] = useState<HistoryCategory | 'all'>('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  // A newer request for the same tab (refresh, network switch) makes older answers stale.
  const generation = useRef(0);
  // The multisig accounts the wallet cosigns (looked up once per account and network, when the 署名待ち tab or the setting needs them).
  const multisigRef = useRef<string[] | null>(null);

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActive();
      generation.current += 1;
      multisigRef.current = null;
      setAddress(wallet?.address ?? '');
      setTabs({ confirmed: emptyTab(), unconfirmed: emptyTab(), partial: emptyTab() });
    })();
  }, [network, showMultisig]);

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
      // 署名待ち always covers the accounts the wallet cosigns for (as on NEM); the other tabs only when the setting is on.
      let accounts: string[] = [];
      if (status === 'partial' || showMultisig) {
        if (multisigRef.current === null) {
          try {
            multisigRef.current = (await fetchCosignedAccounts(address)).map((a) => a.info.address);
          } catch (e) {
            console.warn('Could not look up the multisig accounts', e); // the wallet's own history is still shown
            multisigRef.current = [];
          }
        }
        accounts = multisigRef.current;
      }
      const result = await fetchHistoryPageWithMultisig(address, accounts, status, page);
      if (gen !== generation.current) return;
      setTabs((prev) => ({
        ...prev,
        [status]: {
          // A later page can repeat a transaction that an earlier page already showed from another account's list.
          items: reset ? result.items : [...prev[status].items, ...result.items.filter((it) => !prev[status].items.some((old) => old.hash === it.hash))],
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
  }, [address, showMultisig]);

  // Load a tab the first time it is shown.
  useEffect(() => {
    if (!isHarvest && address && !tabs[tab].loaded && !tabs[tab].loading) void load(tab, true);
  }, [isHarvest, address, tab, tabs, load]);

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
  const filtered = useMemo(() => filterHistory(current.items, category, direction), [current.items, category, direction]);

  // アドレス帳：ブラックリストのアドレスから来た取引は隠す（設定でオフにできる。この画面でだけ一時的に表示もできる）。
  const blocked = useBlockedAddresses();
  const [revealBlocked, setRevealBlocked] = useState(false);
  const visible = useMemo(
    () => (revealBlocked || blocked.size === 0 ? filtered : filtered.filter((item) => item.isOutgoing || !blocked.has(plainAddress(item.signerAddress)))),
    [filtered, blocked, revealBlocked],
  );
  const hiddenCount = filtered.length - visible.length;

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

  const tabBar = (
    <Tabs value={isHarvest ? 'harvest' : tab} onChange={(_, v: HistoryStatus | 'harvest') => setTab(v)} variant="fullWidth">
      {HISTORY_STATUSES.map((s) => (
        <Tab key={s} value={s} label={t(`history.status_${s}`)} />
      ))}
      {network !== 'mijin' && <Tab value="harvest" label={t('history.view_harvest')} />}
    </Tabs>
  );

  if (isHarvest) {
    return (
      <Box sx={{ pb: 1 }}>
        {tabBar}
        <HarvestHistory />
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 1 }}>
      {tabBar}
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
        <Box sx={{ mt: 3, textAlign: 'center', px: 2 }}>
          <Typography sx={{ color: 'text.secondary' }}>
            {current.items.length > 0 ? t('history.no_match') : t(`history.empty_${tab}`)}
          </Typography>
          {hiddenCount > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('addressbook.history_hidden', { count: hiddenCount })}</Typography>
              <Button size="small" onClick={() => setRevealBlocked(true)}>{t('addressbook.history_show')}</Button>
            </Box>
          )}
        </Box>
      ) : (
        <Box>
          <HistoryList items={visible} onOpen={(item) => navigate(`/transaction/view?hash=${item.hash}&status=${item.status}`)} />
          {(hiddenCount > 0 || (revealBlocked && blocked.size > 0)) && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mt: 1.5, px: 1.5 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {revealBlocked ? t('addressbook.history_showing_blocked') : t('addressbook.history_hidden', { count: hiddenCount })}
              </Typography>
              <Button size="small" onClick={() => setRevealBlocked((v) => !v)}>{revealBlocked ? t('addressbook.history_hide') : t('addressbook.history_show')}</Button>
            </Box>
          )}
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
