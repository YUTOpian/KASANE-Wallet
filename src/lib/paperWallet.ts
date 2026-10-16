// KASANE paper wallet: builds the printable A4 PDF (recovery phrase or private key + QR codes).
//
// This module is pure - it only lays out a page with pdf-lib from data the caller hands over
// (see paperWalletExport.ts for where that data comes from). No PDF template and no embedded
// font are needed: everything is drawn as vector shapes and standard PDF fonts, so the file stays
// small and the secret never leaves the device. All printed text is therefore plain ASCII
// (the BIP39 words, addresses and keys are ASCII anyway).
import type { SymbolNetwork } from './symbol/constants';
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  appendBezierCurve,
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';

export type PaperChain = 'symbol' | 'nem';
export type PaperKind = 'mnemonic' | 'key';

export interface PaperWalletInput {
  chain: PaperChain;
  network: SymbolNetwork;
  kind: PaperKind;
  /** Recovery phrase words (kind = 'mnemonic'). */
  words?: string[];
  /** Private key, 64 hex chars (kind = 'key'). */
  privateKey?: string;
  /** Address and public key of the account printed on the sheet. */
  address: string;
  publicKey: string;
  /** BIP44 path of the printed account (kind = 'mnemonic'), e.g. m/44'/4343'/0'/0'/0'. */
  derivationPath?: string;
  /** PNG of the secret QR (recovery phrase / private key). Symbol only - NEM has no such QR standard. */
  secretQrPng?: Uint8Array;
  /** PNG of the public QR (address / contact). */
  publicQrPng: Uint8Array;
  /** PNG of the KASANE hexagon mark (transparent background). */
  markPng: Uint8Array;
  createdAt: Date;
}

// ---- KASANE palette (same values as theme/kasaneTheme.ts) ----
export const C = {
  coral: '#FA7268',
  pink: '#E58AAE',
  lavender: '#B79BD0',
  aqua: '#7ED1C0',
  mint: '#55E2A0',
  lime: '#EAF4A6',
  ink: '#262129',
  stage: '#2B262D',
  text: '#262129',
  muted: '#7A7080',
  line: '#E4DDEC',
  tint: '#F6F2FA',
  warnBg: '#FFF1EF',
  warnText: '#B23A30',
} as const;
export const GRADIENT: [number, string][] = [
  [0, C.coral],
  [0.34, C.pink],
  [0.62, C.lavender],
  [1, C.mint],
];

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 32;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const HEADER_H = 92;

// ---- small drawing helpers (all take "top-down" y, converted to PDF's bottom-up here) ----
function hex(color: string) {
  const n = parseInt(color.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function lerpStops(stops: [number, string][], t: number) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i += 1) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      const a = parseInt(c0.slice(1), 16);
      const b = parseInt(c1.slice(1), 16);
      const ch = (shift: number) => (((a >> shift) & 255) + ((((b >> shift) & 255) - ((a >> shift) & 255)) * k)) / 255;
      return rgb(ch(16), ch(8), ch(0));
    }
  }
  return hex(stops[stops.length - 1][1]);
}

/** Rounded-rectangle path in SVG coordinates (origin top-left, y down), for drawSvgPath. */
function roundedRectPath(w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  const k = r * 0.5523;
  return [
    `M ${r} 0`, `H ${w - r}`, `C ${w - r + k} 0 ${w} ${r - k} ${w} ${r}`,
    `V ${h - r}`, `C ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`,
    `H ${r}`, `C ${r - k} ${h} 0 ${h - r + k} 0 ${h - r}`,
    `V ${r}`, `C 0 ${r - k} ${r - k} 0 ${r} 0`, 'Z',
  ].join(' ');
}

interface BoxStyle {
  fill?: string;
  border?: string;
  borderWidth?: number;
  radius?: number;
}

export function box(page: PDFPage, x: number, top: number, w: number, h: number, style: BoxStyle) {
  page.drawSvgPath(roundedRectPath(w, h, style.radius ?? 0), {
    x,
    y: PAGE_H - top,
    color: style.fill ? hex(style.fill) : undefined,
    borderColor: style.border ? hex(style.border) : undefined,
    borderWidth: style.border ? (style.borderWidth ?? 0.75) : 0,
  });
}

