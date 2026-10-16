// Run: npx tsx dev-tests/keystore.test.ts
// Checks lib/keystore.ts: an encrypted keystore opens with the right password only, hides the private key,
// refuses tampering with the address, and the plain key file round-trips.
import { buildKeystore, buildPlainKeyFile, readKeystore, keystoreFilename } from '../src/lib/keystore';
import type { KeystoreAccount } from '../src/lib/keystore';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'error'; }
}

const account: KeystoreAccount = {
  chain: 'symbol',
  network: 'mainnet',
  address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG',
  privateKey: 'DEADBEEF'.repeat(8),
  publicKey: 'ABCDEF01'.repeat(8),
};
const PASSWORD = 'correct horse battery';

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

  const plain = buildPlainKeyFile({ ...account, chain: 'nem' });
  const plainBack = await readKeystore(plain);
  check('plain: round-trips both keys', plainBack.privateKey === account.privateKey && plainBack.publicKey === account.publicKey && plainBack.chain === 'nem');
  check('invalid: garbage is refused', (await rejects(() => readKeystore('not json'))) === 'invalid_keystore');
  check('filename', keystoreFilename(account, true, new Date('2026-10-11T00:00:00Z')) === 'kasane-keystore-symbol-NBCDEF-20261011.json');

  if (failed > 0) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
})();
