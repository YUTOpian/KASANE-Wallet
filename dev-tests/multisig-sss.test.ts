// マルチシグの送金・設定変更を SSS Extension で署名しても、秘密鍵で署名したものと同じになるかの確認（偽の window.SSS）。
// ネットワークには触れない。 実行: npx tsx dev-tests/multisig-sss.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { Address, KeyPair, SymbolFacade, models } from 'symbol-sdk/symbol';
import { SssError } from '../src/lib/sss';
import { addressFromPublicKey, bytesToHex, facadeFor } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setCustomNodeUrl, setNetwork } from '../src/lib/symbol/network';
import { PartialRebuildError } from '../src/lib/symbol/partialPayload';
import type { RestPartialAggregate } from '../src/lib/symbol/partialPayload';
import { cosignPartialWith, signHashLockWith, signMultisigWith } from '../src/lib/symbol/multisigApi';
import { cosignAggregateHash, signHashLock, signMultisigAggregate } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const cfg = getNetworkConfig();
const priv = '3'.repeat(64);
const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString().toUpperCase();
const multisigKey = new KeyPair(PrivateKey.random()).publicKey.toString().toUpperCase();
const newCosigner = new KeyPair(PrivateKey.random()).publicKey.toString().toUpperCase();
const recipient = addressFromPublicKey(newCosigner, cfg.networkByte);

const win: any = {};
(globalThis as any).window = win;
win.SSS = { activePublicKey: pub, activeNetworkType: cfg.networkByte, activeName: 'me' };
let asked = 0;
let received = '';
win.SSS.setTransactionByPayload = (payload: string) => { received = payload; };
win.SSS.requestSign = async () => {
  asked++;
  const tx = models.TransactionFactory.deserialize(utils.hexToUint8(received));
  const sig = facadeFor(cfg.networkByte).signTransaction(new KeyPair(new PrivateKey(priv)), tx);
  tx.signature = new models.Signature(sig.bytes);
  return { payload: bytesToHex(tx.serialize()).toUpperCase() };
};

const base = { signerPublicKey: pub, networkByte: cfg.networkByte, cosignatureCount: 2, feeMultiplier: 100, deadline: 123456789n };
const transfer = { kind: 'transfer', accountPublicKey: multisigKey, recipient, mosaics: [{ id: cfg.currencyMosaicId, amount: 1_000_000n }], message: 'hello' } as const;
const modification = { kind: 'modification', accountPublicKey: multisigKey, change: { minApprovalDelta: 1, minRemovalDelta: 1, additions: [addressFromPublicKey(newCosigner, cfg.networkByte)], deletions: [] } } as never;

for (const [name, inner] of [['transfer', transfer], ['modification', modification]] as const) {
  for (const bonded of [false, true]) {
    const params = { ...base, inner: inner as never, bonded };
    const direct = signMultisigAggregate(priv, cfg.generationHash, params);
    const before = asked;
    const viaSss = await signMultisigWith('', { kind: 'sss' }, pub, params);
    ok(asked === before + 1, `${name}/${bonded ? 'bonded' : 'complete'}: asked the extension once`);
    ok(viaSss.payload.toUpperCase() === direct.payload.toUpperCase() && viaSss.hash === direct.hash && viaSss.fee === direct.fee, `${name}/${bonded ? 'bonded' : 'complete'}: identical to the private-key signature`);
    const viaEmpty = await signMultisigWith('', undefined, pub, params);
    ok(viaEmpty.payload.toUpperCase() === direct.payload.toUpperCase(), `${name}/${bonded ? 'bonded' : 'complete'}: privateKey "" alone also means SSS`);
  }
}

// ハッシュロック
const lockParams = { signerPublicKey: pub, networkByte: cfg.networkByte, currencyMosaicId: cfg.currencyMosaicId, amount: 10_000_000n, duration: 5760n, aggregateHash: 'AB'.repeat(32), feeMultiplier: 100, deadline: 123456789n };
const lockDirect = signHashLock(priv, cfg.generationHash, lockParams);
const lockSss = await signHashLockWith('', { kind: 'sss' }, pub, lockParams);
ok(lockSss.payload.toUpperCase() === lockDirect.payload.toUpperCase() && lockSss.hash === lockDirect.hash, 'hash lock: identical to the private-key signature');

