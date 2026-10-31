import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ImportQrPanel from './ImportQrPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 設定 > QRコードのインポート: the reader of signing QR codes and address / invoice codes, as a popup over the settings screen. Symbol only. */
export default function ImportQrDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle>{t('home.import_qr_ribbon')}</DialogTitle>
      <DialogContent dividers sx={{ textAlign: 'left' }}>
        <ImportQrPanel compact />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
