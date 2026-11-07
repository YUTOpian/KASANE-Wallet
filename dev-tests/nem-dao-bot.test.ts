// NEM 版 DAO: 自動引き渡しボットの判定、送金の読み取り（倍率）、特別会員限定のテーマ。ネットワーク不要。
// Run: npx tsx dev-tests/nem-dao-bot.test.ts
import {
  DAO_SEND_FEE_MARGIN, buildExchangeMessage, buildFulfilMessage, buildItemDescription, buildThemeMessage, canOpenLimited, parseFulfilMessage, parseThemeMessage, selectDaoItems,
} from '../src/lib/nem/daoCore';
import type { CreatedMosaicRow, DaoItemRow } from '../src/lib/nem/daoCore';
import { effectiveQuantity, toDaoMove } from '../src/lib/nem/daoMoves';
import type { DaoMove, RawMove } from '../src/lib/nem/daoMoves';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } from '../src/lib/nem/crypto';
import { nemMosaicTransferFee, signNemMultisigWrapped } from '../src/lib/nem/tx';
import { verifyNemExchange } from '../src/server/nem-dao-bot/verify';
import type { VerifyInput } from '../src/server/nem-dao-bot/verify';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

const NET = 0x98; // testnet
const key = (n: number) => nemKeyPairFromPrivateKey(n.toString(16).padStart(64, '0'));
const dao = key(1);
const member = key(2);
const bot = key(3);
const DAO_ID = dao.publicKey;
const daoAddress = nemAddressFromPublicKey(dao.publicKey, NET);
const memberAddress = nemAddressFromPublicKey(member.publicKey, NET);

// --- 倍率 ---
ok(effectiveQuantity(30n, 1_000_000n) === 30n, 'multiplier x1 keeps the quantity');
ok(effectiveQuantity(30n, 0n) === 0n, 'multiplier x0 moves nothing');
ok(effectiveQuantity(30n, 2_000_000n) === 60n, 'multiplier x2 doubles it');

// --- ノードの送金の読み取り ---
const raw = (p: { amount?: number; quantity?: number; message?: string; signer?: string; to?: string; hash?: string; timeStamp?: number }): RawMove => ({
  meta: { id: 1, hash: { data: p.hash ?? 'AB'.repeat(32).toLowerCase() } },
  transaction: {
    type: 257, signer: p.signer ?? member.publicKey, version: (NET << 24) | 2, timeStamp: p.timeStamp ?? 1000, amount: p.amount ?? 1_000_000,
    recipient: p.to ?? daoAddress,
    message: p.message === undefined ? undefined : { type: 1, payload: hex(p.message) },
    mosaics: [{ quantity: p.quantity ?? 30, mosaicId: { namespaceId: 'abc.cafe', name: 'point' } }],
  },
});
const m1 = toDaoMove(raw({ message: 'hello' }), NET);
ok(m1 !== null && m1.mosaics.get('abc.cafe:point') === 30n, 'reads the mosaic quantity', m1);
ok(m1?.from === memberAddress && m1?.to === daoAddress && m1?.message === 'hello', 'reads from / to / message');
ok(m1?.hash === 'AB'.repeat(32), 'hash is upper case');
ok(m1?.timeMs === (1427587585 + 1000) * 1000, 'time follows the NEM epoch');
const zero = toDaoMove(raw({ amount: 0 }), NET);
ok(zero?.mosaics.get('abc.cafe:point') === 0n, 'a transfer with multiplier 0 pays nothing, whatever the quantity says');
const wrapped: RawMove = { meta: { id: 2 }, transaction: { type: 4100, signer: bot.publicKey, otherTrans: raw({ signer: dao.publicKey, to: memberAddress, message: 'x' }).transaction } };
ok(toDaoMove(wrapped, NET)?.from === daoAddress, 'a multisig wrapper is read as the inner transfer, signed by the DAO');
ok(toDaoMove({ meta: {}, transaction: { type: 2049, signer: member.publicKey } }, NET) === null, 'non-transfer is skipped');

