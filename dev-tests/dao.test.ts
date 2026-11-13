// DAO（symbol_book_v3_demo_dao の移植）: ネットワークに触れずに確かめられる部分。Run: npx tsx dev-tests/dao.test.ts
import { PrivateKey, PublicKey, Signature, utils } from 'symbol-sdk';
import { Address, KeyPair, SymbolFacade, Verifier, metadataGenerateKey, models } from 'symbol-sdk/symbol';
import { MOSAIC_META, THEME_META_KEY, DAO_KEY, VOTE_INDEX_FIRST_KEY, MAX_VOTE_OPTIONS, VOTE_BOX_KEYS, VOTE_CLOSED_KEY, buildVoteDoc, isVoteClosed, daoDeposit, parseVoteMessage, voteOptionIndexes, voteTokenHex, GOVERNANCE_SUPPLY } from '../src/lib/dao/daoCore';
import { MAX_DAO_ITEMS } from '../src/lib/dao/daoBatch';
import { CLOSE_VOTE_REVOKES_PER_BATCH, planCastVote, planCloseVote, planCreateDao, planCreateVote, planRequestExchange, planRevoke, planSendMosaic } from '../src/lib/dao/daoActions';
import type { Actor } from '../src/lib/dao/daoActions';
import { searchHeightAtOrBefore, sumLateTransfers } from '../src/lib/dao/daoApi';
import type { VoteView } from '../src/lib/dao/daoApi';
import { MAX_DAO_INNER, quoteDao, signDao, signDaoWith } from '../src/lib/dao/daoTx';
import { SssError } from '../src/lib/sss';
import { addressFromPublicKey, bytesToHex, facadeFor } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';

// 送り先などはアドレスのバイト列で比べる（SDK の toString は未解決アドレスだと16進になる）。
const sameAddr = (u: { bytes: Uint8Array }, base32: string) => bytesToHex(u.bytes) === bytesToHex(new Address(base32).bytes);

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const cfg = getNetworkConfig();
const f = facadeFor(cfg.networkByte);
const ownerKp = new KeyPair(PrivateKey.random());
const owner: Actor = { publicKey: ownerKp.publicKey.toString(), address: addressFromPublicKey(ownerKp.publicKey.toString(), cfg.networkByte) };
const ownerPriv = ownerKp.privateKey.toString();
const deadline = 100_000n;
const mult = 100;

// --- メタデータのキー: 元アプリ（SDK の metadataGenerateKey）と同じ値 ---
ok(MOSAIC_META.name === metadataGenerateKey('name'), 'key name');
ok(MOSAIC_META.type === metadataGenerateKey('type'), 'key type');
ok(MOSAIC_META.exchangeCost === metadataGenerateKey('exchangeCost'), 'key exchangeCost');
ok(MOSAIC_META.pointMosaicId === metadataGenerateKey('pointMosaicId'), 'key pointMosaicId');
ok(THEME_META_KEY === metadataGenerateKey('theme'), 'key theme');
ok(daoDeposit(10_000_000n) === 50_000_000n && daoDeposit(500_000_000n) === 540_000_000n, 'deposit', [daoDeposit(10_000_000n), daoDeposit(500_000_000n)]);

