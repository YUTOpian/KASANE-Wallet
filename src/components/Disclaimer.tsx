import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

/** The numbered points of the 免責事項 (wallet.disclaimer_points). */
export function DisclaimerPoints() {
  const { t } = useTranslation();
  const points = t('wallet.disclaimer_points', { returnObjects: true }) as string[];
  return (
    <Box component="ol" sx={{ m: 0, pl: 3, lineHeight: 1.8 }}>
      {points.map((line, i) => (
        <Typography key={i} component="li" sx={{ mb: 1.25, fontSize: 14 }}>{line}</Typography>
      ))}
    </Box>
  );
}

/**
 * 免責事項: this wallet is non-custodial, so the developers / operators are not responsible for funds that
 * leave the account. Shown inline on the 「安全な保管の知識」 screen (must be agreed to) and as a dialog from
 * the welcome screen and the settings screen.
 */
export function DisclaimerBox() {
  const { t } = useTranslation();
  return (
    <Box sx={{ mt: 3, p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Typography sx={{ fontWeight: 700, mb: 1.5 }}>{t('wallet.disclaimer_title')}</Typography>
      <DisclaimerPoints />
    </Box>
  );
}

export default function DisclaimerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle>{t('wallet.disclaimer_title')}</DialogTitle>
      <DialogContent dividers>
        <DisclaimerPoints />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
