// DAO「ポイント交換」の自動連署ボット: 連署してよい申請の判定（ネットワークに触れない）。
// 本物の申請と同じ作り方（daoTx の embRevoke / embTransfer）でアグリゲートを作り、ノードの JSON の形にして判定にかける。
// 実行: npx tsx dev-tests/dao-bot.test.ts
import { PrivateKey } from 'symbol-sdk';
import { Address, KeyPair, SymbolFacade, models } from 'symbol-sdk/symbol';
import { MOSAIC_META } from '../src/lib/dao/daoCore';
import { embAccountMetadata, embRevoke, embTransfer } from '../src/lib/dao/daoTx';
import type { Embedded } from '../src/lib/dao/daoTx';
import { addressFromPublicKey, bytesToHex, facadeFor } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import type { RestEmbedded, RestPartialAggregate } from '../src/lib/symbol/partialPayload';
import { EXCHANGE_KEYS, verifyExchangeRequest } from '../src/server/dao-bot/verify';
import type { BotContext, ExchangeTerms } from '../src/server/dao-bot/verify';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const cfg = getNetworkConfig();
const net = cfg.networkByte;
const facade = facadeFor(net);
const kp = () => new KeyPair(PrivateKey.random());
const pub = (k: KeyPair) => k.publicKey.toString().toUpperCase();
const addr = (publicKey: string) => addressFromPublicKey(publicKey, net);
const addrHex = (publicKey: string) => bytesToHex(new Address(addr(publicKey)).bytes).toUpperCase();

const daoKey = kp();
const member = kp();
const other = kp();
const DAO = pub(daoKey);
const POINT = '5E4F3A2B1C0D9E8F';
const REWARD = '4B3C2D1E0F9A8B7C';
const COST = 30n;

// --- 設定の鍵が、ウォレット本体の鍵と同じであること（食い違うと、ボットは何にも連署しない/誤って連署する） ---
ok(EXCHANGE_KEYS.exchangeable === MOSAIC_META.exchangeable, 'key: exchangeable matches daoCore');
ok(EXCHANGE_KEYS.pointMosaicId === MOSAIC_META.pointMosaicId, 'key: pointMosaicId matches daoCore');
ok(EXCHANGE_KEYS.exchangeCost === MOSAIC_META.exchangeCost, 'key: exchangeCost matches daoCore');

interface Inner { tx: Embedded; rest: RestEmbedded }
const restBase = { version: 1, network: net };
const revokeInner = (signer: string, source: string, mosaicId: string, amount: bigint): Inner => ({
  tx: embRevoke(facade, signer, addr(source), mosaicId, amount),
  rest: { ...restBase, type: 0x434d, signerPublicKey: signer, sourceAddress: addrHex(source), mosaic: { id: mosaicId, amount: amount.toString() } } as RestEmbedded,
});
const transferInner = (signer: string, to: string, mosaicId: string, amount: bigint, message?: string): Inner => ({
  tx: embTransfer(facade, signer, addr(to), mosaicId, amount, message),
  rest: {
    ...restBase, type: 0x4154, signerPublicKey: signer, recipientAddress: addrHex(to), mosaics: [{ id: mosaicId, amount: amount.toString() }],
    ...(message ? { message: '00' + bytesToHex(new TextEncoder().encode(message)).toUpperCase() } : {}),
  } as RestEmbedded,
});
const metadataInner = (): Inner => ({
  tx: embAccountMetadata(facade, DAO, addr(DAO), 7n, new TextEncoder().encode('token')),
  rest: { ...restBase, type: 0x4144, signerPublicKey: DAO, targetAddress: addrHex(DAO), scopedMetadataKey: '0000000000000007', valueSizeDelta: 5, value: bytesToHex(new TextEncoder().encode('token')).toUpperCase() } as RestEmbedded,
});

function aggregate(inners: Inner[], initiator: KeyPair) {
  const embedded = inners.map((i) => i.tx);
  const transactionsHash = SymbolFacade.hashEmbeddedTransactions(embedded);
  const tx = facade.transactionFactory.create({
    type: 'aggregate_bonded_transaction_v3', signerPublicKey: initiator.publicKey, fee: 0n, deadline: 987654321000n, transactionsHash, transactions: embedded,
  });
  tx.fee = new models.Amount(BigInt(tx.size + 104) * 100n);
  tx.signature = new models.Signature(facade.signTransaction(initiator, tx).bytes);
  const hash = facade.hashTransaction(tx).toString().toUpperCase();
  const json: RestPartialAggregate = {
    meta: { hash },
    transaction: {
      signature: bytesToHex(tx.signature.bytes).toUpperCase(), signerPublicKey: pub(initiator), version: 3, network: net, type: 0x4241,
      maxFee: tx.fee.value.toString(), deadline: '987654321000', transactionsHash: transactionsHash.toString().toUpperCase(),
      transactions: inners.map((i) => ({ transaction: i.rest })),
    },
  };
  return { hash, json };
}

const request = (qty: bigint, over: { initiator?: KeyPair; points?: bigint; pointId?: string; to?: string; message?: string } = {}) =>
  aggregate([
    revokeInner(DAO, pub(member), over.pointId ?? POINT, over.points ?? qty * COST),
    transferInner(DAO, over.to ?? pub(member), REWARD, qty, over.message),
  ], over.initiator ?? member);

