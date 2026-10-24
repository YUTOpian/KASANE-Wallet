// Encrypted mnemonic QR (Symbol QR v3 type 5): make -> parse -> decrypt, wrong password, plain QR.
// Run: npx tsx dev-tests/mnemonic-qr.test.ts
// To pin the official library's parameters, add a real QR + password from an official Symbol wallet below.
import { buildMnemonicQr, decryptMnemonic, parseMnemonicQr } from '../src/lib/symbol/mnemonicQr';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

(async () => {
  const text = buildMnemonicQr(PHRASE, 'correct horse battery');
  const json = JSON.parse(text);
  ok(json.v === 3 && json.type === 5 && typeof json.data.ciphertext === 'string' && typeof json.data.salt === 'string', 'envelope', json);
  ok(!text.includes('abandon'), 'the phrase is not in the QR text');
  const qr = parseMnemonicQr(text);
  ok(qr !== null && qr.encrypted, 'parsed as encrypted');
  if (qr && qr.encrypted) {
    ok((await decryptMnemonic(qr, 'correct horse battery')) === PHRASE, 'right password restores the phrase');
    ok((await decryptMnemonic(qr, 'wrong password')) === null, 'wrong password gives null');
  }
  const plain = parseMnemonicQr(JSON.stringify({ v: 3, type: 5, network_id: 104, chain_id: 'X', data: { plainMnemonic: PHRASE } }));
  ok(plain !== null && !plain.encrypted && plain.mnemonic === PHRASE, 'plain paper-wallet QR');
  ok(parseMnemonicQr('word word word') === null && parseMnemonicQr('{"type":2,"data":{}}') === null, 'other text / types are not mnemonic QRs');
  console.log(fails === 0 ? `ok (${checks} checks)` : `${fails} of ${checks} checks failed`);
  if (fails) process.exit(1);
})();
