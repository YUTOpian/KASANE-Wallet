import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, CircularProgress, IconButton, Link as MuiLink, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTranslation } from 'react-i18next';
import { explorerBlockUrl, fetchHarvestRewards, fetchHarvestedBlocks, fetchImportanceInfo } from '../../lib/symbol/api';
import type { HarvestReward, HarvestStatus, HarvestedBlock, ImportanceInfo } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { StatGrid, StatTile } from './StatTile';

const FETCH_LIMIT = 100;
const PER_PAGE = 10;

const xym = (atomic: bigint) => `${formatAtomic(atomic, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
const when = (ms: number | null) => (ms === null ? '–' : new Date(ms).toLocaleString());
const percentText = (p: number) => `${p.toFixed(p < 0.01 ? 4 : 2).replace(/\.?0+$/, '') || '0'}%`;

interface Row { height: string; timestampMs: number | null; totalFee: bigint | null; reward: bigint | null }

/**
 * 「ハーベスト統計」: the blocks this account harvested (signed by its linked remote key, or by its own key), the fees it
 * earned, and its importance score. A block's total fee is what all of its transactions paid; the reward is this account's share.
 */
export default function HarvestBlocksPanel({ status, address, publicKey }: { status: HarvestStatus; address: string; publicKey: string }) {
  const { t } = useTranslation();
  const [blocks, setBlocks] = useState<HarvestedBlock[]>([]);
  const [rewards, setRewards] = useState<HarvestReward[]>([]);
  const [importance, setImportance] = useState<ImportanceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);

  const remote = status.remotePublicKey;
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const keys = [...new Set([remote, publicKey].filter((k): k is string => !!k).map((k) => k.toUpperCase()))];
    const [blockLists, rewardList, importanceInfo] = await Promise.allSettled([
      Promise.allSettled(keys.map((k) => fetchHarvestedBlocks(k, FETCH_LIMIT))),
      fetchHarvestRewards(address, FETCH_LIMIT),
      fetchImportanceInfo(address),
    ]);
    const merged = new Map<string, HarvestedBlock>();
    if (blockLists.status === 'fulfilled') {
      for (const r of blockLists.value) if (r.status === 'fulfilled') for (const b of r.value) merged.set(b.height, b);
    }
    setBlocks([...merged.values()].sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0)).slice(0, FETCH_LIMIT));
    setRewards(rewardList.status === 'fulfilled' ? rewardList.value : []);
    setImportance(importanceInfo.status === 'fulfilled' ? importanceInfo.value : null);
    const blocksFailed = blockLists.status === 'rejected' || (blockLists.status === 'fulfilled' && blockLists.value.length > 0 && blockLists.value.every((r) => r.status === 'rejected'));
    setFailed(blocksFailed && rewardList.status === 'rejected' && importanceInfo.status === 'rejected');
    setPage(1);
    setLoading(false);
  }, [address, publicKey, remote]);

  useEffect(() => { void load(); }, [load, reload]);

  // One row per block: the blocks it signed, plus the blocks it was paid for (the reward statement is the proof of a harvest).
  const rows = useMemo<Row[]>(() => {
    const byHeight = new Map<string, Row>();
    for (const b of blocks) byHeight.set(b.height, { height: b.height, timestampMs: b.timestampMs, totalFee: b.totalFee, reward: null });
    for (const r of rewards) {
      const row = byHeight.get(r.height);
      if (row) row.reward = r.atomic;
      else byHeight.set(r.height, { height: r.height, timestampMs: r.timestampMs, totalFee: null, reward: r.atomic });
    }
    return [...byHeight.values()].sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0));
  }, [blocks, rewards]);

  const totalReward = rewards.reduce((sum, r) => sum + r.atomic, 0n);
  const average = rewards.length > 0 ? totalReward / BigInt(rewards.length) : null;
  const last = rows[0] ?? null;
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const pageRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const limitNote = rows.length >= FETCH_LIMIT ? t('harvest.stats_limit_note', { count: FETCH_LIMIT }) : undefined;

  if (loading && rows.length === 0 && importance === null) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>;
  }
  if (failed) {
    return (
      <Box sx={{ textAlign: 'center', py: 3 }}>
        <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('harvest.history_failed')}</Typography>
        <Button variant="outlined" onClick={() => setReload((n) => n + 1)}>{t('harvest.retry')}</Button>
      </Box>
    );
  }

  return (
    <Box>
      <StatGrid>
        <StatTile label={t('harvest.stats_importance')} hint={importance !== null && importance.importance > 0n ? `${t('harvest.stats_importance_raw')}: ${importance.importance.toLocaleString()}` : undefined}>
          {importance === null ? '–' : importance.percent === null ? importance.importance.toLocaleString() : percentText(importance.percent)}
        </StatTile>
        <StatTile label={t('harvest.stats_blocks')} hint={limitNote}>{rows.length}</StatTile>
        <StatTile label={t('harvest.stats_total_reward')} hint={t('harvest.stats_reward_count', { count: rewards.length })}>{xym(totalReward)}</StatTile>
        <StatTile label={t('harvest.stats_average_reward')}>{average === null ? '–' : xym(average)}</StatTile>
        <StatTile label={t('harvest.stats_last_block')} hint={last ? `#${last.height}` : undefined}>
          <Box component="span" sx={{ fontSize: '0.95rem' }}>{last ? when(last.timestampMs) : '–'}</Box>
        </StatTile>
      </StatGrid>
      {importance !== null && importance.importance === 0n && (
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>{t('harvest.stats_importance_none')}</Typography>
      )}

      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{t('harvest.stats_blocks_title')}</Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>{t('harvest.stats_blocks_empty')}</Typography>
      ) : (
        <>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ '& th': { color: 'text.secondary', fontWeight: 'bold' }, '& td, & th': { whiteSpace: 'nowrap' } }}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('harvest.col_time')}</TableCell>
                  <TableCell>{t('harvest.col_block')}</TableCell>
                  <TableCell align="right">{t('harvest.col_block_fee')}</TableCell>
                  <TableCell align="right">{t('harvest.col_reward')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pageRows.map((r) => (
                  <TableRow key={r.height} hover>
                    <TableCell>{when(r.timestampMs)}</TableCell>
                    <TableCell>
                      <MuiLink href={explorerBlockUrl(r.height)} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace' }}>{r.height}</MuiLink>
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.totalFee === null ? '–' : xym(r.totalFee)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.reward === null ? '–' : `+${xym(r.reward)}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1.5 }}>{t('harvest.stats_blocks_note')}</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mt: 1 }}>
            <IconButton size="small" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} aria-label={t('harvest.prev_page')}><ChevronLeftIcon /></IconButton>
            <Typography variant="body2">{page} / {pageCount}</Typography>
            <IconButton size="small" disabled={page >= pageCount} onClick={() => setPage((n) => n + 1)} aria-label={t('harvest.next_page')}><ChevronRightIcon /></IconButton>
          </Box>
        </>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
        <Button variant="outlined" disabled={loading} onClick={() => setReload((n) => n + 1)}>{t('harvest.retry')}</Button>
      </Box>
    </Box>
  );
}
