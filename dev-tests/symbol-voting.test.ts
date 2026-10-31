// Symbol の投票（lib/symbol/voting.ts）: アドレスの作り方・メッセージの形・投票の組み立て・票の数え方。通信なし。
// 実行: npx tsx dev-tests/symbol-voting.test.ts
import { createHash } from 'node:crypto';
import { addressFromPublicKey, isValidAddress } from '../src/lib/symbol/crypto';
import {
  POLL_TYPE_POI, POLL_TYPE_WHITELIST, WHITELIST_ADDRESSES_PER_MESSAGE, assemblePoll, buildPollMessages, deriveOptionAddress, generatePollAddress,
  hasPollForm, isPollEnded, parseImportance, parsePollHeader, parsePollTx, plainText, poiResults, pollIndexAddress, sha3Hex, sortNewestFirst,
  tallyVoters, validateNewPoll, whitelistResults,
} from '../src/lib/symbol/voting';
import type { NewPollInput, PollAddressing, PollTx, RawPollEntry } from '../src/lib/symbol/voting';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const throws = (fn: () => unknown, msg: string, what: string) => {
  try { fn(); ok(false, `${what} (did not throw)`); } catch (e) { ok(e instanceof Error && e.message === msg, what, e instanceof Error ? e.message : e); }
};

const MAIN = 0x68;
const TEST = 0x98;
const adOf = (networkByte: number): PollAddressing => ({
  networkByte,
  addressOfKey: (keyHex) => addressFromPublicKey(keyHex, networkByte),
  isValid: (address) => isValidAddress(address, networkByte),
});
const main = adOf(MAIN);
const test = adOf(TEST);

// --- 参照実装（SDK を使わず、Symbol のアドレスの作り方どおりに）-----------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(bytes: Uint8Array): string {
  let out = '', bits = 0, v = 0;
  for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
const sha3 = (d: Uint8Array) => new Uint8Array(createHash('sha3-256').update(d).digest());
const rip = (d: Uint8Array) => new Uint8Array(createHash('ripemd160').update(d).digest());
function refAddress(keyHex: string, net: number): string {
  const key = Uint8Array.from(keyHex.match(/.{2}/g)!, (h) => parseInt(h, 16));
  const v = new Uint8Array(21); v[0] = net; v.set(rip(sha3(key)), 1);
  const out = new Uint8Array(24); out.set(v); out.set(sha3(v).subarray(0, 3), 21);
  return b32(out);
}
const refHex = (text: string) => createHash('sha3-256').update(text, 'utf8').digest('hex');

// --- addresses ------------------------------------------------------------------------------
{
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const titles = ['test', 'ポール１', 'Which one? 🍣', 'a'.repeat(100)];
  for (const [ad, net] of [[main, MAIN], [test, TEST]] as const) {
    for (let i = 0; i < 40; i += 1) {
      const pk = rnd(64).toUpperCase();
      for (const t of titles) {
        const pa = generatePollAddress(t, pk, ad);
        eq(pa, refAddress(refHex(pk.toLowerCase() + t), net), `poll address ${t}`);
        ok(ad.isValid(pa), 'poll address is a valid address of the network');
        for (const o of ['はい', 'No', `Option ${i}`, '']) eq(deriveOptionAddress(pa, o, ad), refAddress(refHex(pa + o), net), `option ${o}`);
      }
    }
  }
  ok(main.isValid(pollIndexAddress(main)) && test.isValid(pollIndexAddress(test)), 'index address is valid on both networks');
  ok(pollIndexAddress(main) !== pollIndexAddress(test), 'index differs by network');
  ok(pollIndexAddress(main).startsWith('N') && pollIndexAddress(test).startsWith('T'), 'mainnet N / testnet T');
  ok(!test.isValid(pollIndexAddress(main)), 'mainnet address is not valid on testnet');
  eq(sha3Hex('abc'), refHex('abc'), 'sha3Hex');
  // 大文字・ハイフン付きでも同じ投票のアドレス（選択肢のアドレスの計算）
  const pa = generatePollAddress('t', 'AB'.repeat(32), main);
  eq(deriveOptionAddress(pa, 'x', main), deriveOptionAddress(`${pa.slice(0, 6)}-${pa.slice(6)}`.toLowerCase(), 'x', main), 'option address ignores hyphens / case of the poll address');
}

