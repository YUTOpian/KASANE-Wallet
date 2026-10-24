// アドレス帳：連絡先の検証・JSONバックアップ・インポート・信頼度判定の確認。
// 実行: npx tsx dev-tests/address-book.test.ts
// アドレスの判定は簡易版を渡す（本物の parseWatchAddress はチェックサムまで見る）。
import {
  BackupFormatError, LIMITS, blockedAddresses, displayName, entryKey, mergeImported, parseBackup,
  normalizeList, serializeBackup, trustOf, validateContact,
} from '../src/lib/addressBook';
import type { AddressBookEntry, AddressParser } from '../src/lib/addressBook';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const parse: AddressParser = (input) => {
  const a = input.replace(/[-\s]/g, '').toUpperCase();
  if (!/^[NT][A-Z2-7]+$/.test(a)) return null;
  const network = a[0] === 'N' ? 'mainnet' : 'testnet';
  if (a.length === 39) return { chain: 'symbol', network, address: a };
  if (a.length === 40) return { chain: 'nem', network, address: a };
  return null;
};
const sym = (n: string) => `N${n.repeat(38)}`.slice(0, 39);
const A = sym('A');
const B = sym('B');
const C = sym('C');
const NEM_A = `N${'D'.repeat(39)}`;

// --- 検証 ---
let r = validateContact({ name: 'Alice', address: A }, [], parse);
check('valid contact', r.ok && r.fields.chain === 'symbol' && r.fields.network === 'mainnet' && r.fields.list === 'white');
r = validateContact({ name: 'Alice', address: 'hello' }, [], parse);
check('invalid address', !r.ok && r.error === 'invalid_address');
r = validateContact({ name: '  ', address: A }, [], parse);
check('name required', !r.ok && r.error === 'name_required');
r = validateContact({ name: '', address: A, list: 'black' }, [], parse);
check('blacklist needs no name', r.ok && r.fields.list === 'black');
r = validateContact({ name: 'x', address: A, email: 'not-an-email' }, [], parse);
check('invalid email', !r.ok && r.error === 'invalid_email');
r = validateContact({ name: 'x', address: A, email: 'a@b.co', phone: '090-1234-5678', memo: 'メモ\n二行目' }, [], parse);
check('email / phone / memo kept', r.ok && r.fields.email === 'a@b.co' && r.fields.phone === '090-1234-5678' && r.fields.memo === 'メモ\n二行目');
r = validateContact({ name: 'x', address: `${A.slice(0, 6)}-${A.slice(6)}` }, [], parse);
check('hyphens are normalised', r.ok && r.fields.address === A);
r = validateContact({ name: 'x'.repeat(500), address: A }, [], parse);
check('name length capped', r.ok && r.fields.name.length === LIMITS.name);

const now = 1_700_000_000_000;
const alice: AddressBookEntry = { id: 'id-a', chain: 'symbol', network: 'mainnet', address: A, name: 'Alice', email: '', phone: '', memo: '', list: 'white', createdAt: now, updatedAt: now };
const bob: AddressBookEntry = { ...alice, id: 'id-b', address: B, name: 'Bob', list: 'black' };
const carol: AddressBookEntry = { ...alice, id: 'id-c', address: C, name: 'Carol', list: 'white' };
const book = [alice, bob, carol];

r = validateContact({ name: 'Alice2', address: A }, book, parse);
check('duplicate on add', !r.ok && r.error === 'duplicate');
r = validateContact({ name: 'Alice2', address: A }, book, parse, 'id-a');
check('same entry may be edited', r.ok);
r = validateContact({ name: 'Alice2', address: B }, book, parse, 'id-a');
check('edit into another contact is a duplicate', !r.ok && r.error === 'duplicate');
r = validateContact({ name: 'NEM Alice', address: NEM_A }, book, parse);
check('same text on another chain is not a duplicate', r.ok && r.fields.chain === 'nem');
check('entryKey ignores hyphens and case', entryKey('symbol', 'mainnet', `${A.slice(0, 6)}-${A.slice(6).toLowerCase()}`) === entryKey('symbol', 'mainnet', A));

