// Apostille explorer: only apostille messages of the sink's incoming transfers are kept (multisig ones through the inner transfer).
// Run: npx tsx dev-tests/nem-apostille-explorer.test.ts
import { APOSTILLE_EXPLORER_PAGE_SIZE, fetchApostilleExplorerPage, parseApostilleExplorerEntries } from '../src/lib/nem/apostilleExplorer';
import type { RawSinkEntry } from '../src/lib/nem/apostilleExplorer';
import { NEM_EPOCH_SECONDS } from '../src/lib/nem/constants';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const PREFIX = 'fe4e5459';
const payloadA = `${PREFIX}03${'ab'.repeat(32)}`;
const transfer = (id: number, hash: string, payload: string | undefined, signer = 'AA'.repeat(32), timeStamp = 1000): RawSinkEntry => ({
  meta: { id, hash: { data: hash } },
  transaction: { type: 257, signer, timeStamp, message: payload === undefined ? undefined : { payload } },
});

// a plain apostille keeps its hash, signer (upper case), payload and time
const rows = parseApostilleExplorerEntries([transfer(9, 'H1', payloadA, 'aa'.repeat(32), 1234)]);
ok(rows.length === 1, 'one apostille kept', rows);
ok(rows[0].txHash === 'H1' && rows[0].payloadHex === payloadA, 'hash and payload');
ok(rows[0].signer === 'AA'.repeat(32), 'signer upper case');
ok(rows[0].timestampMs === (NEM_EPOCH_SECONDS + 1234) * 1000, 'time stamp');

// anything that is not an apostille is dropped: other messages, no message, other transaction types, an upper-case prefix is still read
const mixed = parseApostilleExplorerEntries([
  transfer(8, 'H2', '68656c6c6f'),
  transfer(7, 'H3', undefined),
  { meta: { id: 6, hash: { data: 'H4' } }, transaction: { type: 2049, signer: 'AA'.repeat(32), timeStamp: 1 } },
  transfer(5, 'H5', payloadA.toUpperCase()),
  {},
]);
ok(mixed.length === 1 && mixed[0].txHash === 'H5' && mixed[0].payloadHex === payloadA, 'only the apostille is kept', mixed);

// multisig: the inner transfer's message, hash and signer (the multisig account) are used
const multisig: RawSinkEntry = {
  meta: { id: 4, hash: { data: 'OUTER' }, innerHash: { data: 'INNER' } },
  transaction: { type: 4100, signer: 'CC'.repeat(32), timeStamp: 50, otherTrans: { signer: 'DD'.repeat(32), message: { payload: payloadA } } },
};
const m = parseApostilleExplorerEntries([multisig]);
ok(m.length === 1 && m[0].txHash === 'INNER' && m[0].signer === 'DD'.repeat(32), 'multisig uses the inner transfer', m);
const mNoInner = parseApostilleExplorerEntries([{ ...multisig, meta: { id: 4, hash: { data: 'OUTER' } } }]);
ok(mNoInner.length === 1 && mNoInner[0].txHash === 'OUTER', 'multisig without an inner hash falls back to the outer one');
ok(parseApostilleExplorerEntries([{ ...multisig, transaction: { type: 4100, signer: 'CC'.repeat(32), timeStamp: 1 } }]).length === 0, 'multisig without an inner transfer is dropped');

// paging: the cursor is the last entry's id, and a full page means there may be more
async function main() {
  const asked: string[] = [];
  const full = Array.from({ length: APOSTILLE_EXPLORER_PAGE_SIZE }, (_, i) => transfer(100 - i, `F${i}`, i % 2 === 0 ? payloadA : '00'));
  const page1 = await fetchApostilleExplorerPage(async <T>(path: string) => { asked.push(path); return { data: full } as T; }, 'SINK');
  ok(asked[0] === `/account/transfers/incoming?address=SINK&pageSize=${APOSTILLE_EXPLORER_PAGE_SIZE}`, 'first request', asked[0]);
  ok(page1.hasMore && page1.nextId === 100 - (APOSTILLE_EXPLORER_PAGE_SIZE - 1), 'a full page has more', page1);
  ok(page1.rows.length === Math.ceil(APOSTILLE_EXPLORER_PAGE_SIZE / 2), 'filtered rows of the page');
  await fetchApostilleExplorerPage(async <T>(path: string) => { asked.push(path); return { data: [transfer(3, 'L', payloadA)] } as T; }, 'SINK', page1.nextId);
  ok(asked[1].endsWith(`&id=${page1.nextId}`), 'next request carries the cursor', asked[1]);
  const last = await fetchApostilleExplorerPage(async <T>() => ({ data: [transfer(3, 'L', payloadA)] }) as T, 'SINK', 5);
  ok(!last.hasMore && last.rows.length === 1, 'a short page is the end');
  const empty = await fetchApostilleExplorerPage(async <T>() => ({}) as T, 'SINK');
  ok(!empty.hasMore && empty.rows.length === 0 && empty.nextId === undefined, 'no data at all');

  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
  if (fails > 0) process.exit(1);
}
void main();
