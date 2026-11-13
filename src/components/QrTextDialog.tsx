import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import QrTextPanel from './QrTextPanel';

interface Props {
  open: boolean;
  title: string;
  hint?: string;
  text: string; // what the QR code holds (also shown, and copied, as text)
  note?: string; // small print under the QR code
  file?: { text: string; name: string }; // also offered as a .json file (for data too long for a QR code, or to carry offline)
  onClose: () => void;
}

/** Shows `text` as a QR code plus the text itself with a copy button. Too long for a QR: text only. */
export default function QrTextDialog({ open, title, hint, text, note, file, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {hint && <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>{hint}</Typography>}
        <QrTextPanel text={text} note={note} file={file} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
