// NEM「ハーベスト統計」の集計（lib/nem/harvestStats.ts）。
// Run: node --experimental-strip-types dev-tests/nem-harvest-stats.test.ts   (or npx tsx)
import { sortNemHarvestsNewestFirst, summarizeNemHarvests } from '../src/lib/nem/harvestStats.ts';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const blocks = [
  { height: '5000100', timestampMs: 1_700_000_100_000, atomic: 3_000_000n },
  { height: '5000300', timestampMs: 1_700_000_300_000, atomic: 0n },
  { height: '5000200', timestampMs: 1_700_000_200_000, atomic: 4_500_000n },
];

const empty = summarizeNemHarvests([]);
ok(empty.totalFee === 0n && empty.averageFee === null && empty.last === null, 'empty list: total 0, no average, no last block');

const s = summarizeNemHarvests(blocks);
ok(s.totalFee === 7_500_000n, 'total fee is the sum of the block fees', s.totalFee);
ok(s.averageFee === 2_500_000n, 'average fee is the total over the number of blocks (a 0-fee block counts)', s.averageFee);
ok(s.last?.height === '5000300', 'the last block is the one with the highest height, whatever the order', s.last);

const sorted = sortNemHarvestsNewestFirst(blocks);
ok(sorted.map((b) => b.height).join() === '5000300,5000200,5000100', 'newest block first', sorted.map((b) => b.height));
ok(blocks[0].height === '5000100', 'sorting does not change the original array');
ok(sortNemHarvestsNewestFirst([{ height: '99999999999999999999', timestampMs: null, atomic: 1n }, { height: '1', timestampMs: null, atomic: 1n }])[0].height === '99999999999999999999', 'heights are compared as numbers, not text');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails) process.exit(1);
