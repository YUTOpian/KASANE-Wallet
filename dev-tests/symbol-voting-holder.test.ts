// Symbol の「モザイク保有者による投票」（5つ目の集計方法、種類 4）: 作成の検査・メッセージ・読み取り・集計。
// 「移転できないモザイクのみ」か「移転できるモザイクでもよい」かを作成者が選ぶ。REST は模擬。
// Run: npx tsx dev-tests/symbol-voting-holder.test.ts
import { PrivateKey } from 'symbol-sdk';
import { Address, KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { getNetwork, getNetworkConfig, setCustomNodeUrl } from '../src/lib/symbol/network';
import {
  POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_POI, POLL_TYPE_SIMPLE, assemblePoll, buildPollMessages, isKnownPollType, parsePollHeader, parsePollTx, pollUsesMosaic,
  sortNewestFirst, validateNewPoll,
} from '../src/lib/symbol/voting';
import type { NewPollInput } from '../src/lib/symbol/voting';
import { fetchMosaicTransferable, fetchSymbolPollResults, symbolAddressing } from '../src/lib/symbol/votingApi';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const rejects = async (p: Promise<unknown>, msg: string, what: string) => {
  try { await p; ok(false, `${what} (did not throw)`); } catch (e) { ok(e instanceof Error && e.message === msg, what, e instanceof Error ? e.message : e); }
};

const cfg = getNetworkConfig();
const nb = cfg.networkByte;
const ad = symbolAddressing(nb);
const kp = () => new KeyPair(PrivateKey.random());
const acct = () => { const k = kp(); return { publicKey: k.publicKey.toString(), address: addressFromPublicKey(k.publicKey.toString(), nb) }; };
const [creator, A, B, C, D, E] = [acct(), acct(), acct(), acct(), acct(), acct()];
const hexOf = (a: string) => Array.from(new Address(a).bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const addressOf = (pk: string) => addressFromPublicKey(pk, nb);

// flags: 1 = supply mutable, 2 = transferable. SOUL: not transferable; COIN: transferable.
const SOUL = '1122334455667788';
const COIN = '8877665544332211';
const GONE = 'AAAAAAAAAAAAAAAA';
const XYM = cfg.currencyMosaicId.toUpperCase();
const flagsOf: Record<string, number> = { [SOUL]: 1, [COIN]: 3 };
let mosaicStatus = 200; // what /mosaics/<id> answers (429 = it cannot be read right now; a 5xx would make the shared node logic switch nodes)
let mosaicRequests = 0;
const holdings: Record<string, Array<{ id: string; amount: string }>> = {};
const incoming: Record<string, unknown[]> = {};
interface Hist { id: string; meta: { hash: string; height: string; index: number; timestamp: string; feeMultiplier: string; aggregateHash?: string }; transaction: unknown }
const history: Record<string, Hist[]> = {};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (path === '/accounts' && init?.method === 'POST') {
    return json((body.addresses as string[]).filter((a) => holdings[a]).map((a) => ({ account: { address: hexOf(a), importance: '0', mosaics: holdings[a] } })));
  }
  if (path.startsWith('/mosaics/')) {
    mosaicRequests++;
    if (mosaicStatus !== 200) return json({ code: 'x' }, mosaicStatus);
    const id = path.slice(9);
    return id in flagsOf ? json({ mosaic: { id, flags: flagsOf[id], divisibility: 0 } }) : json({ code: 'ResourceNotFound' }, 404);
  }
  if (path.startsWith('/transactions/confirmed')) {
    const q = new URLSearchParams(path.split('?')[1]);
    if (q.get('address')) {
      const embedded = q.get('embedded') === 'true';
      const list = (history[q.get('address')!] ?? []).filter((e) => (e.meta.aggregateHash !== undefined) === embedded);
      const size = Number(q.get('pageSize') ?? 100);
      const page = Number(q.get('pageNumber') ?? 1);
      return json({ data: list.slice((page - 1) * size, page * size) });
    }
    if (q.get('embedded') === 'true') return json({ data: [] });
    return json({ data: incoming[q.get('recipientAddress') ?? ''] ?? [] });
  }
  return new Response('{"code":"ResourceNotFound"}', { status: 404 });
}) as typeof fetch;
setCustomNodeUrl(getNetwork(), 'http://mock.local');

// --- the type ------------------------------------------------------------------------------
ok(POLL_TYPE_MOSAIC_HOLDER === 4, 'the type value is 4');
ok(isKnownPollType(4) && !isKnownPollType(5), '4 is a known type, 5 is not');
ok(pollUsesMosaic(POLL_TYPE_MOSAIC) && pollUsesMosaic(POLL_TYPE_MOSAIC_HOLDER) && !pollUsesMosaic(POLL_TYPE_POI) && !pollUsesMosaic(POLL_TYPE_SIMPLE), 'which types name a mosaic');

