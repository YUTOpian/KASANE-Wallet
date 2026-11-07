// Run: npx tsx dev-tests/paper-wallet.test.ts
// Checks that lib/paperWallet.ts lays out every variant (Symbol / NEM x recovery phrase / private key,
// 24 and 12 words) as exactly one A4 page, with no secret leaking into the PDF metadata.
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { buildPaperWalletPdf, formatAddress } from '../src/lib/paperWallet';
import type { PaperWalletInput } from '../src/lib/paperWallet';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

// 1x1 white PNG, stands in for the QR images (the real ones come from qrcode.react in the browser).
const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const MARK = new Uint8Array(readFileSync(new URL('../src/assets/kasane_mark.png', import.meta.url)));

const words24 = `${'abandon '.repeat(23)}art`.split(' ');
const base = { network: 'mainnet' as const, publicKey: 'A'.repeat(64), markPng: MARK, publicQrPng: PIXEL, createdAt: new Date('2026-10-09T00:00:00Z') };
const SECRET_KEY = 'DEADBEEF'.repeat(8);

const cases: [string, PaperWalletInput][] = [
  ['symbol phrase (24)', { ...base, chain: 'symbol', kind: 'mnemonic', words: words24, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', derivationPath: "m/44'/4343'/0'/0'/0'", secretQrPng: PIXEL }],
  ['symbol phrase (12)', { ...base, chain: 'symbol', kind: 'mnemonic', words: words24.slice(0, 12), address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', derivationPath: "m/44'/4343'/0'/0'/0'", secretQrPng: PIXEL }],
  ['symbol private key', { ...base, chain: 'symbol', kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', secretQrPng: PIXEL }],
  ['nem phrase (24, testnet)', { ...base, network: 'testnet', chain: 'nem', kind: 'mnemonic', words: words24, address: 'TBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH', derivationPath: "m/44'/43'/0'/0'/0'" }],
  ['nem private key', { ...base, chain: 'nem', kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH' }],
];

(async () => {
  for (const [name, input] of cases) {
    const bytes = await buildPaperWalletPdf(input);
    const doc = await PDFDocument.load(bytes);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    check(`${name}: one A4 page`, doc.getPageCount() === 1 && Math.abs(w - 595.28) < 0.01 && Math.abs(h - 841.89) < 0.01);
    check(`${name}: metadata holds no secret`, !`${doc.getTitle()}${doc.getSubject()}${doc.getKeywords()}${doc.getAuthor()}`.includes(SECRET_KEY));
  }

  let threw = false;
  try { await buildPaperWalletPdf({ ...cases[0][1], words: [] }); } catch { threw = true; }
  check('empty recovery phrase is refused', threw);
  threw = false;
  try { await buildPaperWalletPdf({ ...cases[2][1], privateKey: '' }); } catch { threw = true; }
  check('empty private key is refused', threw);

  check('formatAddress groups of six', formatAddress('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG') === 'ABCDEF-GHIJKL-MNOPQR-STUVWX-YZ2345-67ABCD-EFG');
  check('formatAddress ignores existing hyphens', formatAddress('ABCDEF-GHIJKL') === 'ABCDEF-GHIJKL');
  console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
