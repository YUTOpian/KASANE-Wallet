// DAO: ネームスペースの期限の判定と、DAO 署名での更新（ネットワークに触れずに確かめられる部分）。Run: npx tsx dev-tests/dao-namespace-expiry.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/symbol';
import { composeRenewNamespace } from '../src/lib/dao/daoActions';
import type { Actor } from '../src/lib/dao/daoActions';
import { linkedNamespaceStatus, namespaceRowState, sortByRootExpiry } from '../src/lib/dao/daoNamespaceExpiry';
import { signDao } from '../src/lib/dao/daoTx';
import type { OwnedNamespace } from '../src/lib/symbol/api';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { DAY_MS } from '../src/lib/symbol/namespaceRenew';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const throws = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as Error).message; } };

const NOW = Date.UTC(2026, 10, 3);
const ns = (name: string, over: Partial<OwnedNamespace> = {}): OwnedNamespace => ({
  id: name.split('.').join('').toUpperCase().padEnd(16, '0').slice(0, 16), name, depth: name.split('.').length, eternal: false, expired: false,
  expiresAtMs: NOW + 200 * DAY_MS, aliasType: 'none', alias: '', ...over,
});

// --- 紐付いている名前の状態 -------------------------------------------------------------------
const owned: OwnedNamespace[] = [
  ns('fresh'), ns('fresh.point', { depth: 2 }),
  ns('soon', { expiresAtMs: NOW + 10 * DAY_MS }), ns('soon.reward', { depth: 2, expiresAtMs: NOW + 10 * DAY_MS }),
  ns('gone', { expired: true, expiresAtMs: NOW - 5 * DAY_MS }),
  ns('forever', { eternal: true, expiresAtMs: null }),
];
const st = (name: string, list: OwnedNamespace[] | null = owned) => linkedNamespaceStatus(name, list, NOW);
ok(st('').state === 'none', 'no link → none');
ok(st('fresh.point').state === 'ok' && st('fresh.point').rootName === 'fresh', 'child of a healthy root → ok (root decides)');
ok(st('soon.reward').state === 'soon' && st('soon.reward').days === 10, 'child of an expiring root → soon with days', st('soon.reward'));
ok(st('soon').state === 'soon', 'the expiring root itself → soon');
ok(st('gone').state === 'expired' && st('gone').days === null, 'expired root → expired');
ok(st('forever').state === 'ok', 'eternal → ok');
ok(st('someoneelse.point').state === 'unknown', 'root not owned by the DAO → unknown (no warning)');
ok(st('soon', null).state === 'unknown', 'list not readable → unknown (no warning)');
ok(linkedNamespaceStatus('edge', [ns('edge', { expiresAtMs: NOW + 30 * DAY_MS })], NOW).state === 'soon', 'exactly 30 days left counts as soon');
ok(linkedNamespaceStatus('edge', [ns('edge', { expiresAtMs: NOW + 30 * DAY_MS + 1 })], NOW).state === 'ok', 'just over 30 days is ok');

// --- 一覧の印と並び --------------------------------------------------------------------------
ok(namespaceRowState(ns('a'), NOW) === 'ok' && namespaceRowState(ns('a', { expired: true }), NOW) === 'expired', 'row state ok / expired');
ok(namespaceRowState(ns('a', { expiresAtMs: NOW + DAY_MS }), NOW) === 'soon' && namespaceRowState(ns('a', { eternal: true, expiresAtMs: null }), NOW) === 'eternal', 'row state soon / eternal');
const order = sortByRootExpiry([...owned].reverse()).map((n) => n.name);
ok(order.join(',') === 'gone,soon,soon.reward,fresh,fresh.point,forever', 'expired first, then soonest; children right under their root; eternal last', order);

