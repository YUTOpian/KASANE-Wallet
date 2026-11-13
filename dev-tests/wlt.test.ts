// Run: npx tsx dev-tests/wlt.test.ts
// Checks lib/nem/wlt.ts against the official wallet's own way of sealing a key (nem-sdk: Keccak-256 x20 + AES-CBC,
// done here with CryptoJS exactly as nem-sdk does), so a file made here opens in the official wallet and the other way round.
import CryptoJS from 'crypto-js';
import { buildWlt, derivePassSha, openWlt, parseWlt, wltFilename } from '../src/lib/nem/wlt';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } from '../src/lib/nem/crypto';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'error'; }
}

const PRIVATE_KEY = '5C1D3A6B7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9A0B1C2D3E4F50617283';
const PASSWORD = 'correct horse battery';
const pair = nemKeyPairFromPrivateKey(PRIVATE_KEY);

// nem-sdk (cryptoHelpers.js), copied in behaviour: derivePassSha / encodePrivKey / decrypt.
function sdkDerive(password: string, count: number): string {
  let data: CryptoJS.lib.WordArray | string = password;
  for (let i = 0; i < count; i += 1) data = CryptoJS.SHA3(data, { outputLength: 256 });
  return CryptoJS.enc.Hex.stringify(data as CryptoJS.lib.WordArray);
}
function sdkEncode(privateKey: string, password: string): { ciphertext: string; iv: string } {
  const key = CryptoJS.enc.Hex.parse(sdkDerive(password, 20));
  const ivHex = '000102030405060708090a0b0c0d0e0f';
  const enc = CryptoJS.AES.encrypt(CryptoJS.enc.Hex.parse(privateKey), key, { iv: CryptoJS.enc.Hex.parse(ivHex) });
  return { ciphertext: CryptoJS.enc.Hex.stringify(enc.ciphertext), iv: ivHex };
}
function officialWlt(name: string, algo: string, encrypted: string, iv: string, address: string, network: number, extra: object = {}): string {
  const wallet = { name, accounts: { 0: { brain: algo === 'pass:6k', algo, encrypted, iv, address, label: 'Primary', network, ...extra } } };
  return Buffer.from(JSON.stringify(wallet), 'utf8').toString('base64');
}

// 1. key derivation
check('derivePassSha matches nem-sdk (x20)', Buffer.from(derivePassSha(PASSWORD, 20)).toString('hex') === sdkDerive(PASSWORD, 20));
check('derivePassSha matches nem-sdk (x6000, brain)', Buffer.from(derivePassSha('brain pass', 6000)).toString('hex') === sdkDerive('brain pass', 6000));
check('derivePassSha: non-ASCII password', Buffer.from(derivePassSha('パスワード🔑', 20)).toString('hex') === sdkDerive('パスワード🔑', 20));

// 2. a file made here
const text = buildWlt({ name: 'KASANE test', privateKey: PRIVATE_KEY, publicKey: pair.publicKey, networkByte: 0x68 }, PASSWORD);
const json = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
const acc = json.accounts['0'];
check('made: Base64 of JSON with name and accounts[0]', json.name === 'KASANE test' && acc !== undefined);
check('made: official fields (algo pass:enc, brain false, label Primary, network 104)', acc.algo === 'pass:enc' && acc.brain === false && acc.label === 'Primary' && acc.network === 104);
check('made: address is the key\'s mainnet address', acc.address === nemAddressFromPublicKey(pair.publicKey, 0x68) && acc.address.startsWith('N'));
check('made: cipher text is 48 bytes, iv 16 bytes (hex)', /^[0-9a-f]{96}$/.test(acc.encrypted) && /^[0-9a-f]{32}$/.test(acc.iv));
check('made: private key is not in the file', !text.includes(PRIVATE_KEY) && !Buffer.from(text, 'base64').toString('utf8').toUpperCase().includes(PRIVATE_KEY));
// What the official wallet does when it opens the file: decrypt with nem-sdk's code.
{
  const key = CryptoJS.enc.Hex.parse(sdkDerive(PASSWORD, 20));
  const plain = CryptoJS.AES.decrypt({ ciphertext: CryptoJS.enc.Hex.parse(acc.encrypted) } as CryptoJS.lib.CipherParams, key, { iv: CryptoJS.enc.Hex.parse(acc.iv) });
  check('made: nem-sdk decrypts it to the same private key', CryptoJS.enc.Hex.stringify(plain).toUpperCase() === PRIVATE_KEY);
}
check('made: reads back with the right password', (() => { const r = openWlt(parseWlt(text), PASSWORD); return r.privateKey === PRIVATE_KEY && r.publicKey === pair.publicKey && r.name === 'KASANE test' && r.networkByte === 0x68; })());
check('made: wrong password is refused', throws(() => openWlt(parseWlt(text), 'wrong password!')) === 'wrong_password');
check('made: empty password is refused', throws(() => openWlt(parseWlt(text), '')) === 'wrong_password');
check('made: two files of one key differ (random iv)', buildWlt({ name: 'a', privateKey: PRIVATE_KEY, publicKey: pair.publicKey, networkByte: 0x68 }, PASSWORD) !== text);

// 3. testnet
const testText = buildWlt({ name: 'test net', privateKey: PRIVATE_KEY, publicKey: pair.publicKey, networkByte: 0x98 }, PASSWORD);
const testJson = JSON.parse(Buffer.from(testText, 'base64').toString('utf8')).accounts['0'];
check('testnet: network -104 and a T address', testJson.network === -104 && testJson.address.startsWith('T'));
check('testnet: reads back with networkByte 0x98', openWlt(parseWlt(testText), PASSWORD).networkByte === 0x98);

