// NEM apostille (notarization): message layout, hashes (Keccak "SHA3"), signing, dedicated account, file names.
// Run: npx tsx dev-tests/nem-apostille.test.ts
import { bytesToHex } from '@noble/hashes/utils.js';
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import {
  APOSTILLE_HASHINGS, apostilleFee, apostilleFileName, apostilleSink, buildApostilleMessage, dedicatedAccount,
  parseApostilleFileName, verifyApostille,
} from '../src/lib/nem/apostille';
import { isValidNemAddress } from '../src/lib/nem/crypto';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const owner = '1'.repeat(63) + '2';
const ownerPub = new KeyPair(new PrivateKey(owner)).publicKey.toString();
const file = new TextEncoder().encode('abc');

// known digests of "abc": the SHA3 of NEM is Keccak (not NIST SHA3-256 = 3a985da7...)
const H = APOSTILLE_HASHINGS;
ok(buildApostilleMessage(file, H.MD5, false).fileHash === '900150983cd24fb0d6963f7d28e17f72', 'md5');
ok(buildApostilleMessage(file, H.SHA1, false).fileHash === 'a9993e364706816aba3e25717850c26c9cd0d89d', 'sha1');
ok(buildApostilleMessage(file, H.SHA256, false).fileHash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256');
ok(buildApostilleMessage(file, H['SHA3-256'], false).fileHash === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', 'keccak-256 (NEM "SHA3-256")');

// public message layout
const pub = buildApostilleMessage(file, H.SHA256, false);
ok(pub.messageHex === 'fe4e545903' + pub.fileHash && pub.message.length === 37, 'public layout fe 4e 54 59 03 + hash', pub.messageHex);
ok(apostilleFee(pub.message) === 150_000n, 'fee of a public SHA256 apostille = 0.05 + 2 x 0.05');
ok(verifyApostille(file, pub.messageHex, ownerPub) === 'valid', 'public verifies');
ok(verifyApostille(new TextEncoder().encode('abd'), pub.messageHex, ownerPub) === 'invalid', 'changed file fails');

// signed message
const sig = buildApostilleMessage(file, H.SHA256, true, owner);
ok(sig.messageHex.startsWith('fe4e545983') && sig.message.length === 5 + 64, 'signed layout fe 4e 54 59 83 + signature', sig.messageHex.slice(0, 12));
ok(apostilleFee(sig.message) === 200_000n, 'fee of a signed apostille = 0.05 + 3 x 0.05');
ok(verifyApostille(file, sig.messageHex, ownerPub) === 'valid', 'signed verifies with the owner key');
const otherPub = new KeyPair(new PrivateKey('3'.repeat(64))).publicKey.toString();
ok(verifyApostille(file, sig.messageHex, otherPub) === 'invalid', 'signed fails with another key');
ok(verifyApostille(new TextEncoder().encode('abd'), sig.messageHex, ownerPub) === 'invalid', 'signed: changed file fails');
for (const name of ['SHA256', 'SHA3-256', 'SHA3-512'] as const) {
  const m = buildApostilleMessage(file, H[name], true, owner);
  ok(verifyApostille(file, m.messageHex, ownerPub) === 'valid', `signed ${name} round-trip`);
}
let threw = false;
try { buildApostilleMessage(file, H.SHA256, true); } catch { threw = true; }
ok(threw, 'signing without a key is refused');

ok(verifyApostille(file, 'deadbeef', ownerPub) === 'not_apostille', 'not an apostille message');
ok(verifyApostille(file, '', ownerPub) === 'not_apostille', 'empty message');
ok(verifyApostille(file, 'fe4e545999' + 'aa'.repeat(32), ownerPub) === 'not_apostille', 'unknown hashing byte');

// dedicated account: stable per owner+name, differs by name and owner, valid address
const d1 = dedicatedAccount(owner, 'report.pdf', 0x68);
const d2 = dedicatedAccount(owner, 'report.pdf', 0x68);
ok(d1.address === d2.address && d1.publicKey === d2.publicKey, 'dedicated account is deterministic');
ok(dedicatedAccount(owner, 'other.pdf', 0x68).address !== d1.address, 'differs by file name');
ok(dedicatedAccount('3'.repeat(64), 'report.pdf', 0x68).address !== d1.address, 'differs by owner');
ok(isValidNemAddress(d1.address, 0x68) && d1.address.startsWith('N'), 'valid mainnet address', d1.address);
ok(dedicatedAccount(owner, 'report.pdf', 0x98).address.startsWith('T'), 'testnet address');
ok(isValidNemAddress(apostilleSink(0x68), 0x68) && isValidNemAddress(apostilleSink(0x98), 0x98), 'sink addresses are valid');

// file names
const tx = 'AB'.repeat(32);
const named = apostilleFileName('my report v2.pdf', tx, new Date(2026, 9, 12));
ok(named === `my report v2 -- Apostille TX ${tx} -- Date 2026-10-12.pdf`, 'renamed file', named);
const parsed = parseApostilleFileName(named);
ok(parsed?.originalName === 'my report v2.pdf' && parsed.txHash === tx && parsed.date === '2026-10-12', 'name round-trips', parsed);
ok(parseApostilleFileName('plain.pdf') === null, 'a plain name is not an apostille name');
ok(parseApostilleFileName(apostilleFileName('noext', tx, new Date(2026, 0, 2)))?.originalName === 'noext', 'no extension');
ok(parseApostilleFileName(apostilleFileName('契約書.pdf', tx, new Date(2026, 0, 2)))?.originalName === '契約書.pdf', 'japanese name');
ok(bytesToHex(new Uint8Array([1, 2])) === '0102', 'sanity');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