// --- DAO 署名での更新 ----------------------------------------------------------------------
setNetwork('testnet');
const cfg = getNetworkConfig();
const ownerKp = new KeyPair(PrivateKey.random());
const owner: Actor = { publicKey: ownerKp.publicKey.toString(), address: addressFromPublicKey(ownerKp.publicKey.toString(), cfg.networkByte) };
const daoKp = new KeyPair(PrivateKey.random());
const daoId = daoKp.publicKey.toString();
const dao = { id: daoId, address: addressFromPublicKey(daoId, cfg.networkByte), name: 'x', governanceTokenId: '0'.repeat(16), voteBoxKeys: [], voteIndex: [], admins: [owner.address], minApproval: 1 };
const self: AggregateSigner = { address: dao.address, publicKey: daoId, multisig: true, selfSufficient: true, cosignatures: 0 };
const fees = { childFee: 100_000n, rootFeePerBlock: 10n };
const sign = (plan: ReturnType<typeof composeRenewNamespace>) => {
  const signed = signDao(ownerKp.privateKey.toString(), plan.input, 100, 100_000n);
  return models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signed.payload));
};

const target = ns('mydao', { expiresAtMs: NOW + 100 * DAY_MS });
const plan = composeRenewNamespace(owner, dao, self, target, 365, fees, 0n, NOW);
ok(plan.rental === 10n * 2880n * 365n && plan.spend === 0n, 'rental = fee × blocks; nothing to top up', plan.rental);
const agg = sign(plan);
const reg = agg.transactions[0] as models.EmbeddedNamespaceRegistrationTransactionV1;
ok(agg.transactions.length === 1 && reg.signerPublicKey.toString() === daoId, 'one registration, signed by the DAO');
ok(reg.registrationType === models.NamespaceRegistrationType.ROOT && reg.duration?.value === 2880n * 365n, 'registered again as a root for the extra blocks');
ok(new TextDecoder().decode(reg.name) === 'mydao' && plan.namespaceId === target.id, 'same name');

// 足りないとき: ウォレットから DAO への入金が同じアグリゲートの先頭に入る
const topped = composeRenewNamespace(owner, dao, self, target, 30, fees, 5_000_000n, NOW);
const aggT = sign(topped);
const dep = aggT.transactions[0] as models.EmbeddedTransferTransactionV1;
ok(aggT.transactions.length === 2 && topped.spend === 5_000_000n, 'top-up first, then the registration');
ok(dep.signerPublicKey.toString() === owner.publicKey && dep.mosaics[0].amount.value === 5_000_000n, 'the wallet pays the top-up');
ok((aggT.transactions[1] as models.EmbeddedNamespaceRegistrationTransactionV1).signerPublicKey.toString() === daoId, 'the registration is still signed by the DAO');

// 期限切れでも更新できる（猶予期間のあいだ）。子・無期限・日数の範囲外・上限超えは作らない。
ok(throws(() => composeRenewNamespace(owner, dao, self, ns('gone', { expired: true, expiresAtMs: NOW - DAY_MS }), 365, fees, 0n, NOW)) === null, 'expired root can be renewed');
ok(throws(() => composeRenewNamespace(owner, dao, self, ns('mydao.point', { depth: 2 }), 365, fees, 0n, NOW)) === 'not_renewable', 'sub-namespace is refused');
ok(throws(() => composeRenewNamespace(owner, dao, self, ns('forever', { eternal: true, expiresAtMs: null }), 365, fees, 0n, NOW)) === 'not_renewable', 'eternal is refused');
ok(throws(() => composeRenewNamespace(owner, dao, self, target, 29, fees, 0n, NOW)) === 'invalid_days', 'under the shortest rental is refused');
ok(throws(() => composeRenewNamespace(owner, dao, self, target, 1826, fees, 0n, NOW)) === 'invalid_days', 'over the longest rental is refused');
ok(throws(() => composeRenewNamespace(owner, dao, self, target, 1800, fees, 0n, NOW)) === 'invalid_days', 'would pass 5 years in total → refused');
ok(throws(() => composeRenewNamespace(owner, dao, self, target, 365.5, fees, 0n, NOW)) === 'invalid_days', 'fractional days are refused');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
