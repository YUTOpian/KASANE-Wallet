// 会員が多い DAO（1000 人まで）: 配布・回収・投票の作成を 100 件ずつに分ける。Run: npx tsx dev-tests/dao-batch.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { Address, KeyPair, models } from 'symbol-sdk/symbol';
import { MAX_DAO_ITEMS, chunk, clearPendingVote, loadPendingVote, savePendingVote } from '../src/lib/dao/daoBatch';
import { planCreateVote, planResumeVote, planRevokeBatches, planSendMosaicBatches } from '../src/lib/dao/daoActions';
import type { Actor } from '../src/lib/dao/daoActions';
import type { Holder } from '../src/lib/dao/daoApi';
import { MAX_DAO_INNER, signDao } from '../src/lib/dao/daoTx';
import { addressFromPublicKey, bytesToHex } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const throws = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'error'; } };

setNetwork('testnet');
const cfg = getNetworkConfig();
const kp = new KeyPair(PrivateKey.random());
const owner: Actor = { publicKey: kp.publicKey.toString(), address: addressFromPublicKey(kp.publicKey.toString(), cfg.networkByte) };
const priv = kp.privateKey.toString();
const daoKey = new KeyPair(PrivateKey.random()).publicKey.toString();
const dao = { id: daoKey, address: addressFromPublicKey(daoKey, cfg.networkByte), name: 'x', governanceTokenId: '0'.repeat(16), voteBoxKeys: [], voteIndex: [], admins: [owner.address], minApproval: 1 };
const selfSigner: AggregateSigner = { address: dao.address, publicKey: dao.id, multisig: true, selfSufficient: true, cosignatures: 0 };
const needSigner: AggregateSigner = { ...selfSigner, selfSufficient: false, cosignatures: 2 };
// アドレスは、バイト列を 16 進にしたもので比べる（SDK の toString は未解決アドレスだと 16 進になるため）。
const keyOf = (address: string): string => bytesToHex(new Address(address).bytes);
const addressOf = (t: models.EmbeddedTransferTransactionV1): string => bytesToHex(t.recipientAddress.bytes);
const mkAddress = () => addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), cfg.networkByte);
const addresses = (n: number) => Array.from({ length: n }, mkAddress);
const holdersOf = (n: number): Holder[] => addresses(n).map((address, i) => ({ address, amount: BigInt((i % 7) + 1) }));
const sign = (input: Parameters<typeof signDao>[1]) => signDao(priv, input, 100, 100_000n);
const innerOf = (input: Parameters<typeof signDao>[1]) => {
  const s = sign(input);
  const tx = s.bonded ? models.AggregateBondedTransactionV3.deserialize(utils.hexToUint8(s.payload)) : models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(s.payload));
  return { s, inner: tx.transactions };
};

ok(MAX_DAO_ITEMS === 1000 && MAX_DAO_INNER === 100, 'limits: 1000 per operation, 100 per aggregate');

// --- chunk ---
ok(chunk([1, 2, 3, 4, 5], 2).map((c) => c.join('')).join('|') === '12|34|5', 'chunk splits in order, last one is short');
ok(chunk([], 3).length === 0 && chunk([1], 3).length === 1, 'chunk: empty and tiny inputs');
ok(throws(() => chunk([1], 0)) === 'invalid_chunk', 'chunk refuses size 0');

// --- 配布・回収 ---
{
  const to = addresses(1000);
  const plans = planSendMosaicBatches(owner, dao, selfSigner, '1234567890ABCDEF', to, 5n, '配布');
  ok(plans.length === 10, '1000 recipients → 10 aggregates', plans.length);
  const seen: string[] = [];
  for (const p of plans) {
    const { s, inner } = innerOf(p.input);
    ok(!s.bonded && inner.length === 100, 'each send is a complete aggregate of 100');
    ok(inner.every((t) => t.signerPublicKey.toString() === dao.id), 'sent from the DAO account');
    for (const t of inner as models.EmbeddedTransferTransactionV1[]) seen.push(bytesToHex(t.recipientAddress.bytes));
  }
  ok(seen.length === 1000 && new Set(seen).size === 1000, 'every recipient appears exactly once');
  const odd = planSendMosaicBatches(owner, dao, needSigner, '1234567890ABCDEF', addresses(250), 1n, '');
  ok(odd.length === 3 && odd.map((p) => innerOf(p.input).inner.length).join() === '100,100,50', '250 → 100,100,50', odd.length);
  ok(odd.every((p) => innerOf(p.input).s.bonded), 'admins needed: every batch is bonded (own hash lock each)');
  ok(throws(() => planSendMosaicBatches(owner, dao, selfSigner, '1234567890ABCDEF', addresses(1001), 1n, '')) === 'too_many_items', '1001 is refused');
  ok(throws(() => planSendMosaicBatches(owner, dao, selfSigner, '1234567890ABCDEF', [], 1n, '')) === 'too_many_items', 'no recipients is refused');
  const rev = planRevokeBatches(owner, dao, selfSigner, '1234567890ABCDEF', addresses(1000), 2n);
  ok(rev.length === 10 && rev.every((p) => innerOf(p.input).inner.length === 100), 'revoke 1000 → 10 aggregates of 100');
  ok(throws(() => planRevokeBatches(owner, dao, selfSigner, '1234567890ABCDEF', addresses(1001), 2n)) === 'too_many_items', 'revoke 1001 is refused');
}

