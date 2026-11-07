import { Snackbar, Alert } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { isOfflineIssuedMessage } from '../lib/offline/issue';

interface ErrorSnackbarProps {
  message: string;
  onClose: () => void;
}

/**
 * Ported from src/components/mixins/MessageModule.ts (showError). That mixin just opened
 * a Vuetify snackbar with the given text; this is the same behavior via MUI's Snackbar.
 */
export default function ErrorSnackbar({ message, onClose }: ErrorSnackbarProps) {
  const { t } = useTranslation();
  // 「オフラインのため送らずにQRにした」は失敗ではない: 青い通知で、いまの言語で出す（QRは確認画面にある）。
  const offlineIssued = isOfflineIssuedMessage(message);
  return (
    <Snackbar open={message.length > 0} autoHideDuration={offlineIssued ? 8000 : 4000} onClose={onClose}>
      <Alert severity={offlineIssued ? 'info' : 'error'} onClose={onClose} sx={{ width: '100%' }}>{offlineIssued ? t('offline_tx.issued_notice') : message}</Alert>
    </Snackbar>
  );
}