// --- keys and people ------------------------------------------------------------------------
const keyHex = (i: number) => createHash('sha3-256').update(`person-${i}`).digest('hex').toUpperCase();
const people = Array.from({ length: 8 }, (_, i) => { const publicKey = keyHex(i + 1); return { publicKey, address: addressFromPublicKey(publicKey, MAIN) }; });
const [creator, A, B, C, D, E, F] = people;
const EPOCH = 1615853185;
const END = Date.now() + 7 * 86400_000; // 開催中
const PAST_END = Date.now() - 86400_000; // 終了

// --- creating -------------------------------------------------------------------------------
const baseInput: NewPollInput = { title: '  好きな色は？  ', description: '説明', options: [' 赤 ', '青', '緑'], doe: END, type: POLL_TYPE_POI, multiple: false, whitelist: [] };
{
  eq(validateNewPoll(baseInput, main), [], 'valid input has no issues');
  const built = buildPollMessages(baseInput, creator.publicKey, main);
  eq(built.messages.length, 4, 'formData + description + options + header');
  eq(built.messages.slice(0, 3).map((m) => m.recipient), [built.pollAddress, built.pollAddress, built.pollAddress], 'three messages to the poll address');
  eq(built.messages[3].recipient, pollIndexAddress(main), 'header goes to the index');
  ok(built.messages[0].message.startsWith('formData:'), 'formData');
  eq(JSON.parse(built.messages[0].message.slice(9)), { title: '好きな色は？', doe: END, type: 0, multiple: false }, 'formData content (title trimmed)');
  eq(built.messages[1].message, 'description:説明', 'description');
  const opts = JSON.parse(built.messages[2].message.slice(8)) as { strings: string[]; link: Record<string, string> };
  eq(opts.strings, ['赤', '青', '緑'], 'options trimmed');
  for (const o of opts.strings) eq(opts.link[o], deriveOptionAddress(built.pollAddress, o, main), `link ${o}`);
  eq(JSON.parse(built.messages[3].message.slice(5)), { title: '好きな色は？', type: 0, doe: END, address: built.pollAddress }, 'header content');
  eq(built.pollAddress, generatePollAddress('好きな色は？', creator.publicKey, main), 'poll address = title + creator key');

  const issues = (patch: Partial<NewPollInput>) => validateNewPoll({ ...baseInput, ...patch }, main);
  ok(issues({ title: '' }).includes('title_empty'), 'empty title');
  ok(issues({ title: 'a'.repeat(101) }).includes('title_long'), 'long title');
  ok(issues({ options: ['a'] }).includes('options_few'), 'few options');
  ok(issues({ options: Array.from({ length: 11 }, (_, i) => `o${i}`) }).includes('options_many'), 'many options');
  ok(issues({ options: ['a', ''] }).includes('option_empty'), 'empty option');
  ok(issues({ options: ['a', 'b'.repeat(51)] }).includes('option_long'), 'long option');
  ok(issues({ options: ['a', ' a '] }).includes('option_duplicate'), 'duplicate option (after trim)');
  ok(issues({ doe: Date.now() - 1 }).includes('end_past'), 'end in the past');
  ok(issues({ type: POLL_TYPE_WHITELIST, whitelist: [] }).includes('whitelist_empty'), 'whitelist empty');
  ok(issues({ type: POLL_TYPE_WHITELIST, whitelist: ['NOTANADDRESS'] }).includes('whitelist_invalid'), 'whitelist invalid');
  ok(issues({ type: POLL_TYPE_WHITELIST, whitelist: [pollIndexAddress(test)] }).includes('whitelist_invalid'), 'whitelist address of another network');
  ok(issues({ description: 'x'.repeat(1100) }).includes('message_too_large'), 'description too large for one message');
  ok(!issues({ description: 'x'.repeat(1000) }).includes('message_too_large'), '1000-byte description fits (1023 limit)');
  ok(issues({ description: 'あ'.repeat(400) }).includes('message_too_large'), 'multi-byte description counted in bytes');
}

// --- whitelist messages ---------------------------------------------------------------------
{
  const list = Array.from({ length: 60 }, (_, i) => addressFromPublicKey(keyHex(100 + i), MAIN));
  const input: NewPollInput = { ...baseInput, type: POLL_TYPE_WHITELIST, whitelist: [...list, list[0].toLowerCase()] };
  eq(validateNewPoll(input, main), [], 'whitelist poll is valid');
  const built = buildPollMessages(input, creator.publicKey, main);
  const wl = built.messages.filter((m) => m.message.startsWith('whitelist:'));
  eq(wl.length, Math.ceil(60 / WHITELIST_ADDRESSES_PER_MESSAGE), 'whitelist split in chunks (duplicates removed)');
  eq(wl.flatMap((m) => JSON.parse(m.message.slice(10)) as string[]), list, 'whitelist content in order');
  ok(built.messages[built.messages.length - 1].message.startsWith('poll:'), 'header is last');
  ok(wl.every((m) => new TextEncoder().encode(m.message).length <= 1023), 'each whitelist message fits');
  // 100 件までのアグリゲートに入りきらないほど大きいホワイトリスト
  const huge = Array.from({ length: 2400 }, (_, i) => addressFromPublicKey(keyHex(1000 + i), MAIN));
  ok(validateNewPoll({ ...input, whitelist: huge }, main).includes('message_too_large'), 'too many whitelist messages for one aggregate');
}

