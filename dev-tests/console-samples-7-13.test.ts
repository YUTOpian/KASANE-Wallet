// コンソールのサンプルのうち、メタデータ・ロック・マルチシグ・監視・制限・オフライン署名・検証（lib/console/samples7to13.ts）を、
// 通信なし（fetch と WebSocket は偽物）で、本物のコンソール環境（env.ts）に順に実行して確かめる。
// 実行: npx tsx dev-tests/console-samples-7-13.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { KeyPair, SymbolFacade, models, proveMerkle, mosaicRestrictionGenerateKey as sdkSymbol_mosaicRestrictionGenerateKey } from 'symbol-sdk/symbol';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { parse } from 'acorn';
import { createConsoleEnv } from '../src/lib/console/env';
import type { SignRequest } from '../src/lib/console/env';
import { isIncomplete } from '../src/lib/console/repl';
import { CONSOLE_SAMPLES, NEM_CONSOLE_SAMPLES, SYMBOL_EXTRA_SAMPLE_IDS, SYMBOL_ONLY_SAMPLE_IDS, consoleSamplesFor } from '../src/lib/console/samples';
import messages from '../src/i18n/messages.json';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hex = (b: Uint8Array) => utils.uint8ToHex(b);
const unhex = (h: string) => utils.hexToUint8(h);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha3 = (...p: Uint8Array[]) => hex(sha3_256(cat(...p)));

(globalThis as unknown as { window: unknown }).window = globalThis;

// --- サンプルの形（const なし・Symbol 専用・名前がある） ---
// Symbol の追加サンプル（NEM にも同じ操作があるものは、NEM 版が samplesNem7to13.ts にある。Symbol にしかないものは SYMBOL_ONLY_SAMPLE_IDS）
const extra = CONSOLE_SAMPLES.filter((s) => SYMBOL_EXTRA_SAMPLE_IDS.includes(s.id));
ok(extra.length === SYMBOL_EXTRA_SAMPLE_IDS.length && extra.length >= 34, 'all the extra Symbol samples are in the Symbol list', extra.length);
ok(SYMBOL_ONLY_SAMPLE_IDS.length >= 23 && SYMBOL_ONLY_SAMPLE_IDS.every((id) => SYMBOL_EXTRA_SAMPLE_IDS.includes(id)), 'the Symbol-only ids are some of the extra Symbol ids', SYMBOL_ONLY_SAMPLE_IDS.length);
ok(new Set(CONSOLE_SAMPLES.map((s) => s.id)).size === CONSOLE_SAMPLES.length, 'sample ids are unique');
for (const s of extra) {
  try { parse(s.code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }); ok(!isIncomplete(s.code), `${s.id} is complete`); }
  catch (e) { ok(false, `${s.id} does not parse`, (e as Error).message); }
  ok(!/^\s*(const|let)\s/m.test(s.code), `${s.id} has no const / let`);
  ok(!/walletKeyPair|SymbolFacade|Buffer/.test(s.code), `${s.id} uses alice / sdkSymbol, no Buffer`);
  ok(!/第\s*\d+\s*章|本と同じ/.test(s.code), `${s.id} does not point at book chapters`);
  if (SYMBOL_ONLY_SAMPLE_IDS.includes(s.id)) ok(!NEM_CONSOLE_SAMPLES.some((n) => n.id === s.id), `${s.id} is not in the NEM list`);
  else ok(NEM_CONSOLE_SAMPLES.some((n) => n.id === s.id), `${s.id} has a NEM version`);
  for (const lang of ['ja', 'en'] as const) {
    const name = (messages as unknown as Record<string, { console: Record<string, string> }>)[lang].console[`sample_${s.id}`];
    ok(typeof name === 'string' && name.length > 0, `${lang} has the name of ${s.id}`);
  }
}
ok(consoleSamplesFor('symbol') === CONSOLE_SAMPLES, 'consoleSamplesFor(symbol)');
// アドレス・モザイク・トランザクション制限のサンプルは、alice ではなく carol にかける
for (const id of ['restrict_address', 'restrict_mosaic', 'restrict_op']) {
  const code = CONSOLE_SAMPLES.find((s) => s.id === id)!.code;
  ok(/carol\.signTransaction/.test(code) && !/alice\.signTransaction/.test(code), `${id} is signed by carol, not alice`);
}

