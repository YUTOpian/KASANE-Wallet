import { useState } from 'react';
import { Alert, AppBar, Box, Button, Dialog, IconButton, Toolbar, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import CloseIcon from '@mui/icons-material/Close';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import FileOpenOutlinedIcon from '@mui/icons-material/FileOpenOutlined';
import { Scanner } from '@yudiel/react-qr-scanner';
import { useTranslation } from 'react-i18next';
import { decodeQrFromImageFile } from '../../lib/qrImage';
import { SectionCard } from '../multisig/parts';

// 「トランザクションをインポート」: the first step of 「トランザクションに連署」, the same for Symbol and NEM.
// A request to cosign is read from a camera (QR), a saved QR image, a .json file or pasted text; this card only gets the text and
// hands it to `onLoad`, which judges it (it differs by blockchain) and reports what is wrong through `error`.
// The card is only mounted while nothing has been read, so the camera is off otherwise and the pasted text is gone once it is read.

interface Props {
  intro: string;
  error: string;
  onError: (message: string) => void;
  /** Called with the text of a QR code, a file or the text box. Returns true when it was accepted (the scanner then closes). */
  onLoad: (raw: string) => boolean;
}

export default function OfflineCosignImport({ intro, error, onError, onLoad }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [scanOpen, setScanOpen] = useState(false);

  const load = (raw: string) => {
    if (onLoad(raw)) setScanOpen(false);
  };

  return (
    <>
      <SectionCard>
        <Typography sx={{ fontWeight: 'bold', fontSize: '1.1rem', textAlign: 'center', mb: 0.5 }}>{t('offline_ui.import_title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, textAlign: 'center', mb: 2 }}>{intro}</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, maxWidth: 420, mx: 'auto', mb: 2 }}>
          <Button variant="contained" color="primary" size="large" fullWidth startIcon={<QrCodeScannerIcon />} onClick={() => setScanOpen(true)}>{t('offline_ui.import_qr')}</Button>
          {/* One button for a saved QR image and a JSON file alike: an image is read for its QR code, anything else is read as text. */}
          <Button component="label" variant="outlined" color="primary" size="large" fullWidth startIcon={<FileOpenOutlinedIcon />}>
            {t('offline_ui.import_file')}
            <input
              type="file"
              hidden
              accept="image/*,.json,application/json,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.type.startsWith('image/')) {
                  decodeQrFromImageFile(file)
                    .then((qr) => { if (qr === null) onError(t('signqr.image_not_found')); else load(qr); })
                    .catch(() => onError(t('signqr.image_not_found')));
                  return;
                }
                file.text().then((content) => { setText(content); load(content); }).catch(() => onError(t('signqr.invalid')));
              }}
            />
          </Button>
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', mb: 1 }}>{t('offline_ui.import_payload_note')}</Typography>
        {error !== '' && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.5, alignItems: 'stretch' }}>
          <TextField
            fullWidth
            multiline
            minRows={4}
            maxRows={10}
            placeholder={t('offline_ui.payload_placeholder')}
            value={text}
            onChange={(e) => { setText(e.target.value); onError(''); }}
            error={error !== ''}
            slotProps={{ htmlInput: { 'aria-label': t('offline_ui.payload_placeholder'), autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
          <Button variant="contained" color="primary" disabled={text.trim() === ''} onClick={() => load(text)} sx={{ minWidth: { sm: 180 }, whiteSpace: 'nowrap' }}>{t('offline_ui.import_payload')}</Button>
        </Box>
      </SectionCard>

      {/* The scanner only mounts while open, so the camera is off otherwise. */}
      <Dialog fullScreen open={scanOpen} onClose={() => setScanOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar>
            <IconButton edge="start" onClick={() => setScanOpen(false)} aria-label={t('common.close')}><CloseIcon /></IconButton>
            <Typography variant="h6" sx={{ ml: 1 }}>{t('signqr.scan_title')}</Typography>
          </Toolbar>
        </AppBar>
        {error !== '' && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        <Scanner
          onScan={(results) => { if (results[0]) load(results[0].rawValue); }}
          onError={(e) => onError(`Camera is not available: ${e instanceof Error ? e.message : 'Unknown'}`)}
        />
      </Dialog>
    </>
  );
}
