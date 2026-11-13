// DAO: ネームスペースの紐付け（ネットワークに触れずに確かめられる部分）。Run: npx tsx dev-tests/dao-namespace.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { KeyPair, generateNamespaceId, models } from 'symbol-sdk/symbol';
import { planLinkNamespace } from '../src/lib/dao/daoActions';
import type { Actor } from '../src/lib/dao/daoActions';
import { embMosaicAlias, embNamespaceRegistration, signDao } from '../src/lib/dao/daoTx';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';
import { addressFromPublicKey, facadeFor } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import { namespaceIdOfName } from '../src/lib/dao/daoApi';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const cfg = getNetworkConfig();
const f = facadeFor(cfg.networkByte);
const ownerKp = new KeyPair(PrivateKey.random());
const owner: Actor = { publicKey: ownerKp.publicKey.toString(), address: addressFromPublicKey(ownerKp.publicKey.toString(), cfg.networkByte) };
const daoKp = new KeyPair(PrivateKey.random());
const daoId = daoKp.publicKey.toString();
const dao = { id: daoId, address: addressFromPublicKey(daoId, cfg.networkByte), name: 'x', governanceTokenId: '0'.repeat(16), voteBoxKeys: [], voteIndex: [], admins: [owner.address], minApproval: 1 };
const self: AggregateSigner = { address: dao.address, publicKey: daoId, multisig: true, selfSufficient: true, cosignatures: 0 };
const mosaicId = '1234567890ABCDEF';

// 名前 → ID（SDK と同じ並び）
const rootId = BigInt(generateNamespaceId('mydao', 0n));
const childId = BigInt(generateNamespaceId('point', rootId));
ok(namespaceIdOfName(['mydao']) === rootId.toString(16).toUpperCase().padStart(16, '0'), 'root id');
ok(namespaceIdOfName(['mydao', 'point']) === childId.toString(16).toUpperCase().padStart(16, '0'), 'child id');

// 持っているネームスペースへ紐付けるだけ: 内側は alias 1 つ、署名者は DAO
const owned = await planLinkNamespace(owner, dao, self, mosaicId, { kind: 'owned', id: namespaceIdOfName(['mydao']) });
const sOwned = signDao(ownerKp.privateKey.toString(), owned.input, 100, 100_000n);
const tOwned = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(sOwned.payload));
const a0 = tOwned.transactions[0] as models.EmbeddedMosaicAliasTransactionV1;
ok(tOwned.transactions.length === 1 && a0.signerPublicKey.toString() === daoId, 'owned: one alias signed by the DAO');
ok(a0.aliasAction === models.AliasAction.LINK && a0.mosaicId.value === BigInt(`0x${mosaicId}`) && a0.namespaceId.value === rootId, 'owned: alias links the right pair');
ok(owned.rental === 0n && owned.spend === 0n && !sOwned.bonded, 'owned: no cost, complete');

// 新しいルート / 子: 登録 + alias が 1 つのアグリゲートで、登録した ID に紐付く
for (const [name, parent, dur, nsId] of [['mydao', null, 2880n * 365n, rootId], ['point', rootId.toString(16).toUpperCase().padStart(16, '0'), 0n, childId]] as const) {
  const reg = embNamespaceRegistration(f, daoId, name, parent, dur);
  ok(BigInt(`0x${reg.id}`) === nsId, `${name}: registration id`);
  const input = { publicKey: owner.publicKey, build: () => [reg.tx, embMosaicAlias(f, daoId, reg.id, mosaicId)], dao: self };
  const signed = signDao(ownerKp.privateKey.toString(), input, 100, 100_000n);
  const t = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signed.payload));
  const r = t.transactions[0] as models.EmbeddedNamespaceRegistrationTransactionV1;
  const a = t.transactions[1] as models.EmbeddedMosaicAliasTransactionV1;
  ok(t.transactions.length === 2 && r.signerPublicKey.toString() === daoId && a.signerPublicKey.toString() === daoId, `${name}: both signed by the DAO`);
  ok(r.registrationType === (parent === null ? models.NamespaceRegistrationType.ROOT : models.NamespaceRegistrationType.CHILD), `${name}: registration type`);
  if (parent === null) ok(r.duration?.value === dur, 'root: duration in blocks');
  ok(a.namespaceId.value === nsId && f.verifyTransaction(t, t.signature), `${name}: alias points at the new namespace; signature verifies`);
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