// --- 偽のノード ---
const PRIVATE = 'A'.repeat(63) + '1';
const wallet = new KeyPair(new PrivateKey(PRIVATE));
const facade = new SymbolFacade('testnet');
const requests: { url: string; method: string; body?: string }[] = [];
const state: { root: string; sibling: string; blockJson: unknown; prevHash: string; accountInfo: unknown; stateLeafRoot: string; stateTree: unknown; txHash: string } = {
  root: '', sibling: '', blockJson: null, prevHash: '', accountInfo: null, stateLeafRoot: '', stateTree: null, txHash: '',
};
let partialHash = '';
const KYC_KEY = sdkSymbol_mosaicRestrictionGenerateKey('KYC');
const meta: { root: string; entries: Record<string, unknown>[]; trees: Record<string, unknown> } = { root: '', entries: [], trees: {} };
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  const url = u.pathname + u.search;
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
  let body: unknown = {};
  if (u.pathname.startsWith('/restrictions/mosaic')) {
    body = u.searchParams.get('entryType') === '1'
      ? { data: [{ mosaicRestrictionEntry: { entryType: 1, restrictions: [{ key: KYC_KEY.toString(), restriction: { referenceMosaicId: '0000000000000000', restrictionValue: '1', restrictionType: 1 } }] } }] }
      : { data: [{ mosaicRestrictionEntry: { entryType: 0, restrictions: [{ key: KYC_KEY.toString(), value: '1' }] } }] };
  }
  else if (u.pathname === '/metadata' && ['1', '2'].includes(u.searchParams.get('metadataType') ?? '')) body = { data: meta.entries.filter((e) => String((e.metadataEntry as { metadataType: number }).metadataType) === u.searchParams.get('metadataType')) };
  else if (/^\/metadata\/[0-9A-F]+\/merkle$/.test(u.pathname)) body = meta.trees[u.pathname.split('/')[2]] ?? {};
  else if (u.pathname.startsWith('/metadata')) body = { data: [{ metadataEntry: { scopedMetadataKey: 'AB12', value: hex(new TextEncoder().encode('test')), valueSize: 4 } }] };
  else if (u.pathname.startsWith('/transactions/partial/')) body = { meta: { hash: partialHash } };
  else if (u.pathname.startsWith('/lock/secret')) body = { data: [{ lock: { amount: '1000000' } }] };
  else if (/^\/account\/[^/]+\/multisig$/.test(u.pathname)) body = { multisig: { minApproval: 2, minRemoval: 2, cosignatoryAddresses: ['a', 'b', 'c'], multisigAddresses: [] } };
  else if (u.pathname.startsWith('/restrictions/account/')) body = { accountRestrictions: { restrictions: [{ restrictionFlags: 32769 }] } };
  else if (u.pathname.startsWith('/transactions/confirmed/')) body = { meta: { height: '100', hash: state.txHash } };
  else if (/^\/blocks\/100\/transactions\/[0-9A-F]+\/merkle$/.test(u.pathname)) body = { merklePath: [{ position: 'right', hash: state.sibling }] };
  else if (u.pathname === '/blocks/100') body = state.blockJson;
  else if (u.pathname === '/blocks/99') body = { meta: { hash: state.prevHash } };
  else if (u.pathname === '/blocks') body = { data: [{ meta: { stateHashSubCacheMerkleRoots: [state.stateLeafRoot, '', '', '', '', '', '', '', meta.root] } }] };
  else if (/^\/accounts\/[^/]+\/merkle$/.test(u.pathname)) body = state.stateTree;
  else if (u.pathname.startsWith('/accounts/')) body = { account: state.accountInfo };
  else if (u.pathname === '/transactions' || u.pathname === '/transactions/partial' || u.pathname === '/transactions/cosignature') body = { message: 'packet 9 was pushed to the network via /transactions' };
  return { json: async () => body } as unknown as Response;
};

// 偽の WebSocket（つなぐと uid が届く）
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) { FakeWebSocket.last = this; setTimeout(() => this.onmessage?.({ data: JSON.stringify({ uid: 'UID1' }) }), 0); }
  addEventListener() { /* 使わない */ }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.({ type: 'close' }); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

