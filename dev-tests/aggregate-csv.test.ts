// アグリゲートのCSV一括送信(Ventus Walletに倣った形式): 文字コード・CSVの読み取り・見本CSV・各行の検証。
// 通信はすべて偽物(モック)に差し替えてある。
// Run: npx tsx dev-tests/aggregate-csv.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import {
  CSV_HEADER, buildSampleCsv, csvCell, decodeCsvBytes, detectDelimiter, parseCsv, readCsvRows,
} from '../src/lib/symbol/aggregateCsvText';
import { csvMosaicId, recipientRestrictionProblem, resolveCsvRows } from '../src/lib/symbol/aggregateCsv';
import type { CsvMosaic, CsvResolveDeps } from '../src/lib/symbol/aggregateCsv';
import type { CsvRow } from '../src/lib/symbol/aggregateCsvText';
import { aggregateMosaicId } from '../src/lib/symbol/aggregate';
import type { AggregateItem } from '../src/lib/symbol/aggregate';
import type { RestrictionList } from '../src/lib/symbol/restrictions';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { MOSAIC_FLAG_TRANSFERABLE } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const enc = (s: string) => new TextEncoder().encode(s);

// ================= text side =================
// --- parseCsv
const q = parseCsv('a,"b,c","d ""e"" f","line1\r\nline2"\r\nx,y\r\n');
ok(q.length === 2, 'two records (a trailing line break adds none)', q);
ok(JSON.stringify(q[0]) === JSON.stringify(['a', 'b,c', 'd "e" f', 'line1\r\nline2']), 'quoted cells keep commas, quotes and line breaks', q[0]);
ok(JSON.stringify(parseCsv('a,b\nc,d')) === JSON.stringify([['a', 'b'], ['c', 'd']]), 'LF line ends, no final line break');
ok(JSON.stringify(parseCsv('a,,c\n')) === JSON.stringify([['a', '', 'c']]), 'empty middle cell');
ok(JSON.stringify(parseCsv('a,b,\n')) === JSON.stringify([['a', 'b', '']]), 'empty last cell');
ok(parseCsv('').length === 0, 'empty text has no records');
ok(JSON.stringify(parseCsv('a;b\n', ';')) === JSON.stringify([['a', 'b']]), 'semicolon separator');

// --- detectDelimiter
ok(detectDelimiter('# note, with comma\nlabel\taddress\ta\n') === '\t', 'tab file (comment lines are ignored)');
ok(detectDelimiter('label;address;1\n') === ';', 'semicolon file');
ok(detectDelimiter('label,address,1\n') === ',', 'comma file');
ok(detectDelimiter('"a;b",c\n') === ',', 'a separator inside quotes does not count');
ok(detectDelimiter('') === ',', 'empty -> comma');

// --- decodeCsvBytes
ok(decodeCsvBytes(Uint8Array.from([0xEF, 0xBB, 0xBF, ...enc('テスト')])) === 'テスト', 'UTF-8 with BOM');
ok(decodeCsvBytes(enc('テスト')) === 'テスト', 'UTF-8 without BOM');
ok(decodeCsvBytes(Uint8Array.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67])) === 'テスト', 'Shift_JIS (Excel on Japanese Windows)');
ok(decodeCsvBytes(enc('plain ascii')) === 'plain ascii', 'ASCII');

