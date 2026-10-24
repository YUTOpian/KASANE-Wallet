// Symbol 版 NEMonster：宛先（シンク）アドレスの導出と、取引ハッシュからのモンスターの確認。
// 実行: npx tsx dev-tests/nemonster-symbol.test.ts
import { addressFromPublicKey, isValidAddress } from '../src/lib/symbol/crypto';
import { symbolNemonsterSinkAddress } from '../src/lib/symbol/nemonster';
import { monsterFromHash } from '../src/lib/nem/monster';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const keyA = '3B9670B5CB19C893694FC49B461CE489BF9588BE16DBE8DC29CF06338133DEE6';
const keyB = 'C0C0FFEE00112233445566778899AABBCCDDEEFF00112233445566778899AABB';
const mainA = addressFromPublicKey(keyA, 0x68);
const testA = addressFromPublicKey(keyA, 0x98);
const mainB = addressFromPublicKey(keyB, 0x68);

const sinkA = symbolNemonsterSinkAddress(mainA, 0x68);
check('sink is a valid mainnet address', isValidAddress(sinkA, 0x68), sinkA);
check('sink is deterministic', symbolNemonsterSinkAddress(mainA, 0x68) === sinkA);
check('sink ignores hyphens and case', symbolNemonsterSinkAddress(mainA.toLowerCase().replace(/(.{6})/g, '$1-'), 0x68) === sinkA);
check('sink is not the account itself', sinkA !== mainA);
check('another account has another sink', symbolNemonsterSinkAddress(mainB, 0x68) !== sinkA);
const sinkTest = symbolNemonsterSinkAddress(testA, 0x98);
check('testnet sink is a valid testnet address', isValidAddress(sinkTest, 0x98), sinkTest);
check('testnet sink differs from mainnet sink', sinkTest !== sinkA);

// A Symbol transaction hash is 64 upper-case hex characters, like NEM's.
const h1 = 'A'.repeat(32) + 'B'.repeat(32);
const h2 = '0123456789ABCDEF'.repeat(4);
const m1 = monsterFromHash(h1);
check('monster is deterministic', JSON.stringify(monsterFromHash(h1)) === JSON.stringify(m1));
check('different hashes give different monsters', JSON.stringify(monsterFromHash(h2)) !== JSON.stringify(m1));
check('monster has a name', `${m1.name1} ${m1.name2}`.trim().length > 0);

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