// --- reading a poll back --------------------------------------------------------------------
let seq = 0;
function tx(signer: string, message: string | null, patch: Partial<PollTx> = {}): PollTx {
  seq += 1;
  return { height: 1000 + seq, index: 0, timeMs: Date.now() - 3600_000, hash: `H${seq}`, signer, hasMosaics: false, message, ...patch };
}
function pollTxs(input: NewPollInput, who = creator, patch: Partial<PollTx> = {}): { txs: PollTx[]; address: string } {
  const built = buildPollMessages(input, who.publicKey, main);
  const txs = built.messages.filter((m) => m.recipient === built.pollAddress).map((m) => tx(who.address, m.message, patch));
  return { txs: sortNewestFirst(txs), address: built.pollAddress };
}

{
  const { txs, address } = pollTxs(baseInput);
  const poll = assemblePoll(address, txs, main);
  eq([poll.title, poll.description, poll.options, poll.type, poll.multiple, poll.doe, poll.valid, poll.creator], ['好きな色は？', '説明', ['赤', '青', '緑'], 0, false, END, true, creator.address], 'poll read back');
  eq(Object.keys(poll.optionAddresses), ['赤', '青', '緑'], 'option addresses');
  ok(!isPollEnded(poll), 'not ended');
  ok(isPollEnded({ doe: PAST_END }), 'ended');

  // 作った人より後に、だれかが同じ接頭辞のメッセージを書いても、いちばん古い（作った人の）ものが使われる
  const forged = tx(A.address, `formData:${JSON.stringify({ title: 'forged', doe: END, type: 0, multiple: true })}`, { height: 999999 });
  eq(assemblePoll(address, sortNewestFirst([...txs, forged]), main).title, '好きな色は？', 'later forged formData is ignored');
  eq(assemblePoll(address, sortNewestFirst([...txs, forged]), main).creator, creator.address, 'creator = first writer');

  // 選択肢のアドレスが計算と違えば、投票はできない（valid = false）
  const built = buildPollMessages(baseInput, creator.publicKey, main);
  const opts = JSON.parse(built.messages[2].message.slice(8)) as { strings: string[]; link: Record<string, string> };
  opts.link['赤'] = A.address; // 計算で出る住所とは別の、正しい形のアドレス
  const bad = sortNewestFirst(txs.map((t) => (t.message?.startsWith('options:') ? { ...t, message: `options:${JSON.stringify(opts)}` } : t)));
  eq(assemblePoll(address, bad, main).valid, false, 'tampered option link is not valid');
  opts.link['赤'] = opts.link['青']; // 2 つの選択肢が同じアドレス
  const dup = sortNewestFirst(txs.map((t) => (t.message?.startsWith('options:') ? { ...t, message: `options:${JSON.stringify(opts)}` } : t)));
  throws(() => assemblePoll(address, dup, main), 'poll_invalid', 'two options sharing an address');

  throws(() => assemblePoll(address, [], main), 'poll_not_found', 'nothing written');
  throws(() => assemblePoll(address, txs.filter((t) => !t.message?.startsWith('options:')), main), 'poll_not_found', 'missing options');
  throws(() => assemblePoll(address, txs.map((t) => (t.message?.startsWith('formData:') ? { ...t, message: 'formData:{not json' } : t)), main), 'poll_invalid', 'broken formData');
  throws(() => assemblePoll(address, txs.map((t) => (t.message?.startsWith('formData:') ? { ...t, message: `formData:${JSON.stringify({ title: 'x', doe: END, type: 7 })}` } : t)), main), 'poll_unsupported', 'unknown poll type');
  throws(() => assemblePoll(address, txs.map((t) => (t.message?.startsWith('options:') ? { ...t, message: `options:${JSON.stringify({ strings: ['a', 'b'] })}` } : t)), main), 'poll_invalid', 'options without link');
}

