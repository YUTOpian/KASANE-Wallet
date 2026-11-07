// DAO の操作ごとに、内側のトランザクションを決める（元アプリのサーバーの POST/PUT ルート 1 本ずつに当たる）。
// 画面は計画（DaoPlan）を受け取って、見積もり → 確認 → パスワード → 送信、と進める。
import type { SymbolFacade } from 'symbol-sdk/symbol';
import { aggregateMosaicId } from '../symbol/aggregate';
import type { AggregateSigner } from '../symbol/aggregate';
import { resolveSigner } from '../symbol/aggregateApi';
import { fetchMosaicRentalFee, fetchNamespaceRentalFees } from '../symbol/api';
import type { NamespaceRentalFees, OwnedNamespace } from '../symbol/api';
import { isRenewableRoot, validateRenewDays } from '../symbol/namespaceRenew';
import { addressFromPublicKey, facadeFor } from '../symbol/crypto';
import { getNetworkConfig } from '../symbol/network';
import { BLOCKS_PER_DAY, MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS, newHarvestKeyPair, newMosaicNonce } from '../symbol/tx';
import { MAX_DAO_ITEMS, chunk } from './daoBatch';
import type { PendingVote } from './daoBatch';
import { fetchDaoMetadataValue, fetchHeld } from './daoApi';
import type { DaoInfo, Holder, VoteView } from './daoApi';
import {
  DAO_FLAGS, DAO_KEY, GOVERNANCE_SUPPLY, MOSAIC_META, MAX_VOTE_OPTIONS, THEME_META_KEY, VOTE_BOX_KEYS, VOTE_CLOSED_KEY, VOTE_INDEX_FIRST_KEY, buildVoteDoc, daoDeposit,
} from './daoCore';
import type { DaoAccess, DaoMosaicKind } from './daoCore';
import {
  MAX_DAO_INNER, embAccountMetadata, embMosaicAlias, embMosaicDefinition, embMosaicMetadata, embMultisigAdd, embNamespaceRegistration, embRevoke, embSupplyIncrease, embTransfer, encodeText,
} from './daoTx';
import type { DaoSubmitInput, Embedded } from './daoTx';

/** ウォレットで開いているアカウント。 */
export interface Actor {
  address: string;
  publicKey: string;
}

export interface DaoPlan {
  input: DaoSubmitInput;
  /** 内側の送金でウォレットから出ていく XYM（DAO への入金）。手数料・ロックは別に見積もる。 */
  spend: bigint;
}

/** 内側の署名者としての DAO。ウォレットのアカウントだけの署名で足りるか、他の管理者の連署が要るかが分かる。 */
export const resolveDaoSigner = (actor: Actor, dao: Pick<DaoInfo, 'address' | 'id'>): Promise<AggregateSigner> => resolveSigner(actor.address, dao.address, dao.id);

// --- DAO の作成 ----------------------------------------------------------------------------------

export interface CreateDaoPlan extends DaoPlan {
  daoId: string; // DAO アカウントの公開鍵
  daoAddress: string;
  deposit: bigint;
}

/**
 * DAO を作る: 新しいアカウント（DAO）を作り、50 XYM 以上を入金し、ガバナンストークンを発行し、作った人だけを管理者にした
 * マルチシグにし、名前・トークン ID・投票箱の公開鍵をメタデータとして書く。全部が 1 つのアグリゲート（complete）で、
 * 作ったアカウントの鍵はここで連署に使ったあと捨てる（以後は管理者の連署でしか動かせない）。
 */
