import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Card, CardActionArea, Chip, CircularProgress, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { POLL_TYPE_WHITELIST, isPollEnded } from '../../lib/symbol/voting';
import type { PollHeader } from '../../lib/symbol/voting';
import { fetchPollHeaders } from '../../lib/symbol/votingApi';
import { useAppStore } from '../../store/appStore';

type Filter = 'all' | 'active' | 'ended';

// Symbol 「投票」: 投票の索引に載っている投票の一覧と、アドレスから開く欄。NEM の投票（pages/nem/NemVotingList.tsx）と同じ画面。
// しくみは lib/symbol/voting.ts。文言は、Symbol 固有のものだけ symbolvoting.*、ほかは nemvoting.* を使う。
export default function SymbolVotingList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [headers, setHeaders] = useState<PollHeader[]>([]);
  const [nextPage, setNextPage] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [addressInput, setAddressInput] = useState('');
  const [addressTouched, setAddressTouched] = useState(false);

  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const autoLoadFailed = useRef(false);

  // 索引には、同じ投票のアドレスが何度も載ることがある。React の key が重なると、絞り込みを変えたときに一覧が壊れるので、
  // 新しい順に並べて、アドレスごとに最初の 1 件だけ残す。
  const append = (current: PollHeader[], more: PollHeader[]) => {
    const seen = new Set<string>();
    const out: PollHeader[] = [];
    for (const h of [...current, ...more].sort((a, b) => b.height - a.height)) {
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
      const page = await fetchPollHeaders(1);
      setHeaders(append([], page.headers));
      setNextPage(page.nextPage);
    } catch (e) {
      console.error('Failed to load polls', e);
      setHeaders([]);
      setNextPage(undefined);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    load();
  }, [load]);

  // 索引のページは、すでに載っている投票ばかりのことがあり、1 ページでは何も増えないことがある。
  // 新しいものが出るまで（最大 10 ページ）続けて読む。そうしないと、「さらに読み込む」が何もしないように見える。
  const headersRef = useRef<PollHeader[]>([]);
  headersRef.current = headers;
  const loadMore = useCallback(async () => {
    if (nextPage === undefined || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      let cursor: number | undefined = nextPage;
      let known = headersRef.current;
      for (let i = 0; i < 10 && cursor !== undefined; i += 1) {
        const page = await fetchPollHeaders(cursor);
        const merged = append(known, page.headers);
        cursor = page.nextPage;
        const added = merged.length > known.length;
        known = merged;
        setHeaders(merged);
        setNextPage(cursor);
        if (added) break;
      }
    } catch (e) {
      console.error('Failed to load more polls', e);
      autoLoadFailed.current = true;
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextPage, loadingMore]);

  const visible = useMemo(() => {
    const now = Date.now();
    return headers.filter((h) => (filter === 'all' ? true : filter === 'ended' ? isPollEnded(h, now) : !isPollEnded(h, now)));
  }, [headers, filter]);

  // 状態で絞り込むと、読み込んだページの分しか見えない。当てはまるものが出る（または索引の終わり）まで、古いページを読み続ける。
  useEffect(() => {
    if (autoLoadFailed.current || filter === 'all' || loading || loadingMore || failed || nextPage === undefined || visible.length > 0) return;
    loadMore();
  }, [filter, loading, loadingMore, failed, nextPage, visible.length, loadMore]);

  const normalized = normalizeAddress(addressInput);
  const addressValid = isValidAddress(normalized, getNetworkConfig().networkByte);
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
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>{t('symbolvoting.list_hint')}</Typography>
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

        {!loading && !failed && nextPage !== undefined && (
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