const asked: SignRequest[] = [];
const logs: string[] = [];
const env = createConsoleEnv({
  networkByte: 0x98, nodeUrl: 'https://node.example:3001', signer: { publicKey: wallet.publicKey.toString() },
  onLog: (kind, text) => logs.push(`${kind}: ${text}`), onClear: () => undefined,
  onSign: async (req) => { asked.push(req); return wallet.sign(req.data).bytes; },
});
async function run(code: string): Promise<unknown> { return (await env.interpreter.run(code)).value; }
async function sample(id: string): Promise<void> {
  const s = CONSOLE_SAMPLES.find((x) => x.id === id)!;
  logs.length = 0; requests.length = 0; asked.length = 0;
  try { await env.interpreter.run(s.code); } catch (e) { ok(false, `sample ${id} threw`, e instanceof Error ? `${e.name}: ${e.message}` : String(e)); }
}
const lastPut = () => requests.filter((r) => r.method === 'PUT').slice(-1)[0];
const putPayload = (r: { body?: string } | undefined) => (r?.body ? (JSON.parse(r.body) as { payload: string }).payload : '');
const tx = (payloadHex: string) => models.TransactionFactory.deserialize(unhex(payloadHex));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- メタデータ ---
await sample('metadata');
{
  const p = lastPut();
  ok(p?.url === '/transactions' && asked.length === 1 && asked[0].kind === 'transaction', 'metadata: alice signs once and announces', requests);
  const t = tx(putPayload(p));
  ok(t.transactions.length === 1 && t.transactions[0].type.value === models.TransactionType.ACCOUNT_METADATA.value, 'metadata: one account metadata transaction');
  ok(facade.verifyTransaction(t, t.signature), 'metadata: the signature is the wallet\'s');
  ok(t.transactions[0].valueSizeDelta === 0 && hex(t.transactions[0].value) === hex(new Uint8Array([0, 0, 0, 0])), 'metadata: an existing value is turned into a diff (xor) and the size delta', hex(t.transactions[0].value));
}
await sample('metadata_list');
ok(logs.some((l) => l === 'log: AB12 test'), 'metadata_list: key and decoded value', logs.join('|'));

// --- ロック ---
await sample('bonded');
const bondedHash = String(await run('facade.hashTransaction(aggregateTx).toString()'));
ok(logs.includes(`log: ${bondedHash}`) && /^[0-9A-F]{64}$/.test(bondedHash), 'bonded: prints the hash');
ok(asked.length === 1 && String(await run('aggregateTx.cosignatures.length')) === '0', 'bonded: signed by alice only');
await sample('hash_lock');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.HASH_LOCK.value && hex(t.hash.bytes) === bondedHash, 'hash_lock: locks the hash of the bonded aggregate', hex(t.hash?.bytes ?? new Uint8Array()));
  ok(t.mosaic.amount.value === 10000000n, 'hash_lock: 10 XYM');
}
await sample('bonded_announce');
ok(lastPut()?.url === '/transactions/partial', 'bonded_announce: PUT /transactions/partial');
ok(putPayload(lastPut()) === String(await run('JSON.parse(jsonPayload).payload')), 'bonded_announce: sends the signed bonded payload');
partialHash = bondedHash;
await sample('bonded_cosign');
{
  const put = lastPut();
  const body = JSON.parse(put.body!) as { parentHash: string; signature: string; signerPublicKey: string };
  ok(put.url === '/transactions/cosignature' && body.parentHash === bondedHash, 'bonded_cosign: cosignature for the bonded hash');
  ok(body.signerPublicKey === String(await run('bob.publicKey.toString()')) && asked.length === 0, 'bonded_cosign: signed by bob (no dialog)');
}
await sample('secret');
{
  const secret = logs.find((l) => l.startsWith('log: secret:'))!.slice('log: secret:'.length);
  const proof = logs.find((l) => l.startsWith('log: proof:'))!.slice('log: proof:'.length);
  ok(proof.length === 40 && secret === sha3(unhex(proof)), 'secret: secret is SHA3-256 of the 20-byte proof', { secret, proof });
  ok(logs.some((l) => l.includes('testnet.symbol.tools') && l.includes('amount=10')), 'secret: faucet URL for bob on the testnet');
}
await sample('secret_lock');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.SECRET_LOCK.value && t.mosaic.amount.value === 1000000n, 'secret_lock: locks 1 XYM');
  ok(hex(t.secret.bytes) === String(await run('sdkCore.utils.uint8ToHex(secret)')).toUpperCase(), 'secret_lock: with the secret');
  ok(requests.some((r) => r.url.startsWith('/lock/secret?secret=')), 'secret_lock: looks the lock up');
}
await sample('secret_proof');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.SECRET_PROOF.value && hex(t.proof) === String(await run('sdkCore.utils.uint8ToHex(proof)')).toUpperCase(), 'secret_proof: the proof');
  ok(hex(t.signerPublicKey.bytes) === String(await run('bob.publicKey.toString()')) && asked.length === 0, 'secret_proof: signed by bob');
}