export async function planCreateDao(actor: Actor, name: string, rentalFee?: bigint): Promise<CreateDaoPlan> {
  const networkByte = getNetworkConfig().networkByte;
  const dao = newHarvestKeyPair();
  const daoPublicKey = dao.publicKey.toUpperCase();
  const daoAddress = addressFromPublicKey(daoPublicKey, networkByte);
  const boxKeys = VOTE_BOX_KEYS.map(() => newHarvestKeyPair().publicKey.toUpperCase());
  const deposit = daoDeposit(rentalFee ?? await fetchMosaicRentalFee());
  const nonce = newMosaicNonce();
  const tokenId = aggregateMosaicId(daoAddress, nonce);
  const meta: Array<[bigint, string]> = [
    [DAO_KEY.GOVERNANCE_TOKEN_ID, tokenId],
    [DAO_KEY.VOTE_A, boxKeys[0]],
    [DAO_KEY.VOTE_B, boxKeys[1]],
    [DAO_KEY.VOTE_C, boxKeys[2]],
    [DAO_KEY.VOTE_D, boxKeys[3]],
    [DAO_KEY.VOTE_E, boxKeys[4]],
    [DAO_KEY.VOTE_F, boxKeys[5]],
    [DAO_KEY.DAO_NAME, name],
  ];
  const build = (f: SymbolFacade): Embedded[] => [
    embTransfer(f, actor.publicKey, daoAddress, getNetworkConfig().currencyMosaicId, deposit),
    embMosaicDefinition(f, daoPublicKey, daoAddress, nonce, DAO_FLAGS.governance).tx,
    embSupplyIncrease(f, daoPublicKey, tokenId, GOVERNANCE_SUPPLY),
    embMultisigAdd(f, daoPublicKey, [actor.address]),
    ...meta.map(([key, value]) => embAccountMetadata(f, actor.publicKey, daoAddress, key, encodeText(value))),
  ];
  return { input: { publicKey: actor.publicKey, build, tempKeys: [dao.privateKey] }, spend: deposit, daoId: daoPublicKey, daoAddress, deposit };
}

// --- ポイント・特典の作成 ----------------------------------------------------------------------------

/** DAO アカウントの XYM が足りなければ入金する額（足りていれば 0）。モザイクの作成費は DAO アカウントが払う。 */
async function depositFor(dao: DaoInfo): Promise<bigint> {
  const [rental, held] = await Promise.all([fetchMosaicRentalFee(), fetchHeld(dao.address)]);
  const balance = held.get(getNetworkConfig().currencyMosaicId.toUpperCase()) ?? 0n;
  return balance >= rental + 10_000_000n ? 0n : daoDeposit(rental);
}

export interface CreateMosaicPlan extends DaoPlan {
  mosaicId: string;
}

/** ポイント（回収可）/ 特典（回収不可）のモザイクを DAO アカウントが作る。名前と種別（point/reward）はモザイクメタデータ。 */
export async function planCreateMosaic(actor: Actor, dao: DaoInfo, signer: AggregateSigner, kind: DaoMosaicKind, name: string, amount: bigint): Promise<CreateMosaicPlan> {
  const deposit = await depositFor(dao);
  const nonce = newMosaicNonce();
  const mosaicId = aggregateMosaicId(dao.address, nonce);
  const build = (f: SymbolFacade): Embedded[] => [
    ...(deposit > 0n ? [embTransfer(f, actor.publicKey, dao.address, getNetworkConfig().currencyMosaicId, deposit)] : []),
    embMosaicDefinition(f, dao.id, dao.address, nonce, kind === 'point' ? DAO_FLAGS.point : DAO_FLAGS.reward).tx,
    embSupplyIncrease(f, dao.id, mosaicId, amount),
    embMosaicMetadata(f, dao.id, dao.address, mosaicId, MOSAIC_META.name, encodeText(name)),
    embMosaicMetadata(f, dao.id, dao.address, mosaicId, MOSAIC_META.type, encodeText(kind)),
  ];
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: deposit, mosaicId };
}

// --- 配布・回収 ---------------------------------------------------------------------------------

/** DAO アカウントから、宛先それぞれに同じ量を送る（ポイントの配布・特典の配布）。 */
export function planSendMosaic(actor: Actor, dao: DaoInfo, signer: AggregateSigner, mosaicId: string, recipients: string[], amount: bigint, message: string): DaoPlan {
  if (recipients.length === 0 || recipients.length > MAX_DAO_INNER) throw new Error('too_many_items');
  const build = (f: SymbolFacade): Embedded[] => recipients.map((to) => embTransfer(f, dao.id, to, mosaicId, amount, message || undefined));
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n };
}

/** 持ち主から回収する（回収可のモザイク = ポイント）。 */
export function planRevoke(actor: Actor, dao: DaoInfo, signer: AggregateSigner, mosaicId: string, sources: string[], amount: bigint): DaoPlan {
  if (sources.length === 0 || sources.length > MAX_DAO_INNER) throw new Error('too_many_items');
  const build = (f: SymbolFacade): Embedded[] => sources.map((from) => embRevoke(f, dao.id, from, mosaicId, amount));
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n };
}

