import { useLiveRefresh } from '../../hooks/useLiveRefresh';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Chip, CircularProgress, Dialog, DialogTitle, IconButton, LinearProgress, Link as MuiLink, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TableSortLabel, Tabs, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import CheckIcon from '@mui/icons-material/Check';
import EditIcon from '@mui/icons-material/Edit';
import CloseIcon from '@mui/icons-material/Close';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemBalances, fetchNemCreatedMosaics, nemExplorerMosaicUrl } from '../../lib/nem/api';
import { NEM_CURRENCY_SYMBOL, NEM_NATIVE_ID } from '../../lib/nem/constants';
import { useAppStore } from '../../store/appStore';
import { useNoKey } from '../../hooks/useWatchOnly';
import { groupDigits } from '../mosaic/mosaicFlags';
import NemMosaicCreate from './NemMosaicCreate';
import NemMosaicEdit from './NemMosaicEdit';
import NemMosaicSupply from './NemMosaicSupply';

type SortKey = 'id' | 'supply' | 'balance';
type MosaicTab = 'held' | 'create';

// One line of the list: a mosaic the account holds (XEM included) and / or created.
interface NemRow {
  id: string; // "namespace:name"
  description: string;
  divisibility: number;
  supply: string | null; // whole units (null = its definition could not be read)
  balance: string;
  amount: bigint;
  supplyMutable: boolean;
  transferable: boolean;
  createdByMe: boolean;
}

/** Atomic amount scaled to 6 decimals, so mosaics of different divisibility compare by their real value. */
const scaled = (atomic: bigint, divisibility: number) => atomic * 10n ** BigInt(Math.max(0, 6 - divisibility));