// --- マルチシグ ---
await sample('multisig_create');
const bobAddr = String(await run('bob.address.toString()'));
{
  const t = tx(putPayload(lastPut()));
  const inner = t.transactions[0];
  ok(inner.type.value === models.TransactionType.MULTISIG_ACCOUNT_MODIFICATION.value && inner.addressAdditions.length === 3, 'multisig_create: adds 3 cosigners');
  ok(inner.minApprovalDelta === 2 && inner.minRemovalDelta === 2, 'multisig_create: approval 2 / removal 2');
  ok(hex(inner.signerPublicKey.bytes) === String(await run('bob.publicKey.toString()')), 'multisig_create: the multisig account is bob');
  ok(t.cosignatures.length === 3 && hex(t.signerPublicKey.bytes) === wallet.publicKey.toString(), 'multisig_create: alice initiates, 3 cosignatures');
  ok(facade.verifyTransaction(t, t.signature), 'multisig_create: alice signature is valid');
  ok(asked.length === 1, 'multisig_create: one dialog (alice)');
  ok(logs.filter((l) => l.startsWith('log: bob key:') || l.startsWith('log: carol1 key:') || l.startsWith('log: carol2 key:')).length === 3, 'multisig_create: keys are shown');
}
await sample('multisig_info');
ok(logs.some((l) => l.includes('minApproval: 2 minRemoval: 2')) && requests.length === 2, 'multisig_info: both sides', logs.join('|'));
await sample('multisig_send');
{
  const t = tx(putPayload(lastPut()));
  ok(t.transactions[0].signerPublicKey.toString() === String(await run('bob.publicKey.toString()')) && t.cosignatures.length === 1, 'multisig_send: sent from bob, one cosignature (carol1)');
  ok(hex(t.cosignatures[0].signerPublicKey.bytes) === String(await run('carol1.publicKey.toString()')), 'multisig_send: carol1 cosigns');
  ok(new TextDecoder().decode(t.transactions[0].message) === '\u0000test', 'multisig_send: plain message', JSON.stringify(new TextDecoder().decode(t.transactions[0].message)));
  ok(asked.length === 1, 'multisig_send: one dialog (alice)');
  ok(bobAddr.length > 0, 'bob address known');
}

// --- マルチシグの構成変更（差替え・縮小） ---
const addrHex = async (name: string) => hex((await run(`${name}.address.bytes`)) as Uint8Array);
const keyHex = async (name: string) => String(await run(`${name}.publicKey.toString()`));
await sample('multisig_replace');
{
  const t = tx(putPayload(lastPut()));
  const inner = t.transactions[0];
  ok(lastPut()?.url === '/transactions' && t.transactions.length === 1 && inner.type.value === models.TransactionType.MULTISIG_ACCOUNT_MODIFICATION.value, 'multisig_replace: one multisig modification', requests);
  ok(inner.addressAdditions.length === 1 && hex(inner.addressAdditions[0].bytes) === await addrHex('carol3'), 'multisig_replace: carol3 is added');
  ok(inner.addressDeletions.length === 1 && hex(inner.addressDeletions[0].bytes) === await addrHex('carol2'), 'multisig_replace: carol2 is removed');
  ok(inner.minApprovalDelta === 0 && inner.minRemovalDelta === 0, 'multisig_replace: the numbers do not change');
  ok(hex(inner.signerPublicKey.bytes) === await keyHex('bob'), 'multisig_replace: the multisig account is bob');
  ok(t.cosignatures.length === 2 && hex(t.cosignatures[0].signerPublicKey.bytes) === await keyHex('carol1') && hex(t.cosignatures[1].signerPublicKey.bytes) === await keyHex('carol3'), 'multisig_replace: carol1 approves, carol3 (new) consents');
  ok(hex(t.signerPublicKey.bytes) === wallet.publicKey.toString() && facade.verifyTransaction(t, t.signature) && asked.length === 1, 'multisig_replace: alice initiates and signs once');
  ok(logs.some((l) => l.startsWith('log: carol3 key:')), 'multisig_replace: carol3 key is shown');
  ok(!logs.some((l) => l.startsWith('log: carol2 key:')), 'multisig_replace: carol2 is not needed to sign');
}
await sample('multisig_shrink');
{
  const t = tx(putPayload(lastPut()));
  const inner = t.transactions[0];
  ok(t.transactions.length === 1 && inner.type.value === models.TransactionType.MULTISIG_ACCOUNT_MODIFICATION.value, 'multisig_shrink: one multisig modification', requests);
  ok(inner.addressAdditions.length === 0 && inner.addressDeletions.length === 1 && hex(inner.addressDeletions[0].bytes) === await addrHex('carol3'), 'multisig_shrink: carol3 is removed, nothing is added');
  ok(inner.minApprovalDelta === 0 && inner.minRemovalDelta === 0, 'multisig_shrink: the numbers do not change');
  ok(hex(inner.signerPublicKey.bytes) === await keyHex('bob'), 'multisig_shrink: the multisig account is bob');
  ok(t.cosignatures.length === 1 && hex(t.cosignatures[0].signerPublicKey.bytes) === await keyHex('carol1'), 'multisig_shrink: only carol1 cosigns (the removed carol3 does not)');
  ok(facade.verifyTransaction(t, t.signature) && asked.length === 1, 'multisig_shrink: alice signs once');
}