/** Fills a rounded rectangle with the KASANE gradient (horizontal) by clipping thin strips. */
export function gradientBox(page: PDFPage, x: number, top: number, w: number, h: number, radius: number, stops = GRADIENT) {
  const r = Math.min(radius, w / 2, h / 2);
  const k = r * 0.5523;
  const y0 = PAGE_H - top - h; // bottom edge in PDF space
  const x1 = x + w;
  const y1 = y0 + h;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(x + r, y0),
    lineTo(x1 - r, y0),
    appendBezierCurve(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r),
    lineTo(x1, y1 - r),
    appendBezierCurve(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1),
    lineTo(x + r, y1),
    appendBezierCurve(x + r - k, y1, x, y1 - r + k, x, y1 - r),
    lineTo(x, y0 + r),
    appendBezierCurve(x, y0 + r - k, x + r - k, y0, x + r, y0),
    closePath(),
    clip(),
    endPath(),
  );
  const strips = Math.max(24, Math.ceil(w / 2));
  const sw = w / strips;
  for (let i = 0; i < strips; i += 1) {
    page.drawRectangle({ x: x + i * sw, y: y0, width: sw + 0.6, height: h, color: lerpStops(stops, (i + 0.5) / strips) });
  }
  page.pushOperators(popGraphicsState());
}

export function text(page: PDFPage, s: string, x: number, top: number, size: number, font: PDFFont, color: string) {
  page.drawText(s, { x, y: PAGE_H - top - size * 0.82, size, font, color: hex(color) });
}

/** Text with extra letter spacing (pdf-lib has none built in). Returns the drawn width. */
export function spaced(page: PDFPage, s: string, x: number, top: number, size: number, font: PDFFont, color: string, spacing: number): number {
  let cx = x;
  for (const ch of s) {
    page.drawText(ch, { x: cx, y: PAGE_H - top - size * 0.82, size, font, color: hex(color) });
    cx += font.widthOfTextAtSize(ch, size) + spacing;
  }
  return cx - x - spacing;
}

export function spacedWidth(s: string, size: number, font: PDFFont, spacing: number): number {
  return [...s].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size) + spacing, 0) - spacing;
}

export function centered(page: PDFPage, s: string, cx: number, top: number, size: number, font: PDFFont, color: string) {
  text(page, s, cx - font.widthOfTextAtSize(s, size) / 2, top, size, font, color);
}

export function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** "NAAAAA-BBBBBB-..." - groups of six, the way wallets show addresses. */
export function formatAddress(address: string): string {
  return (address.replace(/-/g, '').match(/.{1,6}/g) ?? []).join('-');
}

// The KASANE wordmark (same strokes as components/kasane/KasaneLogo.tsx), viewBox -8 -8 856 166.
const WORDMARK = [
  'M 8 0 V 150', 'M 122 2 L 10 80', 'M 38 62 L 126 150', // K
  'M 140 150 L 217 0 L 294 150 M 172 108 H 262', // A
  'M 404 30 C 392 8 322 2 318 40 C 314 78 408 68 408 114 C 408 152 332 150 316 122', // S
  'M 424 150 L 501 0 L 578 150 M 456 108 H 546', // A
  'M 600 150 V 0', 'M 600 0 L 712 150', 'M 712 150 V 0', // N
  'M 836 7 H 744 V 143 H 840 M 744 75 H 826', // E
].join(' ');

export function wordmark(page: PDFPage, x: number, top: number, width: number, color: string) {
  const s = width / 856;
  page.drawSvgPath(WORDMARK, {
    x: x + 8 * s,
    y: PAGE_H - (top + 8 * s),
    scale: s,
    borderColor: hex(color),
    borderWidth: 13, // scaled together with the path
  });
}

