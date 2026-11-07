// モザイクの保有量で重み付けする投票の、ノードとの通信部分（モザイクの指定の解決・保有量の取得・集計）。REST は模擬。
// Run: npx tsx dev-tests/symbol-voting-mosaic-api.test.ts
import { PrivateKey } from 'symbol-sdk';
import { Address, KeyPair, generateNamespaceId } from 'symbol-sdk/symbol';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { getNetwork, getNetworkConfig, setCustomNodeUrl } from '../src/lib/symbol/network';
import { POLL_TYPE_MOSAIC, assemblePoll, buildPollMessages, parsePollTx, sortNewestFirst } from '../src/lib/symbol/voting';
import { fetchMosaicHoldings, fetchMosaicHoldingsAtEnd, fetchSymbolPollResults, resolveMosaicInput, symbolAddressing } from '../src/lib/symbol/votingApi';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const cfg = getNetworkConfig();
const nb = cfg.networkByte;
const ad = symbolAddressing(nb);
const kp = () => new KeyPair(PrivateKey.random());
const acct = () => { const k = kp(); return { publicKey: k.publicKey.toString(), address: addressFromPublicKey(k.publicKey.toString(), nb) }; };
const [creator, A, B, C, D, E, F, G] = [acct(), acct(), acct(), acct(), acct(), acct(), acct(), acct()];
const hexOf = (a: string) => Array.from(new Address(a).bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const nsId = (name: string) => { let id = 0n; for (const l of name.split('.')) id = BigInt(generateNamespaceId(l, id)); return id.toString(16).toUpperCase().padStart(16, '0'); };

const TOKEN = '1122334455667788';
const XYM = cfg.currencyMosaicId.toUpperCase();
const holdings: Record<string, Array<{ id: string; amount: string }>> = {
  [A.address]: [{ id: TOKEN, amount: '300' }, { id: XYM, amount: '9' }],
  [B.address]: [{ id: TOKEN, amount: '100' }],
  [C.address]: [{ id: XYM, amount: '5000000' }], // TOKEN は持っていない
};
let accountsBulk = true;
const incoming: Record<string, unknown[]> = {};
// transfers the account sent or received (what /transactions/confirmed?address=... lists)
interface Hist { id: string; meta: { hash: string; height: string; index: number; timestamp: string; feeMultiplier: string; aggregateHash?: string }; transaction: unknown }
const history: Record<string, Hist[]> = {};
const mosaicsKnown: Record<string, { divisibility: number; flags: number }> = { [TOKEN]: { divisibility: 2, flags: 3 }, [XYM]: { divisibility: 6, flags: 3 } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (path === '/accounts' && init?.method === 'POST') {
    if (!accountsBulk) return json({ code: 'x' }, 404);
    const rows = (body.addresses as string[]).filter((a) => holdings[a]).map((a) => ({ account: { address: hexOf(a), importance: '0', mosaics: holdings[a] } }));
    return json(rows);
  }
  if (path.startsWith('/accounts/')) {
    const a = path.slice('/accounts/'.length);
    return holdings[a] ? json({ account: { address: hexOf(a), importance: '0', mosaics: holdings[a] } }) : json({ code: 'ResourceNotFound' }, 404);
  }
  if (path.startsWith('/namespaces/') && path !== '/namespaces/mosaic/names') {
    const id = path.slice('/namespaces/'.length);
    if (id === nsId('mytoken')) return json({ namespace: { alias: { type: 1, mosaicId: TOKEN.toLowerCase() } } });
    if (id === nsId('plain')) return json({ namespace: { alias: { type: 0 } } });
    if (id === nsId('addr')) return json({ namespace: { alias: { type: 2, address: hexOf(A.address) } } });
    return json({ code: 'ResourceNotFound' }, 404);
  }
  if (path === '/namespaces/mosaic/names') return json({ mosaicNames: [{ mosaicId: TOKEN, names: ['mytoken'] }] });
  if (path === '/mosaics' && init?.method === 'POST') {
    return json((body.mosaicIds as string[]).filter((i) => mosaicsKnown[i]).map((i) => ({ mosaic: { id: i, ...mosaicsKnown[i] } })));
  }
  if (path.startsWith('/mosaics/')) return mosaicsKnown[path.slice(9)] ? json({ mosaic: { id: path.slice(9) } }) : json({ code: 'ResourceNotFound' }, 404);
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

const rejects = async (p: Promise<unknown>, msg: string, what: string) => {
  try { await p; ok(false, `${what} (did not throw)`); } catch (e) { ok(e instanceof Error && e.message === msg, what, e instanceof Error ? e.message : e); }
};

// --- resolving what the person typed ---------------------------------------------------------
let info = await resolveMosaicInput(TOKEN.toLowerCase());
eq([info.id, info.divisibility], [TOKEN, 2], 'by mosaic id (lower-case accepted)');
info = await resolveMosaicInput('MyToken');
eq(info.id, TOKEN, 'by namespace name linked to a mosaic (case-insensitive)');
info = await resolveMosaicInput('xym');
eq(info.id, XYM, 'xym');
info = await resolveMosaicInput('symbol.xym');
eq(info.id, XYM, 'symbol.xym');
await rejects(resolveMosaicInput('plain'), 'alias_not_mosaic', 'namespace without an alias');
await rejects(resolveMosaicInput('addr'), 'alias_not_mosaic', 'namespace aliasing an address');
await rejects(resolveMosaicInput('nosuchname'), 'namespace_not_found', 'unknown namespace');
await rejects(resolveMosaicInput('AAAAAAAAAAAAAAAA'), 'mosaic_not_found', 'unknown mosaic id');
await rejects(resolveMosaicInput('not a name!'), 'mosaic_invalid', 'garbage');

// --- holdings -------------------------------------------------------------------------------
eq(await fetchMosaicHoldings([A.address, B.address, C.address, creator.address], TOKEN), [300, 100, 0, 0], 'holdings of the mosaic (none / unknown account = 0)');
eq(await fetchMosaicHoldings([A.address, C.address], XYM), [9, 5000000], 'holdings of XYM');
accountsBulk = false;
eq(await fetchMosaicHoldings([A.address, B.address, creator.address], TOKEN), [300, 100, 0], 'falls back to one request per account when the bulk request is refused');
accountsBulk = true;
eq(await fetchMosaicHoldings([], TOKEN), [], 'no addresses');

// --- counting a poll end to end -------------------------------------------------------------
const END = Date.now() + 86400_000;
const built = buildPollMessages({ title: '提案', description: '', options: ['賛成', '反対'], doe: END, type: POLL_TYPE_MOSAIC, multiple: false, whitelist: [], mosaicId: TOKEN }, creator.publicKey, ad);
const addressOf = (pk: string) => addressFromPublicKey(pk, nb);
const hex = (s: string) => `00${Buffer.from(s, 'utf8').toString('hex')}`;
let seq = 0;
const raw = (signer: { publicKey: string }, message?: string) => ({ id: `e${++seq}`, meta: { hash: `H${seq}`, height: String(100 + seq), index: 0, timestamp: '1' }, transaction: { type: 0x4154, signerPublicKey: signer.publicKey, message: message ? hex(message) : undefined, mosaics: [] } });
const pollTxs = sortNewestFirst(built.messages.filter((m) => m.recipient === built.pollAddress).map((m) => parsePollTx(raw(creator, m.message), addressOf, cfg.epochAdjustment)!));
const poll = assemblePoll(built.pollAddress, pollTxs, ad);
eq([poll.type, poll.mosaicId], [POLL_TYPE_MOSAIC, TOKEN], 'poll assembled');
incoming[poll.optionAddresses['賛成']] = [raw(A), raw(B)];
incoming[poll.optionAddresses['反対']] = [raw(C)];
const res = await fetchSymbolPollResults(poll, A.address);
eq(res.options.map((o) => o.votes), [2, 0], 'vote counts: C holds none of the mosaic, so the vote is invalid and not counted');
eq(res.options.map((o) => Math.round(o.percentage)), [100, 0], 'weighted by holdings: C holds none, so only A (300) and B (100) carry weight');
eq([res.totalVotes, res.approximateImportance, res.myVotes], [2, false, ['賛成']], 'totals, not approximate while running, my vote found');
const ended = await fetchSymbolPollResults({ ...poll, doe: Date.now() - 1000 }, undefined);
eq([ended.approximateImportance, ended.provisional], [false, false], 'ended, nothing moved after the end: holdings at the end, exact, not provisional');
eq([res.provisional, res.excludedVoters], [true, [C.address]], 'running: provisional, and the voter without the mosaic is reported');
eq(Math.round(res.options[0].weighted), 400, 'weight of the option = holdings of its voters');

// --- holdings as of the END of the poll ----------------------------------------------------------
const NOW = Date.now();
const POLL_END = NOW - 60_000; // the poll ended a minute ago
const stamp = (ms: number) => String(ms - cfg.epochAdjustment * 1000);
let hseq = 0;
const move = (from: { publicKey: string }, to: { address: string }, mosaics: Array<{ id: string; amount: string }>, atMs: number, extra: { embedded?: boolean; size?: number; maxFee?: string } = {}) => {
  const h: Hist = {
    id: `m${++hseq}`,
    meta: { hash: `HM${hseq}`, height: String(5000 + hseq), index: 0, timestamp: stamp(atMs), feeMultiplier: '100', ...(extra.embedded ? { aggregateHash: `AGG${hseq}` } : {}) },
    transaction: { type: 0x4154, signerPublicKey: from.publicKey, recipientAddress: hexOf(to.address), mosaics, size: extra.size ?? 200, maxFee: extra.maxFee ?? '100000' },
  };
  for (const a of [addressOf(from.publicKey), to.address]) (history[a] ??= []).unshift(h); // newest first
  return h;
};
const built2 = buildPollMessages({ title: '終了後の送金', description: '', options: ['賛成', '反対'], doe: POLL_END, type: POLL_TYPE_MOSAIC, multiple: false, whitelist: [], mosaicId: TOKEN }, creator.publicKey, ad);
const poll2 = assemblePoll(built2.pollAddress, sortNewestFirst(built2.messages.filter((m) => m.recipient === built2.pollAddress).map((m) => parsePollTx(raw(creator, m.message), addressOf, cfg.epochAdjustment)!)), ad);
// A (voted 賛成, 300 at the end) gave all of it to D AFTER the end; B (賛成, 100 at the end) was given 50 after the end;
// F (賛成) gave 200 to G DURING the poll; G voted 反対.
incoming[poll2.optionAddresses['賛成']] = [raw(A), raw(B), raw(F)];
incoming[poll2.optionAddresses['反対']] = [raw(D), raw(G)];
holdings[A.address] = [{ id: TOKEN, amount: '0' }];
holdings[D.address] = [{ id: TOKEN, amount: '300' }];
holdings[B.address] = [{ id: TOKEN, amount: '150' }];
holdings[F.address] = [{ id: TOKEN, amount: '0' }];
holdings[G.address] = [{ id: TOKEN, amount: '200' }];
move(F, G, [{ id: TOKEN, amount: '200' }], POLL_END - 120_000);                    // during the poll: stays as it is
move(A, D, [{ id: TOKEN, amount: '300' }], POLL_END + 10_000);                     // after the end: undone
move(E, B, [{ id: TOKEN, amount: '50' }], POLL_END + 20_000, { embedded: true });  // after the end, inside an aggregate: undone
const atEnd = await fetchMosaicHoldingsAtEnd([A.address, B.address, D.address, F.address, G.address], TOKEN, POLL_END);
eq(atEnd, { holdings: [300, 100, 0, 0, 200], approximate: false }, 'holdings at the end: transfers after the end are undone (also inside aggregates), those during the poll are not');
eq((await fetchMosaicHoldingsAtEnd([A.address, B.address], TOKEN, null)).holdings, [0, 150], 'no end time: today\'s holdings');
const res2 = await fetchSymbolPollResults(poll2, A.address);
eq(res2.options.map((o) => Math.round(o.weighted)), [400, 200], 'weight = holding at the end: 賛成 = A 300 + B 100; 反対 = G 200 (D held nothing at the end)');
eq(res2.options.map((o) => o.votes), [2, 1], 'ballots: A, B and G; D and F held none at the end');
eq([...(res2.excludedVoters ?? [])].sort(), [D.address, F.address].sort(), 'D (nothing at the end) and F (gave it away during the poll) are invalid');
eq([res2.totalVotes, res2.provisional, res2.approximateImportance], [3, false, false], 'totals; ended; exact for a custom mosaic');
eq(res2.options.map((o) => Math.round(o.percentage)), [67, 33], 'percentages over the valid weights');

// XYM: also undoes the fee of a transfer the account sent itself, but is flagged as an estimate (rewards, locks)
holdings[A.address] = [{ id: XYM, amount: '700' }];
holdings[B.address] = [{ id: XYM, amount: '1000' }];
move(A, B, [{ id: 'E74B99BA41F4AFEE', amount: '250' }], POLL_END + 30_000, { size: 160 }); // sent by the alias id; fee = 160 x 100 = 16000 (maxFee 100000)
const xymEnd = await fetchMosaicHoldingsAtEnd([A.address, B.address], XYM, POLL_END);
eq(xymEnd, { holdings: [700 + 250 + 16000 + 20000, 1000 - 250], approximate: true }, 'XYM: the transfer (sent under the alias id) and the fees of what A sent after the end are undone; flagged as an estimate');

console.log(`checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
