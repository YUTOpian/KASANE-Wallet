import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchDao, isDaoId } from '../../lib/dao/daoApi';
import { fetchAccountPublicKey, fetchCosignedAccounts } from '../../lib/symbol/multisigApi';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';
import { LoadingBox, useActor } from './daoUi';

const RECENT_KEY = 'kasane.dao.recent';
export interface RecentDao { id: string; name: string }

function loadRecent(network: string): RecentDao[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, RecentDao[]>;
    return Array.isArray(all[network]) ? all[network].filter((d) => isDaoId(d.id)) : [];
  } catch { return []; }
}

/** 開いた DAO を覚えておく（ネットワークごと、新しい順に 10 件）。 */
export function rememberDao(network: string, dao: RecentDao): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, RecentDao[]>;
    all[network] = [dao, ...(all[network] ?? []).filter((d) => d.id !== dao.id)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch { /* 覚えられなくても動く */ }
}

export const daoPath = (id: string, tab = 'home') => `/dao/view?id=${id}${tab === 'home' ? '' : `&tab=${tab}`}`;

// 「DAO」: 自分が管理している DAO、最近開いた DAO、DAO の ID（公開鍵）から開く、新しく作る。
export default function DaoTop() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const actor = useActor();
  const [idInput, setIdInput] = useState('');
  const [managed, setManaged] = useState<RecentDao[] | null>(null);
  const [recent, setRecent] = useState<RecentDao[]>([]);

  useEffect(() => setRecent(loadRecent(network)), [network]);

  useEffect(() => {
    if (!actor) return undefined;
    let cancelled = false;
    setManaged(null);
    (async () => {
      try {
        const accounts = (await fetchCosignedAccounts(actor.address)).slice(0, 30);
        const found = await Promise.all(accounts.map(async (a) => {
          try {
            const key = await fetchAccountPublicKey(a.info.address);
            if (!key) return null;
            const dao = await fetchDao(key);
            return { id: dao.id, name: dao.name };
          } catch { return null; }
        }));
        if (!cancelled) setManaged(found.filter((d): d is RecentDao => d !== null));
      } catch {
        if (!cancelled) setManaged([]);
      }
    })();
    return () => { cancelled = true; };
  }, [actor, network]);

  const open = (id: string) => navigate(daoPath(id.trim().toUpperCase()));
  const list = (items: RecentDao[]) => items.map((d) => (
    <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, flexWrap: 'wrap' }}>
      <Button variant="outlined" onClick={() => open(d.id)} sx={{ textTransform: 'none' }}>{d.name || t('dao.unnamed')}</Button>
      <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{d.id.slice(0, 16)}…</Typography>
    </Box>
  ));

  return (
    <Box sx={{ minHeight: '100vh', pb: 4, px: { xs: 2, md: 4 }, py: 2, textAlign: 'left' }}>
      <Typography sx={{ fontSize: '1.4rem', fontWeight: 400, mb: 0.5 }}>{t('dao.title')}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('dao.lead')}</Typography>

      <SectionCard>
        <Button variant="contained" size="large" startIcon={<AddCircleOutlineIcon />} onClick={() => navigate('/dao/create')} sx={{ py: 1.25 }}>
          {t('dao.create_button')}
        </Button>
      </SectionCard>

      <SectionCard title={t('dao.open_by_id')}>
        <FormRow label={t('dao.f_dao_id')} hint={t('dao.hint_dao_id')}>
          <Field ariaLabel={t('dao.f_dao_id')} value={idInput} onChange={(e) => setIdInput(e.target.value)} placeholder="64 hex" error={idInput !== '' && !isDaoId(idInput)} htmlInput={{ style: { fontFamily: 'monospace' } }} />
        </FormRow>
        <Box sx={{ mt: 1 }}>
          <Button variant="outlined" disabled={!isDaoId(idInput)} onClick={() => open(idInput)}>{t('dao.open_button')}</Button>
        </Box>
      </SectionCard>

      <SectionCard title={t('dao.managed')}>
        {managed === null ? <LoadingBox /> : managed.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.managed_none')}</Typography> : list(managed)}
      </SectionCard>

      {recent.length > 0 && <SectionCard title={t('dao.recent')}>{list(recent)}</SectionCard>}
      {actor === undefined && <CircularProgress size={20} />}
      {actor === null && <Alert severity="warning">{t('dao.no_wallet')}</Alert>}
    </Box>
  );
}