// --- DAO の作成 ---
const create = await planCreateDao(owner, 'テストDAO', 10_000_000n);
const signedCreate = signDao(ownerPriv, create.input, mult, deadline);
const txCreate = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signedCreate.payload));
ok(!signedCreate.bonded, 'create DAO is a complete aggregate');
ok(txCreate.transactions.length === 12, 'create DAO: 1 deposit + def + supply + multisig + 8 metadata', txCreate.transactions.length);
ok(txCreate.cosignatures.length === 1 && txCreate.cosignatures[0].signerPublicKey.toString() === create.daoId, 'DAO account cosigns');
ok(f.verifyTransaction(txCreate, txCreate.signature), 'initiator signature verifies');
const hash = f.hashTransaction(txCreate);
ok(new Verifier(txCreate.cosignatures[0].signerPublicKey).verify(hash.bytes, txCreate.cosignatures[0].signature), 'DAO cosignature verifies over the aggregate hash');
const expectedFee = BigInt(txCreate.size) * BigInt(mult);
ok(BigInt(txCreate.fee.value) === expectedFee && expectedFee > 0n, 'fee leaves room for the cosignature', [txCreate.fee.value, expectedFee]);
ok(txCreate.signerPublicKey.toString() === owner.publicKey, 'initiator is the wallet account');
ok(create.daoAddress === addressFromPublicKey(create.daoId, cfg.networkByte), 'DAO address matches its key');
// 内側の署名者: 入金・メタデータは作った人、モザイク・供給量・マルチシグは DAO
const signers = txCreate.transactions.map((t) => t.signerPublicKey.toString());
ok(signers[0] === owner.publicKey && signers[1] === create.daoId && signers[2] === create.daoId && signers[3] === create.daoId, 'inner signers (deposit / def / supply / multisig)');
ok(signers.slice(4).every((s) => s === owner.publicKey), 'metadata is written by the creator');
const msig = txCreate.transactions[3] as models.EmbeddedMultisigAccountModificationTransactionV1;
ok(msig.minApprovalDelta === 1 && msig.minRemovalDelta === 1 && msig.addressAdditions.length === 1, 'multisig: the creator is the only admin, approval 1/1');
ok(sameAddr(msig.addressAdditions[0], owner.address), 'multisig cosigner is the creator');

// --- 管理者の連署が要る操作 → bonded ---
const daoInfo = { id: create.daoId, address: create.daoAddress };
const dao = { ...daoInfo, name: 'x', governanceTokenId: '0'.repeat(16), voteBoxKeys: [], voteIndex: [], admins: [owner.address], minApproval: 1 };
const selfSigner: AggregateSigner = { address: create.daoAddress, publicKey: create.daoId, multisig: true, selfSufficient: true, cosignatures: 0 };
const needSigner: AggregateSigner = { ...selfSigner, selfSufficient: false, cosignatures: 2 };
const recipients = [0, 1, 2].map(() => addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), cfg.networkByte));
const sendSelf = signDao(ownerPriv, planSendMosaic(owner, dao, selfSigner, '1234567890ABCDEF', recipients, 5n, '配布').input, mult, deadline);
const txSelf = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(sendSelf.payload));
ok(!sendSelf.bonded && txSelf.transactions.length === 3 && txSelf.cosignatures.length === 0, 'DAO with one admin: complete aggregate, no hash lock');
ok(txSelf.transactions.every((t) => t.signerPublicKey.toString() === create.daoId), 'sends are signed by the DAO account');
const sendBonded = signDao(ownerPriv, planSendMosaic(owner, dao, needSigner, '1234567890ABCDEF', recipients, 5n, '').input, mult, deadline);
const txBonded = models.AggregateBondedTransactionV3.deserialize(utils.hexToUint8(sendBonded.payload));
ok(sendBonded.bonded && BigInt(txBonded.fee.value) === BigInt(txBonded.size + 104 * 2) * BigInt(mult), 'bonded: fee leaves room for 2 cosignatures', [txBonded.fee.value, txBonded.size]);
const revoke = signDao(ownerPriv, planRevoke(owner, dao, needSigner, '1234567890ABCDEF', recipients, 3n).input, mult, deadline);
const txRevoke = models.AggregateBondedTransactionV3.deserialize(utils.hexToUint8(revoke.payload));
ok(revoke.bonded && txRevoke.transactions.length === 3, 'revoke 3 sources');
let tooMany = false;
try { planSendMosaic(owner, dao, selfSigner, '1234567890ABCDEF', Array.from({ length: MAX_DAO_INNER + 1 }, () => recipients[0]), 1n, ''); } catch { tooMany = true; }
ok(tooMany, 'more than 100 recipients are refused');

