import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Card, CardActionArea, CardActions, Chip, CircularProgress, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { explorerNamespaceUrl, fetchOwnedNamespaces } from '../../lib/symbol/api';
import type { OwnedNamespace } from '../../lib/symbol/api';
import { useAppStore } from '../../store/appStore';

// 「ネームスペース」: the namespaces the active wallet has registered, with a button that opens
// the registration form.
export default function NamespaceList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [namespaces, setNamespaces] = useState<OwnedNamespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      setNamespaces(wallet ? await fetchOwnedNamespaces(wallet.address) : []);
    } catch (e) {
      console.error('Failed to load namespaces', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the network changes (the namespaces belong to one network).
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
          onClick={() => navigate('/namespace/register')}
          sx={{ py: 1.25, px: 4, width: { xs: '100%', md: 'auto' } }}
        >
          {t('namespace.register_button')}
        </Button>

        <Typography sx={{ mt: 3, mb: 0.5, fontWeight: 'bold' }}>{t('namespace.my_namespaces')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>
          {t('namespace.list_hint')}
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={26} />
          </Box>
        ) : failed ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('namespace.load_failed')}</Typography>
            <Button variant="outlined" onClick={load}>{t('namespace.retry')}</Button>
          </Box>
        ) : namespaces.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('namespace.empty')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {namespaces.map((ns) => (
              <Card key={`${ns.id}`}>
                <CardActionArea component="a" href={explorerNamespaceUrl(ns.name)} target="_blank" rel="noopener" sx={{ px: 2, py: 1.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all', flexGrow: 1 }}>{ns.name}</Typography>
                    <Chip size="small" variant="outlined" label={ns.depth === 1 ? t('namespace.root_badge') : t('namespace.child_badge')} />
                  </Box>
                  <Typography
                    variant="body2"
                    sx={{ mt: 0.5, color: ns.expired ? 'error.main' : 'text.secondary' }}
                  >
                    {ns.eternal
                      ? t('namespace.eternal')
                      : ns.expired
                        ? t('namespace.expired')
                        : t('namespace.expires', { date: new Date(ns.expiresAtMs ?? 0).toLocaleDateString() })}
                  </Typography>
                </CardActionArea>
                <CardActions sx={{ px: 1.5, pt: 0 }}>
                  <Button
                    size="small"
                    startIcon={<DataObjectOutlinedIcon />}
                    disabled={ns.expired}
                    onClick={() => navigate(`/metadata?type=namespace&id=${ns.id}`)}
                  >
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
