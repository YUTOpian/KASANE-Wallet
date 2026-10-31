// 手数料の5段階(最も遅い/遅い/標準/速い/最も速い)と、手数料の既定値。
// Run: npx tsx dev-tests/fee-speed.test.ts
import {
  FEE_SPEEDS, getDefaultFeeSpeed, isBelowAverageFee, isFeeSpeed, multipliersFromStats, setDefaultFeeSpeed,
} from '../src/lib/symbol/feeSpeed';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

ok(FEE_SPEEDS.join(',') === 'slowest,slow,standard,fast,fastest', 'five levels, slowest to fastest');
ok(isFeeSpeed('fastest') && isFeeSpeed('slowest') && !isFeeSpeed('fastes') && !isFeeSpeed(undefined), 'isFeeSpeed');
ok(isBelowAverageFee('slowest') && isBelowAverageFee('slow') && !isBelowAverageFee('standard') && !isBelowAverageFee('fast'), 'below-average levels');

// typical mainnet-like statistics
const m = multipliersFromStats(100, 200, 500);
ok(m.slowest === 100, 'slowest = network minimum', m);
ok(m.slow === 150, 'slow = halfway to the standard', m);
ok(m.standard === 200, 'standard = median', m);
ok(m.fast === 400, 'fast = twice the standard', m);
ok(m.fastest === 600 || m.fastest === 800 || (m.fastest >= 600 && m.fastest <= 800), 'fastest between 3x and 4x', m);
const order = FEE_SPEEDS.map((s) => m[s]);
ok(order.every((v, i) => i === 0 || v > order[i - 1]), 'strictly increasing when min < median', order);

// the busiest block is capped, a quiet network still gives a clearly higher fastest
ok(multipliersFromStats(100, 100, 100000).fastest === 400, 'outlier block capped at 4x');
ok(multipliersFromStats(100, 100, 0).fastest === 300, 'no highest known: 3x');

// degenerate statistics never go below 1 / never break the order
const d = multipliersFromStats(0, 0, 0);
ok(FEE_SPEEDS.every((s) => d[s] >= 1), 'multiplier is at least 1', d);
const e = multipliersFromStats(100, 50, 10); // median below minimum: standard lifted to min
ok(e.standard === 100 && e.slowest === 100 && e.slow === 100, 'median below minimum is lifted', e);
ok(FEE_SPEEDS.map((s) => e[s]).every((v, i, a) => i === 0 || v >= a[i - 1]), 'never decreasing', e);

// a malicious/compromised node reporting an absurd fee statistic must not be able to inflate every
// level without bound - this is the fee-drain finding from the defensive review (see feeSpeed.ts).
const malicious = multipliersFromStats(50_000_000, 50_000_000, 50_000_000);
ok(FEE_SPEEDS.every((s) => malicious[s] <= 1_000_000), 'malicious node stats are clamped at the sanity ceiling', malicious);
ok(malicious.slowest === 1_000_000 && malicious.standard === 1_000_000, 'even "slowest" is capped when minimum itself is the lie', malicious);

// default level
ok(getDefaultFeeSpeed() === 'standard', 'default is standard');
setDefaultFeeSpeed('fast');
ok(getDefaultFeeSpeed() === 'fast', 'default can be changed');
setDefaultFeeSpeed('nonsense' as never);
ok(getDefaultFeeSpeed() === 'standard', 'an unknown level falls back to standard');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