// 4. a file made by the official wallet (nem-sdk)
{
  const sealed = sdkEncode(PRIVATE_KEY, PASSWORD);
  const official = officialWlt('Official wallet', 'pass:enc', sealed.ciphertext, sealed.iv, nemAddressFromPublicKey(pair.publicKey, 0x68), 104, { child: 'a'.repeat(40) });
  const r = openWlt(parseWlt(official), PASSWORD);
  check('official pass:enc file opens', r.privateKey === PRIVATE_KEY && r.name === 'Official wallet');
  const bip32 = officialWlt('PRNG wallet', 'pass:bip32', sealed.ciphertext, sealed.iv, nemAddressFromPublicKey(pair.publicKey, 0x68), 104);
  check('official pass:bip32 file opens', openWlt(parseWlt(bip32), PASSWORD).privateKey === PRIVATE_KEY);
  check('official file with a wrong address field is refused', throws(() => openWlt(parseWlt(officialWlt('x', 'pass:enc', sealed.ciphertext, sealed.iv, nemAddressFromPublicKey(pair.publicKey, 0x98), 104)), PASSWORD)) === 'wrong_password');
  check('hyphenated address in the file is accepted', openWlt(parseWlt(officialWlt('x', 'pass:enc', sealed.ciphertext, sealed.iv, nemAddressFromPublicKey(pair.publicKey, 0x68).match(/.{1,6}/g)!.join('-'), 104)), PASSWORD).privateKey === PRIVATE_KEY);
  check('file with line breaks / BOM is accepted', parseWlt('\uFEFF' + official.replace(/(.{60})/g, '$1\r\n') + '\n').name === 'Official wallet');
  check('plain JSON text is accepted too', parseWlt(Buffer.from(official, 'base64').toString('utf8')).name === 'Official wallet');
  // 66-char key with a leading 00 byte (nem-sdk allows it)
  const padded = CryptoJS.AES.encrypt(CryptoJS.enc.Hex.parse('00' + PRIVATE_KEY), CryptoJS.enc.Hex.parse(sdkDerive(PASSWORD, 20)), { iv: CryptoJS.enc.Hex.parse(sealed.iv) });
  check('00-prefixed key is accepted', openWlt(parseWlt(officialWlt('p', 'pass:enc', CryptoJS.enc.Hex.stringify(padded.ciphertext), sealed.iv, nemAddressFromPublicKey(pair.publicKey, 0x68), 104)), PASSWORD).privateKey === PRIVATE_KEY);
}

// 5. brain wallet: the key is the passphrase hashed 6000 times, nothing is encrypted
{
  const brainKey = sdkDerive('my brain passphrase', 6000).toUpperCase();
  const brainPair = nemKeyPairFromPrivateKey(brainKey);
  const brain = officialWlt('Brain', 'pass:6k', '', '', nemAddressFromPublicKey(brainPair.publicKey, 0x68), 104);
  check('brain wallet opens with the passphrase', openWlt(parseWlt(brain), 'my brain passphrase').privateKey === brainKey);
  check('brain wallet: wrong passphrase is refused', throws(() => openWlt(parseWlt(brain), 'another passphrase')) === 'wrong_password');
}

// 6. things that must be refused
check('garbage is invalid_wlt', throws(() => parseWlt('this is not a wallet')) === 'invalid_wlt');
check('empty text is invalid_wlt', throws(() => parseWlt('')) === 'invalid_wlt');
check('JSON without accounts is invalid_wlt', throws(() => parseWlt(Buffer.from('{"name":"x"}').toString('base64'))) === 'invalid_wlt');
check('hardware wallet (trezor) is unsupported', throws(() => parseWlt(officialWlt('hw', 'trezor', '', '', 'NABC', 104))) === 'unsupported_wlt');
check('mijin network (96) is unsupported', throws(() => parseWlt(officialWlt('mj', 'pass:enc', 'aa', 'bb', 'MABC', 96))) === 'unsupported_wlt');
check('pass:enc without cipher text is invalid_wlt', throws(() => parseWlt(officialWlt('x', 'pass:enc', '', '', 'NABC', 104))) === 'invalid_wlt');
check('non-hex cipher text is invalid_wlt', throws(() => parseWlt(officialWlt('x', 'pass:enc', 'zz', 'zz', 'NABC', 104))) === 'invalid_wlt');
check('too short password is refused on writing', throws(() => buildWlt({ name: 'a', privateKey: PRIVATE_KEY, publicKey: pair.publicKey, networkByte: 0x68 }, 'short')) === 'password_too_short');
check('empty name is refused on writing', throws(() => buildWlt({ name: '  ', privateKey: PRIVATE_KEY, publicKey: pair.publicKey, networkByte: 0x68 }, PASSWORD)) === 'invalid_name');
check('a key that does not match the public key is refused on writing', throws(() => buildWlt({ name: 'a', privateKey: PRIVATE_KEY, publicKey: 'AB'.repeat(32), networkByte: 0x68 }, PASSWORD)) === 'key_mismatch');

// 7. file name
check('file name: <name>.wlt', wltFilename('My wallet') === 'My wallet.wlt');
check('file name: unsafe characters replaced', wltFilename('a/b:c*?') === 'a_b_c__.wlt');
check('file name: empty falls back', wltFilename('   ') === 'wallet.wlt');

console.log(failed === 0 ? '\nall ok' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