// --- readCsvRows
const rows1 = readCsvRows(parseCsv([
  '# comment line', '', 'label,address,amount,mosaic_id,message',
  'Alice,NAAAA,１２．５,,"hi, there"', ',NBBBB', '#,skipped', 'Carol, nem.group ,3,６ＢＥＤ９１３ＦＡ１７２２３Ｃ０,',
].join('\r\n')));
ok(rows1.length === 3, 'comments, blank lines and the header are skipped', rows1);
ok(rows1[0].label === 'Alice' && rows1[0].recipient === 'NAAAA' && rows1[0].amount === '12.5' && rows1[0].message === 'hi, there', 'full-width digits become half-width; the message stays', rows1[0]);
ok(rows1[0].line === 4, 'line = record number', rows1[0].line);
ok(rows1[1].amount === '' && rows1[1].mosaic === '' && rows1[1].message === '', 'missing cells are empty', rows1[1]);
ok(rows1[2].recipient === 'nem.group' && rows1[2].mosaic === '6BED913FA17223C0', 'cells are trimmed; full-width mosaic id is normalised', rows1[2]);
ok(readCsvRows(parseCsv('Bob,NCCCC,1\n')).length === 1, 'a file without a header works');
ok(readCsvRows(parseCsv('ラベル,アドレス,数量\nBob,NCCCC,1\n')).length === 1, 'a Japanese header is skipped too');
ok(readCsvRows(parseCsv('Bob,NCCCC,1\nlabel,address\n')).length === 2, 'a header-looking line after data is a row (and will be reported)');

// --- sample file
ok(csvCell('a,b') === '"a,b"' && csvCell('x"y') === '"x""y"' && csvCell('plain') === 'plain', 'csvCell quoting');
const sample = buildSampleCsv('NOWNADDRESS', '72C0212E67A08BCE', ['first, comment', 'second']);
ok(sample.includes('\r\n') && sample.endsWith('\r\n'), 'sample uses CRLF');
const sampleRows = readCsvRows(parseCsv(sample));
ok(sampleRows.length === 3, 'sample parses to its three example rows', sampleRows);
ok(sampleRows.every((r) => r.recipient === 'NOWNADDRESS'), 'every example row sends to the wallet itself');
ok(sampleRows[1].mosaic === '72C0212E67A08BCE' && sampleRows[2].amount === '' && sampleRows[2].message === 'message only', 'sample rows', sampleRows);
ok(sample.split('\r\n')[2] === CSV_HEADER.join(','), 'header line follows the comments');

// ================= checking side =================
const cfg = getNetworkConfig();
const nb = cfg.networkByte;
const currency = cfg.currencyMosaicId.toUpperCase();
const mk = (n = nb) => addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), n);
const me = mk(), a = mk(), b = mk(), c = mk();
const otherNet = mk(nb === 0x98 ? 0x68 : 0x98);

ok(csvMosaicId('', currency) === currency && csvMosaicId('xym', currency) === currency && csvMosaicId('Symbol.XYM', currency) === currency, 'empty / xym = the network currency');
ok(csvMosaicId('0x6bed913fa17223c0', currency) === '6BED913FA17223C0', '0x prefix and lower case');
ok(csvMosaicId('1.2E+15', currency) === null && csvMosaicId('ABC', currency) === null, 'not a mosaic id');

const XYM: CsvMosaic & { amount: bigint } = { id: currency, symbol: 'XYM', divisibility: 6, transferable: true, amount: 10_000_000n };
const TOK: CsvMosaic & { amount: bigint } = { id: '1234567890ABCDEF', symbol: 'company.token', divisibility: 2, transferable: true, amount: 500n };
const LOCKED: CsvMosaic & { amount: bigint } = { id: 'FEDCBA0987654321', symbol: 'locked.token', divisibility: 0, transferable: false, amount: 5n };
let uidN = 0;
const deps = (over: Partial<CsvResolveDeps> = {}): CsvResolveDeps => ({
  networkByte: nb, ownAddress: me, currencyMosaicId: currency, held: [XYM, TOK, LOCKED], existingItems: [],
  resolveRecipient: async () => ({ ok: false, reason: 'not_found' }),
  lookupMosaic: async () => null,
  newUid: () => `u${uidN++}`,
  ...over,
});
const row = (o: Partial<CsvRow> = {}): CsvRow => ({ line: 1, label: '', recipient: a, amount: '1', mosaic: '', message: '', ...o });
const keys = (p: { errors: { key: string }[] }) => p.errors.map((e) => e.key).join(',');

