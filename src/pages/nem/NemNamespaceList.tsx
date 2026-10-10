import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Card, CardActionArea, Chip, CircularProgress, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemOwnedNamespaces, nemExplorerNamespaceUrl } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { useAppStore } from '../../store/appStore';

// NEM 「ネームスペース」: the namespaces (roots and sub-namespaces) the active wallet owns.
export default function NemNamespaceList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const [namespaces, setNamespaces] = useState<NemOwnedNamespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setNamespaces(wallet ? await fetchNemOwnedNamespaces(wallet.address) : []);
    } catch (e) {
      console.error('Failed to load namespaces', e);
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
        <Button variant="contained" color="primary" size="large" startIcon={<AddIcon />} onClick={() => navigate('/namespace/register')} sx={{ py: 1.25, px: 4, width: { xs: '100%', md: 'auto' } }}>
          {t('nemns.register_button')}
        </Button>
        <Typography sx={{ mt: 3, mb: 0.5, fontWeight: 'bold' }}>{t('nemns.my_namespaces')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>{t('nemns.list_hint')}</Typography>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : failed ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemns.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('nemns.retry')}</Button>
          </Box>
        ) : namespaces.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('nemns.empty')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {namespaces.map((ns) => (
              <Card key={ns.name}>
                <CardActionArea component="a" href={nemExplorerNamespaceUrl(ns.name)} target="_blank" rel="noopener" sx={{ px: 2, py: 1.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all', flexGrow: 1 }}>{ns.name}</Typography>
                    <Chip size="small" variant="outlined" label={ns.depth === 1 ? t('nemns.root_badge') : t('nemns.child_badge')} />
                  </Box>
                  <Typography variant="body2" sx={{ mt: 0.5, color: ns.expired ? 'error.main' : 'text.secondary' }}>
                    {ns.expired ? t('nemns.expired') : t('nemns.expires', { date: new Date(ns.expiresAtMs).toLocaleDateString() })}
                  </Typography>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
