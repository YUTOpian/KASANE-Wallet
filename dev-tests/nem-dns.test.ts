// NEM DNS（ネームスペースとポインタアカウント）: 名前の正規化、ポインタ鍵、DNS メッセージ、履歴からの検索（SDK なし）。
// Run: npx tsx dev-tests/nem-dns.test.ts
// 期待値（秘密鍵）は、NEM Wallet 2.7.1（NanoWallet）の nem-sdk で `derivePassSha(SHA256(name), 1)` を実際に計算したもの。
import {
  buildNemDnsMessage, emptyNemDnsRecord, findNemDnsRecord, nemDnsDisplayName, nemDnsMessageBytes, nemDnsPointerPrivateKey,
  nemDnsSiteUrl, normalizeNemDnsName, parseNemDnsMessage,
} from '../src/lib/nem/dns';
import type { RawDnsEntry } from '../src/lib/nem/dns';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- pointer key: identical to NanoWallet's
const vectors: Record<string, string> = {
  nem: '6ed7d9c60c8db0a500521342e9d9ca7fd8687fdc91ef658c91d1de6dca636861',
  test: '18d9fd51f282d2d134197b37b6f37b19a5179e2f2b345a0fe9e22578ea6f508e',
  symbol: 'e57b4e9a1ecd91904937f4ec6965be3ca064515329e6a3abad5af9a22e8c3070',
  'alice.bob': '29775c9a5f9224650b077240163eb04d025a0de8791ac31ac027c99ffb4c6eff',
  日本語: '97dc72974a4157d4a9d2df4f3ca0be8d58b539789de272ab416ee5758a4561eb',
  kasane: '74e18d219c9bd7ff0ea14686a09676c8056563a5eea24d1f979dfca34640d81c',
};
for (const [name, priv] of Object.entries(vectors)) {
  const got = nemDnsPointerPrivateKey(name);
  ok(got === priv.toUpperCase(), `pointer private key of "${name}"`, got);
}

// --- names
ok(normalizeNemDnsName('Kasane') === 'kasane', 'lower-cased');
ok(normalizeNemDnsName('  kasane.NEM ') === 'kasane', 'the .nem display suffix and spaces are dropped');
ok(normalizeNemDnsName('alice.bob') === 'alice.bob', 'a sub-namespace');
ok(normalizeNemDnsName('alice.bob.nem') === 'alice.bob', 'a sub-namespace with the suffix');
ok(normalizeNemDnsName('anem') === 'anem', 'a name that merely ends in "nem" is not cut');
ok(normalizeNemDnsName('nem') === 'nem', 'the namespace "nem" itself');
ok(normalizeNemDnsName('a.b.c.d') === null, 'more than 3 levels');
ok(normalizeNemDnsName('') === null && normalizeNemDnsName('.nem') === null && normalizeNemDnsName('a..b') === null, 'empty parts');
ok(normalizeNemDnsName('has space') === null && normalizeNemDnsName('-a') === null && normalizeNemDnsName('日本語') === null, 'characters NEM does not allow');
ok(normalizeNemDnsName('a'.repeat(16)) !== null && normalizeNemDnsName('a'.repeat(17)) === null, 'a root is at most 16 characters');
ok(normalizeNemDnsName('r.' + 'a'.repeat(64)) !== null && normalizeNemDnsName('r.' + 'a'.repeat(65)) === null, 'a sub is at most 64 characters');
ok(nemDnsDisplayName('kasane') === 'kasane.nem', 'display name');

// --- the message
const rec = { ...emptyNemDnsRecord(), ip1: 'example.com', organization: 'KASANE inc.', other: 'say "hi"\n日本語' };
const msg = buildNemDnsMessage(rec);
ok(msg === '{"dns":"yes","ip1":"example.com","organization":"KASANE inc.","other":"say \\"hi\\"\\n日本語"}', 'message: empty fields are left out, text is escaped', msg);
ok(msg.startsWith('{"dns":"yes"'), 'dns:yes comes first, as NanoWallet writes it');
const back = parseNemDnsMessage(msg);
ok(back !== null && back.ip1 === 'example.com' && back.organization === 'KASANE inc.' && back.other === 'say "hi"\n日本語' && back.phone === '', 'message round trip', back);
ok(buildNemDnsMessage({ ...emptyNemDnsRecord(), ip1: '  x.example  ' }) === '{"dns":"yes","ip1":"x.example"}', 'values are trimmed');
ok(buildNemDnsMessage(emptyNemDnsRecord()) === '{"dns":"yes"}', 'an empty record is just the marker');
ok(nemDnsMessageBytes(rec) === new TextEncoder().encode(msg).length && nemDnsMessageBytes(rec) > msg.length, 'size is in bytes (UTF-8)');
// What NanoWallet writes (no escaping, a space after the commas) is read too.
const nano = parseNemDnsMessage('{"dns":"yes","ip1":"172.16.254.1", "organization":"company inc.", "country":"US", "email":"a@b.c"}');
ok(nano !== null && nano.ip1 === '172.16.254.1' && nano.country === 'US' && nano.email === 'a@b.c', 'a NanoWallet message is read', nano);
ok(parseNemDnsMessage('{"dns":"no"}') === null && parseNemDnsMessage('{"ip1":"x"}') === null && parseNemDnsMessage('hello') === null && parseNemDnsMessage('[1]') === null && parseNemDnsMessage('{"dns":true}') === null, 'not a DNS message');
ok(parseNemDnsMessage('{"dns":"yes","ip1":5,"phone":null}')?.ip1 === '', 'a value that is not text is left empty');

