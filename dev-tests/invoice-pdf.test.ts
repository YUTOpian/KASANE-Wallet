// Run: npx tsx dev-tests/invoice-pdf.test.ts
// Checks that lib/invoicePdf.ts lays out an invoice (one mosaic ... five, with / without / non-ASCII /
// very long messages) as exactly one A4 page, and that a refused input (no mosaic) throws.
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { buildInvoicePdf } from '../src/lib/invoicePdf';
import type { InvoicePdfInput } from '../src/lib/invoicePdf';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const MARK = new Uint8Array(readFileSync(new URL('../src/assets/kasane_mark.png', import.meta.url)));
const base: InvoicePdfInput = {
  network: 'mainnet',
  recipient: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG',
  mosaics: [{ symbol: 'XYM', amount: '10.5' }],
  message: '',
  qrPng: PIXEL,
  markPng: MARK,
  createdAt: new Date('2026-10-10T00:00:00Z'),
  expiresAt: new Date('2026-10-10T02:00:00Z'),
};
const five = ['XYM', 'symbol.xym', 'namespace.mosaic.name', 'A'.repeat(16), 'B'.repeat(16)].map((symbol, i) => ({ symbol, amount: `${i + 1}.123456` }));

const cases: [string, InvoicePdfInput][] = [
  ['one mosaic, no message', base],
  ['testnet', { ...base, network: 'testnet' }],
  ['five mosaics, short message', { ...base, mosaics: five, message: 'Order 1234 - thank you' }],
  ['japanese message', { ...base, message: 'ご注文ありがとうございます' }],
  ['very long ascii message', { ...base, mosaics: five, message: 'x'.repeat(1023) }],
  ['multi-line message', { ...base, message: 'line one\nline two\n\nline four\nline five\nline six' }],
  ['non-ascii mosaic name', { ...base, mosaics: [{ symbol: 'トークン', amount: '1' }] }],
];

for (const [name, input] of cases) {
  const bytes = await buildInvoicePdf(input);
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  check(name, doc.getPageCount() === 1 && Math.round(page.getWidth()) === 595 && Math.round(page.getHeight()) === 842, `${bytes.length} bytes`);
  if (name === 'five mosaics, short message') writeFileSync('/tmp/invoice-sample.pdf', bytes);
}

let threw = false;
try { await buildInvoicePdf({ ...base, mosaics: [] }); } catch { threw = true; }
check('no mosaic is refused', threw);

process.exit(failed === 0 ? 0 : 1);
