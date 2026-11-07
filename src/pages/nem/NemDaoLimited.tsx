import { useEffect, useState } from 'react';
import { Alert, Box, Button, Radio, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { canEnterLimited, fetchDaoItems, fetchMyTheme, saveMyTheme } from '../../lib/nem/dao';
import type { NemDao } from '../../lib/nem/dao';
import { THEME_PRESETS } from '../../lib/dao/daoCore';
import { SectionCard } from '../multisig/parts';
import { useConfirm } from './NemDaoItems';
import { LoadingBox } from './NemDaoUi';

// 「特別会員限定」（Symbol 版 DaoLimited の NEM 版）: この DAO の特典を持っている人（と管理者）だけが開ける見本のページ。
// テーマの色を選んで保存する。NIS1 にメタデータは無いので、自分宛ての 0 XEM の送金のメッセージに書いて残す（手数料は自分が払う）。
// ウォレット全体の見た目は変えない。
export default function NemDaoLimited({ dao, actorAddress, isAdmin, reload, version }: { dao: NemDao; actorAddress: string; isAdmin: boolean; reload: () => void; version: number }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [theme, setTheme] = useState('default');
  const { setConfirm, screen } = useConfirm('nemdao.done_limited', reload);

  useEffect(() => {
    let cancelled = false;
    setAllowed(null);
    (async () => {
      try {
        const items = await fetchDaoItems(dao);
        const ok = await canEnterLimited(items, actorAddress, isAdmin);
        const current = ok ? await fetchMyTheme(actorAddress).catch(() => null) : null;
        if (cancelled) return;
        setAllowed(ok);
        setSaved(current);
        if (current && THEME_PRESETS[current]) setTheme(current);
      } catch {
        if (!cancelled) setAllowed(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dao, actorAddress, isAdmin, version]);

  const toConfirm = () => setConfirm({
    rows: [
      { label: t('nemdao.limited_theme'), value: theme, big: true },
      { label: t('nemdao.row_fee'), value: t('nemdao.limited_fee') },
    ],
    run: async (key) => [(await saveMyTheme(key.privateKey, key.publicKey, actorAddress, theme)).hash],
  });

  if (screen) return screen;
  if (allowed === null) return <LoadingBox />;
  if (!allowed) return <Alert severity="warning">{t('nemdao.limited_locked')}</Alert>;
  return (
    <SectionCard title={t('nemdao.limited_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('nemdao.limited_lead')}</Typography>
      {Object.entries(THEME_PRESETS).map(([name, c]) => (
        <Box key={name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5 }}>
          <Radio checked={theme === name} onChange={() => setTheme(name)} />
          <Typography sx={{ minWidth: 90 }}>{name}{saved === name ? ` (${t('nemdao.limited_saved')})` : ''}</Typography>
          {[c.primary, c.secondary, c.active].map((color) => <Box key={color} sx={{ width: 36, height: 36, bgcolor: color, border: 1, borderColor: 'divider', borderRadius: 1 }} />)}
        </Box>
      ))}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1, mb: 1.5 }}>{t('nemdao.limited_note')}</Typography>
      <Button variant="contained" size="large" fullWidth disabled={theme === saved} onClick={toConfirm} sx={{ py: 1.25 }}>{t('multisig.go_confirm')}</Button>
    </SectionCard>
  );
}