// --- a clean file
{
  const p = await resolveCsvRows([row({ label: 'Alice' }), row({ line: 2, recipient: b, amount: '0.5', mosaic: currency }), row({ line: 3, recipient: a, amount: '', message: 'hi' })], deps());
  ok(p.errorCount === 0 && p.items.length === 3, 'clean file -> three items', p);
  const t0 = p.items[0];
  ok(t0.kind === 'transfer' && t0.amount === 1_000_000n && t0.mosaicId === currency && t0.recipient === a && t0.label === 'Alice' && t0.signer === undefined, 'first item', t0);
  ok(p.items[1].kind === 'transfer' && p.items[1].amount === 500_000n, 'amount in atomic units');
  ok(p.items[2].kind === 'transfer' && p.items[2].amount === 0n && p.items[2].message === 'hi', 'message-only transfer');
}

// --- recipients
{
  let calls = 0;
  const p = await resolveCsvRows([
    row({ recipient: 'nem.group' }), row({ line: 2, recipient: 'nem.group', amount: '2' }), row({ line: 3, recipient: 'gone.name' }),
  ], deps({
    resolveRecipient: async (input) => {
      calls += 1;
      return input.kind === 'alias' && input.name === 'nem.group' ? { ok: true, address: b, via: 'alias', label: 'nem.group' } : { ok: false, reason: 'not_found' };
    },
  }));
  ok(calls === 2, 'each distinct alias is looked up once', calls);
  ok(p.rows[0].toAddress === b && p.rows[0].alias === 'nem.group' && p.rows[0].item?.recipientAlias === 'nem.group', 'alias -> address, alias kept for display', p.rows[0]);
  ok(keys(p.rows[2]) === 'send.alias_not_found' && p.rows[2].item === null, 'unknown alias is an error', p.rows[2]);
  ok(p.items.length === 0 && p.errorCount === 1, 'nothing is imported when a row has an error', p);
}
{
  const pk = new KeyPair(PrivateKey.random()).publicKey.toString();
  const p = await resolveCsvRows([row({ recipient: pk })], deps({ resolveRecipient: async (i) => (i.kind === 'publicKey' ? { ok: true, address: c, via: 'publicKey', label: pk } : { ok: false, reason: 'invalid' }) }));
  ok(p.errorCount === 0 && p.rows[0].toAddress === c && p.rows[0].alias === undefined, 'public key -> address (no alias)', p.rows[0]);
  const failed = await resolveCsvRows([row({ recipient: 'nem.group' })], deps({ resolveRecipient: async () => { throw new Error('offline'); } }));
  ok(keys(failed.rows[0]) === 'send.alias_lookup_failed', 'a failed lookup is reported', failed.rows[0]);
}
{
  const p = await resolveCsvRows([row({ recipient: '' }), row({ line: 2, recipient: 'NOT-AN-ADDRESS' }), row({ line: 3, recipient: otherNet }), row({ line: 4, recipient: a.replace(/(.{6})/g, '$1-') })], deps());
  ok(keys(p.rows[0]) === 'aggregate.csv_err_recipient_empty', 'empty recipient', p.rows[0]);
  ok(keys(p.rows[1]) === 'common.invalid_address', 'invalid address', p.rows[1]);
  ok(keys(p.rows[2]) === 'aggregate.csv_err_address_network', 'address of the other network', p.rows[2]);
  ok(p.rows[3].errors.length === 0 && p.rows[3].toAddress === a, 'hyphens in an address are fine', p.rows[3]);
}

