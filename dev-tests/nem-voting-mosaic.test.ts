// NEM の「モザイク保有量で重み付け」する投票: モザイクの指定の確認・保有量の取得・作成メッセージ・読み取り・集計。NIS は模擬。
// Run: npx tsx dev-tests/nem-voting-mosaic.test.ts
import http from 'node:http';
import { setNemCustomNodeUrl } from '../src/lib/nem/network';
import { nemKeyPairFromPrivateKey, nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import { NEM_EPOCH_SECONDS } from '../src/lib/nem/constants';
import {
  POLL_TYPE_MOSAIC, POLL_TYPE_POI, POLL_TYPE_SIMPLE, POLL_INDEX_ADDRESS, buildPollMessages, fetchNemMosaicHoldings, fetchNemMosaicHoldingsAtEnd, fetchPoll, fetchPollHeaders,
  fetchPollResults, isNemMosaicId, normalizeNemMosaicId, resolveNemMosaicInput, validateNewPoll,
} from '../src/lib/nem/voting';
import type { NewPollInput } from '../src/lib/nem/voting';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const NB = 0x68;
const keyOf = (i: number) => nemKeyPairFromPrivateKey(i.toString(16).padStart(64, '0'));
const people = Array.from({ length: 24 }, (_, i) => { const k = keyOf(i + 1); return { ...k, address: nemAddressFromPublicKey(k.publicKey, NB) }; });
const [creator, A, B, C, D] = people;

// --- mock NIS ------------------------------------------------------------------------------
interface MTx { id: number; height: number; signer: string; amount: number; message?: string }
const chain = new Map<string, MTx[]>();
let nextId = 1;
const TIP = 200000;
const nowNem = Math.floor(Date.now() / 1000) - NEM_EPOCH_SECONDS;
const T0 = nowNem - TIP * 60;
const blockTs = (h: number) => T0 + h * 60;
const TOKEN = 'mytoken:vote';
const holdings = new Map<string, Record<string, number>>(); // address -> { mosaic id -> quantity }
const xemBalance = new Map<string, number>();
const importance = new Map<string, number>();
const definitions: Record<string, Array<{ id: { namespaceId: string; name: string }; divisibility: number }>> = {
  mytoken: [{ id: { namespaceId: 'mytoken', name: 'vote' }, divisibility: 2 }, { id: { namespaceId: 'mytoken', name: 'other' }, divisibility: 0 }],
};
let ownedFailsFor = '';
let ownedRequests = 0;
let batchRequests = 0;
let historicalRequests = 0;
let definitionStatus = 200;
// transfers seen by /account/transfers/all (confirmed, incoming and outgoing)
interface Move { id: number; height: number; from: { publicKey: string; address: string }; to: { address: string }; amount: number; fee?: number; mosaics?: Array<{ id: string; quantity: number }> }
const moves: Move[] = [];
let moveId = 1;
const addMove = (m: Omit<Move, 'id'>) => moves.push({ ...m, id: moveId++ });
const moveEntry = (m: Move) => ({
  meta: { id: m.id, height: m.height, hash: { data: 'm' + m.id } },
  transaction: {
    timeStamp: blockTs(m.height), amount: m.amount, fee: m.fee ?? 50000, type: 257, version: (0x68 << 24) | 1, signer: m.from.publicKey, recipient: m.to.address,
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
    if (p === '/account/get/batch') {
      batchRequests++;
      const accounts = JSON.parse(body).data as { account: string }[];
      return send({ data: accounts.filter((a) => xemBalance.has(a.account) || importance.has(a.account)).map((a) => ({ account: { address: a.account, balance: xemBalance.get(a.account) ?? 0, importance: importance.get(a.account) ?? 0 } })) });
    }
    if (p === '/account/historical/get/batch') { historicalRequests++; return send({ error: 'nope' }, 404); }
    if (p === '/account/mosaic/owned') {
      ownedRequests++;
      const addr = url.searchParams.get('address')!;
      if (addr === ownedFailsFor) return send({ error: 'boom' }, 400);
      const own = holdings.get(addr) ?? {};
      return send({ data: Object.entries(own).map(([id, quantity]) => ({ quantity, mosaicId: { namespaceId: id.split(':')[0], name: id.split(':')[1] } })) });
    }
    if (p === '/namespace/mosaic/definition/page') {
      if (definitionStatus !== 200) return send({ error: 'x' }, definitionStatus);
      const ns = url.searchParams.get('namespace')!;
      return send({ data: (definitions[ns] ?? []).map((d, i) => ({ meta: { id: i + 1 }, mosaic: { creator: 'aa'.repeat(32), id: d.id, properties: [{ name: 'divisibility', value: String(d.divisibility) }, { name: 'initialSupply', value: '1000' }, { name: 'supplyMutable', value: 'false' }, { name: 'transferable', value: 'true' }] } })) });
    }
    send({ error: 'unknown' }, 404);
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  setNemCustomNodeUrl('mainnet', `http://127.0.0.1:${port}`);

  // ---- the id of a mosaic ----
  ok(isNemMosaicId('nem:xem') && isNemMosaicId('mytoken:vote') && isNemMosaicId('a.b.c:d-e_f1'), 'valid mosaic ids');
  ok(!isNemMosaicId('xem') && !isNemMosaicId('Nem:xem') && !isNemMosaicId('a:') && !isNemMosaicId(':b') && !isNemMosaicId('a.b.c.d:e') && !isNemMosaicId('a b:c') && !isNemMosaicId(123), 'invalid mosaic ids');
  ok(!isNemMosaicId(`a:${'x'.repeat(33)}`) && isNemMosaicId(`a:${'x'.repeat(32)}`), 'mosaic name is at most 32 characters');
  ok(normalizeNemMosaicId('  MyToken:Vote ') === 'mytoken:vote' && normalizeNemMosaicId(undefined) === '', 'normalising what was typed');

  // ---- checking what the person typed ----
  let info = await resolveNemMosaicInput('MyToken:Vote');
  eq([info.id, info.divisibility], [TOKEN, 2], 'resolves a mosaic on the chain (case-insensitive)');
  info = await resolveNemMosaicInput('xem');
  eq(info.id, 'nem:xem', '"xem" is XEM (built in, no node lookup needed)');
  info = await resolveNemMosaicInput('nem:xem');
  eq(info.id, 'nem:xem', 'nem:xem');
  const rejects = async (p: Promise<unknown>, msg: string, what: string) => {
    try { await p; ok(false, `${what} (did not throw)`); } catch (e) { ok(e instanceof Error && e.message === msg, what, e instanceof Error ? e.message : e); }
  };
  await rejects(resolveNemMosaicInput('mytoken:nothere'), 'mosaic_not_found', 'a namespace that has no such mosaic');
  await rejects(resolveNemMosaicInput('nonamespace:vote'), 'mosaic_not_found', 'an unknown namespace');
  await rejects(resolveNemMosaicInput('not a mosaic!'), 'mosaic_invalid', 'garbage');
  await rejects(resolveNemMosaicInput(''), 'mosaic_invalid', 'empty');
  await rejects(resolveNemMosaicInput('mytoken'), 'mosaic_invalid', 'a namespace without a mosaic name');
  definitionStatus = 404;
  await rejects(resolveNemMosaicInput('mytoken:vote'), 'mosaic_not_found', 'the node answers 404 -> not found');
  definitionStatus = 500;
  try { await resolveNemMosaicInput('mytoken:vote'); ok(false, 'node failure should throw'); } catch (e) { ok(!(e instanceof Error && ['mosaic_not_found', 'mosaic_invalid'].includes(e.message)), 'a node failure is not reported as "not found"', e); }
  definitionStatus = 200;

  // ---- holdings ----
  holdings.set(A.address, { [TOKEN]: 300, 'other:thing': 7 });
  holdings.set(B.address, { [TOKEN]: 100 });
  holdings.set(C.address, { 'other:thing': 5 }); // holds a different mosaic only
  xemBalance.set(A.address, 9_000_000); xemBalance.set(B.address, 1_000_000);
  eq(await fetchNemMosaicHoldings([A.address, B.address, C.address, D.address], TOKEN), [300, 100, 0, 0], 'holdings of the mosaic (other mosaic / nothing = 0)');
  eq(await fetchNemMosaicHoldings([A.address, B.address, C.address], 'MyToken:Vote'), [300, 100, 0], 'the id is normalised');
  eq(await fetchNemMosaicHoldings([], TOKEN), [], 'no addresses');
  batchRequests = 0;
  eq(await fetchNemMosaicHoldings([A.address, B.address, D.address], 'nem:xem'), [9_000_000, 1_000_000, 0], 'XEM holdings come from the account balance');
  ok(batchRequests === 1, 'XEM: one batch request', batchRequests);
  // many addresses: every one is asked, in the right order
  const many = people.slice(5, 24);
  many.forEach((p, i) => holdings.set(p.address, { [TOKEN]: i + 1 }));
  eq(await fetchNemMosaicHoldings(many.map((p) => p.address), TOKEN), many.map((_, i) => i + 1), 'many addresses keep their order');
  // a node that fails for one account must not turn that account into "0"
  ownedFailsFor = B.address;
  try { await fetchNemMosaicHoldings([A.address, B.address], TOKEN); ok(false, 'a failed lookup should throw'); } catch { ok(true, 'a failed holding lookup throws (never counted as 0)'); }
  ownedFailsFor = '';

  // ---- a poll of this type: validation and messages ----
  const futureMs = Date.now() + 7 * 86400_000;
  const base: NewPollInput = { title: 'Token vote', description: 'Should we?', options: ['Yes', 'No'], doe: futureMs, type: POLL_TYPE_MOSAIC, multiple: false, whitelist: [], mosaicId: TOKEN };
  eq(validateNewPoll(base, NB), [], 'a mosaic poll with a valid mosaic is accepted');
  ok(validateNewPoll({ ...base, mosaicId: '' }, NB).includes('mosaic_invalid'), 'no mosaic -> mosaic_invalid');
  ok(validateNewPoll({ ...base, mosaicId: undefined }, NB).includes('mosaic_invalid'), 'mosaic missing -> mosaic_invalid');
  ok(validateNewPoll({ ...base, mosaicId: 'Bad Id' }, NB).includes('mosaic_invalid'), 'malformed mosaic -> mosaic_invalid');
  ok(validateNewPoll({ ...base, mosaicId: ' MyToken:Vote ' }, NB).length === 0, 'the mosaic is normalised before it is checked');
  ok(validateNewPoll({ ...base, type: POLL_TYPE_POI, mosaicId: '' }, NB).length === 0, 'other types ignore the mosaic field');
  ok(validateNewPoll({ ...base, type: POLL_TYPE_SIMPLE, mosaicId: undefined }, NB).length === 0, 'simple poll unaffected');

  const built = buildPollMessages({ ...base, mosaicId: ' MyToken:Vote ' }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  const form = JSON.parse(built.messages[0].message.slice('formData:'.length));
  eq([form.type, form.mosaicId, form.multiple], [POLL_TYPE_MOSAIC, TOKEN, false], 'formData carries the type and the normalised mosaic');
  ok(built.messages.length === 4, 'a mosaic poll is 4 messages like an importance poll');
  const plain = buildPollMessages({ ...base, type: POLL_TYPE_POI }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  ok(!('mosaicId' in JSON.parse(plain.messages[0].message.slice('formData:'.length))), 'other types do not write a mosaic');
  ok(plain.pollAddress === built.pollAddress, 'the poll address does not depend on the type');
  const header = JSON.parse(built.messages[3].message.slice('poll:'.length));
  eq(header.type, POLL_TYPE_MOSAIC, 'the index header carries the type');

  // ---- reading it back ----
  built.messages.forEach((m, i) => put(m.recipient, { height: 100 + i, signer: creator.publicKey, amount: 0, message: m.message }));
  const heads = await fetchPollHeaders(POLL_INDEX_ADDRESS.mainnet);
  ok(heads.headers.length === 1 && heads.headers[0].type === POLL_TYPE_MOSAIC, 'the index lists a mosaic poll', heads);
  const poll = await fetchPoll(built.pollAddress);
  ok(poll.type === POLL_TYPE_MOSAIC && poll.mosaicId === TOKEN && poll.valid, 'poll round-trips with its mosaic', poll);
  ok(poll.creator === creator.address, 'creator');

  // a poll of the type without a usable mosaic cannot be read
  const bad = buildPollMessages({ ...base, title: 'Broken', mosaicId: TOKEN }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  bad.messages.forEach((m, i) => put(m.recipient, { height: 300 + i, signer: creator.publicKey, amount: 0, message: i === 0 ? m.message.replace(TOKEN, 'NOT A MOSAIC') : m.message }));
  try { await fetchPoll(bad.pollAddress); ok(false, 'mosaic poll without a valid mosaic should not load'); } catch (e) { ok((e as Error).message === 'poll_invalid', 'mosaic poll without a valid mosaic -> poll_invalid', (e as Error).message); }
  const unknown = buildPollMessages({ ...base, title: 'Type four', type: POLL_TYPE_POI, mosaicId: undefined }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  unknown.messages.forEach((m, i) => put(m.recipient, { height: 400 + i, signer: creator.publicKey, amount: 0, message: i === 0 ? m.message.replace('"type":0', '"type":5') : m.message }));
  try { await fetchPoll(unknown.pollAddress); ok(false, 'unknown type should not load'); } catch (e) { ok((e as Error).message === 'poll_unsupported', 'a type KASANE does not know is still unsupported', (e as Error).message); }

  // ---- counting: weighted by holdings, same formula as importance ----
  const opt = (name: string) => poll.optionAddresses[name];
  put(opt('Yes'), { height: 200, signer: A.publicKey, amount: 0 });
  put(opt('Yes'), { height: 201, signer: B.publicKey, amount: 0 });
  put(opt('No'), { height: 202, signer: C.publicKey, amount: 0 });  // holds none of the mosaic: weight 0
  put(opt('No'), { height: 203, signer: D.publicKey, amount: 5_000_000 }); // a paid transfer is not a vote
  importance.set(A.address, 0.9); importance.set(B.address, 0.9); importance.set(C.address, 0.9); // must not matter for this type
  historicalRequests = 0;
  let r = await fetchPollResults(poll, A.address);
  const o = Object.fromEntries(r.options.map((x) => [x.text, x]));
  eq([o.Yes.votes, o.No.votes, r.totalVotes], [2, 0, 2], 'ballots: C holds none of the mosaic, so C\'s vote is invalid and not counted');
  eq(r.excludedVoters, [C.address], 'the voter without the mosaic is reported');
  ok(r.provisional === true, 'a running poll is provisional');
  ok(near(o.Yes.weighted, 400) && near(o.No.weighted, 0), 'weight of an option = holdings of its voters', r.options);
  ok(near(o.Yes.percentage, 100) && near(o.No.percentage, 0), 'percentages: only A (300) and B (100) carry weight', r.options);
  ok(!r.approximateImportance, 'not approximate while the poll runs');
  eq(r.myVotes, ['Yes'], 'my vote found');
  ok(historicalRequests === 0, 'importance is not consulted for this type');

  // the same calculation as the importance-weighted poll: A 300 / B 100 split 75 : 25
  put(opt('No'), { height: 204, signer: B.publicKey, amount: 0 }); // B votes both in a single-choice poll: B nullified
  r = await fetchPollResults(poll);
  ok(near(r.options[0].percentage, 100) && r.totalVotes === 1, 'single choice: a voter who chose two options is not counted (B), nor is the one without the mosaic (C)', r);
  const multi = { ...poll, multiple: true };
  r = await fetchPollResults(multi);
  const m = Object.fromEntries(r.options.map((x) => [x.text, x]));
  // voters A(300, 1 option), B(100, 2 options), C(0, 1 option): total = 400; Yes = 300 + 100/2 = 350 ; No = 100/2 + 0 = 50
  ok(near(m.Yes.weighted, 350) && near(m.No.weighted, 50) && near(m.Yes.percentage, 87.5) && near(m.No.percentage, 12.5), 'multiple choice: a holding is split over the chosen options', r.options);

  // nobody holds any -> no division by zero
  const empty = await fetchPollResults({ ...poll, mosaicId: 'nobody:holds' });
  ok(empty.options.every((x) => x.percentage === 0 && Number.isFinite(x.percentage)), 'no holder at all: 0 %, not NaN', empty.options);

  // a poll that has ended, nothing moved after the end: the holdings are the ones at the end, and it is not an estimate
  historicalRequests = 0;
  const ended = await fetchPollResults({ ...poll, doe: Date.now() - 1000, endBlock: TIP });
  ok(!ended.approximateImportance && ended.provisional === false, 'ended: counted with the holdings at the end (not an estimate, not provisional)', ended);
  ok(historicalRequests === 0, 'ended: no historical importance lookup');
  ok(near(ended.options[0].weighted, 300), 'ended: weight of A is 300', ended.options);
  const noBlock = await fetchPollResults({ ...poll, doe: Date.now() - 1000, endBlock: null });
  ok(noBlock.approximateImportance, 'ended but the end block is unknown: flagged as an estimate');

  // --- holdings at the END of the poll ---------------------------------------------------------
  const END_BLOCK = 1000;
  const [E, F, G] = [people[5], people[6], people[7]];
  const mk = (title: string) => {
    const b = buildPollMessages({ ...base, title }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
    b.messages.forEach((m, i) => put(m.recipient, { height: 600 + i, signer: creator.publicKey, amount: 0, message: m.message }));
    return b;
  };
  const p2built = mk('Ended poll');
  const p2 = { ...(await fetchPoll(p2built.pollAddress)), doe: Date.now() - 1000, endBlock: END_BLOCK };
  const o2 = (name: string) => p2.optionAddresses[name];
  holdings.set(E.address, {});
  // A voted Yes holding 300; B voted Yes holding 100; D voted No holding 0 at the end;
  // F voted Yes holding 200 then gave it to G DURING the poll; G voted No (holds 200 from before the end).
  put(o2('Yes'), { height: 700, signer: A.publicKey, amount: 0 });
  put(o2('Yes'), { height: 701, signer: B.publicKey, amount: 0 });
  put(o2('No'), { height: 702, signer: D.publicKey, amount: 0 });
  put(o2('Yes'), { height: 703, signer: F.publicKey, amount: 0 });
  put(o2('No'), { height: 704, signer: G.publicKey, amount: 0 });
  // moves AFTER the end are undone: A sent 300 to D (900 < end 1000 < 1500), E sent 50 to B
  addMove({ height: 1500, from: A, to: D, amount: 1_000_000, mosaics: [{ id: TOKEN, quantity: 300 }] });
  addMove({ height: 1600, from: E, to: B, amount: 1_000_000, mosaics: [{ id: TOKEN, quantity: 50 }] });
  // a move DURING the poll counts as it is: F gave 200 to G at height 800
  addMove({ height: 800, from: F, to: G, amount: 1_000_000, mosaics: [{ id: TOKEN, quantity: 200 }] });
  holdings.set(A.address, { [TOKEN]: 0 });   // now: gave everything away after the end
  holdings.set(D.address, { [TOKEN]: 300 }); // now: received it after the end
  holdings.set(B.address, { [TOKEN]: 150 }); // now: 100 at the end + 50 received after it
  holdings.set(F.address, { [TOKEN]: 0 });
  holdings.set(G.address, { [TOKEN]: 200 });
  const r2 = await fetchPollResults(p2, A.address);
  const q2 = Object.fromEntries(r2.options.map((x) => [x.text, x]));
  ok(near(q2.Yes.weighted, 400), 'weight = holding at the END: A 300 (given away only after the end) + B 100 (50 came after the end)', r2.options);
  ok(near(q2.No.weighted, 200), 'G holds 200 at the end; D holds nothing at the end (its 300 arrived after it) -> only G', r2.options);
  eq([q2.Yes.votes, q2.No.votes, r2.totalVotes], [2, 1, 3], 'ballots: A, B (Yes) and G (No) count');
  eq([...(r2.excludedVoters ?? [])].sort(), [D.address, F.address].sort(), 'D (nothing at the end) and F (gave it away during the poll) are invalid');
  ok(near(q2.Yes.percentage, 400 * 100 / 600) && near(q2.No.percentage, 200 * 100 / 600), 'percentages over the valid weights', r2.options);
  ok(!r2.approximateImportance && r2.provisional === false, 'a custom mosaic is reconstructed exactly');
  eq(r2.myVotes, ['Yes'], 'my vote still found');

  // the same poll, while it is still running: today's holdings, provisional
  const running = await fetchPollResults({ ...p2, doe: Date.now() + 86400_000, endBlock: null }, undefined);
  ok(running.provisional === true && !running.approximateImportance, 'running: provisional, today\'s holdings');

  // XEM: reconstructed from transfers and fees, but flagged as an estimate (harvesting rewards do not show)
  const p3built = mk('Ended xem poll');
  const p3 = { ...(await fetchPoll(p3built.pollAddress)), doe: Date.now() - 1000, endBlock: END_BLOCK, mosaicId: 'nem:xem' };
  put(p3.optionAddresses['Yes'], { height: 710, signer: A.publicKey, amount: 0 });
  put(p3.optionAddresses['No'], { height: 711, signer: B.publicKey, amount: 0 });
  xemBalance.set(A.address, 7_950_000); xemBalance.set(B.address, 3_000_000);
  addMove({ height: 1700, from: A, to: B, amount: 2_000_000, fee: 50_000 }); // after the end: A 10 XEM at the end; B 1 XEM at the end
  const r3 = await fetchPollResults(p3);
  // A: 7.95 + 2 (transfer) + 0.05 (its fee) + 0.05 (fee of the earlier token transfer to D, also after the end) = 10.05 XEM
  ok(near(r3.options[0].weighted, 10_050_000) && near(r3.options[1].weighted, 1_000_000), 'XEM at the end: the transfers and the fees A paid after the end are undone', r3.options);
  ok(r3.approximateImportance, 'XEM: flagged as an estimate');

  // many moves after the end (more than one page of history) are all undone
  const H = people[8];
  holdings.set(H.address, { [TOKEN]: 1000 });
  for (let i = 0; i < 130; i += 1) addMove({ height: 2000 + i, from: H, to: E, amount: 1_000_000, mosaics: [{ id: TOKEN, quantity: 1 }] });
  eq(await (async () => (await fetchNemMosaicHoldingsAtEnd([H.address], TOKEN, END_BLOCK)).holdings)(), [1130], 'every transfer after the end is undone across pages (1000 now + 130 sent after the end)');
  eq((await fetchNemMosaicHoldingsAtEnd([H.address, A.address], TOKEN, null)).holdings, [1000, 0], 'no end block: today\'s holdings');

  // XEM-weighted
  const xemPoll = { ...poll, mosaicId: 'nem:xem' };
  r = await fetchPollResults(xemPoll);
  ok(near(r.options[0].percentage, 100 * 9 / 9), 'XEM-weighted poll', r.options);

  // the other types still work the old way
  historicalRequests = 0;
  r = await fetchPollResults({ ...poll, type: POLL_TYPE_POI, mosaicId: null });
  ok(near(r.options[0].percentage + r.options[1].percentage, 100), 'importance-weighted poll unaffected', r.options);
  r = await fetchPollResults({ ...poll, type: POLL_TYPE_SIMPLE, mosaicId: null });
  ok(r.totalVotes === 2, 'simple poll unaffected', r);

  console.log(`checks=${checks} fails=${fails}`);
  server.close();
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