/**
 * 会員が多いとき用: 宛先を 100 件ずつに分けて、アグリゲートを何回かに分ける（最大 MAX_DAO_ITEMS = 1000 件）。
 * 1 回ずつ独立していて、順に送る（`submitDaoBatches`）。
 */
export function planSendMosaicBatches(actor: Actor, dao: DaoInfo, signer: AggregateSigner, mosaicId: string, recipients: string[], amount: bigint, message: string): DaoPlan[] {
  if (recipients.length === 0 || recipients.length > MAX_DAO_ITEMS) throw new Error('too_many_items');
  return chunk(recipients, MAX_DAO_INNER).map((part) => planSendMosaic(actor, dao, signer, mosaicId, part, amount, message));
}

/** 回収も同じく、100 件ずつに分ける（最大 1000 件）。 */
export function planRevokeBatches(actor: Actor, dao: DaoInfo, signer: AggregateSigner, mosaicId: string, sources: string[], amount: bigint): DaoPlan[] {
  if (sources.length === 0 || sources.length > MAX_DAO_ITEMS) throw new Error('too_many_items');
  return chunk(sources, MAX_DAO_INNER).map((part) => planRevoke(actor, dao, signer, mosaicId, part, amount));
}

// --- ネームスペースの紐付け ----------------------------------------------------------------------------

/** 紐付けるネームスペース: DAO が持っているもの / 新しいルート（日数分レンタル）/ 新しい子（親は DAO のもの）。 */
export type NamespaceLinkTarget =
  | { kind: 'owned'; id: string }
  | { kind: 'root'; name: string; days: number }
  | { kind: 'child'; name: string; parentId: string };

export interface LinkNamespacePlan extends DaoPlan {
  namespaceId: string;
  rental: bigint; // 新しく作るときのレンタル料（DAO アカウントが払う。紐付けだけなら 0）
}

/**
 * ガバナンストークン・ポイント・特典のモザイクに、ネームスペースを紐付ける。ネームスペースもモザイクも DAO アカウントのものなので、
 * 署名者は DAO。新しく作るときのレンタル料は DAO アカウントが払うので、足りなければ同じアグリゲートの中でウォレットから入金する。
 */
export async function planLinkNamespace(actor: Actor, dao: DaoInfo, signer: AggregateSigner, mosaicId: string, target: NamespaceLinkTarget): Promise<LinkNamespacePlan> {
  if (target.kind === 'owned') {
    const build = (f: SymbolFacade): Embedded[] => [embMosaicAlias(f, dao.id, target.id, mosaicId)];
    return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n, namespaceId: target.id, rental: 0n };
  }
  const fees = await fetchNamespaceRentalFees();
  if (!fees) throw new Error('fee_unavailable');
  let rental: bigint;
  let name: string;
  let parentId: string | null;
  let duration = 0n;
  if (target.kind === 'root') {
    if (!Number.isInteger(target.days) || target.days < MIN_NAMESPACE_DAYS || target.days > MAX_NAMESPACE_DAYS) throw new Error('invalid_days');
    duration = BigInt(target.days) * BigInt(BLOCKS_PER_DAY);
    rental = fees.rootFeePerBlock * duration;
    name = target.name;
    parentId = null;
  } else {
    rental = fees.childFee;
    name = target.name;
    parentId = target.parentId;
  }
  const deposit = await depositForRental(dao, rental);
  const registration = embNamespaceRegistrationFor(name, parentId, duration);
  const build = (f: SymbolFacade): Embedded[] => {
    const reg = embNamespaceRegistration(f, dao.id, name, parentId, duration);
    return [
      ...(deposit > 0n ? [embTransfer(f, actor.publicKey, dao.address, getNetworkConfig().currencyMosaicId, deposit)] : []),
      reg.tx,
      embMosaicAlias(f, dao.id, reg.id, mosaicId),
    ];
  };
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: deposit, namespaceId: registration, rental };
}

/** レンタル料が DAO アカウントの XYM で足りなければ、足りない分（と少しの余裕）を入金する額（足りていれば 0）。 */
async function depositForRental(dao: DaoInfo, rental: bigint): Promise<bigint> {
  const held = (await fetchHeld(dao.address)).get(getNetworkConfig().currencyMosaicId.toUpperCase()) ?? 0n;
  const margin = 1_000_000n;
  return held >= rental + margin ? 0n : rental + margin - held;
}

// --- ネームスペースの更新（期間の延長） ------------------------------------------------------------