// --- amounts, messages, mosaics
{
  const p = await resolveCsvRows([
    row({ amount: 'abc' }), row({ line: 2, amount: '1.1234567' }), row({ line: 3, mosaic: TOK.id, amount: '1.234' }),
    row({ line: 4, amount: '', message: '' }), row({ line: 5, message: 'あ'.repeat(400) }), row({ line: 6, amount: '-1' }),
  ], deps());
  ok(keys(p.rows[0]) === 'aggregate.invalid_amount', 'letters', p.rows[0]);
  ok(keys(p.rows[1]) === 'aggregate.csv_err_decimals' && p.rows[1].errors[0].params?.max === 6, 'too many decimals (XYM: 6)', p.rows[1]);
  ok(keys(p.rows[2]) === 'aggregate.csv_err_decimals' && p.rows[2].errors[0].params?.max === 2, 'too many decimals (token: 2)', p.rows[2]);
  ok(keys(p.rows[3]) === 'aggregate.item_transfer_empty', 'no amount and no message', p.rows[3]);
  ok(keys(p.rows[4]) === 'aggregate.item_message_too_long', 'message over the limit', p.rows[4]);
  ok(keys(p.rows[5]) === 'aggregate.invalid_amount', 'negative amount', p.rows[5]);
}
{
  const p = await resolveCsvRows([
    row({ mosaic: 'zzzz' }), row({ line: 2, mosaic: '1111111111111111' }), row({ line: 3, mosaic: '2222222222222222' }),
    row({ line: 4, mosaic: LOCKED.id, amount: '1' }), row({ line: 5, mosaic: `0x${TOK.id.toLowerCase()}`, amount: '1.5' }),
  ], deps({ lookupMosaic: async (id) => { if (id === '2222222222222222') throw new Error('offline'); return null; } }));
  ok(keys(p.rows[0]) === 'aggregate.csv_err_mosaic_format', 'bad mosaic id', p.rows[0]);
  ok(keys(p.rows[1]) === 'aggregate.csv_err_mosaic_unknown', 'no such mosaic', p.rows[1]);
  ok(keys(p.rows[2]) === 'aggregate.csv_err_lookup_failed', 'lookup failed', p.rows[2]);
  ok(keys(p.rows[3]) === 'aggregate.csv_err_mosaic_not_transferable', 'not transferable', p.rows[3]);
  ok(p.rows[4].errors.length === 0 && p.rows[4].item?.amount === 150n && p.rows[4].item?.mosaicSymbol === 'company.token', 'a held mosaic, 0x prefix, 2 decimals', p.rows[4]);
}
{
  // a mosaic the wallet does not hold but which exists: only an error because of the total (balance 0)
  const p = await resolveCsvRows([row({ mosaic: '3333333333333333', amount: '1' })], deps({ lookupMosaic: async (id) => ({ id, symbol: 'other.token', divisibility: 0, transferable: true }) }));
  ok(p.errors.length === 1 && p.errors[0].key === 'aggregate.csv_err_total_exceeds' && p.errors[0].params?.balance === '0', 'not held -> total exceeds the balance (0)', p.errors);
}

// --- totals
{
  const p = await resolveCsvRows([row({ amount: '6' }), row({ line: 2, recipient: b, amount: '5' })], deps());
  ok(p.errors.length === 1 && p.errors[0].key === 'aggregate.csv_err_total_exceeds' && p.errors[0].params?.total === '11' && p.errors[0].params?.balance === '10' && p.errors[0].params?.symbol === 'XYM', 'sum of the rows over the balance', p.errors);
  ok(p.items.length === 0 && p.errorCount === 1, 'nothing imported');
  const exact = await resolveCsvRows([row({ amount: '6' }), row({ line: 2, recipient: b, amount: '4' })], deps());
  ok(exact.errorCount === 0 && exact.items.length === 2, 'exactly the balance is fine');
  const existing: AggregateItem[] = [{ uid: 'e1', kind: 'transfer', recipient: c, mosaicId: currency, mosaicSymbol: 'XYM', divisibility: 6, amount: 3_000_000n, message: '' }];
  const withDraft = await resolveCsvRows([row({ amount: '8' })], deps({ existingItems: existing }));
  ok(withDraft.errors.length === 1 && withDraft.errors[0].params?.total === '11', 'what the draft already sends counts too', withDraft.errors);
  const bySigner: AggregateItem[] = [{ ...existing[0], uid: 'e2', signer: { address: c, publicKey: '0'.repeat(64), multisig: true, selfSufficient: false, cosignatures: 1 } } as AggregateItem];
  const withSigner = await resolveCsvRows([row({ amount: '8' })], deps({ existingItems: bySigner }));
  ok(withSigner.errorCount === 0, 'transfers from another account do not count against the wallet', withSigner.errors);
}

