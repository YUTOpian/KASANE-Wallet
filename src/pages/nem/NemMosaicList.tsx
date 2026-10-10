import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Card, CardActionArea, Chip, CircularProgress, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemCreatedMosaics, nemExplorerMosaicUrl } from '../../lib/nem/api';
import type { NemOwnedMosaic } from '../../lib/nem/api';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from '../mosaic/mosaicFlags';

// NEM 「モザイク」: the mosaics the active wallet has created. (Held mosaics are shown on Home.)
export default function NemMosaicList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const [mosaics, setMosaics] = useState<NemOwnedMosaic[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setMosaics(wallet ? await fetchNemCreatedMosaics(wallet.address) : []);
    } catch (e) {
      console.error('Failed to load mosaics', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, network]);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box' }}>
        <Button variant="contained" color="primary" size="large" startIcon={<AddIcon />} onClick={() => navigate('/mosaic/create')} sx={{ py: 1.25, px: 4, width: { xs: '100%', md: 'auto' } }}>
          {t('nemmosaic.create_button')}
        </Button>
        <Typography sx={{ mt: 3, mb: 0.5, fontWeight: 'bold' }}>{t('nemmosaic.my_mosaics')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>{t('nemmosaic.list_hint')}</Typography>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : failed ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemmosaic.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('nemmosaic.retry')}</Button>
          </Box>
        ) : mosaics.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('nemmosaic.empty')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {mosaics.map((m) => (
              <Card key={m.id}>
                <CardActionArea component="a" href={nemExplorerMosaicUrl(m.id)} target="_blank" rel="noopener" sx={{ px: 2, py: 1.5 }}>
                  <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{m.id}</Typography>
                  {m.description && <Typography variant="body2" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>{m.description}</Typography>}
                  <Typography variant="body2" sx={{ mt: 0.5 }}>{t('nemmosaic.initial_supply')}: {groupDigits(m.initialSupply)}</Typography>
                  <Typography variant="body2">{t('nemmosaic.divisibility_label')}: {m.divisibility}</Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 1 }}>
                    <Chip size="small" variant={m.supplyMutable ? 'filled' : 'outlined'} label={t('nemmosaic.flag_supply_mutable')} />
                    <Chip size="small" variant={m.transferable ? 'filled' : 'outlined'} label={t('nemmosaic.flag_transferable')} />
                  </Box>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
