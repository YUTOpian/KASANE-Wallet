import { useEffect } from 'react';
import { Box, AppBar, Toolbar, Typography, Button } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { chainExplorerTxUrl } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';
import bgTop from '../../assets/image_transaction_background_top.png';
import bgBottom from '../../assets/image_transaction_background_bottom.png';

export default function SendComplete() {
  const { t } = useTranslation();
  const txHash = useAppStore((s) => s.lastTxHash);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);

  // The transfer is done - forget its recipient and amount so the next send starts empty.
  useEffect(() => {
    clearReceiverAddress();
    clearSendDraft();
    // Back on Home the send section is collapsed again (the history shows the new transfer).
    useAppStore.getState().setHomePanel('history');
  }, [clearReceiverAddress, clearSendDraft]);

  const explorerUrl = txHash ? chainExplorerTxUrl(txHash) : null;

  return (
    <Box>
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6">{t('send.complete_title')}</Typography>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Box component="img" src={bgTop} sx={{ width: '100%', maxWidth: 480 }} />

        <Typography align="center" sx={{ fontSize: 'x-large', color: 'primary.main', mt: '-48px' }}>
          {(t('send.complete_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', zIndex: 1, width: '100%', maxWidth: 480, px: 2, gap: 1 }}>
          <Button component={RouterLink} to="/top" variant="contained" color="primary" fullWidth>HOME</Button>
          {explorerUrl && (
            <Button href={explorerUrl} target="_blank" rel="noopener" variant="contained" fullWidth>
              Transaction
            </Button>
          )}
        </Box>

        <Box sx={{ maxWidth: 480, ml: 'auto', mr: 0, display: 'block', mt: 2 }}>
          <Box component="img" src={bgBottom} sx={{ width: '100%', mb: '-8px' }} />
        </Box>
      </Box>
    </Box>
  );
}