// 秘密鍵があるときは拡張を使わない。別アカウントなら署名を頼まずに止める。
const askedBefore = asked;
const withKey = await signMultisigWith(priv, undefined, pub, { ...base, inner: transfer as never, bonded: false });
ok(asked === askedBefore && withKey.payload.length > 0, 'private key: the extension is not used');
win.SSS.activePublicKey = 'CD'.repeat(32);
let kind = '';
try { await signMultisigWith('', { kind: 'sss' }, pub, { ...base, inner: transfer as never, bonded: false }); } catch (e) { kind = e instanceof SssError ? e.kind : String(e); }
ok(kind === 'account_mismatch' && asked === askedBefore, 'wrong account in the extension: refused before asking to sign', kind);

// --- 署名待ちへの連署（SSS Extension）: ノードの JSON から組み立て直して拡張に渡し、返ってきた連署を検算して送る ---
{
  setCustomNodeUrl('testnet', 'https://node.example:3001');
  const initiator = new KeyPair(PrivateKey.random());
  const facade = facadeFor(cfg.networkByte);
  const addrHex = (p: string) => bytesToHex(new Address(addressFromPublicKey(p, cfg.networkByte)).bytes).toUpperCase();
  const embedded = [facade.transactionFactory.createEmbedded({
    type: 'transfer_transaction_v1',
    signerPublicKey: multisigKey,
    recipientAddress: addressFromPublicKey(newCosigner, cfg.networkByte),
    mosaics: [{ mosaicId: 0x72C0212E67A08BCEn, amount: 2_000_000n }],
    message: new Uint8Array([0, ...new TextEncoder().encode('pay')]),
  })];
  const agg = facade.transactionFactory.create({
    type: 'aggregate_bonded_transaction_v3',
    signerPublicKey: initiator.publicKey,
    fee: 0n,
    deadline: 987654321000n,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  agg.fee = new models.Amount(BigInt(agg.size + 104) * 100n);
  agg.signature = new models.Signature(facade.signTransaction(initiator, agg).bytes);
  const aggHash = facade.hashTransaction(agg).toString().toUpperCase();
  const goodJson: RestPartialAggregate = {
    meta: { hash: aggHash },
    transaction: {
      signature: bytesToHex(agg.signature.bytes).toUpperCase(),
      signerPublicKey: initiator.publicKey.toString().toUpperCase(),
      version: 3,
      network: cfg.networkByte,
      type: 0x4241,
      maxFee: agg.fee.value.toString(),
      deadline: '987654321000',
      transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded).toString().toUpperCase(),
      transactions: [{ transaction: { version: 1, network: cfg.networkByte, type: 0x4154, signerPublicKey: multisigKey, recipientAddress: addrHex(newCosigner), mosaics: [{ id: '72C0212E67A08BCE', amount: '2000000' }], message: '00' + bytesToHex(new TextEncoder().encode('pay')).toUpperCase() } as never }],
    },
  };

  let nodeJson: unknown = goodJson;
  const puts: unknown[] = [];
  const gets: string[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const body = init?.method === 'PUT' ? (puts.push(JSON.parse(String(init.body))), { message: 'ok' }) : (gets.push(url), nodeJson);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  win.SSS.activePublicKey = pub;
  let cosignAsked = 0;
  let givenPayload = '';
  // 拡張のかわり: 受け取ったバイト列のハッシュに、本物の鍵で連署して返す（拡張もハッシュを計算して署名する）。
  let behave: (hash: string) => unknown = (hash) => ({ parentHash: hash, signature: bytesToHex(new KeyPair(new PrivateKey(priv)).sign(Uint8Array.from(hash.match(/../g)!, (h) => parseInt(h, 16))).bytes), signerPublicKey: pub });
  win.SSS.setTransactionByPayload = (payload: string) => { received = payload; givenPayload = payload; };
  win.SSS.requestSignCosignatureTransaction = async () => {
    cosignAsked++;
    const tx = models.TransactionFactory.deserialize(utils.hexToUint8(received));
    return behave(facade.hashTransaction(tx).toString().toUpperCase());
  };
  const reset = () => { puts.length = 0; gets.length = 0; cosignAsked = 0; givenPayload = ''; nodeJson = goodJson; };
  const attempt = async (): Promise<string> => {
    try { await cosignPartialWith('', { kind: 'sss' }, pub, aggHash); return 'ok'; } catch (e) { return e instanceof SssError ? `sss:${e.kind}` : e instanceof PartialRebuildError ? `rebuild:${e.kind}` : `other:${String(e)}`; }
  };

  reset();
  ok(await attempt() === 'ok', 'cosign via SSS: succeeds');
  ok(cosignAsked === 1 && gets.length === 1 && gets[0].endsWith(`/transactions/partial/${aggHash}`), 'cosign via SSS: read the partial once, asked the extension once');
  ok(givenPayload === bytesToHex(agg.serialize()).toUpperCase(), 'cosign via SSS: the extension got exactly the original aggregate bytes');
  ok(puts.length === 1 && JSON.stringify(puts[0]) === JSON.stringify(cosignAggregateHash(priv, aggHash)), 'cosign via SSS: the announced cosignature is identical to the private-key one');

  reset();
  behave = (hash) => ({ parentHash: hash, signature: bytesToHex(new KeyPair(PrivateKey.random()).sign(utils.hexToUint8(hash)).bytes), signerPublicKey: pub });
  ok(await attempt() === 'sss:signature_mismatch' && puts.length === 0, 'cosign via SSS: a signature by another key is not announced');
  behave = (hash) => ({ parentHash: 'EF'.repeat(32), signature: bytesToHex(new KeyPair(new PrivateKey(priv)).sign(utils.hexToUint8(hash)).bytes), signerPublicKey: pub });
  reset();
  ok(await attempt() === 'sss:bad_response' && puts.length === 0, 'cosign via SSS: a different parentHash is refused');
  behave = () => ({ signature: 'nothex' });
  reset();
  ok(await attempt() === 'sss:bad_response' && puts.length === 0, 'cosign via SSS: a malformed answer is refused');
  behave = () => { throw new Error('user rejected'); };
  reset();
  ok(await attempt() === 'sss:rejected' && puts.length === 0, 'cosign via SSS: a rejection is reported, nothing announced');

  // ノードの内容が組み立てと合わないときは、拡張に頼まない。
  behave = (hash) => ({ parentHash: hash, signature: bytesToHex(new KeyPair(new PrivateKey(priv)).sign(utils.hexToUint8(hash)).bytes), signerPublicKey: pub });
  reset();
  nodeJson = JSON.parse(JSON.stringify(goodJson));
  (nodeJson as RestPartialAggregate).transaction.transactions![0].transaction.mosaics![0].amount = '2000001';
  ok(await attempt() === 'rebuild:hash_mismatch' && cosignAsked === 0 && puts.length === 0, 'cosign via SSS: content that does not match the hash never reaches the extension');
  reset();
  nodeJson = JSON.parse(JSON.stringify(goodJson));
  (nodeJson as RestPartialAggregate).transaction.transactions![0].transaction.type = 0x4143;
  ok(await attempt() === 'rebuild:unsupported_type' && cosignAsked === 0 && puts.length === 0, 'cosign via SSS: an unsupported inner type is refused before asking');

  // 別のアカウントなら頼まない。
  reset();
  win.SSS.activePublicKey = 'CD'.repeat(32);
  ok(await attempt() === 'sss:account_mismatch' && cosignAsked === 0 && puts.length === 0, 'cosign via SSS: wrong account in the extension');
  win.SSS.activePublicKey = pub;

  // 秘密鍵があるときは、拡張を使わず、従来どおり。
  reset();
  await cosignPartialWith(priv, undefined, pub, aggHash);
  ok(cosignAsked === 0 && gets.length === 0 && puts.length === 1 && JSON.stringify(puts[0]) === JSON.stringify(cosignAggregateHash(priv, aggHash)), 'cosign with a private key: unchanged, no extension, no rebuild');
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
