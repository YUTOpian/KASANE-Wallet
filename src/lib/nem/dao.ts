// NEM 版 DAO: チェーンからの読み取りと、作成・配布の送信。考え方は daoCore.ts の先頭を参照。
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  announceNemPayload, createNemMosaic, fetchNemCreatedMosaics, fetchNemMosaicDefinition, fetchNemMosaicHolding, fetchNemMosaicInfos, fetchNemMosaicSupply,
  fetchNemOwnedNamespaces, fetchNemTransactionByHash, fetchNemXemBalance, nodeRequest, sendNemTransfer,
} from './api';
import { NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from './crypto';
import type { NemKeyPair } from './crypto';
import {
  DAO_ITEM_FEE_MARGIN, DAO_MOSAIC_RENTAL, DAO_PROVISION_FEE, DAO_SEND_FEE_MARGIN, NEM_DAO_GOVERNANCE_NAME, NEM_DAO_ITEM_MOSAIC_NAME, NEM_DAO_SUPPLY, buildDaoDescription, buildExchangeMessage, buildFulfilMessage,
  buildItemDescription, depositTopUp, exchangeCost, governanceMosaicId, isGovernanceMosaicId, isNemDaoId, isValidDaoNamespace,
  itemDepositTopUp, itemMosaicId, itemNamespace, nextCreateStep, nextItemStep, normalizeMembers, parseDaoDescription, parseExchangeMessage,
  parseFulfilMessage, requestStatus, daoNamespaceOf, daoNamespaceStatus, buildThemeMessage, canOpenLimited, parseThemeMessage, selectDaoItems,
} from './daoCore';
import type {
  DaoCreateStep, DaoCreationState, NemDaoAccess, DaoItemCreateStep, DaoItemCreationState, DaoItemDoc, DaoItemKind, DaoMember, DaoNamespaceStatus, RequestStatus,
} from './daoCore';
import { toDaoMove } from './daoMoves';
import type { DaoMove, RawMove } from './daoMoves';
import { fetchNemMultisigInfo, sendNemMultisigWrapped } from './multisigApi';
import type { NemCosigner } from './multisigApi';
import { getNemNetworkConfig, nemNetworkOf } from './network';
import { NEM_MAX_MOSAIC_INITIAL_SUPPLY, nemSendFee, signNemMultisigConversion, signNemNamespaceRegistration } from './tx';
import type { NemMosaicAmount } from './tx';
import { POLL_INDEX_ADDRESS, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, fetchNemMosaicHoldings, fetchPoll, fetchPollHeaders } from './voting';
import type { Poll, PollHeader } from './voting';
import { getNetwork } from '../symbol/network';

const hexToBytes = (hex: string): Uint8Array => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * DAO アカウントの鍵は、管理者の秘密鍵とネームスペース名から決まる（保存しない）。
 * 途中で止まっても同じ名前でやり直せば同じ DAO アカウントに戻れるので、入金したあとに鍵を失うことがない。
 * 管理者の秘密鍵を知っている人だけが導ける。
 */
export function deriveDaoKeyPair(adminPrivateKey: string, namespace: string): NemKeyPair {
  const head = new TextEncoder().encode('KASANE-NEM-DAO:v1:');
  const tail = new TextEncoder().encode(`:${namespace}`);
  const seed = hexToBytes(adminPrivateKey.trim().toUpperCase());
  const input = new Uint8Array(head.length + seed.length + tail.length);
  input.set(head, 0);
  input.set(seed, head.length);
  input.set(tail, head.length + seed.length);
  return nemKeyPairFromPrivateKey(bytesToHex(keccak_256(input)));
}

/** 秘密鍵なしで、DAO アカウントのアドレスだけを知りたいとき（確認画面用）に使う。 */
export const daoAddressOf = (daoPublicKey: string): string => nemAddressFromPublicKey(daoPublicKey, getNemNetworkConfig().networkByte);

// --- 読み取り ---------------------------------------------------------------------------------
export interface NemDao {
  id: string; // DAO アカウントの公開鍵
  address: string;
  name: string;
  mosaicId: string; // ガバナンストークン
  supply: bigint;
  admins: NemCosigner[];
  minCosignatories: number; // 0 = 全員
  /** ページに入る条件（ガバナンストークンの説明に書いてある。無ければ 'id'）。 */
  access: NemDaoAccess;
}

/** DAO を読む。DAO のものでなければ Error('not_dao')。 */
export async function fetchNemDao(daoPublicKey: string): Promise<NemDao> {
  if (!isNemDaoId(daoPublicKey)) throw new Error('not_dao');
  const id = daoPublicKey.trim().toUpperCase();
  const address = daoAddressOf(id);
  const mosaics = await fetchNemCreatedMosaics(address);
  const gov = mosaics.find((m) => isGovernanceMosaicId(m.id) && parseDaoDescription(m.description) !== null);
  if (!gov) throw new Error('not_dao');
  const info = await fetchNemMultisigInfo(address);
  const supply = (await fetchNemMosaicSupply(gov.id).catch(() => null)) ?? BigInt(gov.initialSupply || '0');
  return {
    id,
    address,
    name: parseDaoDescription(gov.description)?.name ?? '',
    mosaicId: gov.id,
    supply,
    admins: info.cosignatories,
    minCosignatories: info.minCosignatories,
    access: parseDaoDescription(gov.description)?.access ?? 'id',
  };
}

/** DAO のルートネームスペース（ガバナンストークンの親）の期限の状態。一覧を読み込めなかったときは 'unknown'（解散にはしない）。 */
export async function fetchDaoNamespaceStatus(dao: NemDao): Promise<DaoNamespaceStatus> {
  try {
    return daoNamespaceStatus(await fetchNemOwnedNamespaces(dao.address), daoNamespaceOf(dao.mosaicId));
  } catch {
    return { state: 'unknown' };
  }
}

// --- ページに入る条件の変更 -------------------------------------------------------------------------

/** 条件の変更（ガバナンストークンの定義の送り直し）で DAO アカウントが払う XEM（モザイクの登録料 + 手数料 + 余裕）。 */
export const ACCESS_CHANGE_COST = DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE + DAO_ITEM_FEE_MARGIN;

/** DAO アカウントの XEM が条件の変更に足りないとき、足りない額。足りていれば 0。 */
export async function accessChangeShortfall(dao: NemDao): Promise<bigint> {
  const balance = await fetchNemXemBalance(dao.address);
  return balance >= ACCESS_CHANGE_COST ? 0n : ACCESS_CHANGE_COST - balance;
}

/**
 * 管理者が、DAO の名前で（マルチシグ経由で）ガバナンストークンの定義を同じ内容で送り直し、説明の中の「入る条件」だけを変える。
 * NIS1 にメタデータが無いので、DAO の名前と同じ場所（ガバナンストークンの説明）に書く。DAO アカウントの XEM が足りなければ、管理者から入金してから送る。
 * 連署者が複数のときは、ほかの管理者が「マルチシグ」の画面で連署するまで確定しない（反映もそのあと）。
 */
export async function changeDaoAccess(adminPrivateKey: string, adminPublicKey: string, dao: NemDao, access: NemDaoAccess): Promise<string[]> {
  const created = await fetchNemCreatedMosaics(dao.address);
  const gov = created.find((m) => m.id === dao.mosaicId);
  if (!gov) throw new Error('not_dao');
  const sep = dao.mosaicId.lastIndexOf(':');
  const hashes: string[] = [];
  const short = await accessChangeShortfall(dao);
  if (short > 0n) {
    const deposit = (await sendNemTransfer({ privateKey: adminPrivateKey, publicKey: adminPublicKey, recipient: dao.address, amount: short })).hash;
    hashes.push(deposit);
    await waitNemConfirmed(deposit);
  }
  const sent = await sendNemMultisigWrapped(adminPrivateKey, adminPublicKey, dao.id, {
    kind: 'mosaic',
    params: {
      namespace: dao.mosaicId.slice(0, sep),
      name: dao.mosaicId.slice(sep + 1),
      description: buildDaoDescription(dao.name, access),
      divisibility: gov.divisibility,
      initialSupply: BigInt(gov.initialSupply || '0'),
      supplyMutable: gov.supplyMutable,
      transferable: gov.transferable,
    },
  });
  hashes.push(sent.hash);
  return hashes;
}

/** 自分が管理者（連署者）になっている DAO。 */
export async function fetchManagedNemDaos(actorAddress: string): Promise<NemDao[]> {
  const info = await fetchNemMultisigInfo(actorAddress);
  const found = await Promise.all(info.multisigOf.slice(0, 30).map((a) => fetchNemDao(a.publicKey).catch(() => null)));
  return found.filter((d): d is NemDao => d !== null);
}

interface RawOutgoing {
  meta?: { id?: number };
  transaction: {
    type: number;
    recipient?: string;
    mosaics?: Array<{ quantity?: number | string; mosaicId?: { namespaceId?: string; name?: string } }>;
    otherTrans?: RawOutgoing['transaction'];
  };
}

/** 一つのアカウントが、そのモザイクを送った相手（アドレス）。新しい順に最大 pages ページ。 */
async function recipientsOfMosaic(sender: string, mosaicId: string, pages = 8): Promise<string[]> {
  const out = new Set<string>();
  let lastId: number | undefined;
  for (let i = 0; i < pages; i += 1) {
    const page = await nodeRequest<{ data?: RawOutgoing[] }>(
      `/account/transfers/outgoing?address=${normalizeNemAddress(sender)}&pageSize=25${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = page.data ?? [];
    for (const e of entries) {
      const tx = e.transaction.type === NEM_TX_TYPE_MULTISIG && e.transaction.otherTrans ? e.transaction.otherTrans : e.transaction;
      if (tx.type !== NEM_TX_TYPE_TRANSFER || !tx.recipient) continue;
      const moves = (tx.mosaics ?? []).some((m) => m.mosaicId && `${m.mosaicId.namespaceId}:${m.mosaicId.name}`.toLowerCase() === mosaicId.toLowerCase());
      if (moves) out.add(normalizeNemAddress(tx.recipient));
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 25 || next === undefined || next === lastId) break;
    lastId = next;
  }
  return [...out];
}

/**
 * 会員 = ガバナンストークンを持っている人。NIS1 には「モザイクの保有者一覧」が無いので、管理者（と DAO）が
 * そのトークンを送った相手を調べ、いまの保有量を読む。管理者以外から回ったトークンは一覧に出ない。
 */
export async function fetchDaoMembers(dao: NemDao): Promise<DaoMember[]> {
  const senders = [dao.address, ...dao.admins.map((a) => a.address)];
  const lists = await Promise.all(senders.map((s) => recipientsOfMosaic(s, dao.mosaicId).catch(() => [] as string[])));
  const addresses = [...new Set([...lists.flat(), ...dao.admins.map((a) => a.address)])].filter((a) => a !== dao.address);
  const holdings = await fetchNemMosaicHoldings(addresses, dao.mosaicId);
  return normalizeMembers(addresses.map((address, i) => ({ address, amount: BigInt(Math.max(0, holdings[i] ?? 0)) })));
}

export interface DaoPoll {
  header: PollHeader;
  poll: Poll;
}

/** このガバナンストークンで開かれている投票（重み付け・保有者のどちらも）。公開インデックスの新しい順に最大 pages ページ。 */
export async function fetchDaoPolls(mosaicId: string, pages = 6): Promise<DaoPoll[]> {
  const index = POLL_INDEX_ADDRESS[nemNetworkOf(getNetwork())];
  const wanted = new Map<string, PollHeader>();
  let cursor: number | undefined;
  for (let i = 0; i < pages; i += 1) {
    const page = await fetchPollHeaders(index, cursor);
    for (const h of page.headers) {
      if ((h.type === POLL_TYPE_MOSAIC || h.type === POLL_TYPE_MOSAIC_HOLDER) && !wanted.has(h.address)) wanted.set(h.address, h);
    }
    if (page.nextId === undefined) break;
    cursor = page.nextId;
  }
  const result: DaoPoll[] = [];
  const headers = [...wanted.values()];
  for (let i = 0; i < headers.length; i += 4) {
    const chunk = await Promise.all(headers.slice(i, i + 4).map(async (header) => {
      try {
        const poll = await fetchPoll(header.address);
        return poll.mosaicId?.toLowerCase() === mosaicId.toLowerCase() ? { header, poll } : null;
      } catch { return null; }
    }));
    for (const c of chunk) if (c) result.push(c);
  }
  return result;
}

// --- 作成 -------------------------------------------------------------------------------------
export type DaoCreateProblem = 'namespace_invalid' | 'namespace_taken';

/** ネームスペースの持ち主（空きなら null）。 */
async function namespaceOwner(namespace: string): Promise<string | null> {
  try {
    const res = await nodeRequest<{ owner?: string }>(`/namespace?namespace=${encodeURIComponent(namespace)}`);
    return res.owner ? normalizeNemAddress(res.owner) : null;
  } catch {
    return null; // NIS1 は空きの名前を 404 で返す
  }
}

/** 作る前のチェック。問題が無ければ null。自分（この鍵から導いた DAO アカウント）が既に持っている名前は続きとして OK。 */
export async function checkDaoNamespace(adminPrivateKey: string, namespace: string): Promise<DaoCreateProblem | null> {
  if (!isValidDaoNamespace(namespace)) return 'namespace_invalid';
  const owner = await namespaceOwner(namespace);
  if (owner === null) return null;
  return owner === daoAddressOf(deriveDaoKeyPair(adminPrivateKey, namespace).publicKey) ? null : 'namespace_taken';
}

export async function inspectCreation(daoAddress: string, namespace: string): Promise<DaoCreationState> {
  const id = governanceMosaicId(namespace);
  const [balance, namespaces, definition, holds, multisig] = await Promise.all([
    fetchNemXemBalance(daoAddress).catch(() => 0n),
    fetchNemOwnedNamespaces(daoAddress).catch(() => []),
    fetchNemMosaicDefinition(id).catch(() => null),
    fetchNemMosaicHolding(daoAddress, id).catch(() => null),
    fetchNemMultisigInfo(daoAddress).catch(() => null),
  ]);
  return {
    balance,
    namespaceOwned: namespaces.some((n) => n.name === namespace),
    mosaicDefined: definition !== null,
    daoHolds: holds ?? 0n,
    multisig: multisig?.isMultisig ?? false,
  };
}

export type DaoProgress = (step: DaoCreateStep, phase: 'sending' | 'waiting' | 'done') => void;

/** 取り込まれる（確定する）まで待つ。NIS1 のブロックは約 1 分。 */
export async function waitNemConfirmed(hash: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 6_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  while (Date.now() < deadline) {
    const tx = await fetchNemTransactionByHash(hash).catch(() => null);
    if (tx?.confirmed) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('confirm_timeout');
}

export interface CreateNemDaoInput {
  adminPrivateKey: string;
  adminPublicKey: string;
  name: string;
  namespace: string; // DAO 用のルートネームスペース（DAO アカウントが 100 XEM で借りる）
}

export interface CreateNemDaoResult {
  daoId: string;
  daoAddress: string;
  mosaicId: string;
}

/**
 * DAO を作る。順に: DAO アカウントへ入金 → ルートネームスペース登録 → ガバナンストークン作成 → 全量を管理者へ渡す → DAO をマルチシグ化（管理者が連署者）。
 * 1 手順ごとに確定を待って、チェーンの状態を読み直しながら進めるので、途中で止まっても同じ入力でもう一度実行すれば続きから進む。
 */
export async function createNemDao(input: CreateNemDaoInput, onProgress?: DaoProgress): Promise<CreateNemDaoResult> {
  const networkByte = getNemNetworkConfig().networkByte;
  const dao = deriveDaoKeyPair(input.adminPrivateKey, input.namespace);
  const daoAddress = daoAddressOf(dao.publicKey);
  const adminAddress = nemAddressFromPublicKey(input.adminPublicKey, networkByte);
  const mosaicId = governanceMosaicId(input.namespace);
  const name = input.name.trim();

  let last: DaoCreateStep | null = null;
  for (let round = 0; round < 12; round += 1) {
    const state = await inspectCreation(daoAddress, input.namespace);
    const step = nextCreateStep(state);
    if (step === null) return { daoId: dao.publicKey, daoAddress, mosaicId };
    // 同じ手順を続けて 2 回やって状態が変わらないなら、ノードが受け付けていない。
    if (step === last && round > 0) throw new Error('stuck');
    last = step;
    onProgress?.(step, 'sending');
    let hash: string;
    if (step === 'deposit') {
      hash = (await sendNemTransfer({ privateKey: input.adminPrivateKey, publicKey: input.adminPublicKey, recipient: daoAddress, amount: depositTopUp(state) })).hash;
    } else if (step === 'namespace') {
      hash = (await announceNemPayload(signNemNamespaceRegistration(dao.privateKey, { publicKey: dao.publicKey, networkByte, name: input.namespace }))).hash;
    } else if (step === 'mosaic') {
      hash = (await createNemMosaic({
        privateKey: dao.privateKey,
        publicKey: dao.publicKey,
        namespace: input.namespace,
        name: NEM_DAO_GOVERNANCE_NAME,
        description: buildDaoDescription(name),
        divisibility: 0,
        initialSupply: NEM_DAO_SUPPLY,
        supplyMutable: false,
        transferable: true,
      })).hash;
    } else if (step === 'handover') {
      hash = (await sendNemTransfer({
        privateKey: dao.privateKey,
        publicKey: dao.publicKey,
        recipient: adminAddress,
        amount: 0n,
        mosaics: [{ id: mosaicId, quantity: state.daoHolds }],
      })).hash;
    } else {
      hash = (await announceNemPayload(signNemMultisigConversion(dao.privateKey, dao.publicKey, networkByte, { minCosignatoriesDelta: 0, additions: [input.adminPublicKey], deletions: [] }))).hash;
    }
    onProgress?.(step, 'waiting');
    await waitNemConfirmed(hash);
    onProgress?.(step, 'done');
  }
  throw new Error('stuck');
}

// --- トークンの配布（管理者が自分のアカウントから送る） ----------------------------------------------
export class DaoDistributeError extends Error {
  readonly sent: number;
  constructor(sent: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.sent = sent;
  }
}

/** 宛先それぞれに同じ量を送る。途中で失敗したら、そこまでに送れた数を持つ DaoDistributeError。 */
export async function distributeGovernanceTokens(
  adminPrivateKey: string,
  adminPublicKey: string,
  mosaicId: string,
  recipients: string[],
  amount: bigint,
  onProgress?: (sent: number, total: number) => void,
): Promise<string[]> {
  const hashes: string[] = [];
  for (const to of recipients) {
    try {
      const sent = await sendNemTransfer({ privateKey: adminPrivateKey, publicKey: adminPublicKey, recipient: to, amount: 0n, mosaics: [{ id: mosaicId, quantity: amount }] });
      hashes.push(sent.hash);
    } catch (e) {
      throw new DaoDistributeError(hashes.length, e);
    }
    onProgress?.(hashes.length, recipients.length);
  }
  return hashes;
}

// --- ポイント・特典（第 3 段階。考え方は daoCore.ts の「ポイント・特典」を参照） ---------------------------------
// ポイント・特典は、DAO アカウントが DAO のネームスペースの下に作る子ネームスペースの中のモザイク。
// DAO アカウントはマルチシグなので、作る・配る・特典を渡すは、管理者が DAO の名前で（マルチシグ経由で）送る。
export interface DaoItem extends DaoItemDoc {
  id: string; // モザイク ID
  creator: string; // 作ったアカウント = DAO アカウントのアドレス（ポイントの受け取り先 = 特典の渡し元）
}

/** この DAO のネームスペースの子ネームスペースの下にある、DAO 自身が作ったポイントと特典。特典は、同じ DAO のポイントを指しているものだけ。 */
export async function fetchDaoItems(dao: NemDao): Promise<DaoItem[]> {
  const created = await fetchNemCreatedMosaics(dao.address).catch(() => []);
  return selectDaoItems(created, dao.id, dao.address, daoNamespaceOf(dao.mosaicId));
}

export interface NewDaoItem {
  kind: DaoItemKind;
  part: string; // 子ネームスペースの名前（DAO のネームスペースの下の 1 つ分。"abc.coffee" の "coffee"）
  displayName: string;
  amount: bigint; // 最初の発行量（DAO アカウントが持つ）
  description?: string;
  point?: string;
  cost?: bigint;
}

/** DAO のものとして作るポイント・特典の説明（モザイクに書く）。 */
export function newItemDoc(dao: NemDao, item: NewDaoItem): DaoItemDoc {
  return item.kind === 'point'
    ? { dao: dao.id, kind: 'point', name: item.displayName.trim() }
    : { dao: dao.id, kind: 'reward', name: item.displayName.trim(), description: (item.description ?? '').trim(), point: item.point, cost: (item.cost ?? 0n).toString() };
}

/** 作る前のモザイク ID（"abc.coffee:reward"）。 */
export const newItemMosaicId = (dao: NemDao, item: Pick<NewDaoItem, 'kind' | 'part'>): string => itemMosaicId(daoNamespaceOf(dao.mosaicId), item.part, item.kind);

export async function inspectItemCreation(dao: NemDao, namespace: string, mosaicId: string): Promise<DaoItemCreationState> {
  const [balance, namespaces, definition] = await Promise.all([
    fetchNemXemBalance(dao.address),
    fetchNemOwnedNamespaces(dao.address).catch(() => []),
    fetchNemMosaicDefinition(mosaicId).catch(() => null),
  ]);
  return { balance, namespaceOwned: namespaces.some((n) => n.name === namespace), mosaicDefined: definition !== null };
}

export type DaoItemProgress = (step: DaoItemCreateStep, phase: 'sending' | 'waiting' | 'done') => void;

/**
 * ポイント・特典を作る。順に: DAO アカウントへ足りない分を入金（管理者から）→ 子ネームスペースを登録（DAO の名前で）→ モザイクを作成（DAO の名前で）。
 * 1 手順ごとに確定を待って、チェーンの状態を読み直しながら進めるので、途中で止まっても（連署待ちで時間切れになったときも）同じ入力でもう一度実行すれば続きから進む。
 * 連署者が複数のときは、DAO の名前の取引は、ほかの管理者の連署がそろうと確定する。
 */
export async function createDaoItem(
  adminPrivateKey: string, adminPublicKey: string, dao: NemDao, item: NewDaoItem, onProgress?: DaoItemProgress,
): Promise<{ mosaicId: string; hash: string }> {
  const root = daoNamespaceOf(dao.mosaicId);
  const namespace = itemNamespace(root, item.part);
  const mosaicId = newItemMosaicId(dao, item);
  const description = buildItemDescription(newItemDoc(dao, item));
  let lastHash = '';
  let last: DaoItemCreateStep | null = null;
  for (let round = 0; round < 8; round += 1) {
    const state = await inspectItemCreation(dao, namespace, mosaicId);
    const step = nextItemStep(state);
    if (step === null) return { mosaicId, hash: lastHash };
    if (step === last && round > 0) throw new Error('stuck');
    last = step;
    onProgress?.(step, 'sending');
    let hash: string;
    if (step === 'deposit') {
      hash = (await sendNemTransfer({ privateKey: adminPrivateKey, publicKey: adminPublicKey, recipient: dao.address, amount: itemDepositTopUp(state) })).hash;
    } else if (step === 'namespace') {
      hash = (await sendNemMultisigWrapped(adminPrivateKey, adminPublicKey, dao.id, { kind: 'namespace', name: item.part, parentName: root })).hash;
    } else {
      hash = (await sendNemMultisigWrapped(adminPrivateKey, adminPublicKey, dao.id, {
        kind: 'mosaic',
        params: {
          namespace,
          name: NEM_DAO_ITEM_MOSAIC_NAME[item.kind],
          description,
          divisibility: 0,
          initialSupply: item.amount,
          supplyMutable: true,
          transferable: false,
        },
      })).hash;
    }
    lastHash = hash;
    onProgress?.(step, 'waiting');
    await waitNemConfirmed(hash);
    onProgress?.(step, 'done');
  }
  throw new Error('stuck');
}

/** DAO の名前でモザイクを送る取引の手数料（DAO アカウントが払う。送るモザイクの発行量などから決まるので、チェーンから読む）。 */
async function daoMosaicTransferFee(mosaics: NemMosaicAmount[], message: string | undefined): Promise<bigint> {
  const lines = mosaics.map((m) => ({ ...m, id: m.id.toLowerCase() }));
  const infos = await fetchNemMosaicInfos(lines.map((m) => m.id));
  if (lines.some((m) => !infos[m.id])) throw new Error('mosaic_info_unavailable');
  const feeInfos = Object.fromEntries(Object.values(infos).map((i) => [i.id, { supply: i.supply, divisibility: i.divisibility }]));
  return nemSendFee(getNemNetworkConfig().networkByte, lines, feeInfos, message);
}

/** DAO の名前で、モザイクを 1 件送る（管理者が連署者として送る。連署者が複数のときは、ほかの管理者の連署で確定する）。 */
async function sendFromDao(adminPrivateKey: string, adminPublicKey: string, dao: NemDao, recipient: string, mosaics: NemMosaicAmount[], message?: string): Promise<{ hash: string }> {
  const fee = await daoMosaicTransferFee(mosaics, message);
  return sendNemMultisigWrapped(adminPrivateKey, adminPublicKey, dao.id, { kind: 'mosaicTransfer', recipient: normalizeNemAddress(recipient), mosaics, message, fee });
}

/** DAO アカウントの XEM が、n 件の送信（手数料は DAO アカウントが払う）に足りないとき、足りない額。足りていれば 0。 */
export async function daoXemShortfall(dao: NemDao, transfers: number): Promise<bigint> {
  const balance = await fetchNemXemBalance(dao.address);
  const need = DAO_SEND_FEE_MARGIN * BigInt(Math.max(1, transfers));
  return balance >= need ? 0n : need - balance;
}

/** ポイント・特典の発行量の変更の入力チェック（問題が無ければ null）。減らせるのは DAO アカウントが持っている分まで。 */
export async function checkSupplyChange(dao: NemDao, mosaicId: string, action: 'increase' | 'decrease', delta: bigint): Promise<'supply_too_large' | 'not_held' | null> {
  if (action === 'decrease') {
    const held = await fetchNemMosaicHolding(dao.address, mosaicId).catch(() => null);
    return held !== null && held < delta ? 'not_held' : null;
  }
  const supply = await fetchNemMosaicSupply(mosaicId).catch(() => null);
  return supply !== null && supply + delta > NEM_MAX_MOSAIC_INITIAL_SUPPLY ? 'supply_too_large' : null;
}

/** 管理者が、DAO の名前でポイント・特典の発行量を増やす・減らす（増えた分・減った分は DAO アカウントのもの）。 */
export async function changeItemSupplyFromDao(
  adminPrivateKey: string, adminPublicKey: string, dao: NemDao, mosaicId: string, action: 'increase' | 'decrease', delta: bigint,
): Promise<{ hash: string }> {
  return sendNemMultisigWrapped(adminPrivateKey, adminPublicKey, dao.id, { kind: 'mosaicSupply', mosaicId, action, delta });
}

/** ポイント・特典を、DAO アカウントから宛先それぞれに同じ量ずつ送る。途中で失敗したら、そこまでに送れた数を持つ DaoDistributeError。 */
export async function distributeItemsFromDao(
  adminPrivateKey: string, adminPublicKey: string, dao: NemDao, mosaicId: string, recipients: string[], amount: bigint,
  onProgress?: (sent: number, total: number) => void,
): Promise<string[]> {
  const hashes: string[] = [];
  for (const to of recipients) {
    try {
      hashes.push((await sendFromDao(adminPrivateKey, adminPublicKey, dao, to, [{ id: mosaicId, quantity: amount }])).hash);
    } catch (e) {
      throw new DaoDistributeError(hashes.length, e);
    }
    onProgress?.(hashes.length, recipients.length);
  }
  return hashes;
}

// --- 送金の読み取り（申請と受け渡しの検索に使う。読み方は daoMoves.ts） ---

/** 送金（入ってきたもの / 出ていったもの）を新しい順に読む。マルチシグ経由のものは中身の送金として読む。 */
async function scanMoves(address: string, direction: 'incoming' | 'outgoing', pages: number): Promise<DaoMove[]> {
  const out: DaoMove[] = [];
  let lastId: number | undefined;
  for (let i = 0; i < pages; i += 1) {
    const page = await nodeRequest<{ data?: RawMove[] }>(
      `/account/transfers/${direction}?address=${normalizeNemAddress(address)}&pageSize=25${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = page.data ?? [];
    for (const e of entries) {
      const move = toDaoMove(e, getNemNetworkConfig().networkByte);
      if (move) out.push(move);
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 25 || next === undefined || next === lastId) break;
    lastId = next;
  }
  return out;
}

// --- 交換 ---
const rewardOf = (items: DaoItem[], id: string): DaoItem | undefined => items.find((i) => i.kind === 'reward' && i.id === id);
const costOf = (reward: DaoItem | undefined): bigint | null => (reward?.cost ? BigInt(reward.cost) : null);

/** 会員が、ポイントを管理者へ送って特典を申請する（メッセージに欲しい特典と個数を書く）。 */
export async function requestExchange(
  memberPrivateKey: string, memberPublicKey: string, reward: DaoItem, quantity: bigint,
): Promise<{ hash: string }> {
  const cost = costOf(reward);
  if (cost === null || !reward.point) throw new Error('not_reward');
  return sendNemTransfer({
    privateKey: memberPrivateKey,
    publicKey: memberPublicKey,
    recipient: reward.creator,
    amount: 0n,
    mosaics: [{ id: reward.point, quantity: exchangeCost(quantity, cost) }],
    message: buildExchangeMessage(reward.id, quantity),
  });
}

export interface ExchangeRequest {
  hash: string;
  from: string;
  rewardId: string;
  quantity: bigint;
  paid: bigint;
  status: RequestStatus;
}

/**
 * DAO アカウントに届いた申請（まだ渡していないものを先に）。
 * 渡し済みかは、DAO の名前で出た送金（管理者が連署者として出したもの。DAO アカウントの履歴と、各管理者の履歴の両方から探す）に、その申請への返事があるかで決まる。
 */
export async function fetchExchangeRequests(dao: NemDao, items: DaoItem[], pages = 6): Promise<ExchangeRequest[]> {
  const [incoming, ...outgoingLists] = await Promise.all([
    scanMoves(dao.address, 'incoming', pages),
    ...[dao.address, ...dao.admins.map((a) => a.address)].map((a) => scanMoves(a, 'outgoing', pages).catch(() => [] as DaoMove[])),
  ]);
  const fulfilled = new Set(outgoingLists.flat().filter((m) => m.from === dao.address).map((m) => parseFulfilMessage(m.message)).filter((h): h is string => h !== null));
  const result: ExchangeRequest[] = [];
  for (const m of incoming) {
    const req = parseExchangeMessage(m.message);
    const reward = req ? rewardOf(items, req.reward) : undefined;
    if (!req || !reward || !reward.point) continue;
    const paid = m.mosaics.get(reward.point) ?? 0n;
    result.push({
      hash: m.hash, from: m.from, rewardId: reward.id, quantity: req.quantity, paid,
      status: requestStatus({ paid, quantity: req.quantity, cost: costOf(reward), fulfilled: fulfilled.has(m.hash) }),
    });
  }
  return result.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'));
}

/** 管理者が、DAO の名前で申請に応えて特典を渡す（どの申請への返事かをメッセージに書く）。 */
export async function fulfilExchange(adminPrivateKey: string, adminPublicKey: string, dao: NemDao, request: ExchangeRequest): Promise<{ hash: string }> {
  return sendFromDao(adminPrivateKey, adminPublicKey, dao, request.from, [{ id: request.rewardId, quantity: request.quantity }], buildFulfilMessage(request.hash));
}

export interface MyExchange {
  hash: string;
  rewardId: string;
  quantity: bigint;
  done: boolean;
}

/** 自分が出した申請と、渡してもらえたか（特典を作った管理者からの返事が届いているか）。 */
export async function fetchMyExchanges(myAddress: string, items: DaoItem[], pages = 4): Promise<MyExchange[]> {
  const [outgoing, incoming] = await Promise.all([scanMoves(myAddress, 'outgoing', pages), scanMoves(myAddress, 'incoming', pages)]);
  const answered = new Set<string>();
  for (const m of incoming) {
    const h = parseFulfilMessage(m.message);
    if (h && items.some((i) => i.creator === m.from && m.mosaics.has(i.id))) answered.add(h);
  }
  const result: MyExchange[] = [];
  for (const m of outgoing) {
    const req = parseExchangeMessage(m.message);
    if (!req || !rewardOf(items, req.reward)) continue;
    result.push({ hash: m.hash, rewardId: req.reward, quantity: req.quantity, done: answered.has(m.hash) });
  }
  return result;
}

// --- 特別会員限定（テーマの見本。考え方は daoCore.ts の「特別会員限定」を参照） ---

/** 「特別会員限定」を開けるか。特典の保有量が 1 つでも読めなかった（null）ときは、読めた分だけで決める。 */
export async function canEnterLimited(items: DaoItem[], address: string, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const rewards = items.filter((i) => i.kind === 'reward');
  const holdings = await Promise.all(rewards.map((r) => fetchNemMosaicHolding(address, r.id)));
  return canOpenLimited(false, holdings);
}

/** 自分が最後に保存したテーマ（自分宛ての送金のメッセージから読む）。無ければ null。 */
export async function fetchMyTheme(address: string, pages = 3): Promise<string | null> {
  const mine = normalizeNemAddress(address);
  const moves = await scanMoves(mine, 'outgoing', pages);
  for (const m of moves) {
    if (m.to !== mine) continue;
    const theme = parseThemeMessage(m.message);
    if (theme) return theme;
  }
  return null;
}

/** テーマを保存する（自分宛ての 0 XEM の送金。手数料は自分が払う）。 */
export async function saveMyTheme(privateKey: string, publicKey: string, address: string, theme: string): Promise<{ hash: string }> {
  return sendNemTransfer({ privateKey, publicKey, recipient: normalizeNemAddress(address), amount: 0n, message: buildThemeMessage(theme) });
}
