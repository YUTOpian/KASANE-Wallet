import { useEffect, useState } from 'react';
import { Box, CardActionArea, CircularProgress, Divider, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchHarvestRewards } from '../../lib/symbol/api';
import { fetchNemHarvests } from '../../lib/nem/history';
import { currencySymbol } from '../../lib/chainApi';
import type { HarvestReward } from '../../lib/symbol/api';
import { useAppStore } from '../../store/appStore';
import { useNoKey } from '../../hooks/useWatchOnly';
import iconReceiveGreen from '../../assets/icon_transaction_receive_green.png';

const HARVEST_COUNT = 10;

/**
 * ハーベスト報酬の履歴。Home の「履歴」の中で、取引履歴と切り替えて表示する（Symbol / NEM）。
 * 以前は Home の独立した「ハーベスト履歴」リボンだった。
 */
export default function HarvestHistory() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const CURRENCY_SYMBOL = currencySymbol();
  const liveTick = useAppStore((s) => s.liveTick);
  // 閲覧用プロファイルには、署名が要るハーベスト設定へのリンクを出さない。
  const watchOnly = useNoKey();

  const [rewards, setRewards] = useState<HarvestReward[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        const list = !wallet ? [] : chain === 'nem' ? await fetchNemHarvests(wallet.address, HARVEST_COUNT) : await fetchHarvestRewards(wallet.address, HARVEST_COUNT);
        if (!cancelled) setRewards(list);
      } catch (e) {
        console.error('Failed to load harvest rewards', e);
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network, chain, liveTick]);

  return (
    <Box>
      {loading && rewards.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>
      ) : failed ? (
        <Box sx={{ py: 3, px: 2 }}>
          <Typography sx={{ color: 'text.secondary', textAlign: 'center' }}>{t('home.harvest_failed')}</Typography>
        </Box>
      ) : rewards.length === 0 ? (
        <Box sx={{ py: 3, px: 2 }}>
          <Typography sx={{ color: 'text.secondary', textAlign: 'center' }}>{t('home.no_harvest_title')}</Typography>
        </Box>
      ) : (
        <Box sx={{ mt: 1 }}>
          {rewards.map((r, i) => (
            <Box key={r.height}>
              {i > 0 && <Divider />}
              <Box sx={{ px: 2, py: 1.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box component="img" src={iconReceiveGreen} sx={{ width: 16, height: 16, flexShrink: 0 }} />
                  <Typography sx={{ fontWeight: 'bold', color: 'primary.main' }}>+{r.amount} {CURRENCY_SYMBOL}</Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  {r.timestampMs !== null && (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{new Date(r.timestampMs).toLocaleDateString()}</Typography>
                  )}
                </Box>
                <Typography variant="body2" noWrap sx={{ mt: 0.5, color: 'text.secondary', textAlign: 'left' }}>
                  {t('home.harvest_reward')} / {t('home.harvest_block', { height: Number(r.height).toLocaleString() })}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {!watchOnly && (
        <>
          <Divider />
          <CardActionArea onClick={() => navigate('/harvest')} sx={{ py: 1.25 }}>
            <Typography variant="body2" sx={{ color: 'primary.main', textAlign: 'center', fontWeight: 'bold' }}>{t('home.harvest_settings_link')}</Typography>
          </CardActionArea>
        </>
      )}
    </Box>
  );
}
