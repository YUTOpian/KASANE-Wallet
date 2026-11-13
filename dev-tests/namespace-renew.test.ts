// Extending a root namespace (Symbol): which roots qualify, how far they can be extended, the entered days.
// Run: npx tsx dev-tests/namespace-renew.test.ts
import { MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS } from '../src/lib/symbol/tx';
import {
  DAY_MS, RENEW_WINDOW_DAYS, expiringRoots, extendedExpiryMs, isExpiringSoon, isMaxedOut, isRenewableRoot,
  maxExtensionDays, remainingDays, validateRenewDays,
} from '../src/lib/symbol/namespaceRenew';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const now = 1_800_000_000_000;
const root = (daysLeft: number, over: Partial<{ depth: number; eternal: boolean; expired: boolean; expiresAtMs: number | null }> = {}) =>
  ({ depth: 1, eternal: false, expired: false, expiresAtMs: now + daysLeft * DAY_MS, ...over });

// --- which rows can be extended
ok(isRenewableRoot(root(100)), 'an active root');
ok(isRenewableRoot(root(-3, { expired: true })), 'an expired root stays (grace period)');
ok(!isRenewableRoot(root(100, { depth: 2 })), 'a sub-namespace follows its root');
ok(!isRenewableRoot(root(0, { eternal: true, expiresAtMs: null })), 'an eternal one has nothing to extend');

// --- remaining days
ok(remainingDays(root(100), now) === 100, 'remaining days');
ok(remainingDays(root(100.9), now) === 100, 'rounded down');
ok(remainingDays(root(-3, { expired: true }), now) === null, 'expired has none');

// --- the expiry window
ok(isExpiringSoon(root(RENEW_WINDOW_DAYS), now), 'exactly the window');
ok(!isExpiringSoon(root(RENEW_WINDOW_DAYS + 1), now), 'just outside the window');
ok(!isExpiringSoon(root(-1, { expired: true }), now), 'expired is not "soon" (it already is)');
ok(!isExpiringSoon(root(5, { depth: 2 }), now), 'a sub-namespace is never flagged');
const list = expiringRoots([root(20), root(400), root(5), root(10, { depth: 2 })], now);
ok(list.length === 2 && list[0].expiresAtMs === now + 5 * DAY_MS, 'only roots in the window, soonest first');

// --- how far it can be extended
ok(maxExtensionDays(root(100), now) === MAX_NAMESPACE_DAYS - 101, 'ceiling minus what is left, minus one day of slack');
ok(maxExtensionDays(root(-3, { expired: true }), now) === MAX_NAMESPACE_DAYS, 'expired starts from the ceiling');
ok(maxExtensionDays(root(MAX_NAMESPACE_DAYS + 50), now) === 0, 'never below zero');
ok(!isMaxedOut(root(100), now), 'plenty of room');
ok(isMaxedOut(root(MAX_NAMESPACE_DAYS - 10), now), 'less than the shortest rental fits');
ok(isMaxedOut(root(MAX_NAMESPACE_DAYS - MIN_NAMESPACE_DAYS), now), 'the shortest rental no longer fits by the slack day');
ok(!isMaxedOut(root(MAX_NAMESPACE_DAYS - MIN_NAMESPACE_DAYS - 2), now), 'the shortest rental still fits');

// --- the after date
ok(extendedExpiryMs(root(100), 365) === now + 465 * DAY_MS, 'days are added onto the current end');
ok(extendedExpiryMs(root(-3, { expired: true }), 365) === null, 'no estimate for an expired one');

// --- entered days
const r = root(100);
ok(validateRenewDays(r, '', now) === 'invalid', 'empty');
ok(validateRenewDays(r, '3.5', now) === 'invalid', 'not whole days');
ok(validateRenewDays(r, String(MIN_NAMESPACE_DAYS - 1), now) === 'range', 'below the shortest rental');
ok(validateRenewDays(r, String(MAX_NAMESPACE_DAYS + 1), now) === 'range', 'above the longest rental');
ok(validateRenewDays(r, String(MIN_NAMESPACE_DAYS), now) === null, 'the shortest rental');
ok(validateRenewDays(r, String(maxExtensionDays(r, now)), now) === null, 'exactly the room that is left');
ok(validateRenewDays(r, String(maxExtensionDays(r, now) + 1), now) === 'over_max', 'one day too many');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} FAILED`);
process.exit(fails === 0 ? 0 : 1);
