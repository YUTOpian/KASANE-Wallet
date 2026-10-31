import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Card, Checkbox, Chip, CircularProgress, Dialog, DialogTitle, FormControlLabel, IconButton, LinearProgress,
  Link as MuiLink, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Tabs, Tooltip,
  Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import CloseIcon from '@mui/icons-material/Close';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { explorerAccountUrl, explorerMosaicUrl, explorerNamespaceUrl, fetchOwnedNamespaces } from '../../lib/symbol/api';
import type { OwnedNamespace } from '../../lib/symbol/api';
import { useAppStore } from '../../store/appStore';
import { useNoKey } from '../../hooks/useWatchOnly';
import { MetadataEditor } from '../metadata/MetadataPage';
import NamespaceAlias from './NamespaceAlias';
import NamespaceRegister from './NamespaceRegister';
import NamespaceRenew from './NamespaceRenew';
import { aliasActionFor } from '../../lib/symbol/namespaceAlias';
import { isExpiringSoon, isRenewableRoot } from '../../lib/symbol/namespaceRenew';

type SortKey = 'id' | 'name' | 'expiry';
export type NamespaceTab = 'held' | 'create_root' | 'create_child';

function compareRows(a: OwnedNamespace, b: OwnedNamespace, key: SortKey): number {
  if (key === 'id') return a.id.localeCompare(b.id);
  if (key === 'name') return a.name.localeCompare(b.name);
  // eternal namespaces sort after every dated one
  return (a.expiresAtMs ?? Number.MAX_SAFE_INTEGER) - (b.expiresAtMs ?? Number.MAX_SAFE_INTEGER);
}

const dash = <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>–</Box>;