export interface RenewNamespacePlan extends DaoPlan {
  namespaceId: string;
  rental: bigint; // 延長のレンタル料（DAO アカウントが払う）
}

/**
 * 延長のトランザクションを組み立てる（ネットワークに触れない部分）。Symbol に専用の更新トランザクションはなく、
 * 持ち主が同じ名前でルートをもう一度登録すると、今の期限に期間が足される。ここでは署名者が DAO（持ち主）、
 * レンタル料も DAO アカウントが払う。足りなければ、同じアグリゲートの中でウォレットから入金する（deposit）。
 */
export function composeRenewNamespace(actor: Actor, dao: DaoInfo, signer: AggregateSigner, ns: OwnedNamespace, days: number, fees: NamespaceRentalFees, deposit: bigint, nowMs: number): RenewNamespacePlan {
  if (!isRenewableRoot(ns)) throw new Error('not_renewable');
  if (validateRenewDays(ns, String(days), nowMs) !== null) throw new Error('invalid_days');
  const duration = BigInt(days) * BigInt(BLOCKS_PER_DAY);
  const rental = fees.rootFeePerBlock * duration;
  const build = (f: SymbolFacade): Embedded[] => {
    const reg = embNamespaceRegistration(f, dao.id, ns.name, null, duration);
    return [
      ...(deposit > 0n ? [embTransfer(f, actor.publicKey, dao.address, getNetworkConfig().currencyMosaicId, deposit)] : []),
      reg.tx,
    ];
  };
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: deposit, namespaceId: ns.id, rental };
}

/** DAO が持つルートネームスペースを、日数分延長する計画。レンタル料の相場と DAO アカウントの XYM を調べてから組み立てる。 */
export async function planRenewNamespace(actor: Actor, dao: DaoInfo, signer: AggregateSigner, ns: OwnedNamespace, days: number): Promise<RenewNamespacePlan> {
  const fees = await fetchNamespaceRentalFees();
  if (!fees) throw new Error('fee_unavailable');
  const rental = fees.rootFeePerBlock * BigInt(days) * BigInt(BLOCKS_PER_DAY);
  const deposit = await depositForRental(dao, rental);
  return composeRenewNamespace(actor, dao, signer, ns, days, fees, deposit, Date.now());
}

/** 新しいネームスペースの ID（確認画面に出す用）。 */
function embNamespaceRegistrationFor(name: string, parentId: string | null, duration: bigint): string {
  return embNamespaceRegistration(facadeFor(getNetworkConfig().networkByte), '0'.repeat(64), name, parentId, duration).id;
}

// --- 交換 ---------------------------------------------------------------------------------------

export interface ExchangeItemInput {
  rewardMosaicId: string;
  description: string;
  pointMosaicId: string;
  pointMosaicName: string;
  cost: bigint; // 特典 1 つあたりのポイント
}

/** 特典モザイクを「交換アイテム」にする（モザイクメタデータ 5 つ。既にあれば上書き）。 */
export async function planExchangeItem(actor: Actor, dao: DaoInfo, signer: AggregateSigner, item: ExchangeItemInput): Promise<DaoPlan> {
  const entries: Array<[bigint, string]> = [
    [MOSAIC_META.exchangeable, 'true'],
    [MOSAIC_META.description, item.description],
    [MOSAIC_META.pointMosaicId, item.pointMosaicId],
    [MOSAIC_META.pointMosaicName, item.pointMosaicName],
    [MOSAIC_META.exchangeCost, item.cost.toString()],
  ];
  const previous = await Promise.all(entries.map(([key]) => fetchDaoMetadataValue({ sourceAddress: dao.address, mosaicId: item.rewardMosaicId, key })));
  const build = (f: SymbolFacade): Embedded[] => entries.map(([key, value], i) => embMosaicMetadata(f, dao.id, dao.address, item.rewardMosaicId, key, encodeText(value), previous[i]));
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n };
}

/**
 * 会員の交換申請: 会員のポイントを回収し（DAO）、特典を会員へ送る（DAO）。申請（bonded）は会員が出し、管理者が連署すると成立する。
 * ハッシュロックの XYM は会員が預け、成立すると戻る。
 */
export function planRequestExchange(actor: Actor, dao: DaoInfo, signer: AggregateSigner, rewardMosaicId: string, quantity: bigint, pointMosaicId: string, cost: bigint): DaoPlan {
  const build = (f: SymbolFacade): Embedded[] => [
    embRevoke(f, dao.id, actor.address, pointMosaicId, quantity * cost),
    embTransfer(f, dao.id, actor.address, rewardMosaicId, quantity),
  ];
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n };
}

