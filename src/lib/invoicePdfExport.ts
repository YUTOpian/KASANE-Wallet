// Invoice QR -> printable PDF, built on this device and handed over as a download (or the iOS share
// sheet), the same way as the paper wallet (paperWalletExport.ts). Nothing is uploaded or stored.
import { loadMark, qrToPng, saveFile } from './paperWalletExport';
import { buildInvoicePdf } from './invoicePdf';
import { getNetwork } from './symbol/network';
import { INVOICE_LIFETIME_MS } from './symbol/qr';

export interface InvoicePdfSource {
  recipient: string;
  mosaics: Array<{ symbol: string; amount: string }>;
  message: string;
  /** The QR text to print (buildInvoiceQr's result), made just now: its 2 hour validity starts then. */
  qr: string;
}

/** Builds the invoice PDF for `source`. `now` is the moment the QR was made. */
export async function createInvoicePdf(source: InvoicePdfSource, now: Date = new Date()): Promise<{ bytes: Uint8Array; filename: string }> {
  // A dense QR (long message, several mosaics) needs plenty of pixels to stay scannable on paper.
  const qrPng = await qrToPng(source.qr, { level: 'L', size: 1100 });
  const bytes = await buildInvoicePdf({
    network: getNetwork(),
    recipient: source.recipient,
    mosaics: source.mosaics,
    message: source.message,
    qrPng,
    markPng: await loadMark(),
    createdAt: now,
    expiresAt: new Date(now.getTime() + Number(INVOICE_LIFETIME_MS)),
  });
  return { bytes, filename: `kasane-invoice-${now.toISOString().slice(0, 10).replace(/-/g, '')}.pdf` };
}

export async function downloadInvoicePdf(source: InvoicePdfSource): Promise<void> {
  const { bytes, filename } = await createInvoicePdf(source);
  await saveFile(bytes, filename);
}
