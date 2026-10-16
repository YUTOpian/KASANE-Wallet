// KASANE invoice sheet: the invoice / payment-request QR (see InvoiceCard) as a printable A4 PDF with
// the same look as the paper wallet (lib/paperWallet.ts, whose drawing helpers it shares).
//
// Pure layout, like the paper wallet: no template, no embedded font - only standard PDF fonts, so
// everything printed is plain ASCII. The message may contain any text, so it is printed only when it is
// ASCII; otherwise the sheet says it is inside the QR code (the QR itself always carries it in full).
import type { SymbolNetwork } from './symbol/constants';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import {
  C, CONTENT_W, HEADER_H, MARGIN, PAGE_H, PAGE_W,
  box, drawFooter, drawHeader, formatAddress, qrCard, sectionTitle, spaced, text,
} from './paperWallet';
import type { Fonts } from './paperWallet';

export interface InvoicePdfInput {
  /** Which chain the request is for (default 'symbol'). NEM requests carry no deadline. */
  chain?: 'symbol' | 'nem';
  network: SymbolNetwork;
  /** Address that gets paid. */
  recipient: string;
  /** Requested mosaics, amounts already formatted as plain decimals ("10.5"). */
  mosaics: Array<{ symbol: string; amount: string }>;
  /** Plain message of the request ('' = none). */
  message: string;
  /** PNG of the invoice QR. */
  qrPng: Uint8Array;
  /** PNG of the KASANE hexagon mark. */
  markPng: Uint8Array;
  createdAt: Date;
  /** When the request inside the QR stops being valid (Symbol only; NEM requests do not expire). */
  expiresAt?: Date;
}

const MAX_MESSAGE_LINES = 4;
const QR_SIZE = 220;
const ROW_LINE_H = 14;
const ROW_GAP = 6;

/** Characters the standard PDF fonts can print (printable ASCII). */
const isPrintable = (s: string) => /^[\x20-\x7E]*$/.test(s);
const safe = (s: string) => s.replace(/[^\x20-\x7E]/g, '?');

/** Greedy character wrap (a message can hold long unbroken strings); newlines are kept. */
function wrapChars(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of s.split(/\r?\n/)) {
    let line = '';
    for (const ch of paragraph) {
      if (line && font.widthOfTextAtSize(line + ch, size) > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export async function buildInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  if (input.mosaics.length === 0) throw new Error('invoice pdf: no mosaic');

  const pdf = await PDFDocument.create();
  pdf.setTitle('KASANE Invoice');
  pdf.setCreator('KASANE Wallet');
  pdf.setProducer('KASANE Wallet');
  pdf.setCreationDate(input.createdAt);
  pdf.setModificationDate(input.createdAt);

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const mark = await pdf.embedPng(input.markPng);
  const qr = await pdf.embedPng(input.qrPng);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const chain = input.chain ?? 'symbol';
  const chainName = chain === 'nem' ? 'NEM' : 'Symbol';
  const netName = input.network === 'mainnet' ? 'Mainnet' : input.network === 'mijin' ? 'mijin' : 'Testnet';

  drawHeader(page, mark, fonts, 'INVOICE', `${chainName.toUpperCase()}  ${netName.toUpperCase()}`);
  let y = MARGIN + HEADER_H + 22;

  // 1. the QR
  sectionTitle(page, fonts, y, 'PAYMENT REQUEST');
  y += 26;
  const caption = chain === 'nem'
    ? ['NEM invoice QR', 'Scan it with a NEM wallet to pay']
    : ['Symbol transaction-request QR', 'Scan it with a Symbol wallet to pay'];
  const cardW = 300;
  const cardH = 34 + QR_SIZE + 6 + caption.length * 11 + 16;
  qrCard(page, fonts, qr, (PAGE_W - cardW) / 2, y, cardW, cardH, { label: 'PAY', secret: false }, 'INVOICE QR', caption, QR_SIZE);
  y += cardH + 20;

  // 2. what is being asked
  sectionTitle(page, fonts, y, 'DETAILS');
  y += 26;

  interface Row { label: string; lines: string[]; font: PDFFont; size: number }
  const valueX = MARGIN + 112;
  const valueW = CONTENT_W - 112 - 18;
  const rows: Row[] = [
    { label: 'PAY TO', lines: [formatAddress(input.recipient)], font: fonts.monoBold, size: 9.2 },
    ...input.mosaics.map((m, i): Row => ({ label: i === 0 ? 'AMOUNT' : '', lines: [safe(`${m.amount} ${m.symbol}`)], font: fonts.bold, size: 11 })),
  ];
  if (input.message !== '') {
    if (isPrintable(input.message.replace(/[\r\n]+/g, ' '))) {
      const lines = wrapChars(input.message, fonts.regular, 9, valueW);
      const shown = lines.slice(0, MAX_MESSAGE_LINES);
      if (lines.length > MAX_MESSAGE_LINES) shown[MAX_MESSAGE_LINES - 1] = `${shown[MAX_MESSAGE_LINES - 1].slice(0, -3)}...`;
      rows.push({ label: 'MESSAGE', lines: shown, font: fonts.regular, size: 9 });
    } else {
      rows.push({ label: 'MESSAGE', lines: ['(included in the QR code)'], font: fonts.regular, size: 9 });
    }
  }
  if (input.expiresAt) rows.push({ label: 'VALID UNTIL', lines: [utc(input.expiresAt)], font: fonts.bold, size: 9 });
  rows.push({ label: 'NETWORK', lines: [`${chainName} ${netName}`], font: fonts.bold, size: 9 });

  const rowHeight = (r: Row) => r.lines.length * ROW_LINE_H;
  const detailsH = rows.reduce((sum, r) => sum + rowHeight(r) + ROW_GAP, 0) + 8;
  box(page, MARGIN, y, CONTENT_W, detailsH, { fill: C.tint, border: C.line, borderWidth: 0.8, radius: 12 });
  let ry = y + 11;
  for (const r of rows) {
    if (r.label) spaced(page, r.label, MARGIN + 18, ry + 1.5, 7, fonts.bold, C.muted, 1.4);
    r.lines.forEach((line, i) => text(page, line, valueX, ry + i * ROW_LINE_H, r.size, r.font, C.text));
    ry += rowHeight(r) + ROW_GAP;
  }
  y += detailsH + 12;

  // 3. notes
  const notes = chain === 'nem'
    ? [
      'This request has no deadline. Check that the address, amount and message are right before paying.',
      'Whoever scans the QR pays the network fee and signs the transfer.',
    ]
    : [
      'This request is valid for 2 hours from the time this sheet was made. After that, make a new invoice in KASANE.',
      'Whoever scans the QR pays the network fee and signs the transfer. Check the address and amount before paying.',
    ];
  notes.forEach((line, i) => text(page, line, MARGIN + 2, y + i * 11, 7.8, fonts.regular, C.muted));

  drawFooter(page, fonts, input.createdAt);
  return pdf.save();
}
