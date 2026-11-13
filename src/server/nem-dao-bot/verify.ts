// NEM 版 DAO の自動引き渡しボット: 「特典を渡してよいか」の判定（ネットワークに触れない）。
//
// Symbol 版のボットは、会員の申請（1 つのアグリゲート）に「連署」するだけだった。NIS1 にアグリゲートは無く、交換は 2 段階
// （会員がポイントを DAO アカウントへ送る → 管理者が DAO の名前で特典を送る）なので、NEM 版のボットは「渡す側」を自動でやる:
// DAO の連署者として、届いた申請を見て、条件を満たすものだけ、DAO の名前で特典を送る（`fulfilExchange` と同じ取引）。
//
// 渡してよいのは、次をすべて満たす申請だけ。1 つでも外れたら何もしない（管理者が手動で渡す従来のやり方に任せる）。
//   ① DAO アカウント宛ての送金で、DAO 自身からのものではない（確定済み）
//   ② 申請メッセージ（KASANE-DAO-EXCHANGE）が読める
//   ③ まだ渡していない（DAO の名前で出た送金・保留中の取引に、その申請のハッシュへの返事が無い）
//   ④ 新しい申請（既定は 24 時間以内。昔の申請を、起動した途端にまとめて渡さないため）
//   ⑤ 特典は、チェーン上でこの DAO のものとして読めるもの（DAO 自身が作った・転送不可・DAO のネームスペースの下）
//   ⑥ 払われたのはその特典のポイントだけで、量が「個数 × 1 個あたり」とぴったり一致する（多くても少なくても渡さない）
//   ⑦ （任意）1 回の申請の個数の上限
//   ⑧ DAO が特典の在庫と、送信の手数料の XEM を持っている（足りなければ、いまは渡さず、次の回に見直す）
import { DAO_SEND_FEE_MARGIN, exchangeCost, parseExchangeMessage } from '../../lib/nem/daoCore';
import type { DaoItemRow } from '../../lib/nem/daoCore';
import type { DaoMove } from '../../lib/nem/daoMoves';

export interface VerifyInput {
  move: DaoMove;
  daoAddress: string;
  items: DaoItemRow[];
  /** すでに返事が出ている申請のハッシュ（確定済み + 保留中）。 */
  fulfilled: ReadonlySet<string>;
  maxQuantity: bigint | null;
  /** 申請の新しさの上限（ミリ秒）。null = 制限なし。 */
  maxAgeMs: number | null;
  nowMs: number;
  /** DAO アカウントの、その特典の保有量と XEM。 */
  rewardStock: bigint;
  daoXem: bigint;
}

export type Verdict =
  | { ok: true; hash: string; member: string; rewardId: string; quantity: bigint; paid: bigint }
  /** retry = true: あとで条件が整えば渡してよくなる（在庫・XEM 不足）。false: この申請は渡さない。 */
  | { ok: false; reason: string; retry: boolean };

const no = (reason: string, retry = false): Verdict => ({ ok: false, reason, retry });

export function verifyNemExchange(p: VerifyInput): Verdict {
  const { move } = p;
  // ① 宛先と送り主。
  if (move.to !== p.daoAddress) return no('not_to_dao');
  if (move.from === p.daoAddress) return no('from_dao');
  if (!/^[0-9A-F]{64}$/.test(move.hash)) return no('no_hash');
  // ② 申請メッセージ。
  const req = parseExchangeMessage(move.message);
  if (!req) return no('not_exchange');
  // ③ 渡し済み。
  if (p.fulfilled.has(move.hash)) return no('already_fulfilled');
  // ④ 新しさ。
  if (p.maxAgeMs !== null) {
    if (move.timeMs === null) return no('no_time');
    if (p.nowMs - move.timeMs > p.maxAgeMs) return no('too_old');
  }
  // ⑤ 特典。
  const reward = p.items.find((i) => i.kind === 'reward' && i.id === req.reward);
  if (!reward || !reward.point || !reward.cost) return no('not_reward');
  const cost = BigInt(reward.cost);
  if (cost <= 0n) return no('not_reward');
  // ⑥ 払われたポイント。
  if (move.mosaics.size !== 1 || !move.mosaics.has(reward.point)) return no('unexpected_mosaics');
  const paid = move.mosaics.get(reward.point) ?? 0n;
  const need = exchangeCost(req.quantity, cost);
  if (paid < need) return no('paid_short');
  if (paid > need) return no('paid_over');
  // ⑦ 上限。
  if (p.maxQuantity !== null && req.quantity > p.maxQuantity) return no('over_max_quantity');
  // ⑧ 在庫と手数料。
  if (p.rewardStock < req.quantity) return no('reward_stock_short', true);
  if (p.daoXem < DAO_SEND_FEE_MARGIN) return no('dao_xem_short', true);
  return { ok: true, hash: move.hash, member: move.from, rewardId: reward.id, quantity: req.quantity, paid };
}
