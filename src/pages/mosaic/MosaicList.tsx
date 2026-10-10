import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Card, CardActionArea, CardActions, Chip, CircularProgress, Tab, Tabs, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { explorerMosaicUrl, fetchBalances, fetchOwnedMosaics } from '../../lib/symbol/api';
import type { MosaicBalance, OwnedMosaic } from '../../lib/symbol/api';
import { useAppStore } from '../../store/appStore';
import { MOSAIC_FLAG_LABELS, blocksToDays, groupDigits } from './mosaicFlags';

// 「モザイク」: the mosaics the active wallet has created, with a button that opens the creation
// form. (Mosaics the wallet merely holds are on Home / in the send form.)
export default function MosaicList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [tab, setTab] = useState<'held' | 'created'>('held');
  const [mosaics, setMosaics] = useState<OwnedMosaic[]>([]);
  const [held, setHeld] = useState<MosaicBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [heldFailed, setHeldFailed] = useState(false);

  // Created mosaics and held mosaics are loaded together; each list can fail on its own.
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setHeldFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) {
        setMosaics([]);
        setHeld([]);
        return;
      }
      const [created, balances] = await Promise.allSettled([fetchOwnedMosaics(wallet.address), fetchBalances(wallet.address)]);
      if (created.status === 'fulfilled') setMosaics(created.value);
      else { console.error('Failed to load mosaics', created.reason); setFailed(true); }
      if (balances.status === 'fulfilled') setHeld(balances.value.filter((m) => m.amount > 0n));
      else { console.error('Failed to load held mosaics', balances.reason); setHeldFailed(true); }
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the mosaics belong to one network).
  useEffect(() => {
    load();
  }, [load, network]);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box' }}>
        <Button
          variant="contained"
          color="primary"
          size="large"
          startIcon={<AddIcon />}
          onClick={() => navigate('/mosaic/create')}
          sx={{ py: 1.25, px: 4, width: { xs: '100%', md: 'auto' } }}
        >
          {t('mosaic.create_button')}
        </Button>

        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth" sx={{ mt: 2, mb: 1.5 }}>
          <Tab value="held" label={t('mosaic.tab_held')} />
          <Tab value="created" label={t('mosaic.tab_created')} />
        </Tabs>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>
          {tab === 'held' ? t('mosaic.held_hint') : t('mosaic.list_hint')}
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={26} />
          </Box>
        ) : (tab === 'held' ? heldFailed : failed) ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('mosaic.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('mosaic.retry')}</Button>
          </Box>
        ) : tab === 'held' ? (
          held.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('mosaic.held_empty')}</Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
              {held.map((m) => (
                <Card key={m.id}>
                  <CardActionArea component="a" href={explorerMosaicUrl(m.id)} target="_blank" rel="noopener" sx={{ px: 2, py: 1.5 }}>
                    <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{m.symbol}</Typography>
                    {m.symbol !== m.id && (
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{m.id}</Typography>
                    )}
                    <Typography sx={{ mt: 1, fontSize: '1.15rem', fontWeight: 'bold', color: 'primary.main', wordBreak: 'break-all' }}>
                      {groupDigits(m.balance)}
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {t('mosaic.divisibility_label')}: {m.divisibility}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                      {mosaics.some((c) => c.id === m.id) && <Chip size="small" color="primary" label={t('mosaic.held_created_by_me')} />}
                      {!m.transferable && <Chip size="small" variant="outlined" label={t('mosaic.held_not_transferable')} />}
                    </Box>
                  </CardActionArea>
                </Card>
              ))}
            </Box>
          )
        ) : mosaics.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('mosaic.empty')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {mosaics.map((m) => (
              <Card key={m.id}>
                <CardActionArea component="a" href={explorerMosaicUrl(m.id)} target="_blank" rel="noopener" sx={{ px: 2, py: 1.5 }}>
                  <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{m.symbol}</Typography>
                  {m.symbol !== m.id && (
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{m.id}</Typography>
                  )}
                  <Typography sx={{ mt: 1, fontSize: '1.15rem', fontWeight: 'bold', color: 'primary.main', wordBreak: 'break-all' }}>
                    {groupDigits(m.supplyText)}
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t('mosaic.divisibility_label')}: {m.divisibility}　
                    {t('mosaic.duration_label')}: {m.duration === 0n ? t('mosaic.duration_unlimited') : t('mosaic.duration_days', { days: blocksToDays(m.duration) })}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                    {MOSAIC_FLAG_LABELS.filter((f) => (m.flags & f.mask) !== 0).map((f) => (
                      <Chip key={f.mask} size="small" variant="outlined" label={t(f.labelKey)} />
                    ))}
                  </Box>
                </CardActionArea>
                <CardActions sx={{ px: 1.5, pt: 0 }}>
                  <Button size="small" startIcon={<DataObjectOutlinedIcon />} onClick={() => navigate(`/metadata?type=mosaic&id=${m.id}`)}>
                    {t('metadata.set_button')}
                  </Button>
                </CardActions>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
