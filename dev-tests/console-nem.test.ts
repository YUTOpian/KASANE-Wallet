// コンソールの NEM 版（lib/console/env.ts の chain: 'nem' と、samples.ts の NEM サンプル）。通信なし（fetch は偽物）。
// 実行: npx tsx dev-tests/console-nem.test.ts
import { PrivateKey, PublicKey, Signature } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import { SymbolFacade, descriptors } from 'symbol-sdk/symbol';
import { parse } from 'acorn';
import { createConsoleEnv } from '../src/lib/console/env';
import type { SignRequest } from '../src/lib/console/env';
import { isIncomplete } from '../src/lib/console/repl';
import { NEM_CONSOLE_SAMPLES, CONSOLE_SAMPLES, SYMBOL_ONLY_SAMPLE_IDS, consoleSamplesFor } from '../src/lib/console/samples';
import { decryptNemBytes, encryptNemBytes } from '../src/lib/nem/message';
import { nemAddressFromPublicKey, signNemData, verifyNemSignature } from '../src/lib/nem/crypto';
import { readNemTransfer } from '../src/lib/nem/offline';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

(globalThis as unknown as { window: unknown }).window = globalThis;

// ウォレットの鍵（テストネット）。秘密鍵はダイアログ側（ここでは onSign）だけが持つ。
const PRIVATE = 'A'.repeat(63) + '1';
const PUBLIC = new KeyPair(new PrivateKey(PRIVATE)).publicKey.toString().toUpperCase();
const NETWORK_BYTE = 0x98;

// 偽の NIS1
const requests: { url: string; method: string; body?: string }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
  let body: unknown = {};
  if (url.includes('/node/info')) body = { identity: { name: 'fake' }, endpoint: { host: 'x' } };
  else if (url.includes('/account/get')) body = { account: { balance: 12345678, address: 'x' } };
  else if (url.includes('/account/mosaic/owned')) body = { data: [{ quantity: 150, mosaicId: { namespaceId: 'mytest', name: 'mymosaic' } }] };
  else if (url.includes('/namespace/mosaic/definition/page')) body = { data: [{ meta: { id: 1 }, mosaic: { id: { namespaceId: 'mytest', name: 'other' }, properties: [{ name: 'divisibility', value: '0' }] } }, { meta: { id: 2 }, mosaic: { id: { namespaceId: 'mytest', name: 'mymosaic' }, properties: [{ name: 'divisibility', value: '2' }] } }] };
  else if (url.includes('/transaction/announce')) body = { code: 1, type: 1, message: 'SUCCESS', transactionHash: { data: 'ab' } };
  else if (url.includes('/transaction/get')) body = { error: 'Not Found' };
  else if (url.includes('/account/unconfirmedTransactions')) body = { data: [] };
  return { json: async () => body } as unknown as Response;
};

