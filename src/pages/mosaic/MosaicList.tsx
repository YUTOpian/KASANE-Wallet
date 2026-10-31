import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Checkbox, Chip, CircularProgress, Dialog, DialogTitle, FormControlLabel, IconButton, LinearProgress,
  Link as MuiLink, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Tabs, Tooltip,
  Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import CheckIcon from '@mui/icons-material/Check';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import LinkIcon from '@mui/icons-material/Link';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { useTranslation } from 'react-i18next';
import AliasLinkDialog from '../../components/AliasLinkDialog';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { explorerMosaicUrl, fetchMosaicRows } from '../../lib/symbol/api';
import type { MosaicRow } from '../../lib/symbol/api';
import {
  MOSAIC_FLAG_REVOKABLE, MOSAIC_FLAG_RESTRICTABLE, MOSAIC_FLAG_SUPPLY_MUTABLE, MOSAIC_FLAG_TRANSFERABLE,
} from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { useNoKey } from '../../hooks/useWatchOnly';
import { MetadataEditor } from '../metadata/MetadataPage';
import MosaicCreate from './MosaicCreate';
import MosaicSupply from './MosaicSupply';
import { isSupplyMutableMine } from '../../lib/symbol/mosaicSupply';
import { groupDigits } from './mosaicFlags';

type SortKey = 'id' | 'name' | 'supply' | 'balance';

// The four options as table columns, in the order of the official wallet's table.
const FLAG_COLUMNS: { mask: number; labelKey: string }[] = [
  { mask: MOSAIC_FLAG_TRANSFERABLE, labelKey: 'mosaic.table_transferable' },
  { mask: MOSAIC_FLAG_SUPPLY_MUTABLE, labelKey: 'mosaic.table_supply_mutable' },
  { mask: MOSAIC_FLAG_RESTRICTABLE, labelKey: 'mosaic.table_restrictable' },
  { mask: MOSAIC_FLAG_REVOKABLE, labelKey: 'mosaic.table_revokable' },
];

/** Atomic amount scaled to 6 decimals, so mosaics of different divisibility compare by their real value. */
const scaled = (atomic: bigint, divisibility: number) => atomic * 10n ** BigInt(Math.max(0, 6 - divisibility));

