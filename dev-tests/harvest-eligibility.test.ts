// 開始前の資格チェック: balance range, importance, and the node's checks (pure logic, no network).
// Run: npx tsx dev-tests/harvest-eligibility.test.ts
import { NODE_BEHIND_WARN_BLOCKS, hasBlocking, planAccountChecks, planNodeChecks } from '../src/lib/symbol/harvestEligibility';
import type { HarvestNodeCheck } from '../src/lib/symbol/api';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const state = (items: ReturnType<typeof planAccountChecks>, id: string) => items.find((i) => i.id === id)?.state;

const MIN = 10_000_000_000n, MAX = 50_000_000_000_000n;
const acc = (balance: bigint, importance: bigint) => planAccountChecks({ balance, min: MIN, max: MAX, importance });

ok(!hasBlocking(acc(MIN, 1n)), 'exactly the minimum with importance is fine');
ok(state(acc(MIN - 1n, 1n), 'balance_min') === 'ng', 'below the minimum is ng');
ok(hasBlocking(acc(MIN - 1n, 1n)), 'below the minimum blocks');
ok(state(acc(MAX, 1n), 'balance_max') === 'ok', 'exactly the maximum is fine');
ok(state(acc(MAX + 1n, 1n), 'balance_max') === 'ng', 'over the maximum is ng');
ok(hasBlocking(acc(MAX + 1n, 1n)), 'over the maximum blocks');
ok(state(acc(MIN, 0n), 'importance') === 'warn', 'importance 0 only warns');
ok(!hasBlocking(acc(MIN, 0n)), 'importance 0 does not block');

const good: HarvestNodeCheck = { reachable: true, networkMatches: true, isPeer: true, keyMatches: true, behindBlocks: 0, healthy: true };
ok(planNodeChecks(null).length === 0, 'nothing chosen lists nothing');
ok(!hasBlocking(planNodeChecks(good)), 'a good node does not block');
ok(planNodeChecks(good).some((i) => i.id === 'delegation' && i.state === 'unknown'), 'delegation acceptance is always "unknown"');
ok(hasBlocking(planNodeChecks({ ...good, isPeer: false })), 'an API-only node blocks');
ok(hasBlocking(planNodeChecks({ ...good, networkMatches: false })), 'another network blocks');
ok(!hasBlocking(planNodeChecks({ ...good, keyMatches: false })), 'a key mismatch only warns');
ok(planNodeChecks({ ...good, behindBlocks: NODE_BEHIND_WARN_BLOCKS + 1 }).find((i) => i.id === 'synced')?.state === 'warn', 'far behind warns');
ok(planNodeChecks({ ...good, behindBlocks: NODE_BEHIND_WARN_BLOCKS }).find((i) => i.id === 'synced')?.state === 'ok', 'at the limit is fine');
const unreachable = planNodeChecks({ reachable: false, networkMatches: null, isPeer: null, keyMatches: null, behindBlocks: null, healthy: null });
ok(!hasBlocking(unreachable) && unreachable[0].state === 'warn', 'unreachable only warns (it may just be a browser limit)');
const keyOnly = planNodeChecks({ reachable: null, networkMatches: null, isPeer: null, keyMatches: null, behindBlocks: null, healthy: null });
ok(keyOnly[0].state === 'unknown' && !hasBlocking(keyOnly), 'a key-only node is unknown, not blocked');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
