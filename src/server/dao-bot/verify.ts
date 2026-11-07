// 自動連署ボットの「連署してよいか」の判定（ネットワークに触れない部分）。
//
// ボットが連署してよいのは、`planRequestExchange`（src/lib/dao/daoActions.ts）が作る形の「ポイント交換の申請」だけ。
// 次の条件を、すべて満たしたときだけ ok にする。1つでも外れたら連署しない（管理者が手動で連署する従来のやり方に任せる）。
//
//   ① ノードの JSON から組み立て直したアグリゲートのハッシュが、ノードが言うハッシュと一致する（読み違い・すり替えの防止）
//   ② 内側がちょうど 2 件: [DAO がポイントを回収] → [DAO が特典を送る]。どちらも署名者は DAO
//   ③ 申請を出した人（アグリゲートの署名者）= ポイントを回収される人 = 特典を受け取る人（他人のポイントを勝手に回収させない）
//   ④ 特典はチェーン上で「交換アイテム」になっている（DAO 自身が付けたメタデータ）。回収するポイントの ID と量が、
//      その設定（pointMosaicId × exchangeCost × 数量）とぴったり一致する
//   ⑤ 受け取る特典は 1 種類・1 件以上。メッセージなし。宛先はネームスペース別名ではなくアドレス
//   ⑥ 申請者がポイントを足りるだけ持っていて、DAO が特典の在庫を足りるだけ持っている（足りなければ、いまは連署しない）
//   ⑦ （任意）1 回の申請の数量の上限
import { Address } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex } from '../../lib/symbol/crypto';
import { generateMetadataKey } from '../../lib/symbol/metadata';
import { PartialRebuildError, rebuildPartialPayload } from '../../lib/symbol/partialPayload';
import type { RestEmbedded, RestPartialAggregate } from '../../lib/symbol/partialPayload';

const TX_AGGREGATE_BONDED = 0x4241;
const TX_TRANSFER = 0x4154;
const TX_SUPPLY_REVOCATION = 0x434d;

/** 交換アイテムのモザイクメタデータのキー（src/lib/dao/daoCore.ts の MOSAIC_META と同じ値。dev-tests/dao-bot.test.ts で一致を確かめる）。 */
export const EXCHANGE_KEYS = {
  exchangeable: generateMetadataKey('exchangeable'),
  pointMosaicId: generateMetadataKey('pointMosaicId'),
  exchangeCost: generateMetadataKey('exchangeCost'),
} as const;

/** チェーン上の交換アイテムの設定。 */
export interface ExchangeTerms {
  pointMosaicId: string; // 16 hex
  cost: bigint;
}

export interface BotContext {
  networkByte: number;
  /** DAO アカウントの公開鍵。 */
  daoPublicKey: string;
  /** 1 回の申請で連署する数量の上限（null = 制限なし）。 */
  maxQuantity: bigint | null;
  /** 特典モザイクの交換アイテム設定（DAO 自身が付けたメタデータ）。交換アイテムでなければ null。 */
  exchangeTerms(rewardMosaicId: string): Promise<ExchangeTerms | null>;
  /** アカウントの、あるモザイクの保有量。 */
  balance(address: string, mosaicId: string): Promise<bigint>;
}

export type Verdict =
  | { ok: true; hash: string; member: string; rewardMosaicId: string; quantity: bigint; points: bigint }
  /** retry = true: 条件しだいで後から連署してよくなる（ポイントや在庫が足りない）。false: このアグリゲートは連署しない。 */
  | { ok: false; reason: string; retry: boolean };

const no = (reason: string, retry = false): Verdict => ({ ok: false, reason, retry });

const addressHex = (publicKey: string, networkByte: number): string => bytesToHex(new Address(addressFromPublicKey(publicKey, networkByte)).bytes).toUpperCase();
const hexToAddress = (hex: string): string => new Address(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))).toString();

