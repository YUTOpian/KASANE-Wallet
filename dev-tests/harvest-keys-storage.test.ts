// 委任ハーベストの開始時に作るリモート／VRFの秘密鍵の保存（パスワードで暗号化）。ウォレットの暗号化まわりだけを確かめる。
// Run: npx tsx dev-tests/harvest-keys-storage.test.ts
import { Wallet } from '../src/lib/storage';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const R = 'ab'.repeat(32), V = 'CD'.repeat(32);
const w = await Wallet.createWithKeys('t', 'AA'.repeat(32), 'BB'.repeat(32), 'pw-old');

ok(w.encryptedHarvestKeys === '' && (await w.decryptHarvestKeys('pw-old')) === null, 'nothing kept at first');

await w.setHarvestKeys({ remotePrivateKey: R, vrfPrivateKey: V }, 'pw-old');
ok(w.encryptedHarvestKeys !== '' && !w.encryptedHarvestKeys.includes(R) && !w.encryptedHarvestKeys.toLowerCase().includes(V.toLowerCase()), 'kept encrypted (the keys do not appear in the stored text)');
const back = await w.decryptHarvestKeys('pw-old');
ok(back !== null && back.remotePrivateKey === R.toUpperCase() && back.vrfPrivateKey === V.toUpperCase() && back.savedAt > 0, 'right password: both keys come back (upper case)', back);
ok((await w.decryptHarvestKeys('pw-wrong')) === null, 'wrong password: nothing');

// a password change re-encrypts the kept keys too
ok(await w.encryptSecret('pw-old', 'pw-new'), 'password change succeeds');
ok((await w.decryptHarvestKeys('pw-old')) === null, 'after the change the old password no longer opens the keys');
const moved = await w.decryptHarvestKeys('pw-new');
ok(moved !== null && moved.remotePrivateKey === R.toUpperCase() && moved.vrfPrivateKey === V.toUpperCase(), 'after the change the new password opens the keys', moved);
ok((await w.decryptSecret('pw-new')) === 'BB'.repeat(32), 'the account secret follows the password as before');

// the same-password re-encryption used for the format upgrade keeps them readable
ok(await w.encryptSecret('pw-new', 'pw-new') && (await w.decryptHarvestKeys('pw-new')) !== null, 'same-password re-encryption keeps the keys');

// a wallet without kept keys is unaffected by a password change
const plain = await Wallet.createWithKeys('p', 'CC'.repeat(32), 'DD'.repeat(32), 'a');
ok(await plain.encryptSecret('a', 'b') && plain.encryptedHarvestKeys === '', 'no keys kept: a password change leaves it that way');

// damaged / unexpected content is refused, not trusted
const bad = await Wallet.createWithKeys('b', 'EE'.repeat(32), 'FF'.repeat(32), 'pw');
await bad.setHarvestKeys({ remotePrivateKey: 'zz', vrfPrivateKey: V }, 'pw');
ok((await bad.decryptHarvestKeys('pw')) === null, 'keys that are not 64 hex chars are refused on reading');
bad.encryptedHarvestKeys = 'v2:not-really-encrypted';
ok((await bad.decryptHarvestKeys('pw')) === null, 'damaged data: null, no throw');

// an old saved wallet (without the field) loads with none kept
const legacy = Object.assign(new Wallet(), { id: 'x', encryptedSecret: w.encryptedSecret });
ok(legacy.encryptedHarvestKeys === '' && (await legacy.decryptHarvestKeys('pw-new')) === null, 'wallets saved before this feature have no kept keys');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
