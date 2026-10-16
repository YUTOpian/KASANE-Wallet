import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, IconButton } from '@mui/material';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import type { ButtonProps } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { decodeQrFromImageFile } from '../lib/qrImage';

interface Props {
  /** The text of the QR code found in the chosen image. */
  onDecoded: (text: string) => void;
  /** No QR code could be read from the chosen image. */
  onNotFound: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  fullWidth?: boolean;
  sx?: ButtonProps['sx'];
  startIcon?: ReactNode;
  /** A small icon button (no text) for tight spots such as next to an input field. */
  iconOnly?: boolean;
}

/** "QR画像から読み込む": picks an image file (a saved QR, a screenshot, a photo) and reads the QR code out of it. */
export default function QrImageButton({ onDecoded, onNotFound, variant = 'outlined', size = 'large', fullWidth = true, sx, startIcon, iconOnly = false }: Props) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const onChosen = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await decodeQrFromImageFile(file);
      if (text === null) onNotFound();
      else onDecoded(text);
    } catch (e) {
      console.error('Failed to read the QR image', e);
      onNotFound();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ''; // so the same file can be chosen again
    }
  };

  return (
    <>
      {iconOnly ? (
        <IconButton color="primary" disabled={busy} onClick={() => input.current?.click()} aria-label={t('signqr.image_button')} sx={sx}>
          <ImageOutlinedIcon />
        </IconButton>
      ) : (
        <Button variant={variant} color="primary" size={size} fullWidth={fullWidth} disabled={busy} startIcon={startIcon} onClick={() => input.current?.click()} sx={sx}>
          {busy ? t('common.loading') : t('signqr.image_button')}
        </Button>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void onChosen(e.target.files?.[0]); }} />
    </>
  );
}