// --- 監視 ---
await sample('listener');
await sleep(20);
{
  const ws = FakeWebSocket.last!;
  ok(ws.url === 'wss://node.example:3001/ws', 'listener: wss endpoint', ws.url);
  ok(logs.includes('log: connected. uid: UID1') && String(await run('uid')) === 'UID1', 'listener: uid is kept');
}
await sample('listen_tx');
{
  const ws = FakeWebSocket.last!;
  const addr = String(await run('alice.address.toString()'));
  const subs = ws.sent.map((s) => (JSON.parse(s) as { uid: string; subscribe: string }));
  ok(subs.length === 2 && subs.every((s) => s.uid === 'UID1'), 'listen_tx: two subscriptions with the uid');
  ok(subs[0].subscribe === `confirmedAdded/${addr}` && subs[1].subscribe === `unconfirmedAdded/${addr}`, 'listen_tx: channels', subs);
  logs.length = 0;
  ws.onmessage!({ data: JSON.stringify({ topic: `confirmedAdded/${addr}`, data: { meta: { hash: 'H' } } }) });
  ok(logs.some((l) => l.startsWith('log: confirmed added')), 'listen_tx: a confirmed transaction is printed', logs.join('|'));
}
await sample('listen_block');
{
  const ws = FakeWebSocket.last!;
  logs.length = 0;
  ws.onmessage!({ data: JSON.stringify({ topic: 'block', data: { block: { height: '5' } } }) });
  ok(JSON.parse(ws.sent.slice(-1)[0]).subscribe === 'block' && logs.some((l) => l.startsWith('log: block')), 'listen_block: subscribes and prints', logs.join('|'));
}
await sample('listen_partial');
ok(JSON.parse(FakeWebSocket.last!.sent.slice(-1)[0]).subscribe.startsWith('partialAdded/'), 'listen_partial: partialAdded channel');
await run('listener.close()');
ok(FakeWebSocket.last!.closed && String(await run('uid')) === '', 'listener: close() ends the connection');

// --- 制限 ---
await sample('restrict_address');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.ACCOUNT_ADDRESS_RESTRICTION.value && t.restrictionAdditions.length === 1, 'restrict_address: one address added');
  ok(t.restrictionFlags.value === 0x8001 && asked.length === 0, 'restrict_address: BlockIncomingAddress, signed by carol (no dialog)', t.restrictionFlags.value);
  ok(logs.some((l) => l.includes('amount=10')), 'restrict_address: faucet URL for carol');
}
await sample('restrict_mosaic');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.ACCOUNT_MOSAIC_RESTRICTION.value && t.restrictionFlags.value === 0x8002, 'restrict_mosaic: BlockMosaic');
  ok(t.restrictionAdditions[0].value === 0x72C0212E67A08BCEn, 'restrict_mosaic: testnet XYM id', t.restrictionAdditions[0]?.value);
}
await sample('restrict_op');
{
  const t = tx(JSON.parse(lastPut().body!).payload);
  ok(t.type.value === models.TransactionType.ACCOUNT_OPERATION_RESTRICTION.value && t.restrictionFlags.value === 0x4004, 'restrict_op: AllowOutgoingTransactionType', t.restrictionFlags.value);
  ok(t.restrictionAdditions.length === 1 && t.restrictionAdditions[0].value === models.TransactionType.ACCOUNT_OPERATION_RESTRICTION.value, 'restrict_op: only the restriction type is allowed');
}
await sample('restrict_info');
ok(requests[0].url.startsWith('/restrictions/account/') && logs.length === 1, 'restrict_info: fetches carol restrictions', logs.join('|'));

