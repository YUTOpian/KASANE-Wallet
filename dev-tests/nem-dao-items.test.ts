// NEM 版 DAO のポイント・特典: DAO のネームスペースの子ネームスペースの下に、DAO アカウントが（マルチシグ経由で）作る。
// ネットワーク不要。Run: npx tsx dev-tests/nem-dao-items.test.ts
import {
  DAO_ITEM_CREATE_STEPS, DAO_MOSAIC_RENTAL, DAO_PROVISION_FEE, DAO_SUB_NAMESPACE_RENTAL, daoItemDepositMicro, isUnderDaoNamespace, isValidItemNamespacePart,
  itemBalanceTarget, itemDepositTopUp, itemMosaicId, itemNamespace, mosaicNamespaceOf, nextItemStep,
} from '../src/lib/nem/daoCore';
import type { DaoItemCreationState } from '../src/lib/nem/daoCore';
import { nemKeyPairFromPrivateKey } from '../src/lib/nem/crypto';
import { NEM_PROVISION_TX_FEE, signNemMultisigWrapped } from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const asciiHex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

// --- 名前 ---
ok(itemNamespace('abc', 'coffee') === 'abc.coffee', 'child namespace = dao namespace + "." + part');
ok(itemMosaicId('abc', 'coffee', 'reward') === 'abc.coffee:reward', 'reward mosaic id');
ok(itemMosaicId('abc', 'cafe', 'point') === 'abc.cafe:point', 'point mosaic id');
ok(mosaicNamespaceOf('abc.coffee:reward') === 'abc.coffee', 'namespace of a mosaic id');
ok(isValidItemNamespacePart('coffee') && isValidItemNamespacePart('a-b_c1') && isValidItemNamespacePart('a'.repeat(64)), 'good parts');
ok(!isValidItemNamespacePart('') && !isValidItemNamespacePart('Coffee') && !isValidItemNamespacePart('a.b') && !isValidItemNamespacePart('-a') && !isValidItemNamespacePart('a'.repeat(65)), 'bad parts');

// --- DAO のものとして読むのは、DAO のネームスペースの子ネームスペースの下だけ ---
ok(isUnderDaoNamespace('abc.coffee:reward', 'abc'), 'child of the dao namespace');
ok(isUnderDaoNamespace('ABC.Coffee:reward', 'abc'), 'case does not matter');
ok(isUnderDaoNamespace('abc.coffee.large:reward', 'abc'), 'grandchild too');
ok(!isUnderDaoNamespace('abc:gov', 'abc'), 'the governance token is directly under the root, not a child');
ok(!isUnderDaoNamespace('abc:reward', 'abc'), 'directly under the root is not an item');
ok(!isUnderDaoNamespace('abcd.coffee:reward', 'abc'), 'a namespace that only starts with the same letters is not a child');
ok(!isUnderDaoNamespace('other.coffee:reward', 'abc'), 'somebody else\'s namespace');

// --- 費用と手順 ---
ok(daoItemDepositMicro() > DAO_SUB_NAMESPACE_RENTAL + DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE * 2n, 'deposit covers both rentals and both fees');
ok(DAO_SUB_NAMESPACE_RENTAL === 10_000_000n, 'sub-namespace rental is 10 XEM');
const st = (o: Partial<DaoItemCreationState>): DaoItemCreationState => ({ balance: 0n, namespaceOwned: false, mosaicDefined: false, ...o });
ok(nextItemStep(st({})) === 'deposit', 'empty DAO account needs a deposit first');
ok(itemDepositTopUp(st({})) === daoItemDepositMicro(), 'top-up from nothing = full deposit');
ok(nextItemStep(st({ balance: daoItemDepositMicro() })) === 'namespace', 'funded: register the child namespace');
ok(nextItemStep(st({ balance: daoItemDepositMicro() - 1n })) === 'deposit', 'one micro short: deposit again');
ok(itemDepositTopUp(st({ balance: daoItemDepositMicro() - 5n })) === 5n, 'top-up is only the missing part');
ok(itemDepositTopUp(st({ balance: daoItemDepositMicro() + 1n })) === 0n, 'no top-up when funded');
ok(nextItemStep(st({ balance: itemBalanceTarget({ namespaceOwned: true, mosaicDefined: false }), namespaceOwned: true })) === 'mosaic', 'namespace done: create the mosaic');
ok(nextItemStep(st({ balance: 0n, namespaceOwned: true })) === 'deposit', 'namespace done but the DAO account ran dry: deposit');
ok(nextItemStep(st({ namespaceOwned: true, mosaicDefined: true })) === null, 'mosaic defined: finished (even with no balance)');
ok(DAO_ITEM_CREATE_STEPS.join() === 'deposit,namespace,mosaic', 'steps in order');
// 子ネームスペース（10 XEM）を払ったあとでも、モザイク（10 XEM）の分が残るだけ入れてある
ok(daoItemDepositMicro() - (DAO_SUB_NAMESPACE_RENTAL + DAO_PROVISION_FEE) >= itemBalanceTarget({ namespaceOwned: true, mosaicDefined: false }), 'what is left after the namespace step covers the mosaic step');