// --- validation ----------------------------------------------------------------------------
const END = Date.now() + 86400_000;
const base: NewPollInput = { title: '保有者の投票', description: '', options: ['賛成', '反対'], doe: END, type: POLL_TYPE_MOSAIC_HOLDER, multiple: false, whitelist: [], mosaicId: SOUL, nonTransferableOnly: true, mosaicTransferable: false };
eq(validateNewPoll(base, ad), [], 'non-transferable only + a non-transferable mosaic: accepted');
ok(validateNewPoll({ ...base, mosaicTransferable: true }, ad).includes('mosaic_transferable'), 'non-transferable only + a transferable mosaic: refused');
ok(validateNewPoll({ ...base, mosaicTransferable: undefined }, ad).includes('mosaic_transferable'), 'non-transferable only + a mosaic that was not confirmed: refused');
eq(validateNewPoll({ ...base, nonTransferableOnly: false, mosaicTransferable: true, mosaicId: COIN }, ad), [], 'transferable allowed + a transferable mosaic: accepted');
eq(validateNewPoll({ ...base, nonTransferableOnly: false, mosaicTransferable: false }, ad), [], 'transferable allowed also takes a non-transferable one');
ok(validateNewPoll({ ...base, mosaicId: '' }, ad).includes('mosaic_invalid'), 'no mosaic: mosaic_invalid');
ok(!validateNewPoll({ ...base, mosaicId: '' }, ad).includes('mosaic_transferable'), 'no mosaic: not also reported as transferable');
ok(validateNewPoll({ ...base, mosaicId: 'xyz' }, ad).includes('mosaic_invalid'), 'malformed mosaic: mosaic_invalid');
eq(validateNewPoll({ ...base, type: POLL_TYPE_POI, mosaicId: undefined, mosaicTransferable: true }, ad), [], 'other types ignore the holder fields');
eq(validateNewPoll({ ...base, type: POLL_TYPE_MOSAIC, mosaicId: COIN, mosaicTransferable: true }, ad), [], 'the weighted type does not need a non-transferable mosaic');

// --- the messages --------------------------------------------------------------------------
const formOf = (input: NewPollInput) => JSON.parse(buildPollMessages(input, creator.publicKey, ad).messages[0].message.slice('formData:'.length));
let form = formOf(base);
eq([form.type, form.mosaicId, form.nonTransferableOnly], [4, SOUL, true], 'formData carries the type, the mosaic and the rule');
form = formOf({ ...base, nonTransferableOnly: false, mosaicId: ` ${COIN.toLowerCase()} ` });
eq([form.mosaicId, form.nonTransferableOnly], [COIN, false], 'the rule is written as false when transferable mosaics are allowed (and the mosaic is normalised)');
form = formOf({ ...base, nonTransferableOnly: undefined });
eq(form.nonTransferableOnly, false, 'an unset rule is written as false, never left out');
ok(!('nonTransferableOnly' in formOf({ ...base, type: POLL_TYPE_MOSAIC, mosaicId: COIN })), 'the weighted type does not write the rule');
ok(!('mosaicId' in formOf({ ...base, type: POLL_TYPE_SIMPLE })) && !('nonTransferableOnly' in formOf({ ...base, type: POLL_TYPE_SIMPLE })), 'other types write neither');
ok(!JSON.stringify(buildPollMessages(base, creator.publicKey, ad).messages).includes('mosaicTransferable'), 'the check-only field is not written');
const built = buildPollMessages(base, creator.publicKey, ad);
const header = JSON.parse(built.messages[3].message.slice('poll:'.length));
eq(header.type, 4, 'the index header carries the type');

// --- reading it back -----------------------------------------------------------------------
let seq = 0;
const hex = (s: string) => `00${Buffer.from(s, 'utf8').toString('hex')}`;
const raw = (signer: { publicKey: string }, message?: string) => ({ id: `e${++seq}`, meta: { hash: `H${seq}`, height: String(100 + seq), index: 0, timestamp: '1' }, transaction: { type: 0x4154, signerPublicKey: signer.publicKey, message: message ? hex(message) : undefined, mosaics: [] } });
const assemble = (b: ReturnType<typeof buildPollMessages>, tweak?: (m: string) => string) =>
  assemblePoll(b.pollAddress, sortNewestFirst(b.messages.filter((m) => m.recipient === b.pollAddress).map((m, i) => parsePollTx(raw(creator, i === 0 && tweak ? tweak(m.message) : m.message), addressOf, cfg.epochAdjustment)!)), ad);