// --- the site address
ok(nemDnsSiteUrl('example.com') === 'http://example.com/', 'no scheme: http://, like NanoWallet');
ok(nemDnsSiteUrl('172.16.254.1') === 'http://172.16.254.1/', 'an IP address');
ok(nemDnsSiteUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1', 'https is kept');
ok(nemDnsSiteUrl('example.com:8080/x') === 'http://example.com:8080/x', 'a port without a scheme');
ok(nemDnsSiteUrl('javascript:alert(1)') === null, 'javascript: is not opened');
ok(nemDnsSiteUrl('ftp://example.com') === null && nemDnsSiteUrl('data:text/html,x') === null && nemDnsSiteUrl('file:///etc/passwd') === null, 'only http / https');
ok(nemDnsSiteUrl('https://user:pass@example.com') === null, 'no credentials in the address');
ok(nemDnsSiteUrl('') === null && nemDnsSiteUrl('a b') === null, 'empty / with a space');

// --- finding the record in the history
const OWNER = 'N' + 'O'.repeat(39), OTHER = 'N' + 'X'.repeat(39), POINTER = 'N' + 'P'.repeat(39);
const addressOf = (pk: string) => ({ OWNERKEY: OWNER, OTHERKEY: OTHER, MSIGKEY: OWNER })[pk] ?? (() => { throw new Error('bad key'); })();
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const transfer = (signer: string, text: string, opts: { type?: number; to?: string; msgType?: number } = {}): RawDnsEntry['transaction'] =>
  ({ type: opts.type ?? 0x101, signer, recipient: opts.to ?? POINTER, timeStamp: 100, message: { type: opts.msgType ?? 1, payload: hex(text) } });
const entry = (tx: RawDnsEntry['transaction'], hash: string, height = 1): RawDnsEntry => ({ meta: { hash: { data: hash }, height }, transaction: tx });
const m = (ip: string) => buildNemDnsMessage({ ...emptyNemDnsRecord(), ip1: ip });
const find = (entries: RawDnsEntry[]) => findNemDnsRecord(entries, OWNER, POINTER, addressOf);

ok(find([entry(transfer('OWNERKEY', m('new.example')), 'H1'), entry(transfer('OWNERKEY', m('old.example')), 'H2')])?.record.ip1 === 'new.example', 'the newest (first) record of the owner wins');
const spoof = find([entry(transfer('OTHERKEY', m('evil.example')), 'HX'), entry(transfer('OWNERKEY', m('good.example')), 'HG')]);
ok(spoof?.record.ip1 === 'good.example' && spoof.hash === 'HG', 'a DNS message from someone who is not the owner is ignored', spoof);
ok(find([entry(transfer('OTHERKEY', m('evil.example')), 'HX')]) === null, 'only a stranger: nothing');
ok(find([entry(transfer('OWNERKEY', 'just a note'), 'H1'), entry(transfer('OWNERKEY', m('x.example')), 'H2')])?.hash === 'H2', 'owner messages that are not DNS are skipped (NanoWallet would crash on them)');
ok(find([entry(transfer('OWNERKEY', m('x.example'), { to: OTHER }), 'H1')]) === null, 'a transfer to another address is not the record');
ok(find([entry(transfer('OWNERKEY', m('x.example'), { msgType: 2 }), 'H1')]) === null, 'an encrypted message is not read');
ok(find([entry(transfer('OWNERKEY', m('x.example'), { type: 0x801 }), 'H1')]) === null, 'not a transfer');
const wrapped = find([entry({ type: 0x1004, signer: 'OTHERKEY', otherTrans: transfer('MSIGKEY', m('msig.example')) }, 'HM')]);
ok(wrapped?.record.ip1 === 'msig.example' && wrapped.hash === 'HM', 'a multisig transfer: the account it is in the name of counts, not the cosigner');
ok(find([entry({ type: 0x1004, signer: 'OWNERKEY', otherTrans: transfer('OTHERKEY', m('x.example')) }, 'HM')]) === null, 'a multisig transfer of another account does not count even if the owner cosigned');
ok(find([entry(transfer('UNKNOWN', m('x.example')), 'H1'), entry(transfer('OWNERKEY', m('y.example')), 'H2')])?.hash === 'H2', 'an unreadable signer is skipped');
ok(find([]) === null, 'no history');
ok(find([entry({ type: 0x101, signer: 'OWNERKEY', recipient: POINTER, message: { type: 1, payload: 'ZZ' } }, 'H1'), entry({ type: 0x101, signer: 'OWNERKEY', recipient: POINTER, message: { type: 1, payload: 'FF' } }, 'H2')]) === null, 'payloads that are not hex / not UTF-8 are skipped');
ok(find([entry(transfer('OWNERKEY', m('x.example')), 'H1')])?.timeStamp === 100, 'time stamp is returned');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
