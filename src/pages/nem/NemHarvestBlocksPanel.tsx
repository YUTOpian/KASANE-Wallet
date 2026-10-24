import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTranslation } from 'react-i18next';
import { fetchNemHarvests } from '../../lib/nem/history';
import { sortNemHarvestsNewestFirst, summarizeNemHarvests } from '../../lib/nem/harvestStats';
import type { HarvestReward } from '../../lib/symbol/api';
import { StatGrid, StatTile } from '../harvest/StatTile';
import { nemXem } from './parts';

// NIS1 /account/harvests answers with the latest 25 blocks only (no way to ask for older ones), so asking
// for more than that changes nothing. PER_PAGE is the table's page size.
const FETCH_LIMIT = 100;
const NIS_PAGE_SIZE = 25;
const PER_PAGE = 10;

const when = (ms: number | null) => (ms === null ? '–' : new Date(ms).toLocaleString());

/**
 * 「ハーベスト統計」(NEM): the blocks this account harvested most recently and the fees each one paid
 * to it - the NEM counterpart of the Symbol HarvestBlocksPanel. On NEM the harvester receives the whole
 * fee of the block, so the "fee" is the reward. `harvestedBlocks` is the lifetime count NIS1 keeps on the account.
 */
export default function NemHarvestBlocksPanel({ address, harvestedBlocks }: { address: string; harvestedBlocks: number | null }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HarvestReward[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setRows(sortNemHarvestsNewestFirst(await fetchNemHarvests(address, FETCH_LIMIT)));
      setPage(1);
    } catch (e) {
      console.error('NemHarvestBlocksPanel: failed to load the harvested blocks', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void load(); }, [load, reload]);

  const summary = useMemo(() => summarizeNemHarvests(rows), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const pageRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const last = summary.last;

  if (loading && rows.length === 0) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>;
  }
  if (failed) {
    return (
      <Box sx={{ textAlign: 'center', py: 3 }}>
        <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemharvest.stats_failed')}</Typography>
        <Button variant="outlined" onClick={() => setReload((n) => n + 1)}>{t('nemharvest.stats_reload')}</Button>
      </Box>
    );
  }

  return (
    <Box>
      <StatGrid>
        <StatTile label={t('nemharvest.stats_blocks_total')}>{harvestedBlocks === null ? '–' : harvestedBlocks.toLocaleString()}</StatTile>
        <StatTile label={t('nemharvest.stats_blocks_listed')} hint={rows.length >= NIS_PAGE_SIZE ? t('nemharvest.stats_limit_note', { count: NIS_PAGE_SIZE }) : undefined}>{rows.length}</StatTile>
        <StatTile label={t('nemharvest.stats_total_fee')}>{nemXem(summary.totalFee)}</StatTile>
        <StatTile label={t('nemharvest.stats_average_fee')}>{summary.averageFee === null ? '–' : nemXem(summary.averageFee)}</StatTile>
        <StatTile label={t('nemharvest.stats_last_block')} hint={last ? `#${last.height}` : undefined}>
          <Box component="span" sx={{ fontSize: '0.95rem' }}>{last ? when(last.timestampMs) : '–'}</Box>
        </StatTile>
      </StatGrid>

      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{t('nemharvest.stats_blocks_title')}</Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>{t('nemharvest.stats_blocks_empty')}</Typography>
      ) : (
        <>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ '& th': { color: 'text.secondary', fontWeight: 'bold' }, '& td, & th': { whiteSpace: 'nowrap' } }}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('nemharvest.stats_col_time')}</TableCell>
                  <TableCell>{t('nemharvest.stats_col_block')}</TableCell>
                  <TableCell align="right">{t('nemharvest.stats_col_fee')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pageRows.map((r) => (
                  <TableRow key={r.height} hover>
                    <TableCell>{when(r.timestampMs)}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{Number(r.height).toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>+{nemXem(r.atomic)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1.5 }}>{t('nemharvest.stats_blocks_note')}</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mt: 1 }}>
            <IconButton size="small" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} aria-label={t('nemharvest.stats_prev_page')}><ChevronLeftIcon /></IconButton>
            <Typography variant="body2">{page} / {pageCount}</Typography>
            <IconButton size="small" disabled={page >= pageCount} onClick={() => setPage((n) => n + 1)} aria-label={t('nemharvest.stats_next_page')}><ChevronRightIcon /></IconButton>
          </Box>
        </>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
        <Button variant="outlined" disabled={loading} onClick={() => setReload((n) => n + 1)}>{t('nemharvest.stats_reload')}</Button>
      </Box>
    </Box>
  );
}
