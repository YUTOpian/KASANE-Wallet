import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ApostilleTabs from './ApostilleTabs';

// NEM の「アポスティーユ」（公証）の単独の画面（サービス → アポスティーユ）。Home の「アポスティーユ」リボンと同じ内容。
export default function ApostillePage() {
  const { t } = useTranslation();
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 300, mb: 1 }}>{t('apostille.title')}</Typography>
        <ApostilleTabs />
      </Box>
    </Box>
  );
}
