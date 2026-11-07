// Apostille history (.nty) read / merge / write, and the stored ZIP writer.
// Run: npx tsx dev-tests/nem-apostille-files.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeNty, parseNty, serializeNty } from '../src/lib/nem/apostilleNty';
import type { ApostilleRecord } from '../src/lib/nem/apostilleNty';
import { buildZip, crc32 } from '../src/lib/zipStore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const rec = (tx: string, name = 'a.pdf'): ApostilleRecord => ({
  filename: name, tags: 't', fileHash: 'fe4e545903' + 'aa'.repeat(32), owner: 'NABC', fromMultisig: '',
  dedicatedAccount: 'NSINK', txHash: tx, txMultisigHash: '', timeStamp: 'Mon, 12 Oct 2026 11:00:00 GMT',
});
const t1 = 'A'.repeat(64), t2 = 'B'.repeat(64);

const text = serializeNty([rec(t1), rec(t2, '契約書.pdf')]);
const back = parseNty(text);
ok(back?.data.length === 2 && back.data[1].filename === '契約書.pdf', 'nty round-trips', back);
ok(parseNty('not json') === null && parseNty('{"x":1}') === null, 'not a nty file');
// NanoWallet's own file: lower-case hash, private key present, an item without a hash is skipped
const nano = parseNty(JSON.stringify({ data: [{ ...rec(t1.toLowerCase()), dedicatedPrivateKey: 'ff'.repeat(32) }, { filename: 'x' }] }));
ok(nano?.data.length === 1 && nano.data[0].txHash === t1 && nano.data[0].dedicatedPrivateKey === 'ff'.repeat(32), 'NanoWallet file is read', nano);
const m = mergeNty([rec(t1)], [rec(t1), rec(t2)]);
ok(m.added === 1 && m.records.length === 2, 'merge skips known transaction hashes', m);

// zip: unzip with the system tool and compare
ok(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'crc32 check value');
const dir = mkdtempSync(join(tmpdir(), 'zip-'));
const files = [
  { name: 'plain.txt', data: new TextEncoder().encode('hello') },
  { name: '日本語 -- Apostille TX x.pdf', data: Uint8Array.from({ length: 5000 }, (_, i) => i % 251) },
  { name: 'empty.bin', data: new Uint8Array(0) },
];
writeFileSync(join(dir, 'x.zip'), buildZip(files));
try {
  execFileSync('unzip', ['-tq', join(dir, 'x.zip')]);
  ok(true, 'unzip -t passes');
  execFileSync('unzip', ['-qo', join(dir, 'x.zip'), '-d', join(dir, 'out')]);
  ok(readFileSync(join(dir, 'out', 'plain.txt'), 'utf8') === 'hello', 'text entry');
  ok(Buffer.compare(readFileSync(join(dir, 'out', '日本語 -- Apostille TX x.pdf')), Buffer.from(files[1].data)) === 0, 'binary entry with a UTF-8 name');
} catch (e) {
  ok(false, 'unzip failed', (e as Error).message);
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