// --- mosaics created earlier in the draft
{
  const def: AggregateItem = { uid: 'd1', kind: 'mosaic_definition', nonce: 7, divisibility: 3, flags: MOSAIC_FLAG_TRANSFERABLE, durationBlocks: 0n };
  const id = aggregateMosaicId(me, 7);
  const p = await resolveCsvRows([row({ mosaic: id, amount: '1.5' })], deps({ existingItems: [def] }));
  ok(p.errorCount === 0 && p.items[0].kind === 'transfer' && p.items[0].amount === 1500n && p.items[0].divisibility === 3, 'a mosaic created in the draft can be sent (no balance limit)', p);
  const locked = await resolveCsvRows([row({ mosaic: id })], deps({ existingItems: [{ ...def, flags: 0 }] }));
  ok(keys(locked.rows[0]) === 'aggregate.csv_err_mosaic_not_transferable', 'a draft mosaic that is not transferable', locked.rows[0]);
}

// --- size
{
  const filler: AggregateItem[] = Array.from({ length: 95 }, (_, i) => ({ uid: `f${i}`, kind: 'namespace', name: 'x', durationBlocks: 1n }) as AggregateItem);
  const rows6 = Array.from({ length: 6 }, (_, i) => row({ line: i + 1, amount: `${i + 1}` }));
  const p = await resolveCsvRows(rows6, deps({ existingItems: filler }));
  ok(p.errors.some((e) => e.key === 'aggregate.csv_err_too_many' && e.params?.count === 6 && e.params?.draft === 95 && e.params?.max === 100), 'draft + file over 100', p.errors);
  ok(p.items.length === 0, 'nothing imported');
  const fits = await resolveCsvRows(rows6.slice(0, 5), deps({ existingItems: filler }));
  ok(!fits.errors.some((e) => e.key === 'aggregate.csv_err_too_many'), '95 + 5 = 100 fits', fits.errors);
  const none = await resolveCsvRows([], deps());
  ok(none.errors.length === 1 && none.errors[0].key === 'aggregate.csv_err_no_rows' && none.items.length === 0, 'empty file', none);
}

// --- warnings
{
  const p = await resolveCsvRows([row({ message: 'x' }), row({ line: 2, message: 'x' }), row({ line: 3, recipient: me })], deps());
  ok(p.errorCount === 0 && p.items.length === 3, 'warnings do not block the import', p);
  ok(p.rows[1].warnings.some((w) => w.key === 'aggregate.csv_warn_duplicate' && w.params?.line === 1), 'the same transfer twice', p.rows[1].warnings);
  ok(p.rows[2].warnings.some((w) => w.key === 'aggregate.csv_warn_self'), 'sending to yourself', p.rows[2].warnings);
  ok(p.warningCount === 2, 'warning count', p.warningCount);
}

