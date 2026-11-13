// Symbol 事後オプトイン（デモ）：画面の判定。
// Run: node --experimental-strip-types dev-tests/optin-post.test.ts   （または npx tsx）
import {
  RANDOM_CLAIM_MAX_MICRO, RANDOM_CLAIM_MIN_MICRO, amountLabelKey, canClaim, canStart, formatClaimAmount, isPublicKeyFormat,
  isUnusedOnNem, randomClaimAmount, showsDestination,
} from '../src/lib/optin/post.ts';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const hex64 = 'a'.repeat(64);
ok(isPublicKeyFormat(hex64), '64 hex chars is a public key');
ok(isPublicKeyFormat(` ${hex64.toUpperCase()} `), 'upper case and surrounding spaces are fine');
ok(!isPublicKeyFormat('a'.repeat(63)), '63 chars is not');
ok(!isPublicKeyFormat('g'.repeat(64)), 'non-hex is not');

ok(isUnusedOnNem({ balance: 0, publicKey: null }, { balance: 0, publicKey: null }), 'unused on both readings → a Symbol key');
ok(!isUnusedOnNem({ balance: 5, publicKey: null }, { balance: 0, publicKey: null }), 'balance as a public key → NIS1 key');
ok(!isUnusedOnNem({ balance: 0, publicKey: null }, { balance: 0, publicKey: 'ab' }), 'known public key as a private key → NIS1 key');
ok(isUnusedOnNem(null, null), 'node did not answer → accepted');
ok(!isUnusedOnNem(null, { balance: 1, publicKey: null }), 'one answer is enough to refuse');

ok(formatClaimAmount(1_234_500_000n) === '1234.5', 'trailing zeros are dropped');
ok(formatClaimAmount(2_000_000n) === '2', 'whole numbers have no point');
ok(formatClaimAmount(1_000_001n) === '1.000001', 'small fractions are kept');
ok(formatClaimAmount(0n) === '0', 'zero');

ok(randomClaimAmount(() => 0) === RANDOM_CLAIM_MIN_MICRO, 'lowest draw → 1 XYM');
ok(randomClaimAmount(() => 0.9999999999) <= RANDOM_CLAIM_MAX_MICRO, 'highest draw stays within 1,000,000 XYM');
let inRange = true, allClaimable = true;
for (let i = 0; i < 2000; i++) {
  const v = randomClaimAmount();
  if (v < RANDOM_CLAIM_MIN_MICRO || v > RANDOM_CLAIM_MAX_MICRO) inRange = false;
  if (!canClaim(v)) allClaimable = false;
}
ok(inRange, 'random amounts are between 1 and 1,000,000 XYM');
ok(allClaimable, 'every random amount can be claimed');
ok(canClaim(1_000_000n) && !canClaim(999_999n), 'claim threshold is 1');

ok(canStart(1, 5_000_000n), 'start only when not done');
ok(!canStart(2, 5_000_000n) && !canStart(6, 5_000_000n), 'no start when pending / done');
ok(!canStart(1, 999_999n), 'no start when too little');
ok(amountLabelKey(1) === 'amount' && amountLabelKey(2) === 'amount_claimed' && amountLabelKey(6) === 'amount_claimed', 'amount label by status');
ok(!showsDestination(1) && showsDestination(2) && showsDestination(6), 'destination shown once requested');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails) process.exit(1);