const asked: SignRequest[] = [];
const logs: string[] = [];
const onSign = async (req: SignRequest): Promise<Uint8Array | null> => {
  asked.push(req);
  const other = req.otherPublicKey ?? '';
  if (req.kind === 'encrypt') return encryptNemBytes(PRIVATE, other, req.data);
  if (req.kind === 'decrypt') return decryptNemBytes(PRIVATE, other, req.data);
  const sig = Uint8Array.from((signNemData(PRIVATE, req.data).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
  if (!verifyNemSignature(PUBLIC, req.data, sig)) throw new Error('bad signature');
  return sig;
};
const env = createConsoleEnv({
  chain: 'nem', networkByte: NETWORK_BYTE, nodeUrl: 'https://nis.example:7891', signer: { publicKey: PUBLIC },
  onLog: (kind, text) => logs.push(`${kind}: ${text}`), onClear: () => undefined, onSign,
});
async function run(code: string): Promise<unknown> { return (await env.interpreter.run(code)).value; }

// --- 変数 ---
ok(await run('typeof sdkNem.NemFacade') === 'function', 'sdkNem has NemFacade');
ok(await run('typeof sdkSymbol') === 'undefined', 'sdkSymbol is not defined on NEM');
ok(await run('identifier') === 'testnet', 'identifier is testnet');
ok(await run('NODE') === 'https://nis.example:7891', 'NODE');
ok(await run('wallet.address.toString()') === nemAddressFromPublicKey(PUBLIC, NETWORK_BYTE), 'wallet.address is the NEM address of the wallet key');
ok(await run('wallet.publicKey.toString()') === PUBLIC, 'wallet.publicKey');
ok(await run('typeof wallet.cosignTransaction') === 'undefined', 'no cosign on NEM');
ok(await run('alice === wallet') === true, 'alice is the wallet account (same object as wallet)');
ok(await run('alice.publicKey.toString()') === PUBLIC, 'alice.publicKey');
await run('alice = sdkNem.NemFacade ? 5 : 6');
ok(await run('alice') === 5 && await run('typeof wallet.address') === 'object', 'assigning alice leaves wallet alone');
await run('alice = wallet');
ok(await run('typeof wallet.keyPair.privateKey') === 'undefined', 'no private key on wallet.keyPair');

// --- サンプルは構文として完結していて、const なし・wallet・sdkNem ---
ok(consoleSamplesFor('nem') === NEM_CONSOLE_SAMPLES && consoleSamplesFor('symbol') === CONSOLE_SAMPLES, 'consoleSamplesFor');
for (const s of NEM_CONSOLE_SAMPLES) {
  try { parse(s.code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }); ok(!isIncomplete(s.code), `nem sample ${s.id} is complete`); }
  catch (e) { ok(false, `nem sample ${s.id} does not parse`, (e as Error).message); }
  ok(!/^\s*(const|let)\s/m.test(s.code), `nem sample ${s.id} has no const / let`);
  ok(!/walletKeyPair|sdkSymbol|SymbolFacade/.test(s.code), `nem sample ${s.id} is NEM only`);
}
for (const s of CONSOLE_SAMPLES) {
  if (SYMBOL_ONLY_SAMPLE_IDS.includes(s.id)) ok(!NEM_CONSOLE_SAMPLES.some((n) => n.id === s.id), `nem does not have the Symbol-only sample ${s.id}`);
  else ok(NEM_CONSOLE_SAMPLES.some((n) => n.id === s.id), `nem has the Symbol sample ${s.id}`);
}
ok(new Set(NEM_CONSOLE_SAMPLES.map((s) => s.id)).size === NEM_CONSOLE_SAMPLES.length, 'nem sample ids are unique');

// --- サンプルを順に実行する ---
async function sample(id: string): Promise<void> {
  const s = NEM_CONSOLE_SAMPLES.find((x) => x.id === id)!;
  logs.length = 0;
  try { await env.interpreter.run(s.code); } catch (e) { ok(false, `sample ${id} threw`, e instanceof Error ? `${e.name}: ${e.message}` : String(e)); }
  console.log(`--- ${id}`); for (const l of logs) console.log('  ', l.length > 150 ? `${l.slice(0, 150)}…` : l);
}

await sample('node');
ok(logs.some((l) => l.includes('fake')), 'node info printed');

await sample('account');
ok(logs.length === 4 && logs[0] === `log: ${nemAddressFromPublicKey(PUBLIC, NETWORK_BYTE)}` && logs[1] === `log: ${PUBLIC}`, 'account: wallet address / key, then bob');
ok(/^log: T[A-Z2-7]{39}$/.test(logs[2]) && /^log: [0-9A-F]{64}$/.test(logs[3]), 'account: bob is a fresh testnet account');

await sample('accountinfo');
ok(logs.includes('log: 12.345678 XEM'), 'accountinfo: XEM balance with 6 decimals', logs.join('|'));
ok(logs.includes('log: mytest:mymosaic = 1.50'), 'accountinfo: mosaic with divisibility 2', logs.join('|'));

await sample('keys');
ok(logs.length === 2 && logs[1] === 'log: true', 'keys: sign and verify', logs.join('|'));
ok(asked.length === 0, 'keys: no confirmation for bob\'s own key');

await sample('crypt');
ok(asked.length === 1 && asked[0].kind === 'encrypt', 'crypt: wallet encrypt asks once');
ok(logs.includes('log: Hello NEM!'), 'crypt: bob decrypts what wallet encrypted', logs.join('|'));
asked.length = 0;

await sample('tx_create');
ok(logs.length >= 2, 'tx_create prints bob and the tx');
const feeValue = await run('tx.fee.value');
ok(feeValue === 100000n, 'tx_create: fee is 0.1 XEM (1 unit for the amount + 1 for the message)', String(feeValue));
ok(await run('tx.signerPublicKey.toString()') === PUBLIC, 'tx_create: signed by wallet');

await sample('tx_announce');
ok(asked.length === 1 && asked[0].kind === 'transaction' && asked[0].payloadHex !== undefined, 'tx_announce: asks to sign once, with the payload');
const body = requests.find((r) => r.url.endsWith('/transaction/announce'));
ok(body?.method === 'POST', 'tx_announce: POST /transaction/announce');
const parsed = JSON.parse(body?.body ?? '{}') as { data?: string; signature?: string };
ok(typeof parsed.data === 'string' && typeof parsed.signature === 'string' && parsed.signature.length === 128, 'tx_announce: body has data and a 128-digit signature');
ok(parsed.signature !== '0'.repeat(128), 'tx_announce: signed');
if (parsed.data) {
  const read = readNemTransfer(parsed.data);
  ok(read.signerPublicKey === PUBLIC && read.networkByte === NETWORK_BYTE, 'tx_announce: payload is the tx of wallet on testnet');
  ok(read.transfer?.mosaics[0].quantity === 1000000n && read.transfer.message?.text === 'Hello, NEM!', 'tx_announce: 1 XEM with the plain message', JSON.stringify(read.transfer, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  ok(asked[0].payloadHex === parsed.data.toUpperCase(), 'tx_announce: the dialog is shown exactly what is announced (what is signed)');
}
ok(logs.some((l) => l.includes('code')), 'tx_announce: result printed');
asked.length = 0;

await sample('tx_status');
ok(logs.some((l) => l.startsWith('error: not exist tx')), 'tx_status: unknown tx is reported', logs.join('|'));
ok(logs.some((l) => l.includes('/transaction/get?hash=')), 'tx_status: clog prints the node URL');

await sample('ns_fee');
ok(logs.includes('log: rootNsRentalFee:100000000') && logs.includes('log: childNsRentalFee:10000000') && logs.includes('log: mosaicRentalFee:10000000'), 'ns_fee: 100 / 10 / 10 XEM', logs.join('|'));

await sample('namespace');
ok(asked.length === 1 && asked[0].kind === 'transaction', 'namespace: asks to sign once');
ok(((await run('tx.fee.value')) as bigint) === 150000n, 'namespace: fee is 0.15 XEM', String(await run('tx.fee.value')));
const nsRes = requests.filter((r) => r.url.endsWith('/transaction/announce')).pop();
ok(nsRes !== undefined && readNemTransfer((JSON.parse(nsRes.body ?? '{}') as { data: string }).data).typeValue === 0x2001, 'namespace: a namespace registration (0x2001) was announced');
asked.length = 0;

await sample('mosaic');
ok(asked.length === 1, 'mosaic: asks to sign once');
ok(((await run('tx.fee.value')) as bigint) === 150000n, 'mosaic: fee is 0.15 XEM', String(await run('tx.fee.value')));
const mRes = requests.filter((r) => r.url.endsWith('/transaction/announce')).pop();
ok(mRes !== undefined && readNemTransfer((JSON.parse(mRes.body ?? '{}') as { data: string }).data).typeValue === 0x4001, 'mosaic: a mosaic definition (0x4001) was announced');
asked.length = 0;

await sample('mosaic_supply');
ok(asked.length === 1, 'mosaic_supply: asks to sign once');
const sRes = requests.filter((r) => r.url.endsWith('/transaction/announce')).pop();
ok(sRes !== undefined && readNemTransfer((JSON.parse(sRes.body ?? '{}') as { data: string }).data).typeValue === 0x4002, 'mosaic_supply: a supply change (0x4002) was announced');
ok(logs.some((l) => l.includes('code')), 'mosaic_supply: result printed');
asked.length = 0;

// --- ウォレットの鍵を直接使う書き方も、確認を挟む（facade.signTransaction(walletKeyPair, tx)）---
await run('tx2 = facade.createTransactionFromTypedDescriptor(new sdkNem.descriptors.TransferTransactionV1Descriptor(bob.address, new sdkNem.models.Amount(1n)), wallet.publicKey, 50000n, 3600)');
await run('s2 = facade.signTransaction(walletKeyPair, tx2)');
ok(asked.length === 1 && asked[0].kind === 'transaction', 'facade.signTransaction(walletKeyPair, tx) asks too');
asked.length = 0;
// 自分で作った鍵は確認なし
await run('s3 = bob.signTransaction(tx2)');
ok(asked.length === 0, 'own key signs without asking');

// --- new NemFacade(...) でも確認つき ---
await run('f2 = new sdkNem.NemFacade("testnet")');
await run('s4 = f2.signTransaction(walletKeyPair, tx2)');
ok(asked.length === 1, 'new NemFacade() is also mediated');
asked.length = 0;

// --- 読み取り専用 ---
let blocked = '';
try { await run('sdkNem.NemFacade = 1'); } catch (e) { blocked = String(e); }
ok(blocked !== '' || (await run('typeof sdkNem.NemFacade')) === 'function', 'sdkNem is read-only');

// --- 暗号化の往復（別の鍵で）---
const other = new KeyPair(PrivateKey.random());
const cipher = encryptNemBytes(PRIVATE, other.publicKey.toString(), new TextEncoder().encode('abc'));
ok(hex(decryptNemBytes(other.privateKey.toString(), PUBLIC, cipher) ?? new Uint8Array()) === hex(new TextEncoder().encode('abc')), 'encryptNemBytes / decryptNemBytes round trip');
ok(decryptNemBytes(PRIVATE, PUBLIC, new Uint8Array(10)) === null, 'garbage does not decrypt');

// --- Symbol の環境は今までどおり（NEM 対応で壊していない）---
{
  const symAsked: SignRequest[] = [];
  const sym = createConsoleEnv({
    networkByte: 0x98, nodeUrl: 'https://sym.example:3001', signer: { publicKey: PUBLIC },
    onLog: () => undefined, onClear: () => undefined, onSign: async (req) => { symAsked.push(req); return new Uint8Array(64).fill(7); },
  });
  const rs = async (code: string) => (await sym.interpreter.run(code)).value;
  ok(await rs('typeof sdkSymbol.SymbolFacade') === 'function' && await rs('typeof sdkNem') === 'undefined', 'symbol env: sdkSymbol only');
  ok(await rs('typeof wallet.cosignTransaction') === 'function', 'symbol env: wallet has cosign');
  await rs('b = facade.createAccount(sdkCore.PrivateKey.random()); t = facade.createTransactionFromTypedDescriptor(new sdkSymbol.descriptors.TransferTransactionV1Descriptor(b.address, [], "\\0hi"), wallet.publicKey, 100, 3600)');
  await rs('s = wallet.signTransaction(t)');
  ok(symAsked.length === 1 && symAsked[0].kind === 'transaction' && typeof symAsked[0].payloadHex === 'string' && symAsked[0].payloadHex.length > 200, 'symbol env: the dialog gets the whole transaction as payloadHex');
  sym.dispose();
}

// --- 通信先の制限（lib/console/netPolicy.ts）と、データ署名の読み直し（lib/console/dataSignGuard.ts）---
{
  const sent: { url: string; init?: RequestInit }[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => { sent.push({ url: String(input), init }); return { json: async () => ({}) } as unknown as Response; };
  const asked2: SignRequest[] = [];
  const mk = (nodeUrl: string) => createConsoleEnv({
    networkByte: 0x98, nodeUrl, signer: { publicKey: PUBLIC },
    onLog: () => undefined, onClear: () => undefined, onSign: async (req) => { asked2.push(req); return new Uint8Array(64).fill(9); },
  });
  const sym = mk('https://sym.example:3001');
  const runIn = async (e: ReturnType<typeof mk>, code: string): Promise<string> => {
    try { await e.interpreter.run(code); return '(no error)'; } catch (x) { return x instanceof Error ? `${x.name}: ${x.message}` : String(x); }
  };

  // fetch / WebSocket
  ok(await runIn(sym, 'await fetch("https://sym.example:3001/node/info")') === '(no error)', 'fetch to a public host goes through');
  ok(sent.at(-1)?.init?.credentials === 'omit' && sent.at(-1)?.init?.redirect === 'error' && sent.at(-1)?.init?.referrerPolicy === 'no-referrer', 'fetch sends no cookies, follows no redirects, sends no referrer');
  const before = sent.length;
  for (const u of ['http://127.0.0.1:3000/', 'http://localhost/', 'http://192.168.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://router/', 'http://nas.local/']) {
    const r = await runIn(sym, `await fetch(${JSON.stringify(u)})`);
    ok(r.includes('blocked'), `fetch to ${u} is blocked`, r);
  }
  ok(sent.length === before, 'blocked requests never reach fetch');
  ok((await runIn(sym, 'new WebSocket("ws://127.0.0.1:3000/ws")')).includes('blocked'), 'WebSocket to localhost is blocked');
  ok((await runIn(sym, 'await fetch("ftp://example.com/")')).includes('only'), 'fetch rejects a non-http scheme');
  sym.dispose();
  // 自分のノードが LAN にあるときは、そのホストだけ通る
  const lan = mk('http://192.168.1.20:3000');
  ok(await runIn(lan, 'await fetch("http://192.168.1.20:3000/node/info")') === '(no error)', 'own LAN node is allowed');
  ok((await runIn(lan, 'await fetch("http://192.168.1.21:3000/")')).includes('blocked'), 'another LAN host is still blocked');
  lan.dispose();

  // 設定で制限なしにしたとき（limitNetwork が false を返す）。切り替えは、環境を作り直さなくても効く
  {
    let limit = true;
    const sw = createConsoleEnv({
      networkByte: 0x98, nodeUrl: 'https://sym.example:3001', signer: { publicKey: PUBLIC },
      onLog: () => undefined, onClear: () => undefined, onSign: async () => new Uint8Array(64), limitNetwork: () => limit,
    });
    ok((await runIn(sw, 'await fetch("http://192.168.0.1/")')).includes('blocked'), 'switch on: LAN is blocked');
    limit = false;
    const n = sent.length;
    ok(await runIn(sw, 'await fetch("http://192.168.0.1/")') === '(no error)' && sent.length === n + 1, 'switch off: LAN is allowed, right away');
    ok(sent.at(-1)?.init?.credentials === 'omit' && sent.at(-1)?.init?.referrerPolicy === 'no-referrer' && sent.at(-1)?.init?.redirect === undefined, 'switch off: still no cookies / referrer; redirects follow the default');
    ok((await runIn(sw, 'await fetch("ftp://192.168.0.1/")')).includes('only'), 'switch off: scheme is still checked');
    limit = true;
    ok((await runIn(sw, 'await fetch("http://192.168.0.1/")')).includes('blocked'), 'switch on again: blocked again');
    sw.dispose();
  }

  // walletKeyPair.sign(bytes)
  const e2 = mk('https://sym.example:3001');
  const facade = new SymbolFacade('testnet');
  const gen = facade.network.generationHashSeed.bytes;
  const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
  // 本物のトランザクションの、署名するバイト列を取り出す
  const tx = facade.createTransactionFromTypedDescriptor(new descriptors.TransferTransactionV1Descriptor(facade.network.publicKeyToAddress(new PublicKey(PUBLIC)), [], '\0hi'), new PublicKey(PUBLIC), 100, 3600);
  let signing = new Uint8Array(0);
  facade.signTransaction({ publicKey: new PublicKey(PUBLIC), sign: (d: Uint8Array) => { signing = new Uint8Array(d); return new Signature(new Uint8Array(64)); } } as never, tx);
  ok(signing.length > 32 && hex(signing.subarray(0, 32)) === hex(gen), 'the signing bytes start with the generation hash (the guard relies on this)');
  e2.interpreter.defineGlobal('rawTx', signing);
  asked2.length = 0;
  ok(await runIn(e2, 'await walletKeyPair.sign(rawTx)') === '(no error)', 'a transaction signed as data goes through the transaction dialog');
  ok(asked2.length === 1 && asked2[0].kind === 'transaction' && asked2[0].viaRawSign === true && typeof asked2[0].payloadHex === 'string', 'it is shown as a transaction (viaRawSign), not as data', asked2[0]);
  ok(asked2[0]?.payloadHex?.length === tx.serialize().length * 2, 'the rebuilt payload is the same size as the transaction');
  // 壊れたトランザクションは断る
  const broken = signing.slice(); broken[32] = 9; // version を壊す
  e2.interpreter.defineGlobal('brokenTx', broken);
  asked2.length = 0;
  ok((await runIn(e2, 'await walletKeyPair.sign(brokenTx)')).includes('refused') && asked2.length === 0, 'unreadable transaction-shaped data is refused without asking');
  e2.interpreter.defineGlobal('stub', cat(gen, new Uint8Array(3)));
  ok((await runIn(e2, 'await walletKeyPair.sign(stub)')).includes('refused'), 'a generation hash with a short tail is refused');
  // ふつうのデータと32バイトは、これまでどおり data（32バイトは警告つき）
  asked2.length = 0;
  await runIn(e2, 'await walletKeyPair.sign(new TextEncoder().encode("hello"))');
  ok(asked2.length === 1 && asked2[0].kind === 'data' && asked2[0].looksLikeHash !== true, 'plain data is still a data request');
  await runIn(e2, 'await walletKeyPair.sign(new Uint8Array(32))');
  ok(asked2.length === 2 && asked2[1].kind === 'data' && asked2[1].looksLikeHash === true, '32 bytes is a data request flagged as a hash');
  e2.dispose();
}

env.dispose();
console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