// --- 交換申請（会員が出して、管理者が連署する） ---
const member: Actor = owner;
const exchange = signDao(ownerPriv, planRequestExchange(member, dao, needSigner, 'ABCDEF0123456789', 3n, '1234567890ABCDEF', 20n).input, mult, deadline);
const txEx = models.AggregateBondedTransactionV3.deserialize(utils.hexToUint8(exchange.payload));
const revokeInner = txEx.transactions[0] as models.EmbeddedMosaicSupplyRevocationTransactionV1;
ok(exchange.bonded && txEx.transactions.length === 2, 'exchange: revoke points + send reward');
ok(BigInt(revokeInner.mosaic.amount.value) === 60n, 'points taken = quantity × cost', revokeInner.mosaic.amount.value);
ok(sameAddr(revokeInner.sourceAddress, member.address), 'points are taken from the member');

// --- 投票 ---
const holders = [0, 1, 2].map((i) => ({ address: recipients[i], amount: BigInt((i + 1) * 100) }));
const vote = planCreateVote(owner, dao, selfSigner, 0, '会議室の色は？', ['赤', '青', '', ''], holders);
ok(vote.totalSupply === 600n && vote.holders.length === 3, 'vote token supply = sum of the holders');
const s1 = signDao(ownerPriv, vote.stage1.input, mult, deadline);
const t1 = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(s1.payload));
ok(!s1.bonded && t1.transactions.length === 6, 'vote stage 1: index + def + supply + 3 transfers', t1.transactions.length);
const indexTx = t1.transactions[0] as models.EmbeddedTransferTransactionV1;
const doc = parseVoteMessage(bytesToHex(indexTx.message));
ok(doc !== null && doc.title === '会議室の色は？' && doc.a === '赤' && doc.b === '青' && doc.c === '' && doc.token === BigInt(`0x${vote.voteTokenId}`).toString(), 'index message round-trips', doc);
ok(doc !== null && voteTokenHex(doc) === vote.voteTokenId && voteOptionIndexes(doc).join() === '0,1', 'vote token id and used options');
ok(parseVoteMessage('00') === null && parseVoteMessage(bytesToHex(new TextEncoder().encode('{"x":1}'))) === null, 'garbage is not a vote');
const s2 = signDao(ownerPriv, vote.stage2(s1.hash).input, mult, deadline);
const t2 = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(s2.payload));
const metaTx = t2.transactions[0] as models.EmbeddedAccountMetadataTransactionV1;
ok(metaTx.scopedMetadataKey === VOTE_INDEX_FIRST_KEY && sameAddr(metaTx.targetAddress, create.daoAddress) && metaTx.signerPublicKey.toString() === create.daoId, 'stage 2 writes the first vote index on the DAO');
ok(new TextDecoder().decode(metaTx.value) === s1.hash, 'index value = stage-1 hash');
ok(doc !== null && doc.weighted === true, 'default vote is weighted (and the index has no extra field)', doc);
{
  // 重み付けなし: 保有量に関係なく 1 人 1 票。配る先はガバナンストークンの保有者だけ。
  const flat = planCreateVote(owner, dao, selfSigner, 0, '1人1票', ['はい', 'いいえ', '', ''], holders, false);
  ok(flat.totalSupply === 3n, 'unweighted: supply = number of members', flat.totalSupply);
  const sf = signDao(ownerPriv, flat.stage1.input, mult, deadline);
  const tf = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(sf.payload));
  const sends = tf.transactions.slice(3) as models.EmbeddedTransferTransactionV1[];
  ok(sends.length === 3 && sends.every((x) => x.mosaics[0].amount.value === 1n), 'unweighted: every member gets exactly 1', sends.map((x) => x.mosaics[0].amount.value));
  ok(sends.every((x, i) => sameAddr(x.recipientAddress, holders[i].address)), 'unweighted: only the holders receive');
  const docFlat = parseVoteMessage(bytesToHex((tf.transactions[0] as models.EmbeddedTransferTransactionV1).message));
  ok(docFlat !== null && docFlat.weighted === false, 'unweighted flag round-trips', docFlat);
  const sendsW = (models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(s1.payload)).transactions.slice(3) as models.EmbeddedTransferTransactionV1[]).map((x) => x.mosaics[0].amount.value);
  ok(sendsW.join() === '100,200,300', 'weighted: members get their holdings', sendsW);
}
{
  // 選択肢は A〜F の 6 つまで。5・6 つ目を使わない投票は、これまでと同じ形（e・f を書かない）。
  ok(MAX_VOTE_OPTIONS === 6 && VOTE_BOX_KEYS.length === 6 && DAO_KEY.VOTE_E === 8n && DAO_KEY.VOTE_F === 9n, 'six vote boxes (keys 8 and 9 are new)');
  ok(!('e' in (doc as object)) && !('f' in (doc as object)), 'a 4-option vote document has no e / f field');
  const six = planCreateVote(owner, dao, selfSigner, 0, '6択', ['a', 'b', 'c', 'd', 'e', 'f'], holders);
  const s6 = signDao(ownerPriv, six.stage1.input, mult, deadline);
  const t6 = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(s6.payload));
  const doc6 = parseVoteMessage(bytesToHex((t6.transactions[0] as models.EmbeddedTransferTransactionV1).message));
  ok(doc6 !== null && doc6.e === 'e' && doc6.f === 'f' && voteOptionIndexes(doc6).join() === '0,1,2,3,4,5', 'six options round-trip', doc6);
  const five = planCreateVote(owner, dao, selfSigner, 0, '飛び飛び', ['a', 'b', '', '', 'e', ''], holders);
  const t5 = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, five.stage1.input, mult, deadline).payload));
  const doc5 = parseVoteMessage(bytesToHex((t5.transactions[0] as models.EmbeddedTransferTransactionV1).message));
  ok(doc5 !== null && voteOptionIndexes(doc5).join() === '0,1,4' && doc5.f === '', 'gaps between options are allowed', doc5);
  let tooManyOptions = false;
  try { planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], holders); } catch (e) { tooManyOptions = (e as Error).message === 'too_many_options'; }
  ok(tooManyOptions, 'a seventh option is refused');
  // E・F の投票箱が無い DAO（以前に作ったもの）: E・F を使うときだけ、登録のアグリゲートで足りない箱を書き足す。使わないなら今までと同じ。
  const box = () => new KeyPair(PrivateKey.random()).publicKey.toString().toUpperCase();
  const oldDao = { ...dao, voteBoxKeys: [box(), box(), box(), box(), '', ''] };
  const innerOf = (v: ReturnType<typeof planCreateVote>) => models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, v.stage2('0'.repeat(64)).input, mult, deadline).payload)).transactions as models.EmbeddedAccountMetadataTransactionV1[];
  const plain = innerOf(planCreateVote(owner, oldDao, selfSigner, 0, 't', ['a', 'b', 'c', 'd', '', ''], holders));
  ok(plain.length === 1 && plain[0].scopedMetadataKey === VOTE_INDEX_FIRST_KEY, 'old DAO, 4 options: only the index is written');
  const withEF = innerOf(planCreateVote(owner, oldDao, selfSigner, 0, 't', ['a', 'b', 'c', 'd', 'e', 'f'], holders));
  ok(withEF.length === 3 && withEF[0].scopedMetadataKey === DAO_KEY.VOTE_E && withEF[1].scopedMetadataKey === DAO_KEY.VOTE_F && withEF[2].scopedMetadataKey === VOTE_INDEX_FIRST_KEY, 'old DAO, 6 options: E and F boxes are added with the index');
  ok(withEF.every((m) => m.signerPublicKey.toString() === oldDao.id && sameAddr(m.targetAddress, oldDao.address)), 'the DAO writes its own metadata');
  ok(/^[0-9A-F]{64}$/.test(new TextDecoder().decode(withEF[0].value)), 'a new box key is a 64-hex public key');
  const onlyE = innerOf(planCreateVote(owner, oldDao, selfSigner, 0, 't', ['a', 'b', '', '', 'e', ''], holders));
  ok(onlyE.length === 2 && onlyE[0].scopedMetadataKey === DAO_KEY.VOTE_E, 'old DAO, option E only: just box E is added', onlyE.map((m) => m.scopedMetadataKey));
  const newDao = { ...dao, voteBoxKeys: [box(), box(), box(), box(), box(), box()] };
  ok(innerOf(planCreateVote(owner, newDao, selfSigner, 0, 't', ['a', 'b', 'c', 'd', 'e', 'f'], holders)).length === 1, 'DAO that already has all six boxes: only the index is written');
}
{
  // 投票の期限: 索引に `end`（UTC ミリ秒）を書く。無ければ期限なし（これまでと同じ形）。
  const readDoc = (v: ReturnType<typeof planCreateVote>) => parseVoteMessage(bytesToHex((models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, v.stage1.input, mult, deadline).payload)).transactions[0] as models.EmbeddedTransferTransactionV1).message));
  ok(doc !== null && doc.end === 0 && !('end' in JSON.parse(new TextDecoder().decode(indexTx.message.slice(1)))), 'no deadline: no end field, read as 0');
  const endsAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const timed = readDoc(planCreateVote(owner, dao, selfSigner, 0, '期限つき', ['a', 'b', '', ''], holders, true, endsAt));
  ok(timed !== null && timed.end === endsAt && timed.weighted === true, 'deadline round-trips', timed);
  const timedFlat = readDoc(planCreateVote(owner, dao, selfSigner, 0, '期限つき1人1票', ['a', 'b', '', ''], holders, false, endsAt));
  ok(timedFlat !== null && timedFlat.end === endsAt && timedFlat.weighted === false, 'deadline and unweighted flag coexist', timedFlat);
  for (const bad of [Date.now() - 1000, Number.NaN, -5]) {
    let refused = '';
    try { planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], holders, true, bad); } catch (e) { refused = (e as Error).message; }
    ok(refused === 'invalid_deadline', 'a past or invalid deadline is refused', [bad, refused]);
  }
  ok(!isVoteClosed({ end: 0 }, Number.MAX_SAFE_INTEGER), 'no deadline never closes');
  ok(!isVoteClosed({ end: 1000 }, 999) && isVoteClosed({ end: 1000 }, 1000) && isVoteClosed({ end: 1000 }, 5000), 'closes exactly at the deadline');
  ok(parseVoteMessage(bytesToHex(new Uint8Array([0, ...new TextEncoder().encode(JSON.stringify({ token: '1', title: 't', a: 'x', b: 'y', end: 'soon' }))])))?.end === 0, 'a malformed end is read as no deadline');
}
{
  // 締め切り: 投票トークンを持っている人（投票箱以外）から回収し、回収した分と自分の手元の分を、使い捨てのアドレスへ送って使えなくする。
  const many = Array.from({ length: 200 }, (_, i) => ({ address: addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), cfg.networkByte), amount: BigInt(i + 1) }));
  const close = planCloseVote(owner, vote.voteTokenId, many, 7n);
  ok(close.targets === 200 && close.revoked === many.reduce((n, h) => n + h.amount, 0n), 'close: every holder is a target', [close.targets, close.revoked]);
  ok(close.batches.length === 3 && close.unit === CLOSE_VOTE_REVOKES_PER_BATCH && CLOSE_VOTE_REVOKES_PER_BATCH === MAX_DAO_INNER - 2, 'close: 200 holders → 98 + 98 + 4', close.batches.length);
  const closeTx = close.batches.map((b) => models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, b.input, mult, deadline).payload)));
  ok(closeTx.every((t) => t.transactions.length <= MAX_DAO_INNER), 'close: every aggregate fits the inner limit', closeTx.map((t) => t.transactions.length));
  ok(closeTx.every((t) => t.cosignatures.length === 0) && close.batches.every((b) => b.input.dao === undefined), 'close: signed by the vote creator alone (no DAO cosignature)');
  const inners = closeTx.map((t) => t.transactions);
  const revokes = inners.flatMap((l) => l.filter((x) => x.type.value === models.TransactionType.MOSAIC_SUPPLY_REVOCATION.value)) as models.EmbeddedMosaicSupplyRevocationTransactionV1[];
  ok(revokes.length === 200 && revokes.every((r) => r.signerPublicKey.toString() === owner.publicKey), 'close: 200 revocations, all by the creator (the mosaic owner)');
  ok(revokes.every((r, i) => sameAddr(r.sourceAddress, many[i].address) && r.mosaic.amount.value === many[i].amount), 'close: each holder loses exactly what it holds');
  const burns = inners.map((l) => l.filter((x) => x.type.value === models.TransactionType.TRANSFER.value) as models.EmbeddedTransferTransactionV1[]);
  ok(burns.every((b) => b.length === 1 && sameAddr(b[0].recipientAddress, close.burnAddress)), 'close: one burn transfer per aggregate, to the throwaway address');
  const sums = [many.slice(0, 98), many.slice(98, 196), many.slice(196)].map((h) => h.reduce((n, x) => n + x.amount, 0n));
  ok(burns[0][0].mosaics[0].amount.value === sums[0] && burns[1][0].mosaics[0].amount.value === sums[1] && burns[2][0].mosaics[0].amount.value === sums[2] + 7n, 'close: burn = what was taken back (+ the creator\'s own balance in the last one)', burns.map((b) => b[0].mosaics[0].amount.value));
  const marks = inners.map((l) => l.filter((x) => x.type.value === models.TransactionType.MOSAIC_METADATA.value) as models.EmbeddedMosaicMetadataTransactionV1[]);
  ok(marks[0].length === 0 && marks[1].length === 0 && marks[2].length === 1, 'close: the "closed" mark is written only by the last aggregate');
  ok(marks[2][0].scopedMetadataKey === VOTE_CLOSED_KEY && new TextDecoder().decode(marks[2][0].value) === '1' && sameAddr(marks[2][0].targetAddress, owner.address), 'close: mark = voteClosed on the vote token, set by its owner');
  const none = planCloseVote(owner, vote.voteTokenId, [], 5n);
  const noneTx = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, none.batches[0].input, mult, deadline).payload));
  ok(none.batches.length === 1 && noneTx.transactions.length === 2, 'close: nobody else holds any → burn own balance + mark', noneTx.transactions.length);
  const empty = planCloseVote(owner, vote.voteTokenId, [], 0n);
  const emptyTx = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signDao(ownerPriv, empty.batches[0].input, mult, deadline).payload));
  ok(emptyTx.transactions.length === 1, 'close: nothing left anywhere → just the mark', emptyTx.transactions.length);
  let closeTooMany = false;
  try { planCloseVote(owner, vote.voteTokenId, Array.from({ length: MAX_DAO_ITEMS + 1 }, () => many[0]), 0n); } catch (e) { closeTooMany = (e as Error).message === 'too_many_items'; }
  ok(closeTooMany, 'close: more than 1000 holders is refused');
  ok(planCloseVote(owner, vote.voteTokenId, many, 0n).burnAddress !== close.burnAddress, 'close: a fresh throwaway address each time');
}
{
  // 期限後の送金を除く: 期限のブロックの高さを探す（時刻は高さとともに増える）。
  const epoch = 1_700_000_000_000;
  const mk = (jitter: number) => async (h: number) => { probes += 1; return epoch + h * 30_000 + ((h * 7919) % 2000) * jitter; };
  let probes = 0;
  const cases: Array<[number, number, number]> = [[epoch + 500_000 * 30_000, 1_000_000, 500_000], [epoch + 29_999, 1_000_000, 0], [epoch + 30_000, 1_000_000, 1], [epoch + 999_999 * 30_000, 1_000_000, 999_999], [epoch + 2_000_000 * 30_000, 1_000_000, 1_000_000], [epoch - 1, 1_000_000, 0]];
  for (const [end, tip, want] of cases) {
    probes = 0;
    const got = await searchHeightAtOrBefore(end, tip, mk(0));
    ok(got === want, 'cutoff height', [end - epoch, got, want]);
    ok(probes <= 50, 'cutoff search stays small (≤ 50 probes on a million blocks)', probes);
  }
  probes = 0;
  const jittered = await searchHeightAtOrBefore(epoch + 123_456 * 30_000, 1_000_000, mk(0));
  const timeOf = (h: number) => epoch + h * 30_000;
  ok(jittered === 123_456 && timeOf(jittered) <= epoch + 123_456 * 30_000 && timeOf(jittered + 1) > epoch + 123_456 * 30_000, 'cutoff is the last block at or before the deadline');
  // 送金の合計: 新しい順。期限のブロックより後の分だけを足し、古いものに届いたら止める。
  const row = (height: number, ...m: Array<[string, number]>) => ({ meta: { height: String(height) }, transaction: { mosaics: m.map(([id, amount]) => ({ id, amount: String(amount) })) } });
  const rows = [row(120, ['AAAA', 5]), row(110, ['AAAA', 3], ['BBBB', 9]), row(100, ['AAAA', 4]), row(90, ['AAAA', 50])];
  const late = sumLateTransfers(rows, 'aaaa', 100);
  ok(late.amount === 8n && late.done, 'late sum: only transfers after the cutoff block, only this token', late);
  ok(sumLateTransfers(rows.slice(0, 2), 'AAAA', 100).done === false, 'late sum: keeps paging while everything is still newer than the cutoff');
  ok(sumLateTransfers([], 'AAAA', 100).amount === 0n, 'late sum: nothing');
}
let tooManyHolders = false;
try { planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], Array.from({ length: MAX_DAO_ITEMS + 1 }, () => holders[0])); } catch { tooManyHolders = true; }
ok(tooManyHolders, 'more members than one operation can handle is refused');
ok(planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], Array.from({ length: MAX_DAO_INNER }, () => holders[0])).batches.length === 2, '100 members no longer hit the single-aggregate limit (split in two)');
let noHolders = false;
try { planCreateVote(owner, dao, selfSigner, 0, 't', ['a', 'b', '', ''], []); } catch { noHolders = true; }
ok(noHolders, 'no members: refused');

