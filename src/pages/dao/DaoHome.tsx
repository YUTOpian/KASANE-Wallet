import { useEffect, useState } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { fetchMyHoldings } from '../../lib/dao/daoApi';
import type { MyHolding } from '../../lib/dao/daoApi';
import { SectionCard, ValueBox, mono } from '../multisig/parts';
import { LoadingBox, useDao } from './daoUi';

// 「ホーム」: DAO の概要と、自分が持っているこの DAO のトークン・ポイント・特典。
export default function DaoHome() {
  const { t } = useTranslation();
  const { dao, actor, isAdmin, mosaics } = useDao();
  const [holdings, setHoldings] = useState<MyHolding[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyHoldings(dao, actor.address, mosaics)
      .then((h) => { if (!cancelled) setHoldings(h); })
      .catch(() => { if (!cancelled) setHoldings([]); });
    return () => { cancelled = true; };
  }, [dao, actor.address, mosaics]);

  return (
    <>
      <SectionCard title={t('dao.home_about')}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.row_dao_address')}</Typography>
        <ValueBox>{dao.address}</ValueBox>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>{t('dao.f_dao_id')}</Typography>
        <ValueBox>{dao.id}</ValueBox>
        <Box sx={{ mt: 1.5 }}>
          <Chip size="small" color={isAdmin ? 'primary' : 'default'} label={isAdmin ? t('dao.role_admin') : t('dao.role_member')} />
        </Box>
      </SectionCard>
      <SectionCard title={t('dao.home_holdings')}>
        {holdings === null ? <LoadingBox /> : holdings.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.home_holdings_none')}</Typography>
        ) : holdings.map((h) => (
          <Box key={h.id} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1, gap: 1, borderBottom: 1, borderColor: 'divider' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography>{h.kind === 'governance' ? t('dao.governance_token') : h.name}</Typography>
              <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{h.id}</Typography>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography sx={{ fontWeight: 'bold' }}>{h.amount.toString()}</Typography>
              <Chip size="small" variant="outlined" label={t(`dao.kind_${h.kind}`)} />
            </Box>
          </Box>
        ))}
      </SectionCard>
    </>
  );
}
