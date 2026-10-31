import { useEffect, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { downloadCanvasPng } from '../lib/qrImage';
import { saveTextFile } from '../lib/saveTextFile';
import { KASANE_QR_MAX_LENGTH } from '../lib/symbol/kasaneQr';

interface Props {
  text: string; // what the QR code holds (also shown, and copied, as text)
  note?: string; // small print under the QR code
  file?: { text: string; name: string }; // also offered as a .json file
  qrSize?: number;
}

/** `text` as a QR code plus the text itself, with copy / save-image / save-file buttons. Too long for a QR: text only. */
export default function QrTextPanel({ text, note, file, qrSize = 240 }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // A larger copy of the QR code, drawn off screen, that the PNG download is taken from.
  const downloadCanvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => { setCopied(false); setSaveError(false); }, [text]);

  const onDownload = async () => {
    const canvas = downloadCanvas.current;
    if (!canvas) return;
    setSaveError(false);
    try {
      await downloadCanvasPng(canvas, `kasane-qr-${Date.now()}.png`);
    } catch (e) {
      console.error('Failed to save the QR image', e);
      setSaveError(true);
    }
  };

  const hasQr = text.length <= KASANE_QR_MAX_LENGTH;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      console.error('Failed to copy the text', e);
    }
  };

  return (
    <>
      {hasQr ? (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
            <Box sx={{ bgcolor: '#fff', p: 1.5, borderRadius: 2, lineHeight: 0 }}>
              <QRCodeSVG value={text} size={qrSize} level="L" />
            </Box>
          </Box>
          <Box sx={{ display: 'none' }}>
            <QRCodeCanvas ref={downloadCanvas} value={text} size={720} level="L" marginSize={4} bgColor="#ffffff" fgColor="#000000" />
          </Box>
        </>
      ) : (
        <Typography sx={{ color: 'text.secondary', fontSize: 12, mb: 1.5 }}>{t('signqr.qr_too_long')}</Typography>
      )}
      <Box sx={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', maxHeight: 120, overflowY: 'auto', p: 1, borderRadius: 2, bgcolor: 'action.hover', userSelect: 'all' }}>
        {text}
      </Box>
      <Button size="small" sx={{ mt: 1 }} onClick={onCopy}>{copied ? t('txuri.copied') : t('signqr.copy_text')}</Button>
      {file && <Button size="small" sx={{ mt: 1 }} onClick={() => saveTextFile(file.text, file.name)}>{t('offline.save_json')}</Button>}
      {hasQr && <Button size="small" sx={{ mt: 1 }} onClick={onDownload}>{t('signqr.download_image')}</Button>}
      {saveError && <Typography sx={{ color: 'error.main', fontSize: 12, mt: 0.5 }}>{t('signqr.download_failed')}</Typography>}
      {note && <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 1.5 }}>{note}</Typography>}
    </>
  );
}