function compareRows(a: NemRow, b: NemRow, key: SortKey): number {
  if (key === 'id') return a.id.localeCompare(b.id);
  if (key === 'supply') {
    const [x, y] = [BigInt(a.supply ?? '0'), BigInt(b.supply ?? '0')];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const [x, y] = [scaled(a.amount, a.divisibility), scaled(b.amount, b.divisibility)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A number whose decimal part is dimmed, so the whole part stands out. */
function Amount({ text }: { text: string }) {
  const [whole, frac] = groupDigits(text).split('.');
  return (
    <span style={{ wordBreak: 'break-all' }}>
      {whole}
      {frac !== undefined && <span style={{ opacity: 0.45 }}>.{frac}</span>}
    </span>
  );
}

function FlagMark({ on, label }: { on: boolean; label: string }) {
  return on
    ? <CheckIcon fontSize="small" color="success" aria-label={label} sx={{ verticalAlign: 'middle' }} />
    : <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>–</Box>;
}

// NEM 「モザイク」: every mosaic the active wallet holds (XEM included) or created, as a table (cards on a phone) — the same screen as Symbol's.
// The tabs stay put: 「作成」 swaps only the part under them (no screen change).
export default function NemMosaicList({ initialTab = 'held', initialEditId = null }: { initialTab?: MosaicTab; initialEditId?: string | null }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const network = useAppStore((s) => s.network);
  // 閲覧用プロファイル（アドレスだけ）：作成は出さない。
  const watchOnly = useNoKey();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [tab, setTab] = useState<MosaicTab>(initialTab);
  // The supply-change dialog: the mosaic it opens on (null = closed).
  const [supplyMosaicId, setSupplyMosaicId] = useState<string | null>(null);
  // The mosaic whose definition is being edited (the form replaces the list under the tabs).
  const [editId, setEditId] = useState<string | null>(initialEditId);

  const [rows, setRows] = useState<NemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async (silent?: unknown) => {
    const quiet = silent === true;
    if (!quiet) setLoading(true);
    if (!quiet) setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) { setRows([]); return; }
      const [held, created] = await Promise.all([fetchNemBalances(wallet.address), fetchNemCreatedMosaics(wallet.address)]);
      // What is held first (XEM on top), then the created mosaics that are not held (nothing of them left in this wallet).
      const byId = new Map<string, NemRow>();
      for (const b of held) {
        byId.set(b.id.toLowerCase(), {
          id: b.id, description: '', divisibility: b.divisibility, supply: b.supply !== undefined ? b.supply.toString() : null,
          balance: b.balance, amount: b.amount, supplyMutable: false, transferable: b.transferable, createdByMe: false,
        });
      }
      for (const c of created) {
        const key = c.id.toLowerCase();
        const prev = byId.get(key);
        byId.set(key, {
          id: c.id, description: c.description, divisibility: c.divisibility, supply: c.initialSupply,
          balance: prev?.balance ?? '0', amount: prev?.amount ?? 0n, supplyMutable: c.supplyMutable, transferable: c.transferable, createdByMe: true,
        });
      }
      setRows([...byId.values()]);
    } catch (e) {
      console.error('Failed to load mosaics', e);
      if (!quiet) setFailed(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // 画面を開いたまま、取引を受け取ったとき（LiveUpdates）に、静かに読み直す。
  useLiveRefresh(() => { if (!failed) void load(true); });

  // Reload when the network changes (the mosaics belong to one network).
  useEffect(() => {
    load();
  }, [load, network]);

  const shown = useMemo(() => {
    if (!sort) return [...rows].sort((a, b) => (a.id === NEM_NATIVE_ID ? -1 : b.id === NEM_NATIVE_ID ? 1 : a.id.localeCompare(b.id)));
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * compareRows(a, b, sort.key));
  }, [rows, sort]);

  const onSort = (key: SortKey) => setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sortHead = (key: SortKey, label: string, align?: 'right') => (
    <TableCell align={align} sortDirection={sort?.key === key ? sort.dir : false}>
      <TableSortLabel active={sort?.key === key} direction={sort?.key === key ? sort.dir : 'asc'} onClick={() => onSort(key)}>{label}</TableSortLabel>
    </TableCell>
  );

  const idLink = (m: NemRow) => (
    <MuiLink href={nemExplorerMosaicUrl(m.id)} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{m.id}</MuiLink>
  );

  // Back to the created list (after creating a mosaic): shown again and reloaded so the new mosaic can appear.
  const showHeld = () => {
    setTab('held');
    load();
  };

  const creating = tab === 'create' && !watchOnly;
  const editing = editId !== null && !watchOnly && !creating;
  const closeEdit = (changed: boolean) => {
    setEditId(null);
    if (changed) load();
  };
  // 供給量の変更：「供給量の変更を許可」で作ったモザイクの行だけ。
  const supplyButton = (m: NemRow) => m.createdByMe && m.supplyMutable && (
    <Tooltip title={t('mosaic.change_supply')}>
      <IconButton color="primary" size="small" onClick={() => setSupplyMosaicId(m.id)} aria-label={`${t('mosaic.change_supply')} ${m.id}`}><SwapVertIcon fontSize="small" /></IconButton>
    </Tooltip>
  );
  const editButton = (m: NemRow) => m.createdByMe && (
    <Tooltip title={t('nemmosaic.edit_button')}>
      <IconButton color="primary" size="small" onClick={() => setEditId(m.id)} aria-label={`${t('nemmosaic.edit_button')} ${m.id}`}><EditIcon fontSize="small" /></IconButton>
    </Tooltip>
  );

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, boxSizing: 'border-box' }}>
        <Tabs
          value={watchOnly ? 'held' : tab}
          variant={compact ? 'fullWidth' : 'standard'}
          onChange={(_, v: MosaicTab) => { setEditId(null); setTab(v); }}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="held" label={t('mosaic.tab_held')} />
          {!watchOnly && <Tab value="create" label={t('nemmosaic.tab_create')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
        </Tabs>
      </Box>

      {creating ? (
        <NemMosaicCreate embedded onShowList={showHeld} onEdit={(id) => { setTab('held'); setEditId(id); }} />
      ) : editing ? (
        <NemMosaicEdit embedded mosaicId={editId} onClose={closeEdit} />
      ) : (
        <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pb: 4, boxSizing: 'border-box' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mt: 1.5, mb: 1 }}>
            <Tooltip title={t('mosaic.refresh')}>
              <span>
                <IconButton color="primary" onClick={load} disabled={loading} aria-label={t('mosaic.refresh')}><RefreshIcon /></IconButton>
              </span>
            </Tooltip>
          </Box>

          {loading && rows.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
          ) : failed ? (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemmosaic.load_failed')}</Typography>
              <Button variant="outlined" onClick={load}>{t('nemmosaic.retry')}</Button>
            </Box>
          ) : shown.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('mosaic.held_empty')}</Typography>
          ) : compact ? (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {loading && <LinearProgress />}
              {shown.map((m) => (
                <Card key={m.id} variant="outlined" sx={{ px: 2, py: 1.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      {m.id === NEM_NATIVE_ID && <Typography sx={{ fontWeight: 'bold' }}>{NEM_CURRENCY_SYMBOL}</Typography>}
                      <Box>{idLink(m)}</Box>
                    </Box>
                    {!watchOnly && <Box sx={{ display: 'flex', flexShrink: 0 }}>{supplyButton(m)}{editButton(m)}</Box>}
                  </Box>
                  {m.description && <Typography variant="body2" sx={{ color: 'text.secondary', wordBreak: 'break-all', mt: 0.5 }}>{m.description}</Typography>}
                  <Typography sx={{ mt: 1, fontSize: '1.2rem', fontWeight: 'bold', color: 'primary.main' }}><Amount text={m.balance} /></Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', overflowWrap: 'anywhere', columnGap: 2, rowGap: 0.25, mt: 1, fontSize: 13 }}>
                    <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_supply')}</Box><Box sx={{ textAlign: 'right' }}>{m.supply !== null ? <Amount text={m.supply} /> : '–'}</Box>
                    <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_divisibility')}</Box><Box sx={{ textAlign: 'right' }}>{m.divisibility}</Box>
                  </Box>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                    {m.createdByMe && <Chip size="small" color="primary" label={t('mosaic.held_created_by_me')} />}
                    {m.supplyMutable && <Chip size="small" variant="outlined" label={t('nemmosaic.flag_supply_mutable')} />}
                    {m.transferable && <Chip size="small" variant="outlined" label={t('nemmosaic.flag_transferable')} />}
                  </Box>
                </Card>
              ))}
            </Box>
          ) : (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
              {loading && <LinearProgress />}
              <Table size="small" sx={{ '& td, & th': { py: 1.25, whiteSpace: 'nowrap' }, '& th': { color: 'text.secondary', fontWeight: 'bold' } }}>
                <TableHead>
                  <TableRow>
                    {sortHead('id', t('mosaic.table_id'))}
                    <TableCell>{t('nemmosaic.description_short')}</TableCell>
                    {sortHead('supply', t('mosaic.table_supply'), 'right')}
                    {sortHead('balance', t('mosaic.table_balance'), 'right')}
                    <TableCell align="center">{t('mosaic.table_divisibility')}</TableCell>
                    <TableCell align="center">{t('mosaic.table_supply_mutable')}</TableCell>
                    <TableCell align="center">{t('mosaic.table_transferable')}</TableCell>
                    {!watchOnly && <TableCell />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map((m) => (
                    <TableRow key={m.id} hover sx={{ '&:last-child td': { borderBottom: 0 } }}>
                      <TableCell>
                        {idLink(m)}
                        {m.createdByMe && <Chip size="small" color="primary" variant="outlined" label={t('mosaic.created_badge')} sx={{ ml: 1, height: 20 }} />}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.description || undefined}>
                        {m.description || <Box component="span" sx={{ color: 'text.disabled' }}>–</Box>}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{m.supply !== null ? <Amount text={m.supply} /> : '–'}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 'bold' }}><Amount text={m.balance} /></TableCell>
                      <TableCell align="center">{m.divisibility}</TableCell>
                      <TableCell align="center"><FlagMark on={m.supplyMutable} label={t('mosaic.table_supply_mutable')} /></TableCell>
                      <TableCell align="center"><FlagMark on={m.transferable} label={t('mosaic.table_transferable')} /></TableCell>
                      {!watchOnly && <TableCell align="right" sx={{ py: 0, whiteSpace: 'nowrap' }}>{supplyButton(m)}{editButton(m)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      )}

      {/* 供給量の変更: ポップアップ（送信すると閉じて、一覧を読み込み直す） */}
      <Dialog open={supplyMosaicId !== null} onClose={() => setSupplyMosaicId(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('mosaic.change_supply')}
          <IconButton aria-label={t('common.close')} onClick={() => setSupplyMosaicId(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {supplyMosaicId !== null && (
            <NemMosaicSupply initialMosaicId={supplyMosaicId} onDone={() => { setSupplyMosaicId(null); load(); }} />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
