import { nemNetworkOf } from '../../lib/nem/network';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Card, CardActionArea, Chip, CircularProgress, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isValidNemAddress, normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  OFFICIAL_POLL_ACCOUNT, POLL_INDEX_ADDRESS, POLL_TYPE_WHITELIST, fetchPollHeaders, isPollEnded,
} from '../../lib/nem/voting';
import type { PollHeader } from '../../lib/nem/voting';
import { useAppStore } from '../../store/appStore';

type Filter = 'all' | 'active' | 'ended';

// NEM 「投票」: the polls listed in the network's public poll index (the same list the official NEM
// Wallet shows), plus a field to open any poll by its address.
export default function NemVotingList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [headers, setHeaders] = useState<PollHeader[]>([]);
  const [nextId, setNextId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [addressInput, setAddressInput] = useState('');
  const [addressTouched, setAddressTouched] = useState(false);

  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const autoLoadFailed = useRef(false);

  // The index can list the same poll address more than once (and twice within one page). Duplicate
  // React keys corrupt the list when the filter changes, so keep only the first of each address.
  const append = (current: PollHeader[], more: PollHeader[]) => {
    const seen = new Set<string>();
    const out: PollHeader[] = [];
    for (const h of [...current, ...more]) {
      if (seen.has(h.address)) continue;
      seen.add(h.address);
      out.push(h);
    }
    return out;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    autoLoadFailed.current = false;
    try {
      const page = await fetchPollHeaders(POLL_INDEX_ADDRESS[nemNetworkOf(network)]);
      setHeaders(append([], page.headers));
      setNextId(page.nextId);
    } catch (e) {
      console.error('Failed to load polls', e);
      setHeaders([]);
      setNextId(undefined);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    load();
  }, [load]);

  // Pages of the index are often full of polls that are already listed (the same poll is registered
  // many times), so one page can add nothing new. Keep going - up to a few pages - until something new
  // shows up, otherwise "load more" looks like it does nothing.
  const headersRef = useRef<PollHeader[]>([]);
  headersRef.current = headers;
  const loadMore = useCallback(async () => {
    if (nextId === undefined || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      let cursor: number | undefined = nextId;
      let known = headersRef.current;
      for (let i = 0; i < 10 && cursor !== undefined; i += 1) {
        const page = await fetchPollHeaders(POLL_INDEX_ADDRESS[nemNetworkOf(network)], cursor);
        const merged = append(known, page.headers);
        cursor = page.nextId;
        const added = merged.length > known.length;
        known = merged;
        setHeaders(merged);
        setNextId(cursor);
        if (added) break;
      }
    } catch (e) {
      console.error('Failed to load more polls', e);
      autoLoadFailed.current = true;
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextId, loadingMore, network]);

  const visible = useMemo(() => {
    const now = Date.now();
    return headers.filter((h) => (filter === 'all' ? true : filter === 'ended' ? isPollEnded(h, now) : !isPollEnded(h, now)));
  }, [headers, filter]);

  // A status filter only sees the pages loaded so far; keep fetching older pages until something
  // matches (or the index is exhausted), so choosing a filter never leaves an empty dead-end list.
  useEffect(() => {
    if (autoLoadFailed.current || filter === 'all' || loading || loadingMore || failed || nextId === undefined || visible.length > 0) return;
    loadMore();
  }, [filter, loading, loadingMore, failed, nextId, visible.length, loadMore]);

  const normalized = normalizeNemAddress(addressInput);
  const addressValid = isValidNemAddress(normalized, netCfg.networkByte);
  const showAddressError = addressTouched && addressInput.trim() !== '' && !addressValid;

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box' }}>
        <Button variant="contained" color="primary" size="large" startIcon={<AddIcon />} onClick={() => navigate('/voting/create')} sx={{ py: 1.25, px: 4, width: { xs: '100%', md: 'auto' } }}>
          {t('nemvoting.create_button')}
        </Button>

        <Typography sx={{ mt: 3, mb: 0.5, fontWeight: 'bold' }}>{t('nemvoting.open_by_address')}</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', maxWidth: 640 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t('nemvoting.address_placeholder')}
            value={addressInput}
            onChange={(e) => { setAddressInput(e.target.value); setAddressTouched(true); }}
            error={showAddressError}
            helperText={showAddressError ? t('nemvoting.address_invalid') : ' '}
            slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          />
          <Button variant="outlined" disabled={!addressValid} onClick={() => navigate(`/voting/poll/${normalized}`)} sx={{ py: 0.9, flexShrink: 0 }}>
            {t('nemvoting.open')}
          </Button>
        </Box>

        <Typography sx={{ mt: 2, mb: 0.5, fontWeight: 'bold' }}>{t('nemvoting.polls_title')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>{t('nemvoting.list_hint')}</Typography>
        <Box role="group" sx={{ display: 'inline-flex', mb: 2, border: 1, borderColor: 'divider', borderRadius: 8, overflow: 'hidden' }}>
          {(['all', 'active', 'ended'] as Filter[]).map((f) => (
            <Button
              key={f}
              type="button"
              size="small"
              color="primary"
              variant={filter === f ? 'contained' : 'text'}
              disableElevation
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              sx={{ borderRadius: 0, px: 2.5, minWidth: 72, color: filter === f ? undefined : 'text.secondary' }}
            >
              {t(`nemvoting.filter_${f}`)}
            </Button>
          ))}
        </Box>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : failed ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemvoting.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('nemvoting.retry')}</Button>
          </Box>
        ) : visible.length === 0 && loadingMore ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : visible.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('nemvoting.empty')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {visible.map((h) => {
              const ended = isPollEnded(h);
              return (
                <Card key={h.address}>
                  <CardActionArea onClick={() => navigate(`/voting/poll/${h.address}`)} sx={{ px: 2, py: 1.5 }}>
                    <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-word', mb: 0.75 }}>{h.title}</Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 0.75 }}>
                      <Chip size="small" color={ended ? 'default' : 'success'} label={ended ? t('nemvoting.status_ended') : t('nemvoting.status_active')} />
                      <Chip size="small" variant="outlined" label={h.type === POLL_TYPE_WHITELIST ? t('nemvoting.type_whitelist_short') : t('nemvoting.type_poi_short')} />
                      {h.creator === OFFICIAL_POLL_ACCOUNT && <Chip size="small" color="primary" variant="outlined" label={t('nemvoting.official_badge')} />}
                    </Box>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {ended ? t('nemvoting.ended_at', { date: new Date(h.doe).toLocaleString() }) : t('nemvoting.ends_at', { date: new Date(h.doe).toLocaleString() })}
                    </Typography>
                  </CardActionArea>
                </Card>
              );
            })}
          </Box>
        )}

        {!loading && !failed && nextId !== undefined && (
          <Box sx={{ textAlign: 'center', mt: 2 }}>
            {loadMoreFailed && <Typography sx={{ color: 'error.main', mb: 1 }}>{t('nemvoting.load_failed')}</Typography>}
            <Button variant="outlined" disabled={loadingMore} onClick={() => { autoLoadFailed.current = false; loadMore(); }}>
              {loadingMore ? t('nemvoting.loading') : t('nemvoting.load_more')}
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}
