import { useState } from 'react';
import { Box, Tab, Tabs, useMediaQuery, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ApostilleAudit from './ApostilleAudit';
import ApostilleCreate from './ApostilleCreate';
import type { UpdateTarget } from './ApostilleCreate';
import ApostilleHistory from './ApostilleHistory';

type TabKey = 'create' | 'audit' | 'history';

interface Props {
  /** Making an apostille needs the profile's key: view-only and Ledger profiles only audit and look at the history. */
  canCreate?: boolean;
}

// 作成 / 監査 / 履歴 のタブ。サービスの画面と、Home の「アポスティーユ」リボンの下に開く画面で共通。
export default function ApostilleTabs({ canCreate = true }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [tab, setTab] = useState<TabKey>(canCreate ? 'create' : 'audit');
  const [update, setUpdate] = useState<UpdateTarget | null>(null);
  const [version, setVersion] = useState(0);
  const current: TabKey = !canCreate && tab === 'create' ? 'audit' : tab;

  return (
    <Box>
      <Tabs value={current} onChange={(_, v: TabKey) => setTab(v)} variant={compact ? 'fullWidth' : 'standard'} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        {canCreate && <Tab value="create" label={t('apostille.tab_create')} />}
        <Tab value="audit" label={t('apostille.tab_audit')} />
        <Tab value="history" label={t('apostille.tab_history')} />
      </Tabs>
      {/* The create tab stays mounted so a half-filled form survives a look at the history. */}
      {canCreate && (
        <Box sx={{ display: current === 'create' ? 'block' : 'none' }}>
          <ApostilleCreate update={update} onCancelUpdate={() => setUpdate(null)} onCreated={() => setVersion((v) => v + 1)} />
        </Box>
      )}
      {current === 'audit' && <ApostilleAudit />}
      {current === 'history' && <ApostilleHistory version={version} canUpdate={canCreate} onUpdate={(target) => { setUpdate(target); setTab('create'); }} />}
    </Box>
  );
}
