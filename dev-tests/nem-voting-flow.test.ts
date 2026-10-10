import http from 'node:http';
import { setNemCustomNodeUrl } from '../src/lib/nem/network';
import { nemKeyPairFromPrivateKey, nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import { NEM_EPOCH_SECONDS } from '../src/lib/nem/constants';
import {
  POLL_TYPE_POI, POLL_TYPE_WHITELIST, POLL_INDEX_ADDRESS, buildPollMessages, fetchPoll, fetchPollResults, fetchPollHeaders,
  heightAtTimestamp, validateNewPoll, sendNemPoll, sendNemVote, totalPollFee, pollAddressInUse, deriveOptionAddress, PollBroadcastError,
} from '../src/lib/nem/voting';
import type { NewPollInput } from '../src/lib/nem/voting';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const NB = 0x68;
const keyOf = (i: number) => nemKeyPairFromPrivateKey(i.toString(16).padStart(64, '0'));
const people = Array.from({ length: 8 }, (_, i) => { const k = keyOf(i + 1); return { ...k, address: nemAddressFromPublicKey(k.publicKey, NB) }; });
const [creator, A, B, C, D, E, F, G] = people;

// --- mock NIS ------------------------------------------------------------------------------
interface MTx { id: number; height: number; signer: string; amount: number; message?: string; mosaics?: boolean; multisigInner?: boolean }
const chain = new Map<string, MTx[]>();
let nextId = 1;
const TIP = 200000;
const nowNem = Math.floor(Date.now() / 1000) - NEM_EPOCH_SECONDS;
const T0 = nowNem - TIP * 60;
const blockTs = (h: number) => T0 + h * 60;
let pageLimit = 100; // max entries per page the "node" returns
let historical: 'ok' | 'missing' = 'ok';
const importance = new Map<string, number>();
const announced: string[] = [];
let failAnnounceAt = -1;

function put(to: string, tx: Omit<MTx, 'id'>) { const l = chain.get(to) ?? []; l.push({ ...tx, id: nextId++ }); chain.set(to, l); }
const toHex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
function entry(t: MTx) {
  const inner = { timeStamp: blockTs(t.height), amount: t.amount, fee: 50000, type: 257, version: (0x68 << 24) | 1, signer: t.signer, recipient: 'X', ...(t.message !== undefined ? { message: { type: 1, payload: toHex(t.message) } } : {}), ...(t.mosaics ? { mosaics: [{ quantity: 1, mosaicId: { namespaceId: 'a', name: 'b' } }] } : {}) };
  const tx = t.multisigInner ? { timeStamp: blockTs(t.height), type: 4100, version: (0x68 << 24) | 1, signer: 'aa'.repeat(32), otherTrans: inner } : inner;
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
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 25), pageLimit);
      const before = url.searchParams.get('id');
      let list = (chain.get(addr) ?? []).slice().sort((a, b) => b.id - a.id);
      if (before) list = list.filter((t) => t.id < Number(before));
      return send({ data: list.slice(0, size).map(entry) });
    }
    if (p === '/chain/height') return send({ height: TIP });
    if (p === '/block/at/public') { const h = JSON.parse(body).height; return send({ height: h, timeStamp: blockTs(h) }); }
    if (p === '/account/get/batch') {
      const accounts = JSON.parse(body).data as { account: string }[];
      return send({ data: accounts.map((a) => ({ account: { address: a.account, importance: importance.get(a.account) ?? 0 } })) });
    }
    if (p === '/account/historical/get/batch') {
      if (historical === 'missing') return send({ error: 'nope' }, 404);
      const j = JSON.parse(body) as { accounts: { account: string }[] };
      return send({ data: j.accounts.map((a) => ({ data: [{ height: 1, importance: (importance.get(a.account) ?? 0) * 2 }] })) });
    }
    if (p === '/transaction/announce') {
      if (announced.length === failAnnounceAt) return send({ code: 5, message: 'FAILURE_INSUFFICIENT_BALANCE' });
      announced.push(body); return send({ code: 1, message: 'SUCCESS', transactionHash: { data: 'hash' + announced.length } });
    }
    send({ error: 'unknown' }, 404);
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  setNemCustomNodeUrl('mainnet', `http://127.0.0.1:${port}`);

  // ---- heightAtTimestamp vs a linear model ----
  for (const offsetBlocks of [TIP - 1, TIP - 5, TIP - 1234, 50000, 777, 2, 130000]) {
    const target = blockTs(offsetBlocks) + 30; // between block n and n+1
    const got = await heightAtTimestamp((target + NEM_EPOCH_SECONDS) * 1000);
    ok(got === offsetBlocks, `height at ${offsetBlocks}`, got);
  }
  ok((await heightAtTimestamp((nowNem + 5000 + NEM_EPOCH_SECONDS) * 1000)) === TIP, 'future time -> tip');

  // ---- build + validate ----
  const futureMs = Date.now() + 7 * 86400_000;
  const base: NewPollInput = { title: 'Lunch?', description: 'What shall we eat?\n寿司かラーメン', options: ['Sushi', 'Ramen', 'ピザ'], doe: futureMs, type: POLL_TYPE_POI, multiple: false, whitelist: [] };
  ok(validateNewPoll(base, NB).length === 0, 'valid poll accepted');
  ok(validateNewPoll({ ...base, options: ['a'] }, NB).includes('options_few'), 'too few options');
  ok(validateNewPoll({ ...base, options: ['a', 'a'] }, NB).includes('option_duplicate'), 'duplicate options');
  ok(validateNewPoll({ ...base, doe: Date.now() - 1 }, NB).includes('end_past'), 'end in past');
  ok(validateNewPoll({ ...base, type: POLL_TYPE_WHITELIST }, NB).includes('whitelist_empty'), 'whitelist empty');
  ok(validateNewPoll({ ...base, type: POLL_TYPE_WHITELIST, whitelist: ['NOTANADDRESS'] }, NB).includes('whitelist_invalid'), 'whitelist invalid');
  ok(validateNewPoll({ ...base, description: 'x'.repeat(1100) }, NB).includes('message_too_large'), 'description too large');
  ok(validateNewPoll({ ...base, title: ' ' }, NB).includes('title_empty'), 'title empty');

  const built = buildPollMessages(base, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  ok(built.messages.length === 4, 'POI poll = 4 messages');
  ok(built.messages[3].recipient === POLL_INDEX_ADDRESS.mainnet && built.messages[3].message.startsWith('poll:'), 'header goes to the index, last');
  ok(built.messages.slice(0, 3).every((m) => m.recipient === built.pollAddress), 'details go to poll address');
  ok(built.messages.every((m) => m.fee >= 100000n), 'each message costs fee');
  console.log('  fee total (XEM):', Number(totalPollFee(built.messages)) / 1e6);

  // seed chain from built messages (as the creator, at heights 100..)
  const seed = (b: typeof built, h = 100) => b.messages.forEach((m, i) => put(m.recipient, { height: h + i, signer: creator.publicKey, amount: 0, message: m.message }));
  ok(!(await pollAddressInUse(built.pollAddress)), 'address free before creation');
  seed(built);
  ok(await pollAddressInUse(built.pollAddress), 'address in use after creation');

  // ---- listing in the index ----
  const page = await fetchPollHeaders(POLL_INDEX_ADDRESS.mainnet);
  ok(page.headers.length === 1 && page.headers[0].title === 'Lunch?' && page.headers[0].address === built.pollAddress && page.headers[0].creator === creator.address, 'index lists the poll', page);
  put(POLL_INDEX_ADDRESS.mainnet, { height: 150, signer: A.publicKey, amount: 0, message: 'poll:{broken' });
  put(POLL_INDEX_ADDRESS.mainnet, { height: 151, signer: A.publicKey, amount: 0, message: 'hello' });
  ok((await fetchPollHeaders(POLL_INDEX_ADDRESS.mainnet)).headers.length === 1, 'garbage in index ignored');

  // ---- read the poll back ----
  const poll = await fetchPoll(built.pollAddress);
  ok(poll.title === 'Lunch?' && poll.description.includes('寿司') && poll.options.join() === 'Sushi,Ramen,ピザ' && poll.valid && !poll.multiple && poll.endBlock === null, 'poll round-trips', poll);
  ok(poll.creator === creator.address, 'creator = first sender');
  for (const o of poll.options) ok(poll.optionAddresses[o] === deriveOptionAddress(poll.address, o, NB), 'option address ' + o);

  // ---- votes ----
  const opt = (name: string) => poll.optionAddresses[name];
  put(opt('Sushi'), { height: 200, signer: A.publicKey, amount: 0 });
  put(opt('Sushi'), { height: 201, signer: A.publicKey, amount: 0 }); // same voter twice: counted once
  put(opt('Ramen'), { height: 202, signer: B.publicKey, amount: 0 });
  put(opt('Sushi'), { height: 203, signer: C.publicKey, amount: 0 });
  put(opt('Ramen'), { height: 204, signer: C.publicKey, amount: 0 }); // C voted twice -> nullified
  put(opt('Sushi'), { height: 205, signer: D.publicKey, amount: 5_000_000 }); // paid transfer: not a vote
  put(opt('Sushi'), { height: 206, signer: E.publicKey, amount: 0, mosaics: true }); // mosaic transfer: not a vote
  put(opt('ピザ'), { height: 207, signer: F.publicKey, amount: 0, multisigInner: true }); // multisig vote, signer = inner signer
  importance.set(A.address, 0.3); importance.set(B.address, 0.1); importance.set(C.address, 0.4); importance.set(F.address, 0.2);

  let r = await fetchPollResults(poll, A.address);
  const o = Object.fromEntries(r.options.map((x) => [x.text, x]));
  ok(o.Sushi.votes === 1 && o.Ramen.votes === 1 && o['ピザ'].votes === 1, 'valid ballots per option', r.options);
  ok(r.totalVotes === 3, 'total valid ballots', r.totalVotes);
  // total importance is over the valid voters A, B, F (C nullified)
  ok(near(o.Sushi.percentage, 0.3 * 100 / 0.6) && near(o.Ramen.percentage, 0.1 * 100 / 0.6) && near(o['ピザ'].percentage, 0.2 * 100 / 0.6), 'POI percentages', r.options);
  ok(r.myVotes.join() === 'Sushi', 'myVotes for A', r.myVotes);
  ok(!r.approximateImportance, 'no approximation while running');
  r = await fetchPollResults(poll, C.address);
  ok(r.myVotes.join() === 'Sushi,Ramen', 'myVotes shows both of C’s votes (so UI can warn)', r.myVotes);

  // multiple choice: C counts for both options, importance split
  const multiPoll = { ...poll, multiple: true };
  r = await fetchPollResults(multiPoll);
  const m = Object.fromEntries(r.options.map((x) => [x.text, x]));
  ok(m.Sushi.votes === 2 && m.Ramen.votes === 2, 'multiple: C counts twice', r.options);
  // voters A(1 opt),B(1),C(2),F(1): total importance 1.0; Sushi = .3 + .4/2 = .5 ; Ramen = .1 + .2 = .3 ; ピザ = .2
  ok(near(m.Sushi.percentage, 50) && near(m.Ramen.percentage, 30) && near(m['ピザ'].percentage, 20), 'multiple: split importance', r.options);

  // ---- ended poll: votes after the end block ignored; historical importance ----
  const endedInput: NewPollInput = { ...base, title: 'Ended', doe: Date.now() - 3600_000, options: ['Yes', 'No'] };
  const endedBuilt = buildPollMessages(endedInput, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  seed(endedBuilt, 50);
  const endedPoll = await fetchPoll(endedBuilt.pollAddress);
  const expectedEnd = Math.floor((Math.floor(endedInput.doe / 1000) - NEM_EPOCH_SECONDS - T0) / 60);
  ok(endedPoll.endBlock === expectedEnd, 'ended poll end block', [endedPoll.endBlock, expectedEnd]);
  put(endedPoll.optionAddresses.Yes, { height: expectedEnd - 5, signer: A.publicKey, amount: 0 });
  put(endedPoll.optionAddresses.No, { height: expectedEnd, signer: B.publicKey, amount: 0 }); // exactly at end: counts
  put(endedPoll.optionAddresses.No, { height: expectedEnd + 1, signer: C.publicKey, amount: 0 }); // after: ignored
  historical = 'ok';
  r = await fetchPollResults(endedPoll);
  ok(r.totalVotes === 2 && !r.approximateImportance, 'ended: only votes up to end block', r);
  ok(near(r.options[0].percentage, 75) && near(r.options[1].percentage, 25), 'ended: percentages from historical importance', r.options);
  historical = 'missing';
  r = await fetchPollResults(endedPoll);
  ok(r.approximateImportance && near(r.options[0].percentage, 75), 'ended: falls back to current importance and says so', r);

  // ---- whitelist ----
  const wlInput: NewPollInput = { ...base, title: 'Members only', type: POLL_TYPE_WHITELIST, options: ['Yes', 'No'], whitelist: [A.address, B.address, C.address, ...Array.from({ length: 30 }, (_, i) => nemAddressFromPublicKey(keyOf(100 + i).publicKey, NB))] };
  ok(validateNewPoll(wlInput, NB).length === 0, 'whitelist poll valid');
  const wlBuilt = buildPollMessages(wlInput, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  ok(wlBuilt.messages.length === 3 + 2 + 1, 'whitelist split in messages of 23', wlBuilt.messages.length);
  seed(wlBuilt, 300);
  put(wlBuilt.pollAddress, { height: 400, signer: D.publicKey, amount: 0, message: `whitelist:${JSON.stringify([D.address])}` }); // not the creator: ignored
  const wlPoll = await fetchPoll(wlBuilt.pollAddress);
  ok(wlPoll.whitelist!.length === 33 && !wlPoll.whitelist!.includes(D.address), 'whitelist read, intruder ignored', wlPoll.whitelist?.length);
  put(wlPoll.optionAddresses.Yes, { height: 500, signer: A.publicKey, amount: 0 });
  put(wlPoll.optionAddresses.Yes, { height: 501, signer: D.publicKey, amount: 0 }); // not listed
  put(wlPoll.optionAddresses.No, { height: 502, signer: B.publicKey, amount: 0 });
  put(wlPoll.optionAddresses.No, { height: 503, signer: C.publicKey, amount: 0 });
  r = await fetchPollResults(wlPoll);
  ok(r.totalVotes === 3 && r.options[0].votes === 1 && r.options[1].votes === 2 && near(r.options[1].percentage, 200 / 3), 'whitelist counting', r.options);

  // ---- paging (node returns 25 or 100 per page) ----
  const big = buildPollMessages({ ...base, title: 'Big', options: ['x', 'y'] }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  seed(big, 600);
  const bigPoll = await fetchPoll(big.pollAddress);
  for (let i = 0; i < 260; i++) { const k = keyOf(1000 + i); put(bigPoll.optionAddresses.x, { height: 700 + i, signer: k.publicKey, amount: 0 }); importance.set(nemAddressFromPublicKey(k.publicKey, NB), 0.001); }
  for (const limit of [100, 25]) {
    pageLimit = limit;
    r = await fetchPollResults(bigPoll);
    ok(r.options[0].votes === 260, `paging with page limit ${limit}`, r.options[0].votes);
  }
  pageLimit = 100;

  // ---- sending ----
  const priv = creator.privateKey;
  const hashes = await sendNemPoll(priv, creator.publicKey, built.messages);
  ok(hashes.length === 4 && announced.length === 4, 'poll messages announced one by one');
  const first = JSON.parse(announced[0]) as { data?: string; signature?: string };
  ok(typeof first.data === 'string' && typeof first.signature === 'string', 'announce body has data+signature');
  announced.length = 0; failAnnounceAt = 2;
  try { await sendNemPoll(priv, creator.publicKey, built.messages); ok(false, 'should have thrown'); }
  catch (e) { ok(e instanceof PollBroadcastError && e.sent === 2, 'stops at the failing message and reports how many went out', e); }
  failAnnounceAt = -1; announced.length = 0;

  const vote = await sendNemVote({ privateKey: A.privateKey, publicKey: A.publicKey, poll, option: 'Sushi' });
  ok(vote.hash === 'hash1' && announced.length === 1, 'vote announced');
  for (const bad of [
    { poll: { ...poll, doe: Date.now() - 1 }, option: 'Sushi', err: 'poll_ended' },
    { poll: { ...poll, valid: false }, option: 'Sushi', err: 'poll_invalid' },
    { poll, option: 'Nope', err: 'invalid_option' },
  ]) {
    try { await sendNemVote({ privateKey: A.privateKey, publicKey: A.publicKey, poll: bad.poll, option: bad.option }); ok(false, 'should reject ' + bad.err); }
    catch (e) { ok((e as Error).message === bad.err, 'rejects ' + bad.err, (e as Error).message); }
  }

  // ---- tampered option addresses make the poll invalid for voting ----
  const evil = buildPollMessages({ ...base, title: 'Evil', options: ['a', 'b'] }, creator.publicKey, NB, POLL_INDEX_ADDRESS.mainnet);
  evil.messages[2] = { ...evil.messages[2], message: evil.messages[2].message.replace(/"link":\{"a":"[A-Z2-7]{40}"/, `"link":{"a":"${D.address}"`) };
  seed(evil, 900);
  const evilPoll = await fetchPoll(evil.pollAddress);
  ok(!evilPoll.valid, 'tampered option address => poll.valid false');

  // ---- errors ----
  for (const [addr, code] of [['NOPE', 'poll_not_found'], [A.address, 'poll_not_found']] as const) {
    try { await fetchPoll(addr); ok(false, 'should throw ' + code); } catch (e) { ok((e as Error).message === code, 'fetchPoll ' + code, (e as Error).message); }
  }

  console.log(`checks=${checks} fails=${fails}`);
  server.close();
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e); process.exit(2); });
