// Aggregate CSV (CSVでまとめて送信), text side: bytes -> text -> cells -> rows, and the sample file people download,
// edit and upload again. Modelled on Ventus Wallet's CSV bulk send (A: label, B: address or namespace, C: amount,
// D: mosaic id, E: message), with the things a spreadsheet really produces handled on top of it: a UTF-8 BOM,
// Shift_JIS files (Excel's default "CSV" in Japan), quoted cells that contain commas / quotes / line breaks, and
// full-width digits. This file imports nothing, so it can be tested without the SDK.

/** One data row of the file. Everything is still text here; ./aggregateCsv.ts checks and resolves it. */
export interface CsvRow {
  /** 1-based number of the record in the file (what a spreadsheet shows as the row number when no cell holds a line break). */
  line: number;
  label: string; // column A: a note for the person, not sent anywhere
  recipient: string; // column B: address, namespace alias or public key
  amount: string; // column C: plain decimal, '' = none
  mosaic: string; // column D: 16 hex chars, '' = the network currency
  message: string; // column E: plain message, '' = none
}

/** Header of the sample file; a first row whose second cell is one of HEADER_WORDS is taken as this header and skipped. */
export const CSV_HEADER = ['label', 'address', 'amount', 'mosaic_id', 'message'] as const;
const HEADER_WORDS = ['address', 'アドレス', '宛先', '送り先', 'recipient'];

/** The largest file that is read (100 rows with a long message each stay far below this). */
export const MAX_CSV_BYTES = 1024 * 1024;

/**
 * File bytes -> text. UTF-8 is tried first (with or without a BOM); a file that is not valid UTF-8 is read as
 * Shift_JIS, which is what Excel writes for "CSV (コンマ区切り)" on a Japanese Windows.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('shift_jis').decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
  }
  return text.replace(/^\uFEFF/, '');
}

/** The separator a file uses: comma (normal), tab (pasted from a spreadsheet) or semicolon (Excel in some locales). */
export function detectDelimiter(text: string): string {
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // Only the part outside quotes counts.
    const outside = line.replace(/"[^"]*"/g, '');
    const counts = [',', '\t', ';'].map((d) => ({ d, n: outside.split(d).length - 1 }));
    const best = counts.reduce((a, b) => (b.n > a.n ? b : a));
    return best.n > 0 ? best.d : ',';
  }
  return ',';
}

/** RFC 4180 style parsing: quoted cells may hold the separator, line breaks and doubled quotes. Blank lines come back as [''] records. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;
  let started = false; // the current record has had any character
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; started = true; continue; }
    if (ch === delimiter) { record.push(cell); cell = ''; started = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      started = false;
      continue;
    }
    cell += ch;
    started = true;
  }
  if (started || cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

const nfkc = (s: string) => s.normalize('NFKC');

/**
 * Records -> data rows. Blank lines, lines whose first cell starts with "#" (comments) and the header line are skipped.
 * Address, amount and mosaic cells are NFKC-normalised (full-width digits / letters typed on a Japanese keyboard);
 * the message is left exactly as written.
 */
export function readCsvRows(records: string[][]): CsvRow[] {
  const rows: CsvRow[] = [];
  let seenData = false;
  records.forEach((cells, index) => {
    if (cells.every((c) => c.trim() === '')) return;
    if (cells[0].trim().startsWith('#')) return;
    if (!seenData && HEADER_WORDS.includes((cells[1] ?? '').trim().toLowerCase())) { seenData = true; return; }
    seenData = true;
    const cell = (n: number) => cells[n] ?? '';
    rows.push({
      line: index + 1,
      label: cell(0).trim(),
      recipient: nfkc(cell(1)).trim(),
      amount: nfkc(cell(2)).trim(),
      mosaic: nfkc(cell(3)).trim(),
      message: cell(4),
    });
  });
  return rows;
}

/** One cell as it is written in a file: quoted when it holds a comma, a quote or a line break. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The sample file: a few comment lines (`#`), the header and three example rows that all send to the wallet's own
 * address, so a sample that is uploaded without being edited cannot send anything to a stranger.
 * Lines end with CRLF (what spreadsheets expect); the caller puts the UTF-8 BOM in front when it saves the file.
 */
export function buildSampleCsv(ownAddress: string, currencyMosaicId: string, comments: string[]): string {
  const lines: string[] = [
    ...comments.map((c) => csvCell(`# ${c}`)),
    CSV_HEADER.join(','),
    ['sample 1', ownAddress, '1', '', 'sample message'].map(csvCell).join(','),
    ['sample 2', ownAddress, '0.5', currencyMosaicId, ''].map(csvCell).join(','),
    ['sample 3', ownAddress, '', '', 'message only'].map(csvCell).join(','),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
