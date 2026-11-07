// NEM の「モザイク保有者による投票」（5つ目の集計方法、種類 4）: 作成の検査・メッセージ・読み取り・集計。
// 「移転できないモザイクのみ」か「移転できるモザイクでもよい」かを作成者が選ぶ。NIS は模擬。
// Run: npx tsx dev-tests/nem-voting-holder.test.ts
import http from 'node:http';
import { setNemCustomNodeUrl } from '../src/lib/nem/network';
import { nemKeyPairFromPrivateKey, nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import { NEM_EPOCH_SECONDS } from '../src/lib/nem/constants';
import {
  POLL_INDEX_ADDRESS, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_POI, POLL_TYPE_SIMPLE, buildPollMessages, fetchNemMosaicTransferable, fetchPoll, fetchPollHeaders,
  fetchPollResults, pollUsesMosaic, validateNewPoll,
} from '../src/lib/nem/voting';
import type { NewPollInput } from '../src/lib/nem/voting';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const rejects = async (p: Promise<unknown>, msg: string, what: string) => {
  try { await p; ok(false, `${what} (did not throw)`); } catch (e) { ok(e instanceof Error && e.message === msg, what, e instanceof Error ? e.message : e); }
};

const NB = 0x68;
const keyOf = (i: number) => nemKeyPairFromPrivateKey(i.toString(16).padStart(64, '0'));
const people = Array.from({ length: 12 }, (_, i) => { const k = keyOf(i + 1); return { ...k, address: nemAddressFromPublicKey(k.publicKey, NB) }; });
const [creator, A, B, C, D, E, F] = people;

// --- mock NIS ------------------------------------------------------------------------------
interface MTx { id: number; height: number; signer: string; amount: number; message?: string }
const chain = new Map<string, MTx[]>();
let nextId = 1;
const TIP = 200000;
const nowNem = Math.floor(Date.now() / 1000) - NEM_EPOCH_SECONDS;
const T0 = nowNem - TIP * 60;
const blockTs = (h: number) => T0 + h * 60;
const SOUL = 'club:member'; // not transferable
const COIN = 'club:coin'; // transferable
const holdings = new Map<string, Record<string, number>>();
const transferable: Record<string, boolean> = { [SOUL]: false, [COIN]: true };
let definitionStatus = 200; // what the definition list answers (400 = it cannot be read right now)
let definitionRequests = 0;
interface Move { id: number; height: number; from: { publicKey: string; address: string }; to: { address: string }; amount: number; mosaics?: Array<{ id: string; quantity: number }> }
const moves: Move[] = [];
let moveId = 1;
const addMove = (m: Omit<Move, 'id'>) => moves.push({ ...m, id: moveId++ });
const moveEntry = (m: Move) => ({
  meta: { id: m.id, height: m.height, hash: { data: 'm' + m.id } },
  transaction: {
    timeStamp: blockTs(m.height), amount: m.amount, fee: 50000, type: 257, version: (0x68 << 24) | 1, signer: m.from.publicKey, recipient: m.to.address,
    ...(m.mosaics ? { mosaics: m.mosaics.map((x) => ({ quantity: x.quantity, mosaicId: { namespaceId: x.id.split(':')[0], name: x.id.split(':')[1] } })) } : {}),
  },
});
function put(to: string, tx: Omit<MTx, 'id'>) { const l = chain.get(to) ?? []; l.push({ ...tx, id: nextId++ }); chain.set(to, l); }
const toHex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
function entry(t: MTx) {
  const tx = { timeStamp: blockTs(t.height), amount: t.amount, fee: 50000, type: 257, version: (0x68 << 24) | 1, signer: t.signer, recipient: 'X', ...(t.message !== undefined ? { message: { type: 1, payload: toHex(t.message) } } : {}) };
  return { meta: { id: t.id, height: t.height, hash: { data: 'h' + t.id } }, transaction: tx };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (o: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = url.pathname;
    if (p === '/account/transfers/incoming') {
      const addr = url.searchParams.get('address')!;
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 25), 100);
      const before = url.searchParams.get('id');
      let list = (chain.get(addr) ?? []).slice().sort((a, b) => b.id - a.id);
      if (before) list = list.filter((t) => t.id < Number(before));
      return send({ data: list.slice(0, size).map(entry) });
    }
    if (p === '/account/transfers/all') {
      const addr = url.searchParams.get('address')!;
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 25), 100);
      const before = url.searchParams.get('id');
      let list = moves.filter((m) => m.from.address === addr || m.to.address === addr).sort((a, b) => b.id - a.id);
      if (before) list = list.filter((t) => t.id < Number(before));
      return send({ data: list.slice(0, size).map(moveEntry) });
    }
    if (p === '/chain/height') return send({ height: TIP });
    if (p === '/block/at/public') { const h = JSON.parse(body).height; return send({ height: h, timeStamp: blockTs(h) }); }
    if (p === '/account/get/batch') return send({ data: [] });
    if (p === '/account/mosaic/owned') {
      const own = holdings.get(url.searchParams.get('address')!) ?? {};
      return send({ data: Object.entries(own).map(([id, quantity]) => ({ quantity, mosaicId: { namespaceId: id.split(':')[0], name: id.split(':')[1] } })) });
    }
    if (p === '/namespace/mosaic/definition/page') {
      definitionRequests++;
      if (definitionStatus !== 200) return send({ error: 'x' }, definitionStatus);
      if (url.searchParams.get('namespace') !== 'club') return send({ data: [] });
      const def = (name: string, canMove: boolean, metaId: number) => ({ meta: { id: metaId }, mosaic: { creator: 'aa'.repeat(32), id: { namespaceId: 'club', name }, properties: [{ name: 'divisibility', value: '0' }, { name: 'initialSupply', value: '1000' }, { name: 'supplyMutable', value: 'false' }, { name: 'transferable', value: String(canMove) }] } });
      return send({ data: [def('member', transferable[SOUL], 1), def('coin', transferable[COIN], 2)] });
    }
    send({ error: 'unknown' }, 404);
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  setNemCustomNodeUrl('mainnet', `http://127.0.0.1:${port}`);

  // ---- the type ----
  ok(POLL_TYPE_MOSAIC_HOLDER === 4 && POLL_TYPE_MOSAIC === 3, 'the type value is 4 (the weighted type stays 3)');
  ok(pollUsesMosaic(POLL_TYPE_MOSAIC) && pollUsesMosaic(POLL_TYPE_MOSAIC_HOLDER) && !pollUsesMosaic(POLL_TYPE_POI) && !pollUsesMosaic(POLL_TYPE_SIMPLE), 'which types name a mosaic');

  // ---- validation ----
  const END = Date.now() + 7 * 86400_000;
  const base: NewPollInput = { title: 'Members', description: '', options: ['Yes', 'No'], doe: END, type: POLL_TYPE_MOSAIC_HOLDER, multiple: false, whitelist: [], mosaicId: SOUL, nonTransferableOnly: true, mosaicTransferable: false };
  eq(validateNewPoll(base, NB), [], 'non-transferable only + a non-transferable mosaic: accepted');
  ok(validateNewPoll({ ...base, mosaicTransferable: true }, NB).includes('mosaic_transferable'), 'non-transferable only + a transferable mosaic: refused');
  ok(validateNewPoll({ ...base, mosaicTransferable: undefined }, NB).includes('mosaic_transferable'), 'non-transferable only + a mosaic that was not confirmed: refused');
  eq(validateNewPoll({ ...base, nonTransferableOnly: false, mosaicTransferable: true, mosaicId: COIN }, NB), [], 'transferable allowed + a transferable mosaic: accepted');
  eq(validateNewPoll({ ...base, nonTransferableOnly: false, mosaicTransferable: false }, NB), [], 'transferable allowed also takes a non-transferable one');
  ok(validateNewPoll({ ...base, mosaicId: '' }, NB).includes('mosaic_invalid') && !validateNewPoll({ ...base, mosaicId: '' }, NB).includes('mosaic_transferable'), 'no mosaic: mosaic_invalid only');
  ok(validateNewPoll({ ...base, mosaicId: 'Bad Id' }, NB).includes('mosaic_invalid'), 'malformed mosaic: mosaic_invalid');
  eq(validateNewPoll({ ...base, type: POLL_TYPE_POI, mosaicId: undefined, mosaicTransferable: true }, NB), [], 'other types ignore the holder fields');
  eq(validateNewPoll({ ...base, type: POLL_TYPE_MOSAIC, mosaicId: COIN, mosaicTransferable: true }, NB), [], 'the weighted type does not need a non-transferable mosaic');

  // ---- the messages ----
  const msgs = (input: NewPollInput) => buildPollMessages(input, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  const formOf = (input: NewPollInput) => JSON.parse(msgs(input).messages[0].message.slice('formData:'.length));
  let form = formOf(base);
  eq([form.type, form.mosaicId, form.nonTransferableOnly], [4, SOUL, true], 'formData carries the type, the mosaic and the rule');
  form = formOf({ ...base, nonTransferableOnly: false, mosaicId: ' Club:Coin ' });
  eq([form.mosaicId, form.nonTransferableOnly], [COIN, false], 'transferable allowed is written as false (and the mosaic is normalised)');
  eq(formOf({ ...base, nonTransferableOnly: undefined }).nonTransferableOnly, false, 'an unset rule is written as false, never left out');
  ok(!('nonTransferableOnly' in formOf({ ...base, type: POLL_TYPE_MOSAIC, mosaicId: COIN })), 'the weighted type does not write the rule');
  ok(!('mosaicId' in formOf({ ...base, type: POLL_TYPE_SIMPLE })) && !('nonTransferableOnly' in formOf({ ...base, type: POLL_TYPE_SIMPLE })), 'other types write neither');
  ok(!msgs(base).messages.map((m) => m.message).join('').includes('mosaicTransferable'), 'the check-only field is not written');
  const built = msgs(base);
  eq(JSON.parse(built.messages[3].message.slice('poll:'.length)).type, 4, 'the index header carries the type');
  ok(built.messages.length === 4, 'a holder poll is 4 messages');

  // ---- reading it back ----
  const publish = (b: ReturnType<typeof msgs>, h0: number, tweak?: (m: string) => string) =>
    b.messages.forEach((m, i) => put(m.recipient, { height: h0 + i, signer: creator.publicKey, amount: 0, message: i === 0 && tweak ? tweak(m.message) : m.message }));
  publish(built, 100);
  const heads = await fetchPollHeaders(POLL_INDEX_ADDRESS.mainnet);
  ok(heads.headers.length === 1 && heads.headers[0].type === 4, 'the index lists a holder poll', heads);
  const poll = await fetchPoll(built.pollAddress);
  ok(poll.type === 4 && poll.mosaicId === SOUL && poll.nonTransferableOnly === true && poll.valid, 'poll round-trips with its mosaic and rule', poll);
  const anyBuilt = msgs({ ...base, title: 'Anyone with a coin', nonTransferableOnly: false, mosaicId: COIN });
  publish(anyBuilt, 200);
  const pollAny = await fetchPoll(anyBuilt.pollAddress);
  ok(pollAny.nonTransferableOnly === false && pollAny.mosaicId === COIN, 'transferable-allowed poll round-trips');
  const bad = async (title: string, tweak: (m: string) => string, expect: string, what: string, over: Partial<NewPollInput> = {}) => {
    const b = msgs({ ...base, title, ...over });
    publish(b, 300 + chain.size, tweak);
    await rejects(fetchPoll(b.pollAddress), expect, what);
  };
  await bad('rule missing', (m) => m.replace(',"nonTransferableOnly":true', ''), 'poll_invalid', 'a holder poll that does not say whether transferable mosaics are allowed is not read (not read as "allowed")');
  await bad('rule text', (m) => m.replace('"nonTransferableOnly":true', '"nonTransferableOnly":"true"'), 'poll_invalid', 'a rule that is not a boolean is not read');
  await bad('no mosaic', (m) => m.replace(SOUL, 'NOT A MOSAIC'), 'poll_invalid', 'a holder poll without a valid mosaic is not read');
  await bad('five', (m) => m.replace('"type":4', '"type":5'), 'poll_unsupported', 'a type KASANE does not know is still unsupported');
  const wb = msgs({ ...base, title: 'weighted with flag', type: POLL_TYPE_MOSAIC, mosaicId: COIN });
  publish(wb, 900, (m) => m.replace('"multiple":false', '"multiple":false,"nonTransferableOnly":true'));
  ok((await fetchPoll(wb.pollAddress)).nonTransferableOnly === false, 'the rule belongs to holder polls only: the weighted type ignores it');

  // ---- is a mosaic transferable ----
  eq([await fetchNemMosaicTransferable(SOUL), await fetchNemMosaicTransferable('Club:Coin'), await fetchNemMosaicTransferable('nem:xem')], [false, true, true], 'transferable flag: member = no, coin = yes (case ignored), XEM = yes');
  definitionRequests = 0;
  await fetchNemMosaicTransferable('xem');
  ok(definitionRequests === 0, 'XEM needs no definition lookup');
  await rejects(fetchNemMosaicTransferable('club:nothere'), 'mosaic_not_found', 'a mosaic that has no definition');
  definitionStatus = 400;
  await rejects(fetchNemMosaicTransferable(SOUL), 'mosaic_not_found', 'the node answers 400 -> not found (the same as the input check)');
  definitionStatus = 200;

  // ---- counting: one account one vote, whatever the amount ----
  holdings.set(A.address, { [SOUL]: 1_000_000 });
  holdings.set(B.address, { [SOUL]: 1 });
  holdings.set(C.address, { 'other:thing': 5 }); // another mosaic
  holdings.set(D.address, { [SOUL]: 40 });
  const opt = (p: typeof poll, name: string) => p.optionAddresses[name];
  put(opt(poll, 'Yes'), { height: 400, signer: A.publicKey, amount: 0 });
  put(opt(poll, 'Yes'), { height: 401, signer: C.publicKey, amount: 0 });
  put(opt(poll, 'No'), { height: 402, signer: B.publicKey, amount: 0 });
  put(opt(poll, 'No'), { height: 403, signer: D.publicKey, amount: 0 });
  put(opt(poll, 'No'), { height: 404, signer: E.publicKey, amount: 0 }); // holds nothing
  put(opt(poll, 'No'), { height: 405, signer: F.publicKey, amount: 7_000_000 }); // a payment is not a vote
  let r = await fetchPollResults(poll, A.address);
  eq(r.options.map((o) => o.votes), [1, 2], 'holders count (A, B, D); C holds another mosaic and E nothing: not counted');
  eq(r.options.map((o) => o.weighted), [1, 2], 'the amount is not a weight: 1,000,000 counts like 1');
  eq(r.options.map((o) => Math.round(o.percentage)), [33, 67], 'percentages are shares of the votes');
  eq([...(r.excludedVoters ?? [])].sort(), [C.address, E.address].sort(), 'voters without the mosaic are reported');
  eq([r.totalVotes, r.provisional, r.approximateImportance, r.myVotes, r.mosaicRuleBroken], [3, true, false, ['Yes'], undefined], 'totals; running = provisional; my vote found; the rule is met');

  // a transferable mosaic breaks a "non-transferable only" poll: no vote counts
  holdings.set(A.address, { [SOUL]: 1_000_000, [COIN]: 500 });
  const broken = { ...poll, mosaicId: COIN };
  r = await fetchPollResults(broken, A.address);
  ok(r.mosaicRuleBroken === true && r.totalVotes === 0 && r.options.every((o) => o.votes === 0 && o.percentage === 0), 'non-transferable only, but the mosaic is transferable: nothing is counted', r);
  eq(r.myVotes, ['Yes'], 'the broken poll still shows my own vote');
  r = await fetchPollResults({ ...broken, doe: Date.now() - 1000, endBlock: TIP }, undefined);
  ok(r.mosaicRuleBroken === true && r.totalVotes === 0, 'the same when the poll has ended');
  r = await fetchPollResults({ ...poll, mosaicId: 'nem:xem' }, undefined);
  ok(r.mosaicRuleBroken === true, 'XEM is transferable: breaks a non-transferable-only poll');

  // the creator may re-define a mosaic: the rule is checked at every count
  transferable[SOUL] = true;
  r = await fetchPollResults(poll, undefined);
  ok(r.mosaicRuleBroken === true && r.totalVotes === 0, 'a mosaic re-defined as transferable after the poll was made breaks the rule');
  transferable[SOUL] = false;
  r = await fetchPollResults(poll, undefined);
  ok(r.mosaicRuleBroken === undefined && r.totalVotes === 3, 'and it counts again once the mosaic is non-transferable');

  // "transferable is fine" counts a transferable mosaic
  holdings.set(A.address, { [SOUL]: 1_000_000, [COIN]: 500 });
  put(opt(pollAny, 'Yes'), { height: 500, signer: A.publicKey, amount: 0 });
  r = await fetchPollResults(pollAny, A.address);
  ok(r.mosaicRuleBroken === undefined && r.totalVotes === 1, 'transferable allowed: a transferable mosaic counts', r);

  // an unreadable definition must not be taken for either answer
  definitionStatus = 500;
  await fetchPollResults(poll, undefined).then(() => ok(false, 'a failing node should fail the count'), () => ok(true, 'non-transferable only: if the definition cannot be read, the count fails (retry) instead of guessing'));
  r = await fetchPollResults(pollAny, A.address);
  ok(r.totalVotes === 1 && definitionStatus === 500, 'transferable allowed: the definition is not needed at all');
  definitionStatus = 200;

  // ---- holdings at the END of the poll ----
  const END_BLOCK = 1000;
  const ended = msgs({ ...base, title: 'Ended', nonTransferableOnly: false, mosaicId: COIN });
  publish(ended, 600);
  const pollEnded = { ...(await fetchPoll(ended.pollAddress)), doe: Date.now() - 1000, endBlock: END_BLOCK };
  // A (Yes) held 10 at the end and gave it to D AFTER the end; B (Yes) holds 3; F (Yes) gave everything away DURING the poll to E; D (No) held nothing at the end; E (No) holds 9.
  holdings.set(A.address, { [COIN]: 0 });
  holdings.set(B.address, { [COIN]: 3 });
  holdings.set(D.address, { [COIN]: 10 });
  holdings.set(F.address, { [COIN]: 0 });
  holdings.set(E.address, { [COIN]: 9 });
  addMove({ height: 800, from: F, to: E, amount: 1_000_000, mosaics: [{ id: COIN, quantity: 9 }] }); // during the poll: stays
  addMove({ height: 1500, from: A, to: D, amount: 1_000_000, mosaics: [{ id: COIN, quantity: 10 }] }); // after the end: undone
  put(opt(pollEnded, 'Yes'), { height: 700, signer: A.publicKey, amount: 0 });
  put(opt(pollEnded, 'Yes'), { height: 701, signer: B.publicKey, amount: 0 });
  put(opt(pollEnded, 'Yes'), { height: 702, signer: F.publicKey, amount: 0 });
  put(opt(pollEnded, 'No'), { height: 703, signer: D.publicKey, amount: 0 });
  put(opt(pollEnded, 'No'), { height: 704, signer: E.publicKey, amount: 0 });
  r = await fetchPollResults(pollEnded, A.address);
  eq(r.options.map((o) => o.votes), [2, 1], 'at the end: A and B hold it, E holds it; D (received after the end) and F (gave it away during the poll) do not');
  eq([...(r.excludedVoters ?? [])].sort(), [D.address, F.address].sort(), 'the ones without it at the end are reported');
  eq([r.totalVotes, r.provisional, r.approximateImportance], [3, false, false], 'ended: settled, exact for a custom mosaic');
  r = await fetchPollResults({ ...pollEnded, endBlock: null }, undefined);
  ok(r.approximateImportance === true, 'ended but the end block is unknown: flagged as an estimate');

  // ---- the other types are not affected ----
  r = await fetchPollResults({ ...poll, type: POLL_TYPE_SIMPLE, mosaicId: null, nonTransferableOnly: false }, undefined);
  ok(r.totalVotes === 5 && r.mosaicRuleBroken === undefined, 'a simple poll still counts every account (A, B, C, D, E; the paid transfer is no vote)', r);

  console.log(`checks=${checks} fails=${fails}`);
  server.close();
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