// 「ネームスペース」: the namespaces the active wallet owns, as a table (cards on a phone).
// The tabs stay put: the two 「作成」 tabs swap only the part under them (no screen change), and
// 「メタデータ追加」 and a row's 「エイリアス」 / 「更新」 buttons open a dialog on top of this screen.
export default function NamespaceList({ initialTab = 'held' }: { initialTab?: NamespaceTab }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const network = useAppStore((s) => s.network);
  // 閲覧用プロファイル（アドレスだけ）：一覧を見るだけ。登録・メタデータ追加は出さない。
  const watchOnly = useNoKey(true); // SSS Extension のプロファイルも、取得・更新・エイリアスは署名できる
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [tab, setTab] = useState<NamespaceTab>(initialTab);
  // The metadata dialog: null = closed; `id` is the namespace to pre-select (none from the top button).
  const [metadataDialog, setMetadataDialog] = useState<{ id?: string } | null>(null);
  // The alias (link / unlink) and renew dialogs: the namespace each opens on (null = closed).
  const [aliasNamespaceId, setAliasNamespaceId] = useState<string | null>(null);
  const [renewNamespaceId, setRenewNamespaceId] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());

  const [rows, setRows] = useState<OwnedNamespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setRows(wallet ? await fetchOwnedNamespaces(wallet.address) : []);
    } catch (e) {
      console.error('Failed to load namespaces', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the namespaces belong to one network).
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
  const sortHead = (key: SortKey, label: string) => (
    <TableCell sortDirection={sort?.key === key ? sort.dir : false}>
      <TableSortLabel active={sort?.key === key} direction={sort?.key === key ? sort.dir : 'asc'} onClick={() => onSort(key)}>{label}</TableSortLabel>
    </TableCell>
  );

  const expiry = (r: OwnedNamespace) => (r.eternal || r.expiresAtMs === null
    ? t('namespace.eternal')
    : new Date(r.expiresAtMs).toLocaleDateString(i18n.language));

  const expiredMark = (r: OwnedNamespace) => (r.expired
    ? <Chip size="small" color="error" variant="outlined" label={t('namespace.expired')} />
    : dash);

  const aliasTypeText = (r: OwnedNamespace) => (r.aliasType === 'mosaic'
    ? t('namespace.alias_mosaic')
    : r.aliasType === 'address' ? t('namespace.alias_address') : t('namespace.alias_none'));

  const aliasValue = (r: OwnedNamespace) => {
    if (r.aliasType === 'none' || r.alias === '') return dash;
    const href = r.aliasType === 'mosaic' ? explorerMosaicUrl(r.alias) : explorerAccountUrl(r.alias);
    return (
      <MuiLink href={href} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>
        {r.alias}
      </MuiLink>
    );
  };

  const idLink = (r: OwnedNamespace) => (
    <MuiLink href={explorerNamespaceUrl(r.name)} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace', fontSize: 13 }}>{r.id}</MuiLink>
  );

  // エイリアスのリンク / 解除：期限切れでない行だけ。リンク済みなら解除、まだなら新規リンク。
  const aliasButton = (r: OwnedNamespace) => {
    const action = aliasActionFor(r);
    if (watchOnly || action === null) return null;
    const label = t(action === 'link' ? 'namespace.alias_link' : 'namespace.alias_unlink');
    return (
      <Tooltip title={label}>
        <IconButton size="small" color="primary" aria-label={label} onClick={() => setAliasNamespaceId(r.id)}>
          {action === 'link' ? <LinkIcon fontSize="small" /> : <LinkOffIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    );
  };

  // 更新（期間の延長）：ルートだけ。期限が近いものは色を付けて目立たせる。
  const renewButton = (r: OwnedNamespace) => {
    if (watchOnly || !isRenewableRoot(r)) return null;
    return (
      <Tooltip title={t('namespace.renew_button')}>
        <IconButton size="small" color={isExpiringSoon(r, nowMs) ? 'warning' : 'primary'} aria-label={t('namespace.renew_button')} onClick={() => setRenewNamespaceId(r.id)}>
          <AutorenewIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  };

  const nameCell = (r: OwnedNamespace) => (
    <>
      {r.name}
      {r.depth > 1 && <Chip size="small" variant="outlined" label={t('namespace.child_badge')} sx={{ ml: 1, height: 20 }} />}
    </>
  );

  // Back to the owned list (after a registration): shown again and reloaded so the new namespace can appear.
  const showHeld = () => {
    setTab('held');
    load();
  };

  const creating = (tab === 'create_root' || tab === 'create_child') && !watchOnly;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, boxSizing: 'border-box' }}>
        <Tabs
          value={watchOnly ? 'held' : tab}
          variant={compact ? 'scrollable' : 'standard'}
          allowScrollButtonsMobile
          onChange={(_, v: NamespaceTab) => setTab(v)}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="held" label={t('namespace.tab_held')} />
          {!watchOnly && <Tab value="create_root" label={t('namespace.tab_create_root')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
          {!watchOnly && <Tab value="create_child" label={t('namespace.tab_create_child')} icon={<AddCircleIcon fontSize="small" />} iconPosition="start" />}
        </Tabs>
      </Box>

      {creating ? (
        <NamespaceRegister
          key={tab}
          embedded
          fixedKind={tab === 'create_child' ? 'child' : 'root'}
          onShowList={showHeld}
          onSetMetadata={(id) => setMetadataDialog({ id })}
        />
      ) : (
        <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pb: 4, boxSizing: 'border-box' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mt: 1.5, mb: 1 }}>
            {!watchOnly && <Button size="small" startIcon={<DataObjectOutlinedIcon />} onClick={() => setMetadataDialog({})}>{t('namespace.add_metadata')}</Button>}
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

          {loading && rows.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
          ) : failed ? (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('namespace.load_failed')}</Typography>
              <Button variant="outlined" onClick={load}>{t('namespace.retry')}</Button>
            </Box>
          ) : shown.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('namespace.empty')}</Typography>
          ) : compact ? (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {loading && <LinearProgress />}
              {shown.map((r) => (
                <Card key={r.id} variant="outlined" sx={{ px: 2, py: 1.5, opacity: r.expired ? 0.65 : 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{nameCell(r)}</Typography>
                      <Box>{idLink(r)}</Box>
                    </Box>
                    <Box sx={{ display: 'flex', flexShrink: 0 }}>{aliasButton(r)}{renewButton(r)}</Box>
                  </Box>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.25, mt: 1, fontSize: 13 }}>
                    <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_expiry')}</Box><Box sx={{ textAlign: 'right' }}>{expiry(r)}</Box>
                    <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_expired')}</Box><Box sx={{ textAlign: 'right' }}>{expiredMark(r)}</Box>
                    <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_alias_type')}</Box><Box sx={{ textAlign: 'right' }}>{aliasTypeText(r)}</Box>
                    {r.aliasType !== 'none' && (
                      <>
                        <Box sx={{ color: 'text.secondary' }}>{t('namespace.table_alias')}</Box><Box sx={{ textAlign: 'right' }}>{aliasValue(r)}</Box>
                      </>
                    )}
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
                    {sortHead('id', t('namespace.table_id'))}
                    {sortHead('name', t('namespace.table_name'))}
                    {sortHead('expiry', t('namespace.table_expiry'))}
                    <TableCell>{t('namespace.table_expired')}</TableCell>
                    <TableCell>{t('namespace.table_alias_type')}</TableCell>
                    <TableCell>{t('namespace.table_alias')}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map((r) => (
                    <TableRow key={r.id} hover sx={{ opacity: r.expired ? 0.6 : 1, '&:last-child td': { borderBottom: 0 } }}>
                      <TableCell>{idLink(r)}</TableCell>
                      <TableCell sx={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{nameCell(r)}</TableCell>
                      <TableCell>{expiry(r)}</TableCell>
                      <TableCell>{expiredMark(r)}</TableCell>
                      <TableCell>{aliasTypeText(r)}</TableCell>
                      <TableCell>{aliasValue(r)}</TableCell>
                      <TableCell align="right" sx={{ py: 0, whiteSpace: 'nowrap' }}>{aliasButton(r)}{renewButton(r)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      )}

      {/* Namespace metadata is set right here, on top of this screen. */}
      <Dialog open={aliasNamespaceId !== null} onClose={() => setAliasNamespaceId(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('namespace.alias_title')}
          <IconButton aria-label={t('common.close')} onClick={() => setAliasNamespaceId(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {aliasNamespaceId !== null && (
            <NamespaceAlias embedded initialNamespaceId={aliasNamespaceId} onDone={() => { setAliasNamespaceId(null); load(); }} />
          )}
        </Box>
      </Dialog>

      <Dialog open={renewNamespaceId !== null} onClose={() => setRenewNamespaceId(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('namespace.renew_button')}
          <IconButton aria-label={t('common.close')} onClick={() => setRenewNamespaceId(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {renewNamespaceId !== null && (
            <NamespaceRenew embedded initialNamespaceId={renewNamespaceId} onDone={() => { setRenewNamespaceId(null); load(); }} />
          )}
        </Box>
      </Dialog>

      <Dialog open={metadataDialog !== null} onClose={() => setMetadataDialog(null)} fullWidth maxWidth="sm" scroll="paper" fullScreen={compact}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('namespace.add_metadata')}
          <IconButton aria-label={t('common.close')} onClick={() => setMetadataDialog(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto' }}>
          {metadataDialog !== null && (
            <MetadataEditor embedded lockedType="namespace" initialTargetId={metadataDialog.id} onClose={() => setMetadataDialog(null)} />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