// ---- page sections ----
/** The page header of every KASANE PDF: dark card with the mark, wordmark, a subtitle and the chain / network pill. */
export function drawHeader(page: PDFPage, mark: Awaited<ReturnType<PDFDocument['embedPng']>>, f: Fonts, subtitle: string, pillLabel: string) {
  const top = MARGIN;
  const h = HEADER_H;
  box(page, MARGIN, top, CONTENT_W, h, { fill: C.stage, radius: 18 });

  const markW = 76;
  const markH = (markW * 984) / 1140;
  page.drawImage(mark, { x: MARGIN + 24, y: PAGE_H - top - (h - markH) / 2 - markH + 2, width: markW, height: markH });

  wordmark(page, MARGIN + 124, top + 24, 168, C.lime);
  spaced(page, subtitle, MARGIN + 125, top + 24 + 168 * (166 / 856) + 11, 10, f.regular, C.lime, 3.4);

  // chain / network pill, top right
  const pillW = spacedWidth(pillLabel, 8.5, f.bold, 1.4) + 28;
  const pillX = MARGIN + CONTENT_W - 22 - pillW;
  gradientBox(page, pillX, top + 18, pillW, 22, 11, GRADIENT);
  spaced(page, pillLabel, pillX + 14, top + 18 + 7, 8.5, f.bold, C.ink, 1.4);

  // thin gradient rule along the bottom edge of the card
  gradientBox(page, MARGIN + 24, top + h - 9, CONTENT_W - 48, 1.6, 0.8, GRADIENT);
}

function header(page: PDFPage, mark: Awaited<ReturnType<PDFDocument['embedPng']>>, f: Fonts, input: PaperWalletInput) {
  drawHeader(page, mark, f, 'PAPER WALLET', `${input.chain === 'symbol' ? 'SYMBOL' : 'NEM'}  ${input.network === 'mainnet' ? 'MAINNET' : input.network === 'mijin' ? 'MIJIN V2' : 'TESTNET'}`);
}

function warning(page: PDFPage, f: Fonts, top: number, input: PaperWalletInput): number {
  const secretName = input.kind === 'mnemonic' ? 'recovery phrase or the secret QR' : 'private key or the secret QR';
  const body = input.chain === 'nem' && input.kind === 'mnemonic'
    ? 'Anyone who sees the recovery phrase can take everything in this wallet. Keep it offline, away from cameras and cloud-connected printers, and never share it.'
    : `Anyone who sees the ${secretName} can take everything in this wallet. Keep it offline, away from cameras and cloud-connected printers, and never share it.`;
  const lines = wrap(body, f.regular, 8.6, CONTENT_W - 36);
  const h = 28 + lines.length * 11;
  box(page, MARGIN, top, CONTENT_W, h, { fill: C.warnBg, border: C.coral, borderWidth: 1, radius: 12 });
  spaced(page, 'KEEP THIS SHEET PRIVATE', MARGIN + 18, top + 11, 9, f.bold, C.warnText, 1.6);
  lines.forEach((line, i) => text(page, line, MARGIN + 18, top + 26 + i * 11, 8.6, f.regular, C.text));
  return top + h;
}

export function sectionTitle(page: PDFPage, f: Fonts, top: number, title: string, right?: string) {
  spaced(page, title, MARGIN, top, 9.5, f.bold, C.text, 2);
  gradientBox(page, MARGIN, top + 16, 34, 2.4, 1.2, GRADIENT);
  if (right) {
    const w = spacedWidth(right, 7.6, f.bold, 1.2);
    spaced(page, right, MARGIN + CONTENT_W - w, top + 1.5, 7.6, f.bold, C.warnText, 1.2);
  }
}

function wordGrid(page: PDFPage, f: Fonts, top: number, words: string[]): number {
  const cols = 4;
  const gap = 6;
  const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
  const cellH = 24;
  words.forEach((word, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MARGIN + col * (cellW + gap);
    const y = top + row * (cellH + gap);
    box(page, x, y, cellW, cellH, { fill: C.tint, border: C.line, borderWidth: 0.8, radius: 8 });
    const num = String(i + 1);
    text(page, num, x + 9, y + 8.6, 7.2, f.regular, C.muted);
    text(page, word, x + 27, y + 6.6, 12.5, f.monoBold, C.text);
  });
  const rows = Math.ceil(words.length / cols);
  return top + rows * cellH + (rows - 1) * gap;
}