function compareRows(a: MosaicRow, b: MosaicRow, key: SortKey): number {
  if (key === 'id') return a.id.localeCompare(b.id);
  if (key === 'name') return (a.name ?? '\uffff').localeCompare(b.name ?? '\uffff');
  const [x, y] = key === 'supply' ? [scaled(a.supply, a.divisibility), scaled(b.supply, b.divisibility)] : [scaled(a.amount, a.divisibility), scaled(b.amount, b.divisibility)];
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

type MosaicTab = 'held' | 'create';

// 「モザイク」: every mosaic the active wallet holds (XYM included) or created, as a table (cards on a phone).
// The tabs stay put: 「作成」 swaps only the part under them (no screen change), and
// 「メタデータ追加」 and a row's 「供給量を変更」 open a dialog on top of this screen instead of going to another screen.
export default function MosaicList({ initialTab = 'held' }: { initialTab?: MosaicTab }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const network = useAppStore((s) => s.network);
  // 閲覧用プロファイル（アドレスだけ）：保有モザイクを見るだけ。作成・メタデータ追加は出さない。
  const watchOnly = useNoKey(true); // SSS Extension のプロファイルも、作成・供給量・エイリアスは署名できる
  const [tab, setTab] = useState<MosaicTab>(initialTab);
  // The metadata dialog: null = closed; `id` is the mosaic to pre-select (none from the top button).
  const [metadataDialog, setMetadataDialog] = useState<{ id?: string } | null>(null);
  // The supply-change dialog: the mosaic it opens on (null = closed).
  const [supplyMosaicId, setSupplyMosaicId] = useState<string | null>(null);
  // 「ネームスペース連携」ダイアログ：連携するモザイク（null = 閉じている）と、署名するアクティブなアカウント。
  const [aliasMosaic, setAliasMosaic] = useState<MosaicRow | null>(null);
  const [activeWallet, setActiveWallet] = useState<Wallet | null>(null);
  const compact = useMediaQuery(theme.breakpoints.down('md'));

  const [rows, setRows] = useState<MosaicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setActiveWallet(wallet ?? null);
      setRows(wallet ? await fetchMosaicRows(wallet.address) : []);
    } catch (e) {
      console.error('Failed to load mosaics', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the mosaics belong to one network).
  useEffect(() => {
    load();
  }, [load, network]);

  const shown = useMemo(() => {
    const visible = showExpired ? rows : rows.filter((r) => !r.expired);
    if (!sort) return visible;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...visible].sort((a, b) => sign * compareRows(a, b, sort.key));
  }, [rows, showExpired, sort]);

  const onSort = (key: SortKey) => setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sortHead = (key: SortKey, label: string, align?: 'right') => (
    <TableCell align={align} sortDirection={sort?.key === key ? sort.dir : false}>
      <TableSortLabel active={sort?.key === key} direction={sort?.key === key ? sort.dir : 'asc'} onClick={() => onSort(key)}>{label}</TableSortLabel>
    </TableCell>
  );

  const expiry = (r: MosaicRow) => {
    if (r.expiresAtMs === null) return <Typography component="span" sx={{ fontSize: 'inherit' }}>{t('mosaic.duration_unlimited')}</Typography>;
    const date = new Date(r.expiresAtMs).toLocaleDateString(i18n.language);
    return r.expired
      ? <Chip size="small" color="error" variant="outlined" label={`${t('mosaic.expired_label')} ${date}`} />
      : <Typography component="span" sx={{ fontSize: 'inherit' }}>{date}</Typography>;
  };

  // ネームスペース連携：自分が作成した、期限切れでないモザイクの行だけ（エイリアスは作成者が付ける）。
  const aliasButton = (r: MosaicRow) => r.createdByMe && !r.expired && !watchOnly && (
    <Tooltip title={t('mosaic.link_namespace')}>
      <IconButton size="small" color="primary" aria-label={t('mosaic.link_namespace')} onClick={() => setAliasMosaic(r)}>
        <LinkIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  // 供給量の変更：自分が作成した「供給量の変更を許可」のモザイクの行だけ。
  const supplyButton = (r: MosaicRow) => isSupplyMutableMine(r) && !watchOnly && (
    <Tooltip title={t('mosaic.change_supply')}>
      <IconButton size="small" color="primary" aria-label={t('mosaic.change_supply')} onClick={() => setSupplyMosaicId(r.id)}>
        <SwapVertIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  const idLink = (r: MosaicRow) => (
    <MuiLink href={explorerMosaicUrl(r.id)} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace', fontSize: 13 }}>{r.id}</MuiLink>
  );

  // Back to the held list (after creating a mosaic): shown again and reloaded so the new mosaic can appear.
  const showHeld = () => {
    setTab('held');
    load();
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, boxSizing: 'border-box' }}>
        <Tabs
          value={tab}
          variant={compact ? 'fullWidth' : 'standard'}
          onChange={(_, v: MosaicTab) => setTab(v)}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="held" label={t('mosaic.tab_held')} />
          {!watchOnly && <Tab value="create" label={t('mosaic.tab_create')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
        </Tabs>
      </Box>

      {tab === 'create' && !watchOnly ? (
        <MosaicCreate embedded onShowList={showHeld} onSetMetadata={(id) => setMetadataDialog({ id })} />
      ) : (
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pb: 4, boxSizing: 'border-box' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mt: 1.5, mb: 1 }}>
          {!watchOnly && <Button size="small" startIcon={<DataObjectOutlinedIcon />} onClick={() => setMetadataDialog({})}>{t('mosaic.add_metadata')}</Button>}
          <FormControlLabel
            control={<Checkbox size="small" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} />}
            label={<Typography sx={{ fontSize: 13 }}>{t('mosaic.show_expired')}</Typography>}
            sx={{ mr: 0 }}
          />
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
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('mosaic.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('mosaic.retry')}</Button>
          </Box>
        ) : shown.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('mosaic.held_empty')}</Typography>
        ) : compact ? (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {loading && <LinearProgress />}
            {shown.map((r) => (
              <Card key={r.id} variant="outlined" sx={{ px: 2, py: 1.5, opacity: r.expired ? 0.65 : 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{r.name ?? r.id}</Typography>
                    <Box>{idLink(r)}</Box>
                  </Box>
                  <Box sx={{ display: 'flex', flexShrink: 0 }}>{aliasButton(r)}{supplyButton(r)}</Box>
                </Box>
                <Typography sx={{ mt: 1, fontSize: '1.2rem', fontWeight: 'bold', color: 'primary.main' }}><Amount text={r.balance} /></Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.25, mt: 1, fontSize: 13 }}>
                  <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_supply')}</Box><Box sx={{ textAlign: 'right' }}><Amount text={r.supplyText} /></Box>
                  <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_expiry')}</Box><Box sx={{ textAlign: 'right' }}>{expiry(r)}</Box>
                  <Box sx={{ color: 'text.secondary' }}>{t('mosaic.table_divisibility')}</Box><Box sx={{ textAlign: 'right' }}>{r.divisibility}</Box>
                </Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                  {r.createdByMe && <Chip size="small" color="primary" label={t('mosaic.held_created_by_me')} />}
                  {FLAG_COLUMNS.filter((f) => (r.flags & f.mask) !== 0).map((f) => (
                    <Chip key={f.mask} size="small" variant="outlined" label={t(f.labelKey)} />
                  ))}
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
                  {sortHead('name', t('mosaic.table_name'))}
                  {sortHead('supply', t('mosaic.table_supply'), 'right')}
                  {sortHead('balance', t('mosaic.table_balance'), 'right')}
                  <TableCell>{t('mosaic.table_expiry')}</TableCell>
                  <TableCell align="center">{t('mosaic.table_divisibility')}</TableCell>
                  {FLAG_COLUMNS.map((f) => <TableCell key={f.mask} align="center">{t(f.labelKey)}</TableCell>)}
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={r.id} hover sx={{ opacity: r.expired ? 0.6 : 1, '&:last-child td': { borderBottom: 0 } }}>
                    <TableCell>{idLink(r)}</TableCell>
                    <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name ?? undefined}>
                      {r.name ?? <Box component="span" sx={{ color: 'text.disabled' }}>–</Box>}
                      {r.createdByMe && <Chip size="small" color="primary" variant="outlined" label={t('mosaic.created_badge')} sx={{ ml: 1, height: 20 }} />}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}><Amount text={r.supplyText} /></TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 'bold' }}><Amount text={r.balance} /></TableCell>
                    <TableCell>{expiry(r)}</TableCell>
                    <TableCell align="center">{r.divisibility}</TableCell>
                    {FLAG_COLUMNS.map((f) => (
                      <TableCell key={f.mask} align="center"><FlagMark on={(r.flags & f.mask) !== 0} label={t(f.labelKey)} /></TableCell>
                    ))}
                    <TableCell align="right" sx={{ py: 0, whiteSpace: 'nowrap' }}>{aliasButton(r)}{supplyButton(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
      )}

      {/* The namespace link / unlink for one mosaic is done right here too. */}
      <AliasLinkDialog
        open={aliasMosaic !== null}
        onClose={() => setAliasMosaic(null)}
        account={activeWallet}
        target={aliasMosaic ? { type: 'mosaic', mosaicId: aliasMosaic.id } : null}
        onChanged={load}
      />

      {/* Mosaic metadata is set right here, on top of this screen. */}
      {/* 供給量の変更: ポップアップ（送信すると閉じて、一覧を読み込み直す） */}
      <Dialog open={supplyMosaicId !== null} onClose={() => setSupplyMosaicId(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('mosaic.change_supply')}
          <IconButton aria-label={t('common.close')} onClick={() => setSupplyMosaicId(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {supplyMosaicId !== null && (
            <MosaicSupply embedded initialMosaicId={supplyMosaicId} onDone={() => { setSupplyMosaicId(null); load(); }} />
          )}
        </Box>
      </Dialog>

      <Dialog open={metadataDialog !== null} onClose={() => setMetadataDialog(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('mosaic.add_metadata')}
          <IconButton aria-label={t('common.close')} onClick={() => setMetadataDialog(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto' }}>
          {metadataDialog !== null && (
            <MetadataEditor embedded lockedType="mosaic" initialTargetId={metadataDialog.id} onClose={() => setMetadataDialog(null)} />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