const heads = parsePollHeader(parsePollTx(raw(creator, built.messages[3].message), addressOf, cfg.epochAdjustment)!, ad);
ok(heads !== null && heads.type === 4, 'the index accepts a holder poll');
const poll = assemble(built);
ok(poll.type === 4 && poll.mosaicId === SOUL && poll.nonTransferableOnly === true && poll.valid, 'poll round-trips with its mosaic and rule', poll);
const pollAny = assemble(buildPollMessages({ ...base, title: '誰でも可', nonTransferableOnly: false, mosaicId: COIN }, creator.publicKey, ad));
ok(pollAny.nonTransferableOnly === false && pollAny.mosaicId === COIN, 'transferable-allowed poll round-trips');
const throwsMsg = (fn: () => unknown, msg: string, what: string) => { try { fn(); ok(false, `${what} (did not throw)`); } catch (e) { ok((e as Error).message === msg, what, (e as Error).message); } };
throwsMsg(() => assemble(buildPollMessages({ ...base, title: 'rule missing' }, creator.publicKey, ad), (m) => m.replace(',"nonTransferableOnly":true', '')), 'poll_invalid', 'a holder poll that does not say whether transferable mosaics are allowed is not read (not read as "allowed")');
throwsMsg(() => assemble(buildPollMessages({ ...base, title: 'rule text' }, creator.publicKey, ad), (m) => m.replace('"nonTransferableOnly":true', '"nonTransferableOnly":"true"')), 'poll_invalid', 'a rule that is not a boolean is not read');
throwsMsg(() => assemble(buildPollMessages({ ...base, title: 'no mosaic' }, creator.publicKey, ad), (m) => m.replace(SOUL, 'NOPE')), 'poll_invalid', 'a holder poll without a valid mosaic is not read');
const w = assemble(buildPollMessages({ ...base, title: 'weighted with flag', type: POLL_TYPE_MOSAIC, mosaicId: COIN }, creator.publicKey, ad), (m) => m.replace('"multiple":false', '"multiple":false,"nonTransferableOnly":true'));
ok(w.nonTransferableOnly === false, 'the rule belongs to holder polls only: the weighted type ignores it');
throwsMsg(() => assemble(buildPollMessages({ ...base, title: 'five' }, creator.publicKey, ad), (m) => m.replace('"type":4', '"type":5')), 'poll_unsupported', 'a type KASANE does not know is still unsupported');

// --- is a mosaic transferable --------------------------------------------------------------
eq([await fetchMosaicTransferable(SOUL), await fetchMosaicTransferable(COIN.toLowerCase()), await fetchMosaicTransferable(XYM)], [false, true, true], 'transferable flag: soul = no, coin = yes (id case ignored), XYM = yes');
mosaicRequests = 0;
await fetchMosaicTransferable(XYM);
ok(mosaicRequests === 0, 'XYM needs no lookup');
await rejects(fetchMosaicTransferable(GONE), 'mosaic_not_found', 'a mosaic that is not on the chain');
mosaicStatus = 429;
try { await fetchMosaicTransferable(SOUL); ok(false, 'a failing node should throw'); } catch (e) { ok(!(e instanceof Error && e.message === 'mosaic_not_found'), 'a node failure is not reported as "not found"', e); }
mosaicStatus = 200;

// --- counting: one account one vote, whatever the amount ------------------------------------
holdings[A.address] = [{ id: SOUL, amount: '1000000' }];
holdings[B.address] = [{ id: SOUL, amount: '1' }];
holdings[C.address] = [{ id: XYM, amount: '5000000' }]; // not the mosaic
holdings[D.address] = [{ id: SOUL, amount: '40' }];
incoming[poll.optionAddresses['賛成']] = [raw(A), raw(C)];
incoming[poll.optionAddresses['反対']] = [raw(B), raw(D), raw(E)]; // E: unknown to the node
let res = await fetchSymbolPollResults(poll, A.address);
eq(res.options.map((o) => o.votes), [1, 2], 'holders count (A, B, D); C holds another mosaic and E holds nothing: not counted');
eq(res.options.map((o) => o.weighted), [1, 2], 'the amount is not a weight: 1,000,000 counts like 1');
eq(res.options.map((o) => Math.round(o.percentage)), [33, 67], 'percentages are shares of the votes');
eq([...(res.excludedVoters ?? [])].sort(), [C.address, E.address].sort(), 'voters without the mosaic are reported');
eq([res.totalVotes, res.provisional, res.approximateImportance, res.myVotes, res.mosaicRuleBroken], [3, true, false, ['賛成'], undefined], 'totals; running = provisional; my vote found; the rule is met');

