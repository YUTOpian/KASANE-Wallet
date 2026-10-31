// Symbol DNS（ネームスペースとポインタアカウント）: 名前の正規化、ポインタ鍵、メッセージの読み取り、履歴からの検索（SDK なし）。
// Run: npx tsx dev-tests/symbol-dns.test.ts
// SDK を使う部分（ポインタのアドレス、送金、アグリゲートの大きさ）は dev-tests/symbol-dns-tx.test.ts。
import { buildNemDnsMessage, emptyNemDnsRecord, nemDnsPointerPrivateKey } from '../src/lib/nem/dns';
import {
  SYMBOL_DNS_MAX_MESSAGE_BYTES, emptySymbolDnsRecord, findSymbolDnsRecord, isNewerDnsRecord, newerDnsRecord, normalizeSymbolDnsName,
  plainTextOfMessageField, symbolDnsPointerPrivateKey,
} from '../src/lib/symbol/dns';
import type { FoundSymbolDnsRecord, RawSymbolDnsEntry } from '../src/lib/symbol/dns';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const hexOfText = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
/** The message field as the node returns it: the type byte 00 (plain), then the text. */
const plainField = (text: string) => `00${hexOfText(text)}`;

// --- names
ok(normalizeSymbolDnsName('Kasane') === 'kasane', 'lower-cased');
ok(normalizeSymbolDnsName('  kasane ') === 'kasane', 'spaces are dropped');
ok(normalizeSymbolDnsName('alice.bob') === 'alice.bob', 'a sub-namespace');
ok(normalizeSymbolDnsName('a.b.c') === 'a.b.c', 'three levels');
ok(normalizeSymbolDnsName('a.b.c.d') === null, 'more than 3 levels');
// Symbol has no ".symbol" display suffix: "kasane.symbol" is the child "symbol" of "kasane", not a spelling of "kasane".
ok(normalizeSymbolDnsName('kasane.symbol') === 'kasane.symbol', 'a trailing ".symbol" is a sub-namespace, not cut');
ok(normalizeSymbolDnsName('kasane.nem') === 'kasane.nem', 'a trailing ".nem" is a sub-namespace too');
ok(normalizeSymbolDnsName('') === null && normalizeSymbolDnsName('.a') === null && normalizeSymbolDnsName('a.') === null && normalizeSymbolDnsName('a..b') === null, 'empty parts');
ok(normalizeSymbolDnsName('has space') === null && normalizeSymbolDnsName('-a') === null && normalizeSymbolDnsName('_a') === null && normalizeSymbolDnsName('日本語') === null, 'characters Symbol does not allow');
ok(normalizeSymbolDnsName('a_b-c9') === 'a_b-c9', '"_" and "-" inside a name');
ok(normalizeSymbolDnsName('a'.repeat(64)) !== null && normalizeSymbolDnsName('a'.repeat(65)) === null, 'a root is at most 64 characters (NEM: 16)');
ok(normalizeSymbolDnsName('a'.repeat(17)) !== null, 'a root of 17 characters is fine on Symbol');
ok(normalizeSymbolDnsName('r.' + 'a'.repeat(64)) !== null && normalizeSymbolDnsName('r.' + 'a'.repeat(65)) === null, 'a sub is at most 64 characters');

// --- pointer key: the same rule as NEM (Keccak-256 of SHA-256 of the name)
ok(symbolDnsPointerPrivateKey === nemDnsPointerPrivateKey, 'same function as NEM');
ok(symbolDnsPointerPrivateKey('kasane') === '74e18d219c9bd7ff0ea14686a09676c8056563a5eea24d1f979dfca34640d81c'.toUpperCase(), 'pointer private key of "kasane"');
ok(/^[0-9A-F]{64}$/.test(symbolDnsPointerPrivateKey('alice.bob')), 'a 64-digit upper-case hex key');
ok(SYMBOL_DNS_MAX_MESSAGE_BYTES === 1023, 'message limit');
ok(JSON.stringify(emptySymbolDnsRecord()) === JSON.stringify(emptyNemDnsRecord()), 'the same record shape as NEM');

