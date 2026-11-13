import { useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ApostilleExplorer from './ApostilleExplorer';
import ApostilleHistory from './ApostilleHistory';

type TabKey = 'explorer' | 'history';

// Home の「アポスティーユ」リボンの中身: エクスプローラー（公開のアポスティーユの一覧）と、この端末の履歴。
// 作成と監査は サービス → アポスティーユ。
export default function ApostilleRibbon() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('explorer');
  return (
    <Box>
      <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="explorer" label={t('apostille.tab_explorer')} />
        <Tab value="history" label={t('apostille.tab_history')} />
      </Tabs>
      {tab === 'explorer' ? <ApostilleExplorer /> : <ApostilleHistory version={0} canUpdate={false} onUpdate={() => {}} />}
    </Box>
  );
}