// a transferable mosaic breaks a "non-transferable only" poll: no vote counts
const brokenPoll = { ...poll, mosaicId: COIN };
holdings[A.address] = [{ id: COIN, amount: '500' }];
incoming[poll.optionAddresses['賛成']] = [raw(A)];
incoming[poll.optionAddresses['反対']] = [];
res = await fetchSymbolPollResults(brokenPoll, A.address);
ok(res.mosaicRuleBroken === true && res.totalVotes === 0 && res.options.every((o) => o.votes === 0 && o.percentage === 0), 'non-transferable only, but the mosaic is transferable: nothing is counted', res);
eq(res.myVotes, ['賛成'], 'the broken poll still shows my own vote');
res = await fetchSymbolPollResults({ ...brokenPoll, doe: Date.now() - 1000 }, undefined);
ok(res.mosaicRuleBroken === true && res.totalVotes === 0, 'the same when the poll has ended');
res = await fetchSymbolPollResults({ ...poll, mosaicId: XYM }, undefined);
ok(res.mosaicRuleBroken === true, 'XYM is transferable: breaks a non-transferable-only poll');

// the "transferable is fine" poll counts a transferable mosaic
incoming[pollAny.optionAddresses['賛成']] = [raw(A)];
res = await fetchSymbolPollResults(pollAny, A.address);
ok(res.mosaicRuleBroken === undefined && res.totalVotes === 1 && res.options[0].votes === 1, 'transferable allowed: a transferable mosaic counts', res);

// an unreadable definition must not be taken for either answer
mosaicStatus = 429;
await fetchSymbolPollResults(poll, undefined).then(() => ok(false, 'a failing node should fail the count'), () => ok(true, 'non-transferable only: if the definition cannot be read, the count fails (retry) instead of guessing'));
const anyRes = await fetchSymbolPollResults(pollAny, A.address);
ok(anyRes.totalVotes === 1, 'transferable allowed: the definition is not needed at all');
mosaicStatus = 200;

// --- holdings at the END of the poll ------------------------------------------------------------
const NOW = Date.now();
const POLL_END = NOW - 60_000;
const stamp = (ms: number) => String(ms - cfg.epochAdjustment * 1000);
let hseq = 0;
const move = (from: { publicKey: string }, to: { address: string }, mosaics: Array<{ id: string; amount: string }>, atMs: number) => {
  const h: Hist = {
    id: `m${++hseq}`,
    meta: { hash: `HM${hseq}`, height: String(5000 + hseq), index: 0, timestamp: stamp(atMs), feeMultiplier: '100' },
    transaction: { type: 0x4154, signerPublicKey: from.publicKey, recipientAddress: hexOf(to.address), mosaics, size: 200, maxFee: '100000' },
  };
  for (const a of [addressOf(from.publicKey), to.address]) (history[a] ??= []).unshift(h);
};
const ended = assemble(buildPollMessages({ ...base, title: '終了後', doe: POLL_END, nonTransferableOnly: false, mosaicId: COIN }, creator.publicKey, ad));
// A (賛成) held 10 at the end and gave it all to D AFTER the end; B (賛成) held 3 at the end; F (賛成) gave everything away DURING the poll; D (反対) held nothing at the end.
const F = acct();
holdings[A.address] = [{ id: COIN, amount: '0' }];
holdings[B.address] = [{ id: COIN, amount: '3' }];
holdings[D.address] = [{ id: COIN, amount: '10' }];
holdings[F.address] = [{ id: COIN, amount: '0' }];
holdings[E.address] = [{ id: COIN, amount: '9' }];
move(F, E, [{ id: COIN, amount: '9' }], POLL_END - 120_000); // during the poll: stays
move(A, D, [{ id: COIN, amount: '10' }], POLL_END + 10_000); // after the end: undone
incoming[ended.optionAddresses['賛成']] = [raw(A), raw(B), raw(F)];
incoming[ended.optionAddresses['反対']] = [raw(D), raw(E)];
res = await fetchSymbolPollResults(ended, A.address);
eq(res.options.map((o) => o.votes), [2, 1], 'at the end: A (10 then) and B hold it, E holds it; D (received after the end) and F (gave it away during the poll) do not');
eq([...(res.excludedVoters ?? [])].sort(), [D.address, F.address].sort(), 'the ones without it at the end are reported');
eq([res.totalVotes, res.provisional, res.approximateImportance], [3, false, false], 'ended: settled, exact for a custom mosaic');

// --- the other types are not affected ------------------------------------------------------------
const simple = assemble(buildPollMessages({ ...base, title: '簡易', type: POLL_TYPE_SIMPLE, mosaicId: undefined }, creator.publicKey, ad));
incoming[simple.optionAddresses['賛成']] = [raw(A), raw(C)];
incoming[simple.optionAddresses['反対']] = [];
ok((await fetchSymbolPollResults(simple, undefined)).totalVotes === 2, 'a simple poll still counts everyone');

console.log(`checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
