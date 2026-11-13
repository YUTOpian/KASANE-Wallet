// NEM 版 DAO: DAO アカウントの鍵の導き方（同じ入力なら同じ鍵 / 違う入力なら違う鍵）。Run: npx tsx dev-tests/nem-dao-key.test.ts
import { deriveDaoKeyPair, daoAddressOf } from '../src/lib/nem/dao';
import { nemKeyPairFromPrivateKey, isValidNemAddress } from '../src/lib/nem/crypto';
import { setNetwork } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const admin = 'A'.repeat(63) + 'B';
const other = 'C'.repeat(64);

const a1 = deriveDaoKeyPair(admin, 'mydao');
const a2 = deriveDaoKeyPair(admin.toLowerCase(), 'mydao');
ok(a1.privateKey === a2.privateKey && a1.publicKey === a2.publicKey, 'same admin key + namespace → same DAO key (case of the hex does not matter)');
ok(/^[0-9A-F]{64}$/.test(a1.privateKey) && /^[0-9A-F]{64}$/.test(a1.publicKey), 'keys are 64 upper-case hex');
ok(nemKeyPairFromPrivateKey(a1.privateKey).publicKey === a1.publicKey, 'the public key belongs to the private key');
ok(deriveDaoKeyPair(admin, 'otherdao').publicKey !== a1.publicKey, 'another namespace → another DAO account');
ok(deriveDaoKeyPair(other, 'mydao').publicKey !== a1.publicKey, 'another administrator → another DAO account');
ok(a1.privateKey !== admin.toUpperCase(), 'the DAO key is not the administrator key');
const address = daoAddressOf(a1.publicKey);
ok(isValidNemAddress(address) && address.startsWith('T'), 'a testnet NEM address', address);

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