// --- whitelist read back (additions after the end are ignored) --------------------------------
{
  const input: NewPollInput = { ...baseInput, type: POLL_TYPE_WHITELIST, whitelist: [A.address, B.address] };
  const { txs, address } = pollTxs(input);
  const late = tx(creator.address, `whitelist:${JSON.stringify([C.address])}`, { timeMs: END + 1000 });
  const stranger = tx(D.address, `whitelist:${JSON.stringify([E.address])}`);
  const broken = tx(creator.address, 'whitelist:[oops');
  const poll = assemblePoll(address, sortNewestFirst([...txs, late, stranger, broken]), main);
  eq(poll.whitelist, [A.address, B.address], 'whitelist: creator only, before the end, broken ignored');
}

// --- counting -------------------------------------------------------------------------------
function counting(patch: Partial<NewPollInput>, votes: Array<[PollTx[], PollTx[], PollTx[]]>) {
  const input: NewPollInput = { ...baseInput, whitelist: [], ...patch };
  const { txs, address } = pollTxs(input);
  const poll = assemblePoll(address, txs, main);
  return { poll, tally: tallyVoters(poll, votes[0]) };
}
const vote = (who: { address: string }, patch: Partial<PollTx> = {}) => tx(who.address, null, patch);
{
  // 1 つだけ選ぶ投票
  const single = counting({}, [[[vote(A), vote(B)], [vote(C)], [vote(D), vote(A)]]]);
  eq(single.tally.voters, [[B.address], [C.address], [D.address]], 'single choice: A voted twice → no valid vote');
  eq(single.tally.unique, [B.address, C.address, D.address].sort(), 'single choice: unique voters');
  const res = whitelistResults(single.poll, single.tally);
  eq([res.totalVotes, res.options.map((o) => o.votes)], [3, [1, 1, 1]], 'counted per option');

  // 複数選べる投票
  const multi = counting({ multiple: true }, [[[vote(A), vote(B)], [vote(A)], []]]);
  eq(multi.tally.voters.map((l) => [...l].sort()), [[A.address, B.address].sort(), [A.address], []], 'multiple choice: both votes of A count');
  eq(multi.tally.occurrences.get(A.address), 2, 'A chose two options');
  const dupe = counting({ multiple: true }, [[[vote(A), vote(A)], [], []]]);
  eq(dupe.tally.voters[0], [A.address], 'same account voting an option twice counts once');

  // 終わりのあとの票・モザイクつきの送金は数えない
  const filtered = counting({}, [[[vote(A, { timeMs: END + 1 }), vote(B, { hasMosaics: true }), vote(C, { timeMs: END })], [], []]]);
  eq(filtered.tally.voters[0], [C.address], 'after the end / with mosaics are not votes; exactly at the end counts');

  // ホワイトリスト
  const wl = counting({ type: POLL_TYPE_WHITELIST, whitelist: [A.address, B.address] }, [[[vote(A), vote(C)], [vote(B), vote(D)], []]]);
  eq(wl.tally.voters, [[A.address], [B.address], []], 'whitelist: only listed addresses');
  const wr = whitelistResults(wl.poll, wl.tally);
  eq(wr.options.map((o) => o.percentage), [50, 50, 0], 'whitelist percentages');
  eq(whitelistResults(single.poll, tallyVoters(single.poll, [[], [], []])).options.map((o) => o.percentage), [0, 0, 0], 'no votes: 0%');

  // 重要度で重み付け
  const poi = counting({}, [[[vote(A), vote(B)], [vote(C)], []]]);
  const imp = poiResults(poi.poll, poi.tally, poi.tally.unique.map((a) => ({ [A.address]: 30, [B.address]: 10, [C.address]: 60 } as Record<string, number>)[a]), false);
  eq(imp.options.map((o) => Math.round(o.percentage)), [40, 60, 0], 'importance-weighted percentages');
  eq(imp.totalVotes, 3, 'weighted: valid vote count');
  eq(poiResults(poi.poll, poi.tally, poi.tally.unique.map(() => 0), true).options.map((o) => o.percentage), [0, 0, 0], 'zero importance: 0%');
  eq(poiResults(poi.poll, poi.tally, poi.tally.unique.map(() => 1), true).approximateImportance, true, 'approximate flag passes through');
  // 複数選択: 重要度は、選んだ数で割って配る
  const pm = counting({ multiple: true }, [[[vote(A)], [vote(A), vote(B)], []]]);
  const w = poiResults(pm.poll, pm.tally, pm.tally.unique.map((a) => ({ [A.address]: 40, [B.address]: 20 } as Record<string, number>)[a]), false);
  eq(w.options.map((o) => Math.round(o.weighted)), [20, 40, 0], 'multiple: importance split over the chosen options');
}