// --- ポイント・特典の選び方 ---
const itemDesc = (kind: 'point' | 'reward', extra: object = {}) => buildItemDescription({ dao: DAO_ID, kind, name: kind, ...extra } as never);
const created: CreatedMosaicRow[] = [
  { id: 'abc:gov', description: 'KASANE-DAO:{"v":1,"name":"x"}', transferable: true },
  { id: 'abc.cafe:point', description: itemDesc('point'), transferable: false },
  { id: 'abc.cafe:reward', description: itemDesc('reward', { point: 'abc.cafe:point', cost: '30', description: '' }), transferable: false },
  { id: 'abc.cafe:cheat', description: itemDesc('reward', { point: 'abc.cafe:point', cost: '1', description: '' }), transferable: true }, // 転送可は読まない
  { id: 'abc:reward', description: itemDesc('reward', { point: 'abc.cafe:point', cost: '1', description: '' }), transferable: false }, // 子の下ではない
  { id: 'abc.cafe:orphan', description: itemDesc('reward', { point: 'abc.nowhere:point', cost: '1', description: '' }), transferable: false }, // ポイントが無い
];
const items = selectDaoItems(created, DAO_ID, daoAddress, 'abc');
ok(items.length === 2 && items.some((i) => i.id === 'abc.cafe:point') && items.some((i) => i.id === 'abc.cafe:reward'), 'only real items are read', items.map((i) => i.id));
ok(items.every((i) => i.creator === daoAddress), 'creator is the DAO account');
ok(selectDaoItems(created, 'F'.repeat(64), daoAddress, 'abc').length === 0, 'items of another DAO are not read');

// --- ボットの判定 ---
const NOW = Date.UTC(2026, 10, 4);
const HASH = 'CD'.repeat(32);
const move = (o: Partial<DaoMove> = {}): DaoMove => ({
  hash: HASH, from: memberAddress, to: daoAddress, message: buildExchangeMessage('abc.cafe:reward', 2n), mosaics: new Map([['abc.cafe:point', 60n]]), timeMs: NOW - 3_600_000, ...o,
});
const base = (o: Partial<VerifyInput> = {}): VerifyInput => ({
  move: move(), daoAddress, items: items as DaoItemRow[], fulfilled: new Set(), maxQuantity: null, maxAgeMs: 24 * 3_600_000, nowMs: NOW, rewardStock: 100n, daoXem: 5_000_000n, ...o,
});
const v = (o: Partial<VerifyInput> = {}) => verifyNemExchange(base(o));
const reason = (o: Partial<VerifyInput> = {}) => { const r = v(o); return r.ok ? 'ok' : r.reason; };