// --- message field
ok(plainTextOfMessageField(plainField('{"dns":"yes"}')) === '{"dns":"yes"}', 'plain text is read');
ok(plainTextOfMessageField(plainField('日本語').toLowerCase()) === '日本語', 'lower-case hex and multi-byte text');
ok(plainTextOfMessageField(`01${hexOfText('{"dns":"yes"}')}`) === null, 'an encrypted message (type 01) is not read');
ok(plainTextOfMessageField('') === null && plainTextOfMessageField(undefined) === null, 'no message');
ok(plainTextOfMessageField('00') === null, 'the type byte alone');
ok(plainTextOfMessageField('0041F') === null && plainTextOfMessageField('00ZZ') === null, 'not hex / odd length');
ok(plainTextOfMessageField('00C328') === null, 'not UTF-8');

// --- finding the record
const OWNER = 'NOWNERADDRESS';
const OTHER = 'NOTHERADDRESS';
const POINTER_HEX = '98AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00';
const addresses: Record<string, string> = { OWNERKEY: OWNER, OTHERKEY: OTHER, MULTISIGKEY: 'NMULTISIGADDRESS' };
const addressOf = (publicKey: string) => {
  const a = addresses[publicKey];
  if (a === undefined) throw new Error('unknown key');
  return a;
};
const record = (extra: Partial<ReturnType<typeof emptyNemDnsRecord>>) => ({ ...emptyNemDnsRecord(), ...extra });
const dnsText = (extra: Partial<ReturnType<typeof emptyNemDnsRecord>>) => buildNemDnsMessage(record(extra));

function entry(over: {
  type?: number; signer?: string; recipient?: string; message?: string; hash?: string; aggregateHash?: string; height?: string; index?: number; timestamp?: string;
}): RawSymbolDnsEntry {
  return {
    meta: { hash: over.hash, aggregateHash: over.aggregateHash, height: over.height ?? '100', index: over.index ?? 0, timestamp: over.timestamp ?? '5000' },
    transaction: {
      type: over.type ?? 0x4154,
      signerPublicKey: over.signer ?? 'OWNERKEY',
      recipientAddress: over.recipient ?? POINTER_HEX,
      message: over.message ?? plainField(dnsText({ ip1: 'example.com' })),
    },
  };
}
const find = (entries: RawSymbolDnsEntry[]) => findSymbolDnsRecord(entries, OWNER, POINTER_HEX, addressOf);

{
  const f = find([entry({ hash: 'abc123', height: '250', index: 3, timestamp: '123456' })]);
  ok(f !== null && f.record.ip1 === 'example.com', 'the owner\'s record is found');
  ok(f?.hash === 'ABC123' && f.height === 250n && f.index === 3 && f.epochMs === 123456, 'hash, height, index and time of the record', f);
}
ok(find([entry({ signer: 'OTHERKEY' })]) === null, 'a record signed by someone else is ignored');
ok(find([entry({ signer: 'UNKNOWN' })]) === null, 'a signer that cannot be turned into an address is skipped');
ok(find([entry({ recipient: '98FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' })]) === null, 'a transfer to another account is ignored');
ok(find([entry({ recipient: POINTER_HEX.toLowerCase(), hash: 'h' })]) !== null, 'the recipient is compared without regard to case');
ok(find([entry({ type: 0x4141, hash: 'h' })]) === null, 'not a transfer');
ok(find([entry({ message: plainField('{"hello":"world"}') })]) === null, 'JSON that is not a DNS record');
ok(find([entry({ message: plainField('not json') })]) === null, 'text that is not JSON');
ok(find([entry({ message: `01${hexOfText(dnsText({ ip1: 'x.com' }))}` })]) === null, 'an encrypted message is not a record');
ok(find([{ meta: { hash: 'n' }, transaction: { type: 0x4154, signerPublicKey: 'OWNERKEY', recipientAddress: POINTER_HEX } }, entry({ hash: 'ok' })])?.hash === 'OK', 'an entry without a message is skipped, the next one is looked at');
ok(find([]) === null, 'an empty history');