// --- parsing what the node returns ----------------------------------------------------------
{
  const addressOf = (pk: string) => addressFromPublicKey(pk, MAIN);
  const hex = (s: string) => `00${Buffer.from(s, 'utf8').toString('hex')}`;
  const plain: RawPollEntry = {
    id: 'a1',
    meta: { hash: 'abcd', height: '1234', index: 3, timestamp: '600000' },
    transaction: { type: 0x4154, signerPublicKey: A.publicKey, message: hex('poll:{}'), mosaics: [] },
  };
  const t1 = parsePollTx(plain, addressOf, EPOCH);
  eq([t1?.signer, t1?.height, t1?.index, t1?.timeMs, t1?.hash, t1?.hasMosaics, t1?.message], [A.address, 1234, 3, 600000 + EPOCH * 1000, 'ABCD', false, 'poll:{}'], 'plain transfer');
  const emb: RawPollEntry = { meta: { aggregateHash: 'ff00', height: '77', index: 1 }, transaction: { type: 0x4154, signerPublicKey: B.publicKey, message: hex('x'), mosaics: [{ id: '6BED913FA20223F8', amount: '5' }] } };
  const t2 = parsePollTx(emb, addressOf, EPOCH);
  eq([t2?.signer, t2?.timeMs, t2?.hash, t2?.hasMosaics], [B.address, null, 'FF00', true], 'embedded transfer without timestamp (hash = aggregate hash)');
  eq(parsePollTx({ ...plain, transaction: { ...plain.transaction, type: 0x4141 } }, addressOf, EPOCH), null, 'not a transfer');
  eq(parsePollTx({ ...plain, transaction: { type: 0x4154 } }, addressOf, EPOCH), null, 'no signer');
  eq(parsePollTx({ ...plain, transaction: { ...plain.transaction, signerPublicKey: 'zz' } }, (pk) => { if (pk === 'zz') throw new Error('bad'); return ''; }, EPOCH), null, 'unreadable signer');
  eq(plainText('01aabb'), null, 'encrypted message is not text');
  eq(plainText('00'), null, 'empty message');
  eq(plainText(undefined), null, 'no message');
  eq(plainText('00ff'), null, 'invalid UTF-8');
  eq(plainText(hex('日本語')), '日本語', 'UTF-8 text');
  const order = sortNewestFirst([tx(A.address, 'a', { height: 5, index: 1 }), tx(A.address, 'b', { height: 9, index: 0 }), tx(A.address, 'c', { height: 5, index: 2 })]);
  eq(order.map((t) => t.message), ['b', 'c', 'a'], 'newest first (height, then index)');

  // 索引の見出し
  const goodHeader = tx(A.address, `poll:${JSON.stringify({ title: 'T', type: 1, doe: END, address: creator.address })}`);
  eq(parsePollHeader(goodHeader, main)?.address, creator.address, 'header address');
  eq(parsePollHeader(goodHeader, main)?.creator, A.address, 'header creator = who listed it');
  eq(parsePollHeader({ ...goodHeader, message: `poll:${JSON.stringify({ title: 'T', type: 1, doe: END, address: creator.address.toLowerCase() })}` }, main)?.address, creator.address, 'header address normalized');
  for (const [what, body] of [
    ['wrong type', { title: 'T', type: 5, doe: END, address: creator.address }],
    ['no title', { type: 0, doe: END, address: creator.address }],
    ['doe not a number', { title: 'T', type: 0, doe: 'x', address: creator.address }],
    ['address of another network', { title: 'T', type: 0, doe: END, address: pollIndexAddress(test) }],
    ['bad address', { title: 'T', type: 0, doe: END, address: 'N123' }],
  ] as const) eq(parsePollHeader(tx(A.address, `poll:${JSON.stringify(body)}`), main), null, `header: ${what}`);
  eq(parsePollHeader(tx(A.address, 'poll:{broken'), main), null, 'header: broken JSON');
  eq(parsePollHeader(tx(A.address, 'hello'), main), null, 'header: not a poll message');
  eq(parsePollHeader(tx(A.address, null), main), null, 'header: no message');

  eq(hasPollForm([tx(A.address, 'hi'), tx(A.address, 'formData:{}')]), true, 'hasPollForm');
  eq(hasPollForm([tx(A.address, 'hi'), tx(A.address, null)]), false, 'no poll form');

  eq([parseImportance("7'842'928'625'000'000"), parseImportance('12345'), parseImportance(undefined), parseImportance('abc'), parseImportance('')], [7842928625000000, 12345, 0, 0, 0], 'importance parsing');
  void F;
}

console.log(`checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