function ctxWith(opts: { terms?: ExchangeTerms | null; memberPoints?: bigint; stock?: bigint; max?: bigint | null } = {}): BotContext {
  const balances = new Map<string, bigint>([
    [`${addr(pub(member))}:${POINT}`, opts.memberPoints ?? 1000n],
    [`${addr(DAO)}:${REWARD}`, opts.stock ?? 50n],
  ]);
  return {
    networkByte: net, daoPublicKey: DAO, maxQuantity: opts.max ?? null,
    exchangeTerms: async (id) => (id === REWARD ? (opts.terms === undefined ? { pointMosaicId: POINT, cost: COST } : opts.terms) : null),
    balance: async (a, m) => balances.get(`${a}:${m}`) ?? 0n,
  };
}

async function expectNo(label: string, run: () => Promise<Awaited<ReturnType<typeof verifyExchangeRequest>>>, reason: string, retry = false) {
  const v = await run();
  ok(!v.ok && v.reason.startsWith(reason) && v.retry === retry, `${label}: refused (${reason})`, v);
}

// --- 本物の申請は通る ---
{
  const { hash, json } = request(3n);
  const v = await verifyExchangeRequest(json, hash, ctxWith());
  ok(v.ok, 'valid exchange request is approved', v);
  if (v.ok) ok(v.quantity === 3n && v.points === 90n && v.rewardMosaicId === REWARD, 'verdict carries quantity / points / reward');
}

// --- 連署してはいけないもの ---
{
  const { hash, json } = request(3n, { points: 3n * COST + 1n });
  await expectNo('one point too many', () => verifyExchangeRequest(json, hash, ctxWith()), 'wrong_points_amount');
}
{
  const { hash, json } = request(3n, { points: 1n });
  await expectNo('one point instead of cost × quantity', () => verifyExchangeRequest(json, hash, ctxWith()), 'wrong_points_amount');
}
{
  const { hash, json } = request(3n, { pointId: '1111111111111111', points: 90n });
  await expectNo('different point mosaic', () => verifyExchangeRequest(json, hash, ctxWith()), 'wrong_point_mosaic');
}
{
  const { hash, json } = request(3n, { initiator: other });
  await expectNo("someone else's points revoked", () => verifyExchangeRequest(json, hash, ctxWith()), 'requester_mismatch');
}
{
  const { hash, json } = request(3n, { to: pub(other) });
  await expectNo('reward sent to another account', () => verifyExchangeRequest(json, hash, ctxWith()), 'requester_mismatch');
}
{
  const { hash, json } = request(3n);
  await expectNo('not an exchange item', () => verifyExchangeRequest(json, hash, ctxWith({ terms: null })), 'not_exchange_item');
}
{
  const { hash, json } = request(3n, { message: 'hi' });
  await expectNo('transfer with a message', () => verifyExchangeRequest(json, hash, ctxWith()), 'has_message');
}
{
  const { hash, json } = aggregate([revokeInner(DAO, pub(member), POINT, 90n), transferInner(DAO, pub(member), REWARD, 3n), metadataInner()], member);
  await expectNo('extra inner transaction (3 items)', () => verifyExchangeRequest(json, hash, ctxWith()), 'not_exchange_shape');
}
{
  const { hash, json } = aggregate([metadataInner()], member);
  await expectNo("an admin's own aggregate (DAO settings)", () => verifyExchangeRequest(json, hash, ctxWith()), 'not_exchange_shape');
}
{
  const { hash, json } = aggregate([revokeInner(pub(other), pub(member), POINT, 90n), transferInner(pub(other), pub(member), REWARD, 3n)], member);
  await expectNo('inner signer is not the DAO', () => verifyExchangeRequest(json, hash, ctxWith()), 'signer_not_dao');
}
{
  const { hash, json } = request(3n);
  json.transaction.type = 0x4141; // complete aggregate
  await expectNo('not a bonded aggregate', () => verifyExchangeRequest(json, hash, ctxWith()), 'not_bonded');
}
{
  // ノードの JSON が、ハッシュと食い違う（申請の数量を書き換えた）。
  const { hash, json } = request(3n);
  json.transaction.transactions![1].transaction.mosaics![0].amount = '4';
  await expectNo('JSON does not match the hash', () => verifyExchangeRequest(json, hash, ctxWith()), 'hash_mismatch');
}
{
  const { json } = request(3n);
  await expectNo('hash the node did not report', () => verifyExchangeRequest(json, 'AB'.repeat(32), ctxWith()), 'hash_mismatch');
}
{
  const { hash, json } = request(3n);
  await expectNo('over the per-request limit', () => verifyExchangeRequest(json, hash, ctxWith({ max: 2n })), 'over_max_quantity');
  ok((await verifyExchangeRequest(json, hash, ctxWith({ max: 3n }))).ok, 'at the limit is fine');
}

// --- 足りないときは、いまは連署しない（あとで足りれば連署する = retry） ---
{
  const { hash, json } = request(3n);
  await expectNo('member has too few points', () => verifyExchangeRequest(json, hash, ctxWith({ memberPoints: 89n })), 'member_points_short', true);
  await expectNo('reward out of stock', () => verifyExchangeRequest(json, hash, ctxWith({ stock: 2n })), 'reward_stock_short', true);
  ok((await verifyExchangeRequest(json, hash, ctxWith({ memberPoints: 90n, stock: 3n }))).ok, 'exactly enough is fine');
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails > 0) process.exit(1);