// --- 全体制限 ---
await sample('restrict_global');
{
  const t = tx(putPayload(lastPut()));
  const types = t.transactions.map((x) => x.type.value);
  ok(lastPut()?.url === '/transactions' && JSON.stringify(types) === JSON.stringify([models.TransactionType.MOSAIC_DEFINITION.value, models.TransactionType.MOSAIC_SUPPLY_CHANGE.value, models.TransactionType.MOSAIC_GLOBAL_RESTRICTION.value]), 'restrict_global: definition, supply, global restriction', types);
  const def = t.transactions[0] as unknown as { id: { value: bigint }; flags: { value: number } };
  const g = t.transactions[2] as unknown as { mosaicId: { value: bigint }; referenceMosaicId: { value: bigint }; restrictionKey: bigint; previousRestrictionValue: bigint; newRestrictionValue: bigint; previousRestrictionType: { value: number }; newRestrictionType: { value: number } };
  ok((def.flags.value & 4) === 4, 'restrict_global: the mosaic is restrictable', def.flags.value);
  ok(def.id.value === (await run('restrictableMosaicId')), 'restrict_global: the mosaic id is the generated one');
  ok(g.mosaicId.value === def.id.value && g.referenceMosaicId.value === 0n, 'restrict_global: restricts the new mosaic itself');
  ok(g.restrictionKey === KYC_KEY && g.previousRestrictionValue === 0n && g.newRestrictionValue === 1n, 'restrict_global: key KYC, 0 -> 1', g.restrictionKey);
  ok(g.previousRestrictionType.value === 0 && g.newRestrictionType.value === 1, 'restrict_global: NONE -> EQ');
  ok(hex(t.signerPublicKey.bytes) === wallet.publicKey.toString() && facade.verifyTransaction(t, t.signature) && asked.length === 1 && t.cosignatures.length === 0, 'restrict_global: alice signs once, no cosigners');
  ok(logs.some((l) => l.startsWith('log: mosaicId: ')), 'restrict_global: prints the mosaic id');
}
await sample('restrict_global_address');
{
  const t = tx(putPayload(lastPut())) as unknown as { type: { value: number }; mosaicId: { value: bigint }; restrictionKey: bigint; previousRestrictionValue: bigint; newRestrictionValue: bigint; targetAddress: { bytes: Uint8Array }; signerPublicKey: { bytes: Uint8Array } };
  ok(t.type.value === models.TransactionType.MOSAIC_ADDRESS_RESTRICTION.value, 'restrict_global_address: a mosaic address restriction', t.type.value);
  ok(t.mosaicId.value === (await run('restrictableMosaicId')) && t.restrictionKey === KYC_KEY, 'restrict_global_address: the same mosaic and key as the global restriction');
  ok(t.previousRestrictionValue === 0xFFFFFFFFFFFFFFFFn && t.newRestrictionValue === 1n, 'restrict_global_address: no previous value -> 1');
  ok(hex(t.targetAddress.bytes) === await addrHex('alice'), 'restrict_global_address: the target is alice');
  ok(hex(t.signerPublicKey.bytes) === wallet.publicKey.toString() && asked.length === 1, 'restrict_global_address: alice (the creator) signs once');
}
await sample('restrict_global_info');
{
  const urls = requests.map((r) => r.url);
  ok(urls.length === 2 && urls[0].startsWith('/restrictions/mosaic?') && urls[0].includes('entryType=1') && urls[1].includes('entryType=0') && urls[1].includes('targetAddress='), 'restrict_global_info: global rule, then the value for alice', urls);
  const mosaicHex = ((await run('restrictableMosaicId')) as bigint).toString(16).toUpperCase();
  ok(urls.every((u) => u.includes('mosaicId=' + mosaicHex)), 'restrict_global_info: asks about the new mosaic');
  ok(logs.includes(`log: key: ${KYC_KEY} type: 1 value: 1`) && logs.includes(`log: key: ${KYC_KEY} value: 1`), 'restrict_global_info: prints the rule and the value', logs.join('|'));
  ok(logs.includes(`log: KYC のキー: ${KYC_KEY}`), 'restrict_global_info: prints the KYC key');
}

// --- オフライン署名 ---
await sample('offline_sign');
const signedPayload = String(await run('signedPayload'));
ok(/^[0-9A-F]+$/.test(signedPayload) && logs.includes(`log: ${signedPayload}`), 'offline_sign: prints the signed payload');
ok(requests.length === 0 && asked.length === 1, 'offline_sign: nothing is announced');
await sample('offline_restore');
ok(logs.some((l) => l === 'log: true') && logs.filter((l) => l === 'log: true').length === 2 && logs.includes('log: 2'), 'offline_restore: signature ok, 2 inner txs, same hash', logs.join('|'));
await sample('offline_cosign');
ok(logs.length === 2 && /^log: [0-9A-F]{128}$/.test(logs[0]), 'offline_cosign: signature and public key', logs.join('|'));
await sample('offline_announce');
{
  const t = tx(putPayload(lastPut()));
  ok(t.cosignatures.length === 1 && hex(t.cosignatures[0].signerPublicKey.bytes) === String(await run('bob.publicKey.toString()')), 'offline_announce: bob\'s cosignature is added');
  ok(facade.verifyTransaction(t, t.signature), 'offline_announce: alice\'s signature is still valid');
}