// --- バックアップ ---
const json = serializeBackup(book, now);
const back = parseBackup(json, parse, now);
check('roundtrip count', back.entries.length === 3 && back.skipped === 0);
check('roundtrip fields', back.entries.find((e) => e.address === B)?.list === 'black' && back.entries.find((e) => e.address === A)?.name === 'Alice');
check('import gets fresh ids', back.entries.every((e) => !['id-a', 'id-b', 'id-c'].includes(e.id)));
check('backup has no ids', !json.includes('id-a'));

const dirty = JSON.stringify({ format: 'kasane-address-book', version: 1, entries: [
  { address: A, name: 'ok\u0000\u0007name', list: 'white', email: 'bad', memo: 'm' },
  { address: 'garbage', name: 'x' },
  { address: B, name: 'dup1' },
  { address: B, name: 'dup2', list: 'weird' },
  null,
] });
const d = parseBackup(dirty, parse, now);
check('dirty: control chars removed', d.entries[0].name === 'okname');
check('dirty: bad email dropped', d.entries[0].email === '');
check('dirty: skipped rows counted', d.skipped === 2 && d.entries.length === 2);
check('dirty: later duplicate wins, bad list -> white', d.entries.find((e) => e.address === B)?.name === 'dup2' && d.entries.find((e) => e.address === B)?.list === 'white');
check('bare array accepted', parseBackup(JSON.stringify([{ address: A, name: 'x' }]), parse).entries.length === 1);
for (const bad of ['not json', '{}', '{"format":"other","entries":[]}', '{"format":"kasane-address-book"}', '42']) {
  let threw = false;
  try { parseBackup(bad, parse); } catch (e) { threw = e instanceof BackupFormatError; }
  check(`rejects ${bad.slice(0, 20)}`, threw);
}

// --- マージ ---
const incoming = parseBackup(JSON.stringify({ format: 'kasane-address-book', entries: [
  { address: A, name: 'Alice (new)', list: 'white' },
  { address: sym('E'), name: 'Eve', list: 'white' },
] }), parse, now).entries;
const merged = mergeImported(book, incoming, 'merge', now + 1);
check('merge counts', merged.added === 1 && merged.updated === 1 && merged.entries.length === 4);
const mergedA = merged.entries.find((e) => e.address === A)!;
check('merge keeps id & createdAt, takes new data', mergedA.id === 'id-a' && mergedA.createdAt === now && mergedA.name === 'Alice (new)' && mergedA.list === 'white');
check('merge leaves the others', merged.entries.some((e) => e.id === 'id-b') && merged.entries.some((e) => e.id === 'id-c'));
const replaced = mergeImported(book, incoming, 'replace', now);
check('replace', replaced.entries.length === 2 && !replaced.entries.some((e) => e.id === 'id-b'));

// --- 以前の「通常」(none) はホワイトリストにそろえる ---
check('normalizeList: legacy none -> white', normalizeList('none') === 'white' && normalizeList(undefined) === 'white');
check('normalizeList: black stays black', normalizeList('black') === 'black');

// --- 信頼度 ---
const own = new Set([sym('S')]);
check('trust: white', trustOf(book, 'symbol', 'mainnet', A, own).trust === 'white');
check('trust: black', trustOf(book, 'symbol', 'mainnet', B, own).trust === 'black');
check('trust: a contact not on the blacklist is white', trustOf(book, 'symbol', 'mainnet', C, own).trust === 'white');
check('trust: unknown', trustOf(book, 'symbol', 'mainnet', sym('Z'), own).trust === 'unknown');
check('trust: self wins even if blocked', trustOf([{ ...bob, address: sym('S') }], 'symbol', 'mainnet', sym('S'), own).trust === 'self');
check('trust: other network is unknown', trustOf(book, 'symbol', 'testnet', A, own).trust === 'unknown');
check('trust: other chain is unknown', trustOf(book, 'nem', 'mainnet', A, own).trust === 'unknown');
check('trust: hyphenated lookup', trustOf(book, 'symbol', 'mainnet', `${B.slice(0, 6)}-${B.slice(6)}`, own).trust === 'black');

const blocked = blockedAddresses([...book, { ...bob, id: 'x', address: sym('S') }], 'symbol', 'mainnet', own);
check('blocked set', blocked.size === 1 && blocked.has(B));
check('blocked set is per chain/network', blockedAddresses(book, 'symbol', 'testnet').size === 0);

check('displayName: name', displayName(alice) === 'Alice');
check('displayName: short address', displayName({ name: '', address: B }) === `${B.slice(0, 6)}…${B.slice(-4)}`);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