function secretLine(page: PDFPage, f: Fonts, top: number, value: string): number {
  // Private key: two lines of 32 hex chars in a single card.
  const half = Math.ceil(value.length / 2);
  const lines = [value.slice(0, half), value.slice(half)];
  const h = 62;
  box(page, MARGIN, top, CONTENT_W, h, { fill: C.tint, border: C.line, borderWidth: 0.8, radius: 12 });
  lines.forEach((line, i) => centered(page, line, MARGIN + CONTENT_W / 2, top + 14 + i * 20, 14, f.monoBold, C.text));
  return top + h;
}

export function qrCard(
  page: PDFPage,
  f: Fonts,
  qr: Awaited<ReturnType<PDFDocument['embedPng']>>,
  x: number,
  top: number,
  w: number,
  h: number,
  tag: { label: string; secret: boolean },
  title: string,
  caption: string[],
  size = 112,
) {
  box(page, x, top, w, h, { fill: '#FFFFFF', border: C.line, borderWidth: 0.9, radius: 14 });
  // coloured accent along the top of the card
  gradientBox(page, x + 14, top, w - 28, 2.6, 1.3, tag.secret
    ? [[0, C.coral], [1, C.pink]]
    : [[0, C.aqua], [1, C.mint]]);

  spaced(page, title, x + 16, top + 16, 8.6, f.bold, C.text, 1.5);
  const tagW = spacedWidth(tag.label, 7, f.bold, 1.2) + 14;
  const tagX = x + w - 14 - tagW;
  box(page, tagX, top + 13, tagW, 15, { fill: tag.secret ? C.coral : C.aqua, radius: 7.5 });
  spaced(page, tag.label, tagX + 7, top + 17.6, 7, f.bold, tag.secret ? '#FFFFFF' : C.ink, 1.2);

  page.drawImage(qr, { x: x + (w - size) / 2, y: PAGE_H - top - 34 - size, width: size, height: size });
  caption.forEach((line, i) => centered(page, line, x + w / 2, top + 34 + size + 6 + i * 11, 7.6, f.regular, C.muted));
}

export function detailRow(page: PDFPage, f: Fonts, top: number, label: string, value: string, mono = true, size = 9) {
  spaced(page, label, MARGIN + 18, top + 1.5, 7, f.bold, C.muted, 1.4);
  text(page, value, MARGIN + 112, top, size, mono ? f.monoBold : f.bold, C.text);
}

function restoreInfo(input: PaperWalletInput): string[] {
  if (input.kind === 'key') {
    return input.chain === 'symbol'
      ? ['Import the private key (or scan the SECRET QR) in any Symbol wallet, then check that the address matches this sheet.']
      : ['Import the private key in any NEM wallet, then check that the address matches this sheet.'];
  }
  return input.chain === 'symbol'
    ? ['Enter the words in order in any Symbol wallet that supports BIP39 (KASANE, Symbol Wallet ...). Wallets that read Symbol mnemonic QR codes can also scan the SECRET QR. Check that the address matches this sheet.']
    : ['Enter the words in order in any NEM wallet that supports BIP39 and the path above. NEM has no standard recovery-phrase QR, so none is printed. Check that the address matches this sheet.'];
}

/** The footer of every KASANE PDF: gradient rule, generated-on-device note and the KASANE tag. */
export function drawFooter(page: PDFPage, f: Fonts, createdAt: Date) {
  const footerTop = PAGE_H - MARGIN - 10;
  gradientBox(page, MARGIN, footerTop - 10, CONTENT_W, 2, 1, GRADIENT);
  const date = createdAt.toISOString().slice(0, 10);
  text(page, `Generated locally on this device by KASANE Wallet  -  ${date}`, MARGIN, footerTop, 7.6, f.regular, C.muted);
  const tagline = 'KASANE';
  const tw = spacedWidth(tagline, 7.6, f.bold, 2.4);
  spaced(page, tagline, MARGIN + CONTENT_W - tw, footerTop, 7.6, f.bold, C.muted, 2.4);
}

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  monoBold: PDFFont;
}

