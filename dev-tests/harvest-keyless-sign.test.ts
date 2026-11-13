// SSS / Ledger のように「外で署名する」アカウントでハーベストの署名が通るか（通信なし）。
// 外の署名者のかわりに、同じ鍵で署名する関数を渡して、秘密鍵で直接署名した結果と同じトランザクションになることを確かめる。
// 実行: npx tsx dev-tests/harvest-keyless-sign.test.ts
import { PrivateKey } from 'symbol-sdk';
import { SymbolFacade } from 'symbol-sdk/symbol';
import { signViaExternal } from '../src/lib/symbol/sssSign';
import { encodeHarvestDelegationMessage, signHarvestDelegation, signHarvestLinks } from '../src/lib/symbol/tx';
import { signData, verifySignature, addressFromPublicKey } from '../src/lib/symbol/crypto';
import { signAggregate } from '../src/lib/symbol/aggregate';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const GEN = '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6'; // mainnet
const facade = new SymbolFacade('mainnet');
void facade;
const priv = PrivateKey.random().toString();
const { KeyPair } = await import('symbol-sdk/symbol');
const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString();
const node = new KeyPair(PrivateKey.random()).publicKey.toString();
const remote = PrivateKey.random().toString();
const vrf = PrivateKey.random().toString();
const base = { signerPublicKey: pub, networkByte: 0x68, feeMultiplier: 100, deadline: 123456789n };

let asked = 0;
const external = async (signingPayload: Uint8Array) => { asked++; return signData(priv, signingPayload); };

// 1. リンク（アグリゲート）
const links = { ...base, links: [{ kind: 'remote' as const, publicKey: remote.length ? new KeyPair(new PrivateKey(remote)).publicKey.toString() : '', link: true }, { kind: 'node' as const, publicKey: node, link: true }] };
const direct1 = signHarvestLinks(priv, GEN, links);
const via1 = await signViaExternal(external, () => signHarvestLinks('', GEN, links));
ok(direct1.payload === via1.payload && direct1.hash === via1.hash, 'link aggregate: external == direct');

// 2. 委任リクエスト（暗号文は先に1回だけ作る）
const message = encodeHarvestDelegationMessage({ nodePublicKey: node, remotePrivateKey: remote, vrfPrivateKey: vrf });
const dp = { ...base, nodePublicKey: node, remotePrivateKey: remote, vrfPrivateKey: vrf, message };
const direct2 = signHarvestDelegation(priv, GEN, dp);
const via2 = await signViaExternal(external, () => signHarvestDelegation('', GEN, dp));
ok(direct2.payload === via2.payload, 'delegation: external == direct (fixed message)');
// 暗号文を固定しないと、2回の組み立てが食い違って止まる（安全側）
let threw = false;
try { await signViaExternal(external, () => signHarvestDelegation('', GEN, { ...base, nodePublicKey: node, remotePrivateKey: remote, vrfPrivateKey: vrf })); } catch { threw = true; }
ok(threw, 'delegation without a fixed message is refused');

// 3. アグリゲート（アカウント画面の「アグリゲート」）
const owner = addressFromPublicKey(pub, 0x68);
const ap = { signerPublicKey: pub, ownerAddress: owner, networkByte: 0x68, feeMultiplier: 100, deadline: 123456789n,
  items: [{ uid: 'a', kind: 'transfer' as const, recipient: owner, mosaicId: '6BED913FA20223F8', mosaicSymbol: 'XYM', divisibility: 6, amount: 1000000n, message: 'hi' }] };
const direct4 = signAggregate(priv, GEN, ap);
const via4 = await signViaExternal(external, () => signAggregate('', GEN, ap));
ok(direct4.payload === via4.payload && direct4.hash === via4.hash, 'aggregate: external == direct');

// 4. 署名が別の鍵・別の内容なら、署名者の検算で弾かれる（signWithSss / signWithLedger の中）ことの前提: 署名がこちらの内容に対して正しい
ok(asked === 4, 'signer asked once per signature (+1 for the refused one)', asked);
ok(verifySignature(pub, new Uint8Array([1]), signData(priv, new Uint8Array([1]))), 'sanity: signature verifies');

console.log(`${checks - fails}/${checks} ok`);
if (fails > 0) process.exit(1);
