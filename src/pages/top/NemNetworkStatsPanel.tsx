import { useCallback, useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { fetchNemNetworkStats } from '../../lib/nem/api';
import type { NemNetworkStats } from '../../lib/nem/api';
import { useAppStore } from '../../store/appStore';
import { StatGrid, StatTile } from '../harvest/StatTile';

const REFRESH_MS = 30_000;
const num = (v: string | number | null) => (v === null ? '–' : Number(v).toLocaleString());

/** NEMのホーム「ネットワーク統計」リボン: chain height, block time, peers and the answering node. Refreshes by itself. */
export default function NemNetworkStatsPanel() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [stats, setStats] = useState<NemNetworkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchNemNetworkStats();
      setStats(next);
      setFailed(next.height === null && next.peers === null && next.nodeName === null);
    } catch (e) {
      console.error('Failed to load the NEM network statistics', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, network]);

  if (stats === null && loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>;
  if (stats === null || failed) {
    return (
      <Box sx={{ textAlign: 'center', py: 3, px: 2 }}>
        <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('harvest.net_failed')}</Typography>
        <Button variant="outlined" onClick={() => void load()}>{t('harvest.retry')}</Button>
      </Box>
    );
  }

  const blockTime = stats.avgBlockSeconds === null ? '–' : `${stats.avgBlockSeconds.toFixed(1)} ${t('harvest.net_seconds')}`;
  return (
    <Box sx={{ px: 2, py: 2 }}>
      <StatGrid columns={4}>
        <StatTile label={t('harvest.net_height')}>{num(stats.height)}</StatTile>
        <StatTile label={t('harvest.nem_net_nodes')}>{num(stats.peers)}</StatTile>
        <StatTile label={t('harvest.net_block_time')}>{blockTime}</StatTile>
        <StatTile label={t('harvest.net_latest_block')}>
          <Box component="span" sx={{ fontSize: '0.95rem' }}>{stats.latestBlockTimeMs === null ? '–' : new Date(stats.latestBlockTimeMs).toLocaleString()}</Box>
        </StatTile>
      </StatGrid>

      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{t('harvest.net_node_title')}</Typography>
      <StatGrid columns={4}>
        <StatTile label={t('harvest.net_node_name')}><Box component="span" sx={{ fontSize: '0.95rem' }}>{stats.nodeName ?? '–'}</Box></StatTile>
        <StatTile label={t('harvest.net_node_version')}>{stats.nodeVersion ?? '–'}</StatTile>
        <StatTile label={t('harvest.nem_net_platform')}><Box component="span" sx={{ fontSize: '0.85rem' }}>{stats.nodePlatform ?? '–'}</Box></StatTile>
        <StatTile label={t('harvest.net_node_health')}>
          {stats.nodeHealthy === null ? '–' : stats.nodeHealthy ? t('harvest.net_health_ok') : t('harvest.net_health_ng')}
        </StatTile>
      </StatGrid>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('harvest.nem_net_note')}</Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
        <Button variant="outlined" disabled={loading} onClick={() => void load()}>{t('harvest.retry')}</Button>
      </Box>
    </Box>
  );
}