// --- ページに入る条件 ------------------------------------------------------------------------------

/** DAO のページに入る条件を変える（DAO アカウント自身のメタデータ key 7。'id' は既定なので、値 'id' を書く）。署名者は DAO。 */
export async function planSetAccess(actor: Actor, dao: DaoInfo, signer: AggregateSigner, access: DaoAccess): Promise<DaoPlan> {
  const previous = await fetchDaoMetadataValue({ sourceAddress: dao.address, targetAddress: dao.address, key: DAO_KEY.ACCESS_MODE });
  const build = (f: SymbolFacade): Embedded[] => [embAccountMetadata(f, dao.id, dao.address, DAO_KEY.ACCESS_MODE, encodeText(access), previous)];
  return { input: { publicKey: actor.publicKey, build, dao: signer }, spend: 0n };
}

// --- ガバナンス投票 -------------------------------------------------------------------------------

export const VOTE_FIXED_INNER = 3; // 索引メッセージ・モザイク定義・供給量

export interface CreateVotePlan {
  /** 送る順のアグリゲート。0 番目（complete、ウォレットだけで署名）: 索引メッセージ・投票トークンの発行・最初の会員への配布。1 番目以降: 残りの会員への配布（100 人ずつ）。 */
  batches: DaoPlan[];
  /** batches[0] と同じ（1 回目）。 */
  stage1: DaoPlan;
  voteTokenId: string;
  totalSupply: bigint;
  holders: Holder[];
  /** 最後（DAO のメタデータに 1 回目のハッシュを書く。管理者の連署が要るので bonded になりうる）。 */
  stage2: (stage1Hash: string) => DaoPlan;
}

/**
 * DAO のメタデータに投票の索引（1 回目のアグリゲートのハッシュ）を登録する。管理者の連署が要るなら bonded。
 * 投票箱 E・F が無い DAO（選択肢が 4 つまでだった頃に作ったもの）では、`boxCount` 個目までの足りない E・F を、同じアグリゲートで書き足す
 * （投票箱の鍵は秘密鍵を持たない使い捨ての公開鍵。作った後に DAO の情報を読み直せば、投票できるようになる）。
 */
function planVoteIndex(actor: Actor, dao: DaoInfo, signer: AggregateSigner, nextIndex: number, stage1Hash: string, boxCount: number): DaoPlan {
  const missing: Array<[bigint, string]> = [];
  VOTE_BOX_KEYS.forEach((key, i) => {
    if (i >= 4 && i < boxCount && !/^[0-9A-F]{64}$/.test(dao.voteBoxKeys[i] ?? '')) missing.push([key, newHarvestKeyPair().publicKey.toUpperCase()]);
  });
  return {
    input: {
      publicKey: actor.publicKey,
      build: (f) => [
        ...missing.map(([key, value]) => embAccountMetadata(f, dao.id, dao.address, key, encodeText(value))),
        embAccountMetadata(f, dao.id, dao.address, VOTE_INDEX_FIRST_KEY + BigInt(nextIndex), encodeText(stage1Hash)),
      ],
      dao: signer,
    },
    spend: 0n,
  };
}

/**
 * 投票を作る。会員（ガバナンストークンの保有者）それぞれに、（重み付けありなら）保有量と同じ量、（なしなら）1 つの投票トークン（このためだけに作る新しいモザイク）を配り、
 * 索引（タイトルと選択肢）を DAO 宛の 0 コイン送金のメッセージとして残し、そのハッシュを DAO のメタデータに登録する。
 * 会員が多いときは、配布を 100 人ずつのアグリゲートに分ける（最大 MAX_DAO_ITEMS = 1000 人）。1 回目には索引・モザイク定義・供給量の 3 件が入るので、
 * 1 回目の配布は 97 人まで、2 回目以降は 100 人ずつ。
 */