/** 連署してよい申請か調べる。 */
export async function verifyExchangeRequest(raw: RestPartialAggregate, hash: string, ctx: BotContext): Promise<Verdict> {
  const agg = raw.transaction;
  if (!agg) return no('bad_json');
  if (agg.type !== undefined && agg.type !== TX_AGGREGATE_BONDED) return no('not_bonded');
  const inner: RestEmbedded[] = (agg.transactions ?? []).map((e) => e.transaction);
  // ② 2 件だけ（先に形を見て、無関係な署名待ち — 設定変更など — は、組み立て直す前に外す）。
  if (inner.length !== 2) return no('not_exchange_shape');
  const [revoke, transfer] = inner;
  if (revoke.type !== TX_SUPPLY_REVOCATION || transfer.type !== TX_TRANSFER) return no('not_exchange_shape');
  const dao = ctx.daoPublicKey.toUpperCase();
  if (revoke.signerPublicKey?.toUpperCase() !== dao || transfer.signerPublicKey?.toUpperCase() !== dao) return no('signer_not_dao');

  // ① ハッシュまで一致する形に組み立て直せること（中身がノードの言うものと同じであることの検算）。
  try {
    rebuildPartialPayload(raw, ctx.networkByte, hash);
  } catch (e) {
    return no(e instanceof PartialRebuildError ? e.message : 'rebuild_failed');
  }

  // ③ 申請者 = 回収される人 = 受け取る人。
  const requester = addressHex(agg.signerPublicKey, ctx.networkByte);
  const source = (revoke.sourceAddress ?? '').toUpperCase();
  const recipient = (transfer.recipientAddress ?? '').toUpperCase();
  if (!/^[0-9A-F]{48}$/.test(source) || !/^[0-9A-F]{48}$/.test(recipient)) return no('bad_address');
  if (parseInt(source.slice(0, 2), 16) & 1 || parseInt(recipient.slice(0, 2), 16) & 1) return no('namespace_alias_address'); // ⑤
  if (source !== requester || recipient !== requester) return no('requester_mismatch');
  if (requester === addressHex(dao, ctx.networkByte)) return no('requester_is_dao');

  // ⑤ 特典は 1 種類・メッセージなし。
  const rewards = transfer.mosaics ?? [];
  if (rewards.length !== 1) return no('reward_count');
  if ((transfer.message ?? '') !== '') return no('has_message');
  const rewardId = rewards[0].id.toUpperCase();
  let quantity: bigint;
  let points: bigint;
  let pointId: string;
  try {
    quantity = BigInt(rewards[0].amount);
    const m = revoke.mosaic;
    pointId = String(m?.id ?? m?.mosaicId ?? revoke.mosaicId ?? '').toUpperCase();
    points = BigInt(m?.amount ?? revoke.amount ?? '');
  } catch {
    return no('bad_amount');
  }
  if (quantity <= 0n) return no('quantity_zero');
  // ⑦ 上限。
  if (ctx.maxQuantity !== null && quantity > ctx.maxQuantity) return no('over_max_quantity');

  // ④ チェーン上の交換アイテムの設定と一致すること。
  const terms = await ctx.exchangeTerms(rewardId);
  if (!terms) return no('not_exchange_item');
  if (pointId !== terms.pointMosaicId.toUpperCase()) return no('wrong_point_mosaic');
  if (terms.cost <= 0n || points !== quantity * terms.cost) return no('wrong_points_amount');

  // ⑥ 残高。足りないのは、あとで足りるようになるかもしれないので retry。
  const member = hexToAddress(requester);
  if ((await ctx.balance(member, pointId)) < points) return no('member_points_short', true);
  if ((await ctx.balance(addressFromPublicKey(dao, ctx.networkByte), rewardId)) < quantity) return no('reward_stock_short', true);

  return { ok: true, hash: hash.toUpperCase(), member, rewardMosaicId: rewardId, quantity, points };
}
