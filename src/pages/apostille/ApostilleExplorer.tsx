import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CircularProgress, IconButton, LinearProgress, Pagination, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { apostilleDriver } from '../../lib/apostilleChain';
import type { ApostilleExplorerRow } from '../../lib/nem/apostilleExplorer';
import { useAppStore } from '../../store/appStore';

const ROWS_PER_PAGE = 10;
const mono = { fontFamily: 'monospace', fontSize: 12.5 } as const;

// 「エクスプローラー」: 公証用のシンクアカウントに届いた公開（パブリック）のアポスティーユを、新しい順に並べる
// （公式 NEM Wallet の Explorer - Apostilles と同じ。所有者 / ファイルのハッシュ / トランザクションハッシュ / 日時）。
export default function ApostilleExplorer() {
  const { t } = useTranslation();
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const chain = useAppStore((st) => st.chain);
  const driver = apostilleDriver(chain);
  // The sink depends on the chain and on the network (its byte): a change of either reloads the list.
  const sink = driver.sink();

  const [rows, setRows] = useState<ApostilleExplorerRow[]>([]);
  const [nextId, setNextId] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  // A reload while an older request is still running must not mix the two lists.
  const generation = useRef(0);

  const load = useCallback(async (more: boolean, cursor?: number) => {
    const mine = ++generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const res = await driver.explorerPage(sink, more ? cursor : undefined);
      if (mine !== generation.current) return;
      setRows((prev) => {
        const base = more ? prev : [];
        const seen = new Set(base.map((r) => r.txHash));
        return [...base, ...res.rows.filter((r) => !seen.has(r.txHash))];
      });
      setNextId(res.nextId);
      setHasMore(res.hasMore);
      if (!more) setPage(1);
    } catch (e) {
      if (mine !== generation.current) return;
      console.warn('Failed to load the apostille explorer', e);
      setFailed(true);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [sink, driver]);

  useEffect(() => { void load(false); }, [load]);

  const ownerOf = (signer: string): string => {
    try {
      return driver.addressOfSigner(signer);
    } catch {
      return '';
    }
  };

  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const current = Math.min(page, pageCount);
  const shown = rows.slice((current - 1) * ROWS_PER_PAGE, current * ROWS_PER_PAGE);

  const ownerLink = (r: ApostilleExplorerRow) => {
    const address = ownerOf(r.signer);
    return address
      ? <a href={driver.accountUrl(address)} target="_blank" rel="noopener noreferrer">{driver.prettyAddress(address)}</a>
      : <Box component="span" sx={{ color: 'text.disabled' }}>–</Box>;
  };
  const txLink = (r: ApostilleExplorerRow) => <a href={driver.txUrl(r.txHash)} target="_blank" rel="noopener noreferrer">{r.txHash}</a>;
  const dateText = (r: ApostilleExplorerRow) => new Date(r.timestampMs).toLocaleString();

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1.5 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', flexGrow: 1 }}>{t('apostille.explorer_intro', { context: driver.context })}</Typography>
        <Tooltip title={t('apostille.explorer_reload')}>
          <span>
            <IconButton color="primary" onClick={() => { void load(false); }} disabled={loading} aria-label={t('apostille.explorer_reload')}><RefreshIcon /></IconButton>
          </span>
        </Tooltip>
      </Box>

      {failed && (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => { void load(rows.length > 0 && nextId !== undefined, nextId); }}>{t('apostille.explorer_reload')}</Button>}>
          {t('apostille.explorer_failed')}
        </Alert>
      )}

      {loading && rows.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
      ) : rows.length === 0 ? (
        !failed && <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('apostille.explorer_empty')}</Typography>
      ) : compact ? (
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {loading && <LinearProgress />}
          {shown.map((r) => (
            <Card key={r.txHash} variant="outlined" sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>{dateText(r)}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.75 }}>{t('apostille.col_owner')}</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{ownerLink(r)}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.75 }}>{t('apostille.col_file_hash')}</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all', ...mono }}>{r.payloadHex}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.75 }}>{t('apostille.col_tx_hash')}</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all', ...mono }}>{txLink(r)}</Typography>
            </Card>
          ))}
        </Box>
      ) : (
        <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          {loading && <LinearProgress />}
          <Table size="small" sx={{ '& td, & th': { py: 1.25 }, '& th': { color: 'text.secondary', fontWeight: 'bold', whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                <TableCell>{t('apostille.col_owner')}</TableCell>
                <TableCell>{t('apostille.col_file_hash')}</TableCell>
                <TableCell>{t('apostille.col_tx_hash')}</TableCell>
                <TableCell>{t('apostille.col_date')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.txHash} hover sx={{ '&:last-child td': { borderBottom: 0 } }}>
                  <TableCell sx={{ whiteSpace: 'nowrap', ...mono }}>{ownerLink(r)}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all', minWidth: 220, ...mono }}>{r.payloadHex}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all', minWidth: 220, ...mono }}>{txLink(r)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{dateText(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {rows.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 2, mt: 2 }}>
          {pageCount > 1 && <Pagination count={pageCount} page={current} onChange={(_, p) => setPage(p)} color="primary" size={compact ? 'small' : 'medium'} />}
          {hasMore && current === pageCount && (
            <Button variant="outlined" size="small" disabled={loading} onClick={() => { void load(true, nextId); }}>{t('apostille.explorer_more')}</Button>
          )}
        </Box>
      )}
    </Box>
  );
}