const good = v();
ok(good.ok && good.member === memberAddress && good.rewardId === 'abc.cafe:reward' && good.quantity === 2n && good.paid === 60n, 'a proper request is accepted', good);
ok(reason({ move: move({ to: memberAddress }) }) === 'not_to_dao', 'not addressed to the DAO');
ok(reason({ move: move({ from: daoAddress }) }) === 'from_dao', 'the DAO\'s own transfer is not a request');
ok(reason({ move: move({ hash: '' }) }) === 'no_hash', 'no hash');
ok(reason({ move: move({ message: 'hi' }) }) === 'not_exchange', 'not an exchange message');
ok(reason({ move: move({ message: buildExchangeMessage('abc.cafe:reward', 0n) }) }) === 'not_exchange', 'zero quantity is not a request');
ok(reason({ fulfilled: new Set([HASH]) }) === 'already_fulfilled', 'already fulfilled (confirmed or pending)');
ok(reason({ move: move({ timeMs: NOW - 25 * 3_600_000 }) }) === 'too_old', 'older than the age limit');
ok(reason({ move: move({ timeMs: null }) }) === 'no_time', 'time unknown with an age limit');
ok(reason({ maxAgeMs: null, move: move({ timeMs: null }) }) === 'ok', 'no age limit: time does not matter');
ok(reason({ move: move({ message: buildExchangeMessage('abc.cafe:nothing', 1n) }) }) === 'not_reward', 'unknown reward');
ok(reason({ move: move({ message: buildExchangeMessage('abc.cafe:point', 1n) }) }) === 'not_reward', 'a point is not a reward');
ok(reason({ move: move({ mosaics: new Map([['abc.cafe:point', 59n]]) }) }) === 'paid_short', 'paid too little');
ok(reason({ move: move({ mosaics: new Map([['abc.cafe:point', 61n]]) }) }) === 'paid_over', 'paid too much: left to an admin');
ok(reason({ move: move({ mosaics: new Map([['abc.cafe:point', 0n]]) }) }) === 'paid_short', 'multiplier 0 transfer (paid nothing)');
ok(reason({ move: move({ mosaics: new Map() }) }) === 'unexpected_mosaics', 'no mosaic attached');
ok(reason({ move: move({ mosaics: new Map([['abc.cafe:point', 60n], ['nem:xem', 1n]]) }) }) === 'unexpected_mosaics', 'extra mosaic attached');
ok(reason({ move: move({ mosaics: new Map([['other:point', 60n]]) }) }) === 'unexpected_mosaics', 'paid in the wrong mosaic');
ok(reason({ maxQuantity: 1n }) === 'over_max_quantity', 'over the quantity limit');
ok(reason({ maxQuantity: 2n }) === 'ok', 'at the quantity limit');
const stock = v({ rewardStock: 1n });
ok(!stock.ok && stock.reason === 'reward_stock_short' && stock.retry, 'short of stock: try again later');
const xem = v({ daoXem: DAO_SEND_FEE_MARGIN - 1n });
ok(!xem.ok && xem.reason === 'dao_xem_short' && xem.retry, 'short of XEM: try again later');
const old = v({ move: move({ timeMs: NOW - 25 * 3_600_000 }) });
ok(!old.ok && !old.retry, 'a refusal on the request itself is final');

// --- ボットが出す取引（管理者の fulfilExchange と同じ形） ---
const message = buildFulfilMessage(HASH);
ok(parseFulfilMessage(message) === HASH, 'the reply message points at the request');
const mosaics = [{ id: 'abc.cafe:reward', quantity: 2n }];
const fee = nemMosaicTransferFee(NET, mosaics, { 'abc.cafe:reward': { supply: 1000n, divisibility: 0 } }, message);
ok(fee > 0n && fee < DAO_SEND_FEE_MARGIN * 4n, 'fee is computed, in the same order as the margin', fee);
const payload = signNemMultisigWrapped(bot.privateKey, bot.publicKey, NET, DAO_ID, { kind: 'mosaicTransfer', recipient: memberAddress, mosaics, message, fee });
const body = JSON.parse(payload) as { data?: string; signature?: string };
ok(typeof body.data === 'string' && typeof body.signature === 'string' && body.data.length > 100, 'a signed multisig payload comes out');
ok(body.data!.toLowerCase().includes(bot.publicKey.toLowerCase()) && body.data!.toLowerCase().includes(dao.publicKey.toLowerCase()), 'signed by the bot, in the name of the DAO');

// --- 特別会員限定 ---
ok(parseThemeMessage(buildThemeMessage('pink')) === 'pink', 'theme round trip');
ok(parseThemeMessage(buildThemeMessage('Pink!')) === null, 'a theme name with odd characters is not read');
ok(parseThemeMessage('KASANE-DAO-THEME:{') === null && parseThemeMessage(null) === null && parseThemeMessage('hello') === null, 'broken / missing theme messages');
ok(canOpenLimited(true, []), 'admins can always open');
ok(!canOpenLimited(false, []) && !canOpenLimited(false, [0n, null]), 'no reward held: closed');
ok(canOpenLimited(false, [0n, 1n]) && canOpenLimited(false, [null, 5n]), 'one reward held: open (even if another could not be read)');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