// --- 検証 ---
// 検証するトランザクションは、直前の「オフライン署名」の jsonPayload（alice が署名したアグリゲート。連署なし）
{
  const payloadNow = String(await run('JSON.parse(jsonPayload).payload'));
  const t = tx(payloadNow);
  state.txHash = facade.hashTransaction(t).toString();
  state.sibling = hex(sha3_256(new TextEncoder().encode('sibling')));
  state.root = sha3(unhex(state.txHash), unhex(state.sibling)); // 葉が左、兄弟が右
}
await sample('verify_payload');
{
  const t = tx(String(await run('payload')));
  ok(logs[0] === `log: ${state.txHash}` && logs.includes('log: true'), 'verify_payload: hash and signature', logs.join('|').slice(0, 200));
  ok(hex(t.signerPublicKey.bytes) === wallet.publicKey.toString(), 'verify_payload: signer is alice');
}
// ブロック 100（normal）のヘッダー。ハッシュは、ここで独立に計算する。
{
  const f = (n: number, b: number) => hex(new Uint8Array(n).fill(b));
  const roots = Array.from({ length: 9 }, (_, i) => f(32, 0x10 + i));
  const stateHash = sha3(...roots.map(unhex));
  state.prevHash = f(32, 0x77);
  const b = {
    signature: f(64, 1), signerPublicKey: f(32, 2), version: 1, network: 0x98, type: 33091, height: '100', timestamp: '123456', difficulty: '10000000000000',
    proofGamma: f(32, 3), proofVerificationHash: f(16, 4), proofScalar: f(32, 5), transactionsHash: state.root, receiptsHash: f(32, 6), stateHash,
    beneficiaryAddress: f(24, 7), feeMultiplier: 100,
  };
  const head = sha3(unhex(b.signature), unhex(b.signerPublicKey), utils.intToBytes(b.version, 1), utils.intToBytes(b.network, 1), utils.intToBytes(b.type, 2),
    utils.intToBytes(BigInt(b.height), 8), utils.intToBytes(BigInt(b.timestamp), 8), utils.intToBytes(BigInt(b.difficulty), 8),
    unhex(b.proofGamma), unhex(b.proofVerificationHash), unhex(b.proofScalar), unhex(state.prevHash), unhex(b.transactionsHash), unhex(b.receiptsHash), unhex(b.stateHash),
    unhex(b.beneficiaryAddress), utils.intToBytes(b.feeMultiplier, 4));
  state.blockJson = { block: b, meta: { hash: head, stateHashSubCacheMerkleRoots: roots } };
}
await sample('verify_merkle');
ok(String(await run('merkleComponentHash')) === state.txHash && Number(await run('height')) === 100, 'verify_merkle: no cosignature, so the leaf is the transaction hash', logs.join('|'));
ok(logs[logs.length - 1] === 'log: true', 'verify_merkle: the merkle proof holds', logs.join('|'));
ok(proveMerkle !== undefined, 'proveMerkle exported');
await sample('verify_block');
ok(logs.length === 2 && logs[0] === 'log: true' && logs[1] === 'log: true', 'verify_block: block hash and stateHash', logs.join('|'));

// アカウント情報の検証: 葉だけの木（枝なし）で、ルート = 葉のハッシュ
{
  const info = {
    version: 1, address: unhex(wallet.publicKey.toString()).length ? hex(facade.network.publicKeyToAddress(wallet.publicKey).bytes) : '', addressHeight: '5',
    publicKey: wallet.publicKey.toString(), publicKeyHeight: '6', accountType: 0, importance: '0', importanceHeight: '0', activityBuckets: [],
    supplementalPublicKeys: {}, mosaics: [{ id: '72C0212E67A08BCE', amount: '12345678' }],
  };
  state.accountInfo = info;
  const le = (v: bigint | number, n: number) => utils.intToBytes(v, n);
  const bytes = cat(le(info.version, 2), unhex(info.address), le(BigInt(info.addressHeight), 8), unhex(info.publicKey), le(BigInt(info.publicKeyHeight), 8),
    le(info.accountType, 1), le(0, 1), le(0, 1), le(0, 1), le(1, 2), le(BigInt('0x' + info.mosaics[0].id), 8), le(BigInt(info.mosaics[0].amount), 8));
  const stateHash = sha3(bytes);
  const pathHash = sha3(facade.network.publicKeyToAddress(wallet.publicKey).bytes);
  const encodedPath = '20' + pathHash.slice(0, 2);
  state.stateLeafRoot = sha3(unhex(encodedPath + stateHash));
  state.stateTree = { tree: [{ type: 255, path: pathHash, encodedPath, nibbleCount: 64 }] };
}
await sample('verify_account');
ok(logs.includes('log: root: true') && logs.includes('log: path: true'), 'verify_account: root and path match', logs.join('|'));

