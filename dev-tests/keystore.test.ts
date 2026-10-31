// Run: npx tsx dev-tests/keystore.test.ts
// Checks lib/keystore.ts: an encrypted keystore opens with the right password only, hides the private key,
// refuses tampering with the address, and the plain key file round-trips. Reading also re-derives the public key and the
// address from the private key, so a file whose keys / address do not belong together is refused ('key_mismatch').
import { buildKeystore, buildPlainKeyFile, readKeystore, keystoreFilename, peekKeystore, KEYSTORE_MAX_FILE_CHARS } from '../src/lib/keystore';
import type { KeystoreAccount } from '../src/lib/keystore';
import { addressFromPublicKey, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } from '../src/lib/nem/crypto';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'error'; }
}

// Real key pairs: reading re-derives the public key and the address, so made-up values would be refused.
const PRIVATE = 'DEADBEEF'.repeat(8);
const OTHER_PRIVATE = '0123ABCD'.repeat(8);
const symKeys = keyPairFromPrivateKey(PRIVATE);
const otherSymKeys = keyPairFromPrivateKey(OTHER_PRIVATE);
const nemKeys = nemKeyPairFromPrivateKey(PRIVATE);
const account: KeystoreAccount = {
  chain: 'symbol',
  network: 'mainnet',
  address: addressFromPublicKey(symKeys.publicKey, 0x68),
  privateKey: PRIVATE,
  publicKey: symKeys.publicKey,
};
const nemAccount: KeystoreAccount = {
  chain: 'nem',
  network: 'mainnet',
  address: nemAddressFromPublicKey(nemKeys.publicKey, 0x68),
  privateKey: PRIVATE,
  publicKey: nemKeys.publicKey,
};
const PASSWORD = 'correct horse battery';
const nemPlainText = () => buildPlainKeyFile(nemAccount);