// --- 投票の作成 ---
{
  const members = holdersOf(1000);
  for (const weighted of [true, false]) {
    const vote = planCreateVote(owner, dao, selfSigner, 0, '1000人の投票', ['a', 'b', '', ''], members, weighted);
    ok(vote.batches.length === 11 && vote.stage1 === vote.batches[0], `1000 members → 11 aggregates (weighted=${weighted})`, vote.batches.length);
    const want = weighted ? members.reduce((s, h) => s + h.amount, 0n) : 1000n;
    ok(vote.totalSupply === want, 'supply = what gets handed out', vote.totalSupply);
    let given = 0n;
    const seen = new Set<string>();
    vote.batches.forEach((b, i) => {
      const { s, inner } = innerOf(b.input);
      ok(!s.bonded && inner.length <= 100, 'vote batches are complete and within 100', inner.length);
      ok(i > 0 || inner.length === 100, 'first batch holds 3 fixed + 97 members');
      ok(inner.every((t) => t.signerPublicKey.toString() === owner.publicKey), 'vote batches are signed by the wallet account only');
      const transfers = (i === 0 ? inner.slice(3) : inner) as models.EmbeddedTransferTransactionV1[];
      for (const t of transfers) { given += BigInt(t.mosaics[0].amount.value); seen.add(bytesToHex(t.recipientAddress.bytes)); }
    });
    ok(given === vote.totalSupply && seen.size === 1000, 'all supply handed out, each member once', [given, seen.size]);
    const first = innerOf(vote.batches[0].input).inner;
    ok(first[1].type.value === models.TransactionType.MOSAIC_DEFINITION.value && first[2].type.value === models.TransactionType.MOSAIC_SUPPLY_CHANGE.value, 'first batch defines the token and its supply');
    ok(vote.batches.slice(1).every((b) => innerOf(b.input).inner.every((t) => t.type.value === models.TransactionType.TRANSFER.value)), 'later batches are transfers only');
  }
  const need = planCreateVote(owner, dao, needSigner, 0, 't', ['a', 'b', '', ''], members);
  ok(innerOf(need.batches[10].input).s.bonded === false && innerOf(need.stage2('A'.repeat(64)).input).s.bonded, 'only the final index registration needs the admins (bonded)');
  ok(throws(() => planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], holdersOf(1001))) === 'too_many_items', '1001 members refused');
  ok(planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], holdersOf(97)).batches.length === 1, '97 members still fit in one aggregate');
  ok(planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], holdersOf(98)).batches.length === 2, '98 members need a second aggregate');
}

// --- 止まった投票の再開 ---
{
  const members = holdersOf(300);
  const done = new Set(members.slice(0, 97).map((h) => h.address));
  const doneKeys = new Set(members.slice(0, 97).map((h) => keyOf(h.address)));
  const pending = { tokenId: 'ABCDEF0123456789', weighted: true };
  const need = members.slice(97).reduce((s, h) => s + h.amount, 0n);
  const plan = planResumeVote(owner, dao, selfSigner, 2, pending, members, done, need);
  ok(plan.remaining === 203 && plan.needed === need && plan.batches.map((b) => innerOf(b.input).inner.length).join() === '100,100,3', 'resume: only members without the token, 100 at a time', plan.remaining);
  const sent = plan.batches.flatMap((b) => innerOf(b.input).inner as models.EmbeddedTransferTransactionV1[]);
  ok(sent.length === 203 && sent.every((t) => !doneKeys.has(addressOf(t))) && sent.every((t) => t.mosaics[0].mosaicId.value === BigInt(`0x${pending.tokenId}`)), 'resume: never sends again to those who already have it');
  const idx = innerOf(plan.stage2('B'.repeat(64)).input).inner[0] as models.EmbeddedAccountMetadataTransactionV1;
  ok(idx.scopedMetadataKey === 99n + 2n, 'resume: index goes to the next free key');
  ok(throws(() => planResumeVote(owner, dao, selfSigner, 0, pending, members, done, need - 1n)) === 'vote_token_short', 'resume: not enough vote tokens left is refused');
  const flat = planResumeVote(owner, dao, selfSigner, 0, { ...pending, weighted: false }, members, done, 203n);
  ok(flat.needed === 203n, 'resume: unweighted needs 1 each', flat.needed);
  const none = planResumeVote(owner, dao, selfSigner, 0, pending, members, new Set(members.map((h) => h.address)), 0n);
  ok(none.batches.length === 0 && none.remaining === 0, 'resume: everyone has it already → only the index is left');
  const zero = planResumeVote(owner, dao, selfSigner, 0, pending, [...members.slice(0, 2), { address: mkAddress(), amount: 0n }], new Set(), 1000n);
  ok(zero.remaining === 2, 'resume: members who no longer hold the governance token are skipped', zero.remaining);
}
// --- 再開用の記録（この端末のブラウザ） ---
{
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  const rec = { tokenId: 'ABCDEF0123456789', firstHash: 'C'.repeat(64), weighted: false, title: 'テスト' };
  ok(loadPendingVote('dao1') === null, 'pending: none at first');
  savePendingVote('dao1', rec);
  ok(JSON.stringify(loadPendingVote('dao1')) === JSON.stringify(rec), 'pending: round-trips');
  ok(loadPendingVote('dao2') === null, 'pending: kept per DAO');
  clearPendingVote('dao1');
  ok(loadPendingVote('dao1') === null, 'pending: cleared');
  store.set('kasane.dao.pendingVote.DAO1', JSON.stringify({ tokenId: 'xyz', firstHash: 'C'.repeat(64) }));
  ok(loadPendingVote('dao1') === null, 'pending: a broken record is ignored');
  store.set('kasane.dao.pendingVote.DAO1', '{not json');
  ok(loadPendingVote('dao1') === null, 'pending: unreadable is ignored');
  delete (globalThis as any).localStorage;
  ok(loadPendingVote('dao1') === null && throws(() => savePendingVote('dao1', rec)) === null, 'pending: no storage → no crash');
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