{
  // Newest first: the first valid one wins, even though an older valid one follows.
  const f = find([
    entry({ signer: 'OTHERKEY', message: plainField(dnsText({ ip1: 'fake.example' })), hash: 'fake' }),
    entry({ message: plainField(dnsText({ ip1: 'new.example' })), hash: 'new' }),
    entry({ message: plainField(dnsText({ ip1: 'old.example' })), hash: 'old' }),
  ]);
  ok(f?.record.ip1 === 'new.example' && f.hash === 'NEW', 'the newest record of the owner wins; a newer fake is passed over', f);
}
{
  // An embedded transfer (inside an aggregate, i.e. sent in the name of a multisig account) has no hash of its own.
  const f = findSymbolDnsRecord(
    [entry({ signer: 'MULTISIGKEY', hash: undefined, aggregateHash: 'aggregate01', message: plainField(dnsText({ organization: 'Team' })) })],
    'NMULTISIGADDRESS', POINTER_HEX, addressOf,
  );
  ok(f?.record.organization === 'Team' && f.hash === 'AGGREGATE01', 'a record sent in the name of a multisig account (the aggregate\'s hash)', f);
}
ok(findSymbolDnsRecord([entry({ hash: 'h' })], 'NSOMEONEELSE', POINTER_HEX, addressOf) === null, 'a different owner finds nothing');
ok(findSymbolDnsRecord([entry({ hash: 'h' })], 'N-OWNER-ADDRESS', POINTER_HEX, addressOf)?.hash === 'H', 'hyphens in the owner address do not matter');
{
  const f = find([entry({ hash: 'h', height: 'x', index: undefined, timestamp: 'y' })]);
  ok(f !== null && f.height === null && f.epochMs === null, 'unreadable height / time are null, not a failure', f);
}

// --- the newer of the plain and the embedded record
const rec = (height: bigint | null, index: number | null, ip1: string): FoundSymbolDnsRecord => ({ record: { ...emptyNemDnsRecord(), ip1 }, hash: ip1, height, index, epochMs: null });
ok(isNewerDnsRecord(rec(11n, 0, 'a'), rec(10n, 5, 'b')), 'a higher block is newer');
ok(!isNewerDnsRecord(rec(10n, 5, 'a'), rec(11n, 0, 'b')), 'a lower block is not newer');
ok(isNewerDnsRecord(rec(10n, 2, 'a'), rec(10n, 1, 'b')), 'the same block: the later one is newer');
ok(!isNewerDnsRecord(rec(10n, 1, 'a'), rec(10n, 1, 'b')), 'equal is not newer');
ok(!isNewerDnsRecord(rec(null, null, 'a'), rec(10n, 1, 'b')), 'cannot be compared: not newer');
ok(newerDnsRecord(null, null) === null, 'neither');
ok(newerDnsRecord(rec(1n, 0, 'p'), null)?.hash === 'p', 'only the plain one');
ok(newerDnsRecord(null, rec(1n, 0, 'e'))?.hash === 'e', 'only the embedded one');
ok(newerDnsRecord(rec(5n, 0, 'p'), rec(9n, 0, 'e'))?.hash === 'e', 'the embedded one is newer');
ok(newerDnsRecord(rec(9n, 0, 'p'), rec(5n, 0, 'e'))?.hash === 'p', 'the plain one is newer');
ok(newerDnsRecord(rec(null, null, 'p'), rec(null, null, 'e'))?.hash === 'p', 'cannot be compared: the plain one');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