// --- メタデータの検証（モザイク・ネームスペース） ---
// 2 件（モザイク用とネームスペース用）を、1 つの枝と 2 つの葉の木に入れる。ルート = 枝のハッシュ
{
  const le = (v: bigint | number, n: number) => utils.intToBytes(v, n);
  const src = facade.network.publicKeyToAddress(wallet.publicKey).bytes;
  const make = (type: number, keyHexStr: string, targetIdHex: string, value: string) => {
    const valueBytes = new TextEncoder().encode(value);
    const keyB = le(BigInt('0x' + keyHexStr), 8);
    const idB = le(BigInt('0x' + targetIdHex), 8);
    const composite = sha3(src, src, keyB, idB, le(type, 1));
    const stateHash = sha3(le(1, 2), src, src, keyB, idB, le(type, 1), le(valueBytes.length, 2), valueBytes);
    const pathHash = sha3(unhex(composite));
    const entry = { metadataEntry: { version: 1, compositeHash: composite, sourceAddress: hex(src), targetAddress: hex(src), scopedMetadataKey: keyHexStr, targetId: targetIdHex, metadataType: type, valueSize: valueBytes.length, value: hex(valueBytes) } };
    return { entry, composite, stateHash, pathHash };
  };
  const a = make(1, '8A1B2C3D4E5F6071', '1122334455667788', 'mosaic-value');
  const b = make(2, '9A1B2C3D4E5F6071', 'A1B2C3D4E5F60718', 'namespace-value');
  const leafOf = (x: { stateHash: string }) => sha3(unhex('20ab' + x.stateHash));
  ok(a.pathHash[0] !== b.pathHash[0], 'verify_metadata (test setup): the two paths start with different nibbles');
  const links = Array(16).fill('00'.repeat(32));
  for (const x of [a, b]) links[parseInt(x.pathHash[0], 16)] = leafOf(x);
  const branchEncoded = '00';
  meta.root = sha3(unhex(branchEncoded + links.join('')));
  const branchLinks = [a, b].map((x) => ({ bit: x.pathHash[0], link: leafOf(x) }));
  for (const x of [a, b]) {
    meta.trees[x.composite] = { tree: [
      { type: 0, path: '', encodedPath: branchEncoded, nibbleCount: 0, links: branchLinks },
      { type: 255, path: x.pathHash.slice(1), encodedPath: '20ab', nibbleCount: 63 },
    ] };
  }
  meta.entries = [a.entry, b.entry];
  await sample('verify_metadata');
  ok(requests[0].url.startsWith('/blocks?') && requests.some((r) => r.url.includes('/metadata?') && r.url.includes('metadataType=1')) && requests.some((r) => r.url.includes('metadataType=2')), 'verify_metadata: reads the latest block, then mosaic and namespace metadata', requests.map((r) => r.url));
  ok(logs.includes('log: モザイクのメタデータ: 1件') && logs.includes('log: ネームスペースのメタデータ: 1件'), 'verify_metadata: counts per kind', logs.join('|'));
  ok(logs.filter((l) => l === 'log: compositeHash: true').length === 2, 'verify_metadata: the composite hashes match the node\'s', logs.join('|'));
  ok(logs.includes('log: key: 8A1B2C3D4E5F6071 root: true path: true') && logs.includes('log: key: 9A1B2C3D4E5F6071 root: true path: true'), 'verify_metadata: both proofs hold', logs.join('|'));
  ok(requests.filter((r) => /\/metadata\/[0-9A-F]+\/merkle$/.test(r.url)).length === 2, 'verify_metadata: one merkle request per entry');
  ok(asked.length === 0 && requests.every((r) => r.method === 'GET'), 'verify_metadata: read only, no dialog');

  // ノードが返すメタデータの値が書き換えられていたら、合わない
  const forged = JSON.parse(JSON.stringify(a.entry)) as { metadataEntry: { value: string } };
  forged.metadataEntry.value = hex(new TextEncoder().encode('mosaic-VALUE'));
  meta.entries = [forged, b.entry];
  await sample('verify_metadata');
  ok(logs.includes('log: key: 8A1B2C3D4E5F6071 root: false path: false'), 'verify_metadata: a forged value is caught (root and path false)', logs.join('|'));
  ok(logs.includes('log: key: 9A1B2C3D4E5F6071 root: true path: true'), 'verify_metadata: the other entry still holds');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
env.dispose();
process.exit(fails === 0 ? 0 : 1);
