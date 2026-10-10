import { Box, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import InfoCard, { tileGridSx } from '../../components/InfoCard';

// プロファイル選択の「新規プロファイル」から開く画面。
// 「新規作成」（新しいニーモニックを生成）か「インポート」（既存のニーモニックを入力）を選ぶ。
// Symbol / NEM の選択は、それぞれの遷移先（新規作成画面・インポート画面）で行う。
export default function WalletNew() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <KasaneStage back="/wallet/select" title={t('wallet.new_profile')} maxWidth={640}>
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mx: 1, mt: 1, lineHeight: 1.8 }}>
        {t('wallet.new_choice_message')}
      </Typography>
      <Box sx={{ ...tileGridSx, mx: 0 }}>
        <InfoCard
          title={t('wallet.new_create_title')}
          caption={t('wallet.new_create_desc')}
          onClick={() => navigate('/wallet/creation/name')}
        />
        <InfoCard
          title={t('wallet.new_import_title')}
          caption={t('wallet.new_import_desc')}
          onClick={() => navigate('/wallet/login/import')}
        />
      </Box>
    </KasaneStage>
  );
}