const view: VoteView = { index: 0, txHash: s1.hash, doc: doc!, tokenId: vote.voteTokenId, tallies: [0n, 0n, 0n, 0n, 0n, 0n], myBalance: 250n, creator: owner.address, closedOnChain: false, lateExcluded: 0n, lateUnknown: false };
const boxKey = new KeyPair(PrivateKey.random()).publicKey.toString();
const cast = signDao(ownerPriv, planCastVote(owner, view, boxKey).input, mult, deadline);
const tc = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(cast.payload));
const castInner = tc.transactions[0] as models.EmbeddedTransferTransactionV1;
ok(tc.transactions.length === 1 && sameAddr(castInner.recipientAddress, addressFromPublicKey(boxKey, cfg.networkByte)) && BigInt(castInner.mosaics[0].amount.value) === 250n, 'cast vote = all tokens to the chosen box');

// --- SSS Extension で署名する（偽の window.SSS）: 秘密鍵で署名したものと、署名も連署も同じになる ---
{
  const win: any = {};
  (globalThis as any).window = win;
  const ownerPub = new KeyPair(new PrivateKey(ownerPriv)).publicKey.toString().toUpperCase();
  win.SSS = { activePublicKey: ownerPub, activeNetworkType: cfg.networkByte, activeName: 'owner' };
  let asked = 0;
  let received = '';
  win.SSS.setTransactionByPayload = (payload: string) => { received = payload; };
  win.SSS.requestSign = async () => {
    asked++;
    // 拡張のかわりに、受け取った署名前のトランザクションに、本物の鍵で署名して返す。
    const tx = models.TransactionFactory.deserialize(utils.hexToUint8(received));
    const f = facadeFor(cfg.networkByte);
    const sig = f.signTransaction(new KeyPair(new PrivateKey(ownerPriv)), tx);
    tx.signature = new models.Signature(sig.bytes);
    return { payload: bytesToHex(tx.serialize()).toUpperCase() };
  };
  const owner2 = { ...owner, publicKey: ownerPub };
  void owner2;

  // DAO の作成（作ったばかりのアカウントの連署つき）: 署名のあとで連署が付く。
  const viaSss = await signDaoWith('', { kind: 'sss' }, create.input, mult, deadline);
  ok(asked === 1, 'SSS: asked the extension once for the create aggregate');
  ok(viaSss.payload.toUpperCase() === signedCreate.payload.toUpperCase() && viaSss.hash.toUpperCase() === signedCreate.hash.toUpperCase(), 'SSS: create aggregate (with temp cosignatures) is identical to the private-key one');
  const vc = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(viaSss.payload));
  ok(vc.cosignatures.length === (create.input.tempKeys ?? []).length && vc.cosignatures.length > 0, 'SSS: temp cosignatures are attached');
  const f = facadeFor(cfg.networkByte);
  ok(vc.cosignatures.every((c) => new Verifier(new PublicKey(utils.uint8ToHex(c.signerPublicKey.bytes))).verify(utils.hexToUint8(viaSss.hash), new Signature(c.signature.bytes))), 'SSS: cosignatures verify against the final hash');
  ok(f.verifyTransaction(vc, new models.Signature(vc.signature.bytes)), 'SSS: issuer signature verifies');

  // bonded（他の管理者の連署待ち）と、連署の無い complete。
  const bondedSss = await signDaoWith('', undefined, planSendMosaic(owner, dao, needSigner, '1234567890ABCDEF', recipients, 5n, '').input, mult, deadline);
  ok(bondedSss.bonded && bondedSss.payload.toUpperCase() === sendBonded.payload.toUpperCase(), 'SSS: bonded aggregate is identical (privateKey "" = SSS)');
  const selfSss = await signDaoWith('', { kind: 'sss' }, planSendMosaic(owner, dao, selfSigner, '1234567890ABCDEF', recipients, 5n, '配布').input, mult, deadline);
  ok(!selfSss.bonded && selfSss.payload.toUpperCase() === sendSelf.payload.toUpperCase(), 'SSS: complete aggregate is identical');

  // 別のアカウントが選ばれていたら、署名を頼まずに止める。
  win.SSS.activePublicKey = 'CD'.repeat(32);
  const before = asked;
  let kind = '';
  try { await signDaoWith('', { kind: 'sss' }, create.input, mult, deadline); } catch (e) { kind = e instanceof SssError ? e.kind : String(e); }
  ok(kind === 'account_mismatch' && asked === before, 'SSS: wrong account in the extension is refused before asking to sign', kind);

  // 秘密鍵があるときは、拡張を使わない。
  win.SSS.activePublicKey = ownerPub;
  const asked2 = asked;
  const viaKey = await signDaoWith(ownerPriv, undefined, create.input, mult, deadline);
  ok(asked === asked2 && viaKey.payload.toUpperCase() === signedCreate.payload.toUpperCase(), 'private key: the extension is not used');
}

// --- 見積もり（ネットワークに触れない部分だけ） ---
ok(DAO_KEY.GOVERNANCE_TOKEN_ID === 5n && GOVERNANCE_SUPPLY === 1_000_000n, 'constants match the original app');
ok(typeof quoteDao === 'function' && SymbolFacade !== undefined, 'quote exported');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
