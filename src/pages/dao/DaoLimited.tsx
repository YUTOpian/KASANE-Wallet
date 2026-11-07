import { useEffect, useState } from 'react';
import { Alert, Box, Radio, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planSaveTheme } from '../../lib/dao/daoActions';
import { fetchMyHoldings, fetchTheme } from '../../lib/dao/daoApi';
import { THEME_PRESETS } from '../../lib/dao/daoCore';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { SectionCard } from '../multisig/parts';
import { DaoAction, LoadingBox, useDao } from './daoUi';

// 「特別会員限定」: この DAO の特典を持っている人（と管理者）だけが開ける見本のページ。ここでは、テーマの色を選んで
// 自分のアカウントのメタデータに保存する（元アプリの見本機能。ウォレット全体の見た目は変えない）。
function DaoLimited({ onSent }: SentProps) {
  const { t } = useTranslation();
  const { dao, actor, isAdmin, mosaics } = useDao();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [theme, setTheme] = useState('default');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const holdings = await fetchMyHoldings(dao, actor.address, mosaics);
        const ok = isAdmin || holdings.some((h) => h.kind === 'reward');
        const current = ok ? await fetchTheme(actor.address).catch(() => null) : null;
        if (cancelled) return;
        setAllowed(ok);
        setSaved(current);
        if (current && THEME_PRESETS[current]) setTheme(current);
      } catch {
        if (!cancelled) setAllowed(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dao, actor.address, isAdmin, mosaics]);

  if (allowed === null) return <LoadingBox />;
  if (!allowed) return <Alert severity="warning">{t('dao.limited_locked')}</Alert>;
  return (
    <SectionCard title={t('dao.limited_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('dao.limited_lead')}</Typography>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={theme === saved}
        prepare={async () => ({
          plans: [await planSaveTheme(actor, theme)],
          rows: [{ label: t('dao.limited_theme'), value: theme, big: true }],
        })}
        onSent={() => { setSaved(theme); onSent(); }}
      >
        {Object.entries(THEME_PRESETS).map(([name, c]) => (
          <Box key={name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5 }}>
            <Radio checked={theme === name} onChange={() => setTheme(name)} />
            <Typography sx={{ minWidth: 90 }}>{name}{saved === name ? ` (${t('dao.limited_saved')})` : ''}</Typography>
            {[c.primary, c.secondary, c.active].map((color) => <Box key={color} sx={{ width: 36, height: 36, bgcolor: color, border: 1, borderColor: 'divider', borderRadius: 1 }} />)}
          </Box>
        ))}
      </DaoAction>
    </SectionCard>
  );
}

export default withFormReset<object>(DaoLimited);