export function planCreateVote(actor: Actor, dao: DaoInfo, signer: AggregateSigner, nextIndex: number, title: string, options: readonly string[], holders: Holder[], weighted = true, endsAt = 0): CreateVotePlan {
  if (options.length > MAX_VOTE_OPTIONS) throw new Error('too_many_options');
  // 期限（UTC のミリ秒。0 = 期限なし）は、いまより後でなければ受け付けない。
  if (endsAt !== 0 && (!Number.isFinite(endsAt) || endsAt <= Date.now())) throw new Error('invalid_deadline');
  if (holders.length === 0) throw new Error('no_holders');
  if (holders.length > MAX_DAO_ITEMS) throw new Error('too_many_items');
  // 重み付けあり: 保有量と同じ量 / なし: 会員 1 人につき 1。どちらもガバナンストークンの保有者にしか配らない。
  const weightOf = (h: Holder): bigint => (weighted ? h.amount : 1n);
  const totalSupply = holders.reduce((sum, h) => sum + weightOf(h), 0n);
  const nonce = newMosaicNonce();
  const voteTokenId = aggregateMosaicId(actor.address, nonce);
  const doc = buildVoteDoc(BigInt(`0x${voteTokenId}`), title, options, weighted, endsAt);
  // 使う投票箱の数 = 一番後ろの選択肢の位置（A〜D は必ずあるので 4 以上）。E・F が無い DAO では、登録のときに足りない箱を書き足す。
  const boxCount = Math.max(4, options.reduce((last, o, i) => (o.trim() ? i + 1 : last), 0));
  const firstCount = MAX_DAO_INNER - VOTE_FIXED_INNER;
  const build1 = (f: SymbolFacade): Embedded[] => [
    embTransfer(f, actor.publicKey, dao.address, null, 0n, JSON.stringify(doc)),
    embMosaicDefinition(f, actor.publicKey, actor.address, nonce, DAO_FLAGS.vote).tx,
    embSupplyIncrease(f, actor.publicKey, voteTokenId, totalSupply),
    ...holders.slice(0, firstCount).map((h) => embTransfer(f, actor.publicKey, h.address, voteTokenId, weightOf(h))),
  ];
  const first: DaoPlan = { input: { publicKey: actor.publicKey, build: build1 }, spend: 0n };
  const rest = chunk(holders.slice(firstCount), MAX_DAO_INNER).map((part) => voteTokenBatch(actor, voteTokenId, part, weightOf));
  const batches = [first, ...rest];
  return { batches, stage1: first, voteTokenId, totalSupply, holders, stage2: (stage1Hash) => planVoteIndex(actor, dao, signer, nextIndex, stage1Hash, boxCount) };
}

/** 投票トークンを、会員へ送る 1 回分（ウォレットの署名だけ、complete）。 */
function voteTokenBatch(actor: Actor, voteTokenId: string, part: Holder[], weightOf: (h: Holder) => bigint): DaoPlan {
  const build = (f: SymbolFacade): Embedded[] => part.map((h) => embTransfer(f, actor.publicKey, h.address, voteTokenId, weightOf(h)));
  return { input: { publicKey: actor.publicKey, build }, spend: 0n };
}

export interface ResumeVotePlan {
  /** まだ投票トークンを受け取っていない会員への配布（100 人ずつ。無ければ空）。 */
  batches: DaoPlan[];
  stage2: (stage1Hash: string) => DaoPlan;
  /** 続きで配る会員の数・投票トークンの量。 */
  remaining: number;
  needed: bigint;
}

/**
 * 配布の途中で止まった投票の続き。ガバナンストークンを持っているのに、まだ投票トークンを受け取っていない会員だけに配る
 * （受け取り済みかどうかは `voteHolders`＝投票トークンの保有者のアドレスで見る）。手元の投票トークンが足りなければ 'vote_token_short'。
 */
export function planResumeVote(actor: Actor, dao: DaoInfo, signer: AggregateSigner, nextIndex: number, pending: Pick<PendingVote, 'tokenId' | 'weighted'>, members: Holder[], voteHolders: ReadonlySet<string>, actorBalance: bigint): ResumeVotePlan {
  const weightOf = (h: Holder): bigint => (pending.weighted ? h.amount : 1n);
  const todo = members.filter((h) => h.amount > 0n && !voteHolders.has(h.address));
  if (todo.length > MAX_DAO_ITEMS) throw new Error('too_many_items');
  const needed = todo.reduce((sum, h) => sum + weightOf(h), 0n);
  if (needed > actorBalance) throw new Error('vote_token_short');
  const batches = chunk(todo, MAX_DAO_INNER).map((part) => voteTokenBatch(actor, pending.tokenId, part, weightOf));
  return { batches, stage2: (stage1Hash) => planVoteIndex(actor, dao, signer, nextIndex, stage1Hash, MAX_VOTE_OPTIONS), remaining: todo.length, needed };
}

