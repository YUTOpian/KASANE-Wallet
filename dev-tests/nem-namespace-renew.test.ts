// NEM「ネームスペースの更新」の日数・期限の計算（lib/nem/namespaceRenew.ts）。
// Run: npx tsx dev-tests/nem-namespace-renew.test.ts（ネットワーク不要）
import { NEM_RENEW_DAYS, nemExtendedExpiryMs, nemRemainingDays, renewableNemNamespaces } from '../src/lib/nem/namespaceRenew';
import { NEM_BLOCKS_PER_DAY, NEM_NAMESPACE_DURATION_BLOCKS } from '../src/lib/nem/tx';
import type { NemOwnedNamespace } from '../src/lib/nem/api';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const DAY = 24 * 60 * 60 * 1000;
const row = (name: string, remainingBlocks: number | undefined, depth = 1): NemOwnedNamespace => ({
  name, depth, expired: remainingBlocks !== undefined && remainingBlocks < 0, expiresAtMs: 1_800_000_000_000, remainingBlocks,
});

// 1年 = 365日 = 525,600ブロック
ok(NEM_RENEW_DAYS === 365, 'one renewal is 365 days');
ok(NEM_RENEW_DAYS * NEM_BLOCKS_PER_DAY === NEM_NAMESPACE_DURATION_BLOCKS, '365 days equals the rental length in blocks');

// 残り日数: 切り捨て。期限切れ・不明は null
ok(nemRemainingDays(row('a', 31 * NEM_BLOCKS_PER_DAY)) === 31, '31 days exactly');
ok(nemRemainingDays(row('a', 31 * NEM_BLOCKS_PER_DAY + 1439)) === 31, 'rounded down');
ok(nemRemainingDays(row('a', 0)) === 0, 'zero blocks left is 0 days');
ok(nemRemainingDays(row('a', -5)) === null, 'expired is null');
ok(nemRemainingDays(row('a', undefined)) === null, 'unknown height is null');

// 延長後の期限 = 今の期限 + 365日
ok(nemExtendedExpiryMs(row('a', 100)) === 1_800_000_000_000 + 365 * DAY, 'extended expiry adds a year');

// 対象: ルートだけ、1か月以内か期限切れ。期限が近い順
const list = renewableNemNamespaces([
  row('far', 60 * NEM_BLOCKS_PER_DAY),
  row('soon', 10 * NEM_BLOCKS_PER_DAY),
  row('expired', -100),
  row('sub', 5 * NEM_BLOCKS_PER_DAY, 2),
  row('unknown', undefined),
]);
ok(list.map((r) => r.name).join(',') === 'expired,soon', 'renewable roots, soonest first', list.map((r) => r.name));

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
