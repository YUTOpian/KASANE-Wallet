import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, Dialog, DialogTitle, FormControlLabel, IconButton, LinearProgress, Link as MuiLink, Tab,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Tabs, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemOwnedNamespaces, fetchNemPendingNamespaces, nemExplorerNamespaceUrl } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { useAppStore } from '../../store/appStore';
import { useNoKey } from '../../hooks/useWatchOnly';
import NemNamespaceRegister from './NemNamespaceRegister';
import NemNamespaceRenew from './NemNamespaceRenew';
import { renewableNemNamespaces } from '../../lib/nem/namespaceRenew';

type SortKey = 'name' | 'expiry';
export type NemNamespaceTab = 'held' | 'create_root' | 'create_child';

function compareRows(a: NemOwnedNamespace, b: NemOwnedNamespace, key: SortKey): number {
  if (key === 'name') return a.name.localeCompare(b.name);
  return a.expiresAtMs - b.expiresAtMs;
}

const dash = <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>–</Box>;

// NEM 「ネームスペース」: the namespaces (roots and sub-namespaces) the active wallet owns, as a table (cards on a phone)
// — the same screen as Symbol's. The tabs stay put: the two 「作成」 tabs swap only the part under them (no screen change).
export default function NemNamespaceList({ initialTab = 'held' }: { initialTab?: NemNamespaceTab }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const network = useAppStore((s) => s.network);
  // 閲覧用プロファイル（アドレスだけ）：一覧を見るだけ。登録は出さない。
  const watchOnly = useNoKey();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [tab, setTab] = useState<NemNamespaceTab>(initialTab);
  // The renew dialog: the root it opens on (null = closed).
  const [renewName, setRenewName] = useState<string | null>(null);

  const [rows, setRows] = useState<NemOwnedNamespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Registrations announced but not yet confirmed (in the node's unconfirmed pool).
  const [pending, setPending] = useState<string[]>([]);
  const [showExpired, setShowExpired] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setRows(wallet ? await fetchNemOwnedNamespaces(wallet.address) : []);
      // Best effort: only for telling the user "waiting for confirmation".
      setPending(wallet ? await fetchNemPendingNamespaces(wallet.address).catch(() => [] as string[]) : []);
    } catch (e) {
      console.error('Failed to load namespaces', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the namespaces belong to one network), and every time the owned-list tab is shown:
  // this component stays mounted while the 「作成」 / 「更新」 tabs are open, so without this a namespace registered there
  // would never appear when going back to the list.
  useEffect(() => {
    if (tab === 'held') load();
  }, [load, network, tab]);

  // While a registration waits for its block, look again every 20 s so it moves into the list by itself.
  useEffect(() => {
    if (tab !== 'held' || pending.length === 0) return undefined;
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [tab, pending.length, load]);

  // Names already confirmed are not shown twice.
  const waiting = useMemo(() => pending.filter((n) => !rows.some((r) => r.name === n)), [pending, rows]);

  const shown = useMemo(() => {
    const visible = showExpired ? rows : rows.filter((r) => !r.expired);
    if (!sort) return visible;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...visible].sort((a, b) => sign * compareRows(a, b, sort.key));
  }, [rows, showExpired, sort]);

  const onSort = (key: SortKey) => setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sortHead = (key: SortKey, label: string) => (
    <TableCell sortDirection={sort?.key === key ? sort.dir : false}>
      <TableSortLabel active={sort?.key === key} direction={sort?.key === key ? sort.dir : 'asc'} onClick={() => onSort(key)}>{label}</TableSortLabel>
    </TableCell>
  );

  // NIS1 only knows an approximate expiry (from the block height), so the date is shown with a "ごろ"-style hint in the header.
  const expiry = (r: NemOwnedNamespace) => new Date(r.expiresAtMs).toLocaleDateString(i18n.language);
  const expiredMark = (r: NemOwnedNamespace) => (r.expired
    ? <Chip size="small" color="error" variant="outlined" label={t('nemns.expired')} />
    : dash);

  const nameLink = (r: NemOwnedNamespace) => (
    <MuiLink href={nemExplorerNamespaceUrl(r.name)} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{r.name}</MuiLink>
  );
  const kindBadge = (r: NemOwnedNamespace) => (
    <Chip size="small" variant="outlined" label={r.depth === 1 ? t('nemns.root_badge') : t('nemns.child_badge')} sx={{ height: 20 }} />
  );

  // Back to the owned list (after a registration): shown again and reloaded so the new namespace can appear.
  const showHeld = () => {
    setTab('held');
  };

  const creating = (tab === 'create_root' || tab === 'create_child') && !watchOnly;
  // 公式の「ネームスペースの更新」: 期限が近い（または切れた）ルートの行のボタンから、ポップアップで更新する。
  const renewButton = (r: NemOwnedNamespace) => !watchOnly && renewableNemNamespaces([r]).length > 0 && (
    <Tooltip title={t('nemns.renew_title')}>
      <IconButton size="small" color="warning" aria-label={`${t('nemns.renew_title')} ${r.name}`} onClick={() => setRenewName(r.name)}>
        <AutorenewIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, boxSizing: 'border-box' }}>
        <Tabs
          value={watchOnly ? 'held' : tab}
          variant={compact ? 'scrollable' : 'standard'}
          allowScrollButtonsMobile
          onChange={(_, v: NemNamespaceTab) => setTab(v)}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="held" label={t('namespace.tab_held')} />
          {!watchOnly && <Tab value="create_root" label={t('namespace.tab_create_root')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
          {!watchOnly && <Tab value="create_child" label={t('namespace.tab_create_child')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
        </Tabs>
      </Box>

      {creating ? (
        <NemNamespaceRegister key={tab} embedded fixedKind={tab === 'create_child' ? 'child' : 'root'} onShowList={showHeld} />
      ) : (
        <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pb: 4, boxSizing: 'border-box' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mt: 1.5, mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, minWidth: 220 }}>{t('nemns.list_hint')}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 2 }}>
              <FormControlLabel
                control={<Checkbox size="small" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} />}
                label={<Typography sx={{ fontSize: 13 }}>{t('namespace.show_expired')}</Typography>}
                sx={{ mr: 0 }}
              />
              <Tooltip title={t('namespace.refresh')}>
                <span>
                  <IconButton color="primary" onClick={load} disabled={loading} aria-label={t('namespace.refresh')}><RefreshIcon /></IconButton>
                </span>
              </Tooltip>
            </Box>
          </Box>

          {waiting.length > 0 && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              {t('nemns.pending_notice', { names: waiting.join(', ') })}
            </Alert>
          )}

          {loading && rows.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
          ) : failed ? (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemns.load_failed')}</Typography>
              <Button variant="outlined" onClick={load}>{t('nemns.retry')}</Button>
            </Box>
          ) : shown.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('nemns.empty')}</Typography>
          ) : compact ? (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {loading && <LinearProgress />}
              {shown.map((r) => (
                <Card key={r.name} variant="outlined" sx={{ px: 2, py: 1.5, opacity: r.expired ? 0.65 : 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography component="div" sx={{ fontWeight: 'bold', minWidth: 0 }}>{nameLink(r)}</Typography>
                    {kindBadge(r)}
                  </Box>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.25, mt: 1, fontSize: 13 }}>
                    <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_expiry')}</Box><Box sx={{ textAlign: 'right' }}>{expiry(r)}</Box>
                    <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_expired')}</Box><Box sx={{ textAlign: 'right' }}>{expiredMark(r)}</Box>
                  </Box>
                  {renewButton(r) && <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>{renewButton(r)}</Box>}
                </Card>
              ))}
            </Box>
          ) : (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
              {loading && <LinearProgress />}
              <Table size="small" sx={{ '& td, & th': { py: 1.25, whiteSpace: 'nowrap' }, '& th': { color: 'text.secondary', fontWeight: 'bold' } }}>
                <TableHead>
                  <TableRow>
                    {sortHead('name', t('namespace.table_name'))}
                    <TableCell>{t('nemns.type_label')}</TableCell>
                    {sortHead('expiry', t('namespace.table_expiry'))}
                    <TableCell>{t('namespace.table_expired')}</TableCell>
                    {!watchOnly && <TableCell />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map((r) => (
                    <TableRow key={r.name} hover sx={{ opacity: r.expired ? 0.6 : 1, '&:last-child td': { borderBottom: 0 } }}>
                      <TableCell sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{nameLink(r)}</TableCell>
                      <TableCell>{kindBadge(r)}</TableCell>
                      <TableCell>{expiry(r)}</TableCell>
                      <TableCell>{expiredMark(r)}</TableCell>
                      {!watchOnly && <TableCell align="right" sx={{ py: 0 }}>{renewButton(r)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      )}

      {/* ネームスペースの更新: ポップアップ（送信すると閉じて、一覧を読み込み直す） */}
      <Dialog open={renewName !== null} onClose={() => setRenewName(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('nemns.renew_title')}
          <IconButton aria-label={t('common.close')} onClick={() => setRenewName(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {renewName !== null && (
            <NemNamespaceRenew initialName={renewName} onDone={() => { setRenewName(null); load(); }} />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
