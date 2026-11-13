// Reading a QR code out of an image file (a screenshot, or a QR picture saved from KASANE's own QR dialog),
// and saving a QR canvas as a PNG. The decoder is the same zxing build the camera scanner uses.
import { BarcodeDetector } from 'barcode-detector/ponyfill';

// Photos of a screen can be too big for the decoder to find a code in; a scaled-down copy often works.
const FALLBACK_SIZES = [1600, 900];

async function detect(detector: BarcodeDetector, source: ImageBitmapSource): Promise<string | null> {
  const found = await detector.detect(source);
  return found.length > 0 ? found[0].rawValue : null;
}

async function scaled(bitmap: ImageBitmap, maxSide: number): Promise<HTMLCanvasElement | null> {
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // A QR code with a transparent background would read as black-on-black; put it on white.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The text of the first QR code in the image file, or null when there is none (or the file is not an image). */
export async function decodeQrFromImageFile(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const first = await detect(detector, bitmap);
    if (first !== null) return first;
    for (const size of FALLBACK_SIZES) {
      const canvas = await scaled(bitmap, size);
      if (!canvas) continue;
      const text = await detect(detector, canvas);
      if (text !== null) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/** Saves the canvas as a PNG file (the browser's download, or the share sheet's "save image" is not needed). */
export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to make the PNG'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      resolve();
    }, 'image/png');
  });
}
