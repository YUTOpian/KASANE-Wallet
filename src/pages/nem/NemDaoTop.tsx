import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchManagedNemDaos } from '../../lib/nem/dao';
import { isNemDaoId } from '../../lib/nem/daoCore';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';
import { LoadingBox, loadRecentNemDaos, nemDaoPath, useNemActor } from './NemDaoUi';
import type { RecentNemDao } from './NemDaoUi';

// NEM 「DAO」: 自分が管理している DAO、最近開いた DAO、DAO の ID（公開鍵）から開く、新しく作る。
export default function NemDaoTop() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const actor = useNemActor();
  const [idInput, setIdInput] = useState('');
  const [managed, setManaged] = useState<RecentNemDao[] | null>(null);
  const [recent, setRecent] = useState<RecentNemDao[]>([]);

  useEffect(() => setRecent(loadRecentNemDaos(network)), [network]);

  useEffect(() => {
    if (!actor) return undefined;
    let cancelled = false;
    setManaged(null);
    fetchManagedNemDaos(actor.address)
      .then((list) => { if (!cancelled) setManaged(list.map((d) => ({ id: d.id, name: d.name }))); })
      .catch(() => { if (!cancelled) setManaged([]); });
    return () => { cancelled = true; };
  }, [actor, network]);

  const open = (id: string) => navigate(nemDaoPath(id.trim().toUpperCase()));
  const list = (items: RecentNemDao[]) => items.map((d) => (
    <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, flexWrap: 'wrap' }}>
      <Button variant="outlined" onClick={() => open(d.id)} sx={{ textTransform: 'none' }}>{d.name || t('nemdao.unnamed')}</Button>
      <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{d.id.slice(0, 16)}…</Typography>
    </Box>
  ));

  return (
    <Box sx={{ minHeight: '100vh', pb: 4, px: { xs: 2, md: 4 }, py: 2, textAlign: 'left' }}>
      <Typography sx={{ fontSize: '1.4rem', fontWeight: 400, mb: 0.5 }}>{t('nemdao.title')}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('nemdao.lead')}</Typography>

      <SectionCard>
        <Button variant="contained" size="large" startIcon={<AddCircleOutlineIcon />} onClick={() => navigate('/dao/create')} sx={{ py: 1.25 }}>
          {t('nemdao.create_button')}
        </Button>
      </SectionCard>

      <SectionCard title={t('nemdao.open_by_id')}>
        <FormRow label={t('nemdao.f_dao_id')} hint={t('nemdao.hint_dao_id')}>
          <Field ariaLabel={t('nemdao.f_dao_id')} value={idInput} onChange={(e) => setIdInput(e.target.value)} placeholder="64 hex" error={idInput !== '' && !isNemDaoId(idInput)} htmlInput={{ style: { fontFamily: 'monospace' } }} />
        </FormRow>
        <Box sx={{ mt: 1 }}>
          <Button variant="outlined" disabled={!isNemDaoId(idInput)} onClick={() => open(idInput)}>{t('nemdao.open_button')}</Button>
        </Box>
      </SectionCard>

      <SectionCard title={t('nemdao.managed')}>
        {managed === null ? <LoadingBox /> : managed.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.managed_none')}</Typography> : list(managed)}
      </SectionCard>

      {recent.length > 0 && <SectionCard title={t('nemdao.recent')}>{list(recent)}</SectionCard>}
      {actor === undefined && <CircularProgress size={20} />}
      {actor === null && <Alert severity="warning">{t('nemdao.no_wallet')}</Alert>}
    </Box>
  );
}
