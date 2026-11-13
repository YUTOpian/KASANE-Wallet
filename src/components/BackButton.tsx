import { Box, Button } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Environment } from '../lib/environment';

interface BackButtonProps {
  // Runs instead of the default navigation (e.g. to step back inside a multi-step form).
  onBack?: () => void;
  // Where to go in the iOS home-screen app, which has no browser back button.
  back?: string;
}

/**
 * A "戻る" button placed at the top of a sub screen, in place of the old title bar (the side menu
 * already shows where you are). Same navigation rule as AppToolBar's back arrow.
 */
export default function BackButton({ onBack, back }: BackButtonProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const goBack = () => {
    if (onBack) onBack();
    else if (Environment.isIos() && Environment.isInStandaloneMode() && back) navigate(back);
    else navigate(-1);
  };

  return (
    <Box sx={{ px: { xs: 1, md: 3 }, pt: 1.5 }}>
      <Button onClick={goBack} startIcon={<ArrowBackIcon />} color="primary" sx={{ fontWeight: 'bold' }}>
        {t('common.back')}
      </Button>
    </Box>
  );
}