(async () => {
  const text = await buildKeystore(account, PASSWORD, new Date('2026-10-11T00:00:00Z'));
  const json = JSON.parse(text);
  check('encrypted: format and public fields', json.format === 'kasane-keystore' && json.address === account.address && json.publicKey === account.publicKey);
  check('encrypted: private key is not in the file', !text.toUpperCase().includes(account.privateKey));

  const back = await readKeystore(text, PASSWORD);
  check('encrypted: right password restores the keys', back.privateKey === account.privateKey && back.publicKey === account.publicKey && back.chain === 'symbol');
  check('encrypted: wrong password is refused', (await rejects(() => readKeystore(text, 'wrong password!'))) === 'wrong_password');

  const moved = JSON.stringify({ ...json, address: 'NZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' });
  check('encrypted: edited address is refused', (await rejects(() => readKeystore(moved, PASSWORD))) === 'wrong_password');

  const huge = JSON.stringify({ ...json, crypto: { ...json.crypto, kdfparams: { ...json.crypto.kdfparams, n: 1 << 30 } } });
  check('encrypted: absurd scrypt cost is refused', (await rejects(() => readKeystore(huge, PASSWORD))) === 'invalid_keystore');

  check('encrypted: short password is refused', (await rejects(() => buildKeystore(account, 'short'))) !== null);
  check('encrypted: two files differ (random salt/nonce)', text !== (await buildKeystore(account, PASSWORD)));

  const plain = buildPlainKeyFile(nemAccount);
  const plainBack = await readKeystore(plain);
  check('plain: round-trips both keys', plainBack.privateKey === nemAccount.privateKey && plainBack.publicKey === nemAccount.publicKey && plainBack.chain === 'nem');
  check('plain: the address is the derived one', plainBack.address === nemAccount.address);

  const symPlain = await readKeystore(buildPlainKeyFile(account));
  check('plain (symbol): round-trips', symPlain.address === account.address && symPlain.publicKey === account.publicKey);
  const hyphenated = JSON.stringify({ ...JSON.parse(buildPlainKeyFile(account)), address: account.address.toLowerCase().replace(/(.{6})/g, '$1-') });
  check('plain (symbol): a hyphenated lower-case address is accepted and comes back canonical', (await readKeystore(hyphenated)).address === account.address);

  // --- the keys and the address in the file must belong together
  const plainJson = JSON.parse(buildPlainKeyFile(account));
  const wrongPublic = JSON.stringify({ ...plainJson, publicKey: otherSymKeys.publicKey });
  check('plain: another public key is refused', (await rejects(() => readKeystore(wrongPublic))) === 'key_mismatch');
  const wrongAddress = JSON.stringify({ ...plainJson, address: addressFromPublicKey(otherSymKeys.publicKey, 0x68) });
  check('plain: another address is refused', (await rejects(() => readKeystore(wrongAddress))) === 'key_mismatch');
  const wrongNetwork = JSON.stringify({ ...plainJson, network: 'testnet' });
  check('plain: mainnet address under network testnet is refused', (await rejects(() => readKeystore(wrongNetwork))) === 'key_mismatch');
  const testnetAccount: KeystoreAccount = { ...account, network: 'testnet', address: addressFromPublicKey(symKeys.publicKey, 0x98) };
  check('plain: a testnet account reads back', (await readKeystore(buildPlainKeyFile(testnetAccount))).address === testnetAccount.address);
  const nemWrongAddress = JSON.stringify({ ...JSON.parse(buildPlainKeyFile(nemAccount)), address: nemAddressFromPublicKey(nemKeyPairFromPrivateKey(OTHER_PRIVATE).publicKey, 0x68) });
  check('plain (nem): another address is refused', (await rejects(() => readKeystore(nemWrongAddress))) === 'key_mismatch');
  const garbageAddress = JSON.stringify({ ...plainJson, address: 'not an address' });
  check('plain: an unreadable address is refused', (await rejects(() => readKeystore(garbageAddress))) === 'key_mismatch');

  // the public key of an encrypted file is not covered by the cipher text: editing it must still be caught
  const swappedPublic = JSON.stringify({ ...json, publicKey: otherSymKeys.publicKey });
  check('encrypted: an edited public key is refused even with the right password', (await rejects(() => readKeystore(swappedPublic, PASSWORD))) === 'key_mismatch');
  const nemBack = await readKeystore(await buildKeystore(nemAccount, PASSWORD), PASSWORD);
  check('encrypted (nem): round-trips', nemBack.address === nemAccount.address && nemBack.privateKey === PRIVATE);

  // peekKeystore: what a file is, without a password (the import screen decides between "ask the password" and "warn").
  const sealedText = await buildKeystore(account, PASSWORD);
  const plainText = buildPlainKeyFile(account);
  const peekSealed = peekKeystore(sealedText);
  check('peek: encrypted file', peekSealed.encrypted === true && peekSealed.chain === 'symbol' && peekSealed.network === 'mainnet' && peekSealed.address === account.address);
  const peekPlain = peekKeystore(plainText);
  check('peek: plain file is flagged as not encrypted', peekPlain.encrypted === false && peekPlain.address === account.address);
  check('peek: nem file', peekKeystore(buildPlainKeyFile(nemAccount)).chain === 'nem');
  check('peek: reveals no key', !JSON.stringify(peekSealed).includes(PRIVATE) && !JSON.stringify(peekPlain).includes(PRIVATE));
  const peekFails = (text: string) => { try { peekKeystore(text); return false; } catch (e) { return e instanceof Error && e.message === 'invalid_keystore'; } };
  check('peek: garbage / not an object / unknown format are refused', peekFails('not json') && peekFails('null') && peekFails('[]') && peekFails(JSON.stringify({ ...JSON.parse(plainText), format: 'something-else' })));
  check('peek: unknown chain / network are refused', peekFails(JSON.stringify({ ...JSON.parse(plainText), chain: 'btc' })) && peekFails(JSON.stringify({ ...JSON.parse(plainText), network: 'devnet' })) && peekFails(JSON.stringify({ ...JSON.parse(nemPlainText()), network: 'mijin' })));
  check('peek: a huge file is refused before parsing', peekFails(' '.repeat(KEYSTORE_MAX_FILE_CHARS + 1) + plainText));
  check('read: a huge file is refused too', (await rejects(() => readKeystore(' '.repeat(KEYSTORE_MAX_FILE_CHARS + 1) + plainText))) === 'invalid_keystore');
  check('read: an unknown format is refused', (await rejects(() => readKeystore(JSON.stringify({ ...JSON.parse(plainText), format: 'x' })))) === 'invalid_keystore');

  check('invalid: garbage is refused', (await rejects(() => readKeystore('not json'))) === 'invalid_keystore');
  check('filename', keystoreFilename(account, true, new Date('2026-10-11T00:00:00Z')) === `kasane-keystore-symbol-${account.address.slice(0, 6)}-20261011.json`);

  if (failed > 0) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
})();