export async function buildPaperWalletPdf(input: PaperWalletInput): Promise<Uint8Array> {
  if (input.kind === 'mnemonic' && (!input.words || input.words.length === 0)) throw new Error('paper wallet: no recovery phrase');
  if (input.kind === 'key' && !input.privateKey) throw new Error('paper wallet: no private key');

  const pdf = await PDFDocument.create();
  pdf.setTitle('KASANE Paper Wallet');
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
  const publicQr = await pdf.embedPng(input.publicQrPng);
  const secretQr = input.secretQrPng ? await pdf.embedPng(input.secretQrPng) : null;

  const page = pdf.addPage([PAGE_W, PAGE_H]);

  header(page, mark, fonts, input);
  let y = warning(page, fonts, MARGIN + HEADER_H + 12, input) + 18;

  // 1. the secret in text form
  if (input.kind === 'mnemonic') {
    const words = input.words as string[];
    sectionTitle(page, fonts, y, 'RECOVERY PHRASE', `${words.length} WORDS  -  KEEP SECRET`);
    y = wordGrid(page, fonts, y + 26, words) + 20;
  } else {
    sectionTitle(page, fonts, y, 'PRIVATE KEY', 'KEEP SECRET');
    y = secretLine(page, fonts, y + 26, input.privateKey as string) + 20;
  }

  // 2. QR codes
  sectionTitle(page, fonts, y, secretQr ? 'QR CODES' : 'ADDRESS QR');
  y += 26;
  const cardGap = 14;
  const cardW = (CONTENT_W - cardGap) / 2;
  const cardH = 180;
  const publicCaption = input.chain === 'symbol'
    ? ['Symbol contact QR (name + public key)', 'Safe to share - others can send to you']
    : ['NEM address QR', 'Safe to share - others can send to you'];
  if (secretQr) {
    qrCard(page, fonts, secretQr, MARGIN, y, cardW, cardH, { label: 'SECRET', secret: true },
      input.kind === 'mnemonic' ? 'RECOVERY PHRASE QR' : 'PRIVATE KEY QR',
      ['Symbol standard format (not encrypted)', 'Anyone who scans it owns the wallet']);
    qrCard(page, fonts, publicQr, MARGIN + cardW + cardGap, y, cardW, cardH, { label: 'PUBLIC', secret: false },
      'ADDRESS QR', publicCaption);
  } else {
    qrCard(page, fonts, publicQr, MARGIN, y, cardW, cardH, { label: 'PUBLIC', secret: false }, 'ADDRESS QR', publicCaption);
    // NEM: the second slot explains how to restore instead of showing a QR
    const x2 = MARGIN + cardW + cardGap;
    box(page, x2, y, cardW, cardH, { fill: C.tint, border: C.line, borderWidth: 0.9, radius: 14 });
    spaced(page, 'HOW TO RESTORE', x2 + 16, y + 16, 8.6, fonts.bold, C.text, 1.5);
    wrap(restoreInfo(input)[0], fonts.regular, 8.8, cardW - 32).forEach((line, i) => text(page, line, x2 + 16, y + 40 + i * 13, 8.8, fonts.regular, C.text));
  }
  y += cardH + 18;

  // 3. account details
  sectionTitle(page, fonts, y, 'ACCOUNT DETAILS');
  y += 26;
  const network = input.network === 'mijin' ? 'mijin' : `${input.chain === 'symbol' ? 'Symbol' : 'NEM'} ${input.network === 'mainnet' ? 'Mainnet' : 'Testnet'}`;
  const rows: [string, string, boolean, number][] = [
    ['ADDRESS', formatAddress(input.address), true, 10],
    ['PUBLIC KEY', input.publicKey, true, 7.6],
    ['NETWORK', input.derivationPath ? `${network}   -   path ${input.derivationPath}` : network, false, 8.6],
  ];
  const detailsH = rows.length * 18 + 14;
  box(page, MARGIN, y, CONTENT_W, detailsH, { fill: C.tint, border: C.line, borderWidth: 0.8, radius: 12 });
  rows.forEach(([label, value, mono, size], i) => detailRow(page, fonts, y + 11 + i * 18, label, value, mono, size));
  y += detailsH + 12;

  // 4. restore note (Symbol shows it here; NEM already shows it in the card above)
  if (secretQr) {
    wrap(restoreInfo(input)[0], fonts.regular, 7.8, CONTENT_W - 4).forEach((line, i) => text(page, line, MARGIN + 2, y + i * 10.5, 7.8, fonts.regular, C.muted));
  }

  drawFooter(page, fonts, input.createdAt);

  return pdf.save();
}
