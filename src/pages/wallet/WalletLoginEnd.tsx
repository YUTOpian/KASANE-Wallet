import { Box, Button, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';

export default function WalletLoginEnd() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <KasaneStage showBack={false} title={t('wallet.login_end_title')} maxWidth={440}>
      <Box sx={{ mt: 2 }}>
        <Typography align="center" sx={{ mx: 2 }}>
          {(t('wallet.login_end_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 2, gap: 1 }}>
          {/* Getting here already means a recovery phrase/private key was just imported and
              a PIN was just set/checked - the two-step "are you sure, security matters"
              caution that WalletCreationEnd still shows exists to nudge someone who hasn't
              backed up or PIN-protected their *new* wallet yet. That doesn't apply on the
              way out of an *import*, so this just goes straight home. */}
          <Button variant="contained" onClick={() => navigate('/top')}>
            HOME
          </Button>
        </Box>
      </Box>
    </KasaneStage>
  );
}
