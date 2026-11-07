// 投票終了時点の保有量の扱い（NEM・Symbol 共通の純粋な部分）: 保有量 0 の票の除外と、終了後の移動の巻き戻し。
// Run: npx tsx dev-tests/voting-holdings.test.ts
import { dropZeroHolders, emptyTally, holdingAtEnd } from '../src/lib/votingHoldings';
import type { TallyLike } from '../src/lib/votingHoldings';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// --- holdingAtEnd: now - (change after the end) ---
eq(holdingAtEnd(150, 50), 100, 'received 50 after the end: 150 now -> 100 at the end');
eq(holdingAtEnd(0, -300), 300, 'sent 300 after the end: 0 now -> 300 at the end');
eq(holdingAtEnd(300, 300), 0, 'received everything after the end: nothing at the end');
eq(holdingAtEnd(10, 50), 0, 'never below 0');
eq(holdingAtEnd(10, 0), 10, 'nothing moved after the end');
eq(holdingAtEnd(Number.NaN, 0), 0, 'garbage -> 0');

// --- dropZeroHolders ---
const tally = (): TallyLike => ({
  voters: [['A', 'B'], ['C', 'B']],
  occurrences: new Map([['A', 1], ['B', 2], ['C', 1]]),
  unique: ['A', 'B', 'C'],
});
let r = dropZeroHolders(tally(), [300, 100, 0]);
eq(r.excluded, ['C'], 'C holds nothing: excluded');
eq(r.tally.voters, [['A', 'B'], ['B']], 'C is removed from the option it voted for');
eq(r.tally.unique, ['A', 'B'], 'unique voters');
eq([...r.tally.occurrences], [['A', 1], ['B', 2]], 'occurrences of the removed voter are gone, the others kept');
eq(r.holdings, [300, 100], 'holdings stay aligned with the remaining voters');

r = dropZeroHolders(tally(), [0, 100, 5]);
eq(r.excluded, ['A'], 'the first voter can be the one removed');
eq(r.holdings, [100, 5], 'holdings aligned (A removed)');
eq(r.tally.voters, [['B'], ['C', 'B']], 'A removed from its option');

const same = tally();
r = dropZeroHolders(same, [1, 1, 1]);
ok(r.tally === same && r.excluded.length === 0, 'everybody holds some: the tally is returned as it is');
r = dropZeroHolders(tally(), [0, 0, 0]);
eq([r.tally.voters, r.tally.unique, r.holdings, r.excluded.length], [[[], []], [], [], 3], 'nobody holds anything: no valid vote');
r = dropZeroHolders(tally(), [300]);
eq(r.excluded, ['B', 'C'], 'a missing holding counts as 0 (the caller always passes one per voter)');
const t0 = tally(); dropZeroHolders(t0, [0, 1, 1]);
eq(t0.unique, ['A', 'B', 'C'], 'the original tally is not modified');

// --- emptyTally: no vote is counted (a holder poll whose mosaic rule is not met) ---
const empty = emptyTally(3);
eq([empty.voters, empty.unique, empty.occurrences.size], [[[], [], []], [], 0], 'emptyTally: one empty list per option, nobody');
ok(emptyTally(2).voters[0] !== emptyTally(2).voters[0], 'emptyTally: every call gets its own lists (nothing shared)');
const e1 = emptyTally(2); e1.voters[0].push('X');
eq(emptyTally(2).voters, [[], []], 'emptyTally: changing one result does not leak into the next');
eq(emptyTally(0).voters, [], 'emptyTally: no options');

console.log(`checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
