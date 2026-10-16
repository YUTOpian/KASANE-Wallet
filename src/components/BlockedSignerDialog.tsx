import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useTranslation } from 'react-i18next';

interface BlockedSignerDialogProps {
  open: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

/** ブラックリストのアドレスからの署名依頼に署名しようとしたときの、最後の確認。 */
export default function BlockedSignerDialog({ open, onCancel, onContinue }: BlockedSignerDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle>{t('addressbook.blocked_confirm_title')}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t('addressbook.blocked_confirm_message')}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} autoFocus>{t('common.cancel')}</Button>
        <Button color="error" onClick={onContinue}>{t('addressbook.blocked_confirm_continue')}</Button>
      </DialogActions>
    </Dialog>
  );
}