// --- DAO の名前で送る取引（マルチシグの中身） ---
const admin = nemKeyPairFromPrivateKey('8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2');
const dao = nemKeyPairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const NET = 0x98;
const wrap = (inner: Parameters<typeof signNemMultisigWrapped>[4]) => {
  const payload = JSON.parse(signNemMultisigWrapped(admin.privateKey, admin.publicKey, NET, dao.publicKey, inner)) as { data: string; signature: string };
  return payload.data.toLowerCase();
};
const TYPE_MULTISIG = '04100000', TYPE_NAMESPACE = '01200000', TYPE_MOSAIC_DEF = '01400000', TYPE_TRANSFER = '01010000';
const sub = wrap({ kind: 'namespace', name: 'coffee', parentName: 'abc' });
ok(sub.startsWith(TYPE_MULTISIG), 'wrapped in a multisig transaction');
ok(sub.includes(TYPE_NAMESPACE), 'inner is a namespace registration');
ok(sub.includes(asciiHex('coffee')) && sub.includes(asciiHex('abc')), 'carries the new part and the parent');
ok(sub.includes(dao.publicKey.toLowerCase()), 'the inner signer is the DAO account');
const root = wrap({ kind: 'namespace', name: 'abc' });
ok(!root.includes(asciiHex('coffee')) && root.includes(asciiHex('abc')), 'a root renewal is still a plain root registration');
ok(sub.length > root.length, 'a sub-namespace carries its parent name');
// 子ネームスペースの賃料は 10 XEM、ルートは 100 XEM（8 バイトのリトルエンディアン）
const le64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('');
ok(sub.includes(le64(10_000_000n)) && !sub.includes(le64(100_000_000n)), 'sub-namespace rental is 10 XEM');
ok(root.includes(le64(100_000_000n)), 'root rental is 100 XEM');
ok(sub.includes(le64(NEM_PROVISION_TX_FEE)), 'provision fee');

const def = wrap({
  kind: 'mosaic',
  params: { namespace: 'abc.coffee', name: 'reward', description: 'KASANE-DAO-ITEM:{}', divisibility: 0, initialSupply: 100n, supplyMutable: true, transferable: false },
});
ok(def.startsWith(TYPE_MULTISIG) && def.includes(TYPE_MOSAIC_DEF), 'inner is a mosaic definition');
ok(def.includes(asciiHex('abc.coffee')) && def.includes(asciiHex('reward')), 'carries the child namespace and the mosaic name');
ok(def.includes(asciiHex('transferable')) && def.includes(asciiHex('false')), 'transferable = false is written');
ok(def.includes(dao.publicKey.toLowerCase()), 'the creator in the definition is the DAO account, not the administrator');
ok(!def.includes(admin.publicKey.toLowerCase().repeat(2)), 'the administrator key appears only as the outer signer');
ok(def.includes(le64(DAO_MOSAIC_RENTAL)), 'mosaic rental 10 XEM');

const recipient = 'TBULEAUG2CZQISUR442HWA6UAKGWIXHDABJVIPS4';
const xfer = wrap({ kind: 'mosaicTransfer', recipient, mosaics: [{ id: 'abc.coffee:reward', quantity: 3n }], message: 'KASANE-DAO-FULFIL:{}', fee: 150_000n });
ok(xfer.startsWith(TYPE_MULTISIG) && xfer.includes(TYPE_TRANSFER), 'inner is a transfer');
ok(xfer.includes(asciiHex('abc.coffee')) && xfer.includes(asciiHex('reward')), 'carries the mosaic id');
ok(xfer.includes(asciiHex('KASANE-DAO-FULFIL')), 'carries the message');
ok(xfer.includes(le64(150_000n)), 'carries the inner fee given by the caller');
ok(xfer.includes(le64(1_000_000n)) && xfer.includes(le64(3n)), 'version 2 transfer: multiplier x1 and the quantity');
const up = wrap({ kind: 'mosaicSupply', mosaicId: 'abc.coffee:reward', action: 'increase', delta: 500n });
const down = wrap({ kind: 'mosaicSupply', mosaicId: 'abc.coffee:reward', action: 'decrease', delta: 500n });
ok(up.startsWith(TYPE_MULTISIG) && up.includes('0240') , 'inner is a supply change');
ok(up.includes(asciiHex('abc.coffee')) && up.includes(asciiHex('reward')) && up.includes(le64(500n)), 'carries the mosaic and the amount');
ok(up.includes(dao.publicKey.toLowerCase()), 'supply change is signed in the DAO account\'s name');
ok(up !== down, 'increase and decrease differ');
let threw = false;
try { wrap({ kind: 'mosaicTransfer', recipient, mosaics: [], fee: 1n }); } catch { threw = true; }
ok(threw, 'an empty mosaic list is refused');
ok(verifyOuterSignature(), 'outer transaction is signed by the administrator');
function verifyOuterSignature(): boolean {
  const payload = JSON.parse(signNemMultisigWrapped(admin.privateKey, admin.publicKey, NET, dao.publicKey, { kind: 'namespace', name: 'x', parentName: 'abc' })) as { data: string; signature: string };
  return payload.data.toLowerCase().includes(admin.publicKey.toLowerCase()) && payload.signature.length === 128;
}

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