// --- account restrictions of the recipients
const list = (kind: 'address' | 'mosaic', mode: 'allow' | 'block', values: string[]): RestrictionList => ({ rule: { kind, direction: 'incoming' }, mode, values });
ok(recipientRestrictionProblem([list('address', 'allow', [b])], me, null) === 'sender_not_allowed', 'not in the allow list');
ok(recipientRestrictionProblem([list('address', 'allow', [b, me])], me, null) === null, 'in the allow list');
ok(recipientRestrictionProblem([list('address', 'block', [me])], me, null) === 'sender_blocked', 'in the block list');
ok(recipientRestrictionProblem([list('address', 'block', [b])], me, null) === null, 'not in the block list');
ok(recipientRestrictionProblem([list('address', 'allow', ['@ABCDEF0123456789'])], me, null) === null, 'alias entries cannot be compared -> no verdict');
ok(recipientRestrictionProblem([list('address', 'allow', [])], me, null) === null, 'an empty list restricts nothing');
ok(recipientRestrictionProblem([{ rule: { kind: 'address', direction: 'outgoing' }, mode: 'allow', values: [b] }], me, null) === null, 'outgoing lists are the recipient\'s own sending');
ok(recipientRestrictionProblem([list('mosaic', 'block', [currency])], me, currency) === 'mosaic_blocked', 'blocked mosaic');
ok(recipientRestrictionProblem([list('mosaic', 'block', [currency])], me, null) === null, 'message-only transfer carries no mosaic');
ok(recipientRestrictionProblem([list('mosaic', 'allow', [TOK.id])], me, currency) === 'mosaic_not_allowed', 'mosaic not in the allow list');
{
  const lists: Record<string, RestrictionList[]> = {
    [a]: [list('address', 'allow', [b])],
    [b]: [],
    [c]: [list('mosaic', 'block', [currency])],
  };
  const asked: string[] = [];
  const p = await resolveCsvRows([row({ recipient: a }), row({ line: 2, recipient: b }), row({ line: 3, recipient: c }), row({ line: 4, recipient: c, amount: '', message: 'hello' })], deps({
    getRestrictions: async (addr) => { asked.push(addr); return lists[addr] ?? []; },
  }));
  ok(keys(p.rows[0]) === 'aggregate.csv_err_restriction_sender_not_allowed' && p.rows[0].item === null, 'the recipient only accepts listed senders', p.rows[0]);
  ok(p.rows[1].errors.length === 0, 'no restrictions', p.rows[1]);
  ok(keys(p.rows[2]) === 'aggregate.csv_err_restriction_mosaic_blocked', 'the recipient blocks the mosaic', p.rows[2]);
  ok(p.rows[3].errors.length === 0, 'a message-only transfer passes a mosaic block', p.rows[3]);
  ok(asked.length === 3, 'one request per distinct recipient', asked);
  ok(p.items.length === 0, 'nothing imported');

  const unreachable = await resolveCsvRows([row({ recipient: a }), row({ line: 2, recipient: b })], deps({
    getRestrictions: async (addr) => { if (addr === a) throw new Error('offline'); return []; },
  }));
  ok(unreachable.errorCount === 0 && unreachable.items.length === 2, 'an unreachable check does not block', unreachable);
  ok(unreachable.warnings.length === 1 && unreachable.warnings[0].key === 'aggregate.csv_warn_restriction_unchecked' && unreachable.warnings[0].params?.count === 1, 'but it is reported', unreachable.warnings);
  const skipped: string[] = [];
  await resolveCsvRows([row({ recipient: me })], deps({ getRestrictions: async (addr) => { skipped.push(addr); return []; } }));
  ok(skipped.length === 0, 'the wallet itself is not looked up');
  const off = await resolveCsvRows([row({ recipient: a })], deps());
  ok(off.errorCount === 0, 'without getRestrictions nothing is checked');
}

// --- the whole way: bytes of a spreadsheet file -> items
{
  const text = buildSampleCsv(me, currency, ['comment']);
  const bytes = Uint8Array.from([0xEF, 0xBB, 0xBF, ...enc(text)]);
  const records = parseCsv(decodeCsvBytes(bytes), detectDelimiter(decodeCsvBytes(bytes)));
  const p = await resolveCsvRows(readCsvRows(records), deps());
  ok(p.errorCount === 0 && p.items.length === 3, 'the downloaded sample uploads cleanly', p);
  ok(p.warningCount === 3, 'and each of its rows warns that it sends to the wallet itself', p.warningCount);
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails > 0) process.exit(1);