export const CLOSE_VOTE_REVOKES_PER_BATCH = MAX_DAO_INNER - 2; // 1 つのアグリゲートに、回収 + 焼却の送金 + 締め切りの印 が入る

export interface CloseVotePlan {
  /** 順に送る独立したアグリゲート（complete、投票を作ったアカウントの署名だけ）。最後の 1 つに「締め切り済み」の印が入る。 */
  batches: DaoPlan[];
  /** 回収した票の送り先（秘密鍵を捨てた使い捨てのアドレス。誰にも署名できない）。 */
  burnAddress: string;
  /** 回収する人の数・投票トークンの量（作成者自身の手元の分は含まない）。 */
  targets: number;
  revoked: bigint;
  /** 1 つのアグリゲートで回収する人数。 */
  unit: number;
}

/**
 * 投票を締め切る（投票を作ったアカウントだけができる）。投票トークンを持っている人（投票箱は除く）から、残りの投票トークンを回収して
 * （作成者が持ち主の、回収可のモザイク）、使えなくする。回収した分は作成者の手元に戻ってしまうので、同じアグリゲートの中で、
 * 誰にも署名できない使い捨てのアドレスへ送る（供給量を減らす操作は、持ち主が全量を持っていないとできない）。作成者自身の手元の分も同じ。
 * 投票箱に入った票には触らない。最後のアグリゲートに「締め切り済み」の印（投票トークンのメタデータ）を書く。
 * `holders` は投票箱と作成者自身を除いた、投票トークンの保有者。
 */
export function planCloseVote(actor: Actor, tokenId: string, holders: Holder[], myBalance: bigint): CloseVotePlan {
  const targets = holders.filter((h) => h.amount > 0n);
  if (targets.length > MAX_DAO_ITEMS) throw new Error('too_many_items');
  const burnAddress = addressFromPublicKey(newHarvestKeyPair().publicKey.toUpperCase(), getNetworkConfig().networkByte);
  const parts = targets.length === 0 ? [[] as Holder[]] : chunk(targets, CLOSE_VOTE_REVOKES_PER_BATCH);
  const batches = parts.map((part, i): DaoPlan => {
    const last = i === parts.length - 1;
    const toBurn = part.reduce((sum, h) => sum + h.amount, 0n) + (last ? myBalance : 0n);
    const build = (f: SymbolFacade): Embedded[] => [
      ...part.map((h) => embRevoke(f, actor.publicKey, h.address, tokenId, h.amount)),
      ...(toBurn > 0n ? [embTransfer(f, actor.publicKey, burnAddress, tokenId, toBurn)] : []),
      ...(last ? [embMosaicMetadata(f, actor.publicKey, actor.address, tokenId, VOTE_CLOSED_KEY, encodeText('1'))] : []),
    ];
    return { input: { publicKey: actor.publicKey, build }, spend: 0n };
  });
  return { batches, burnAddress, targets: targets.length, revoked: targets.reduce((sum, h) => sum + h.amount, 0n), unit: CLOSE_VOTE_REVOKES_PER_BATCH };
}

/** 投票する: 持っている投票トークンを、選んだ選択肢の投票箱へ全部送る（ウォレットだけで署名、complete）。 */
export function planCastVote(actor: Actor, vote: VoteView, boxPublicKey: string): DaoPlan {
  const boxAddress = addressFromPublicKey(boxPublicKey.toUpperCase(), getNetworkConfig().networkByte);
  const build = (f: SymbolFacade): Embedded[] => [embTransfer(f, actor.publicKey, boxAddress, vote.tokenId, vote.myBalance)];
  return { input: { publicKey: actor.publicKey, build }, spend: 0n };
}

// --- 特別会員限定（見本） ---------------------------------------------------------------------------

/** 会員が自分のアカウントに、選んだテーマ名をメタデータとして保存する。 */
export async function planSaveTheme(actor: Actor, themeName: string): Promise<DaoPlan> {
  const previous = await fetchDaoMetadataValue({ sourceAddress: actor.address, targetAddress: actor.address, key: THEME_META_KEY });
  const build = (f: SymbolFacade): Embedded[] => [embAccountMetadata(f, actor.publicKey, actor.address, THEME_META_KEY, encodeText(themeName), previous)];
  return { input: { publicKey: actor.publicKey, build }, spend: 0n };
}
