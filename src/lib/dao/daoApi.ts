// DAO の読み取り（元アプリのサーバーの GET ルートの置き換え）: ノードの REST を直接読む。
import { fetchOwnedNamespaces, getMosaicInfos, nodeRequest } from '../symbol/api';
import type { OwnedNamespace } from '../symbol/api';
import { MAX_NAMESPACE_DEPTH, isValidNamespaceName } from '../symbol/tx';
import { addressBytesToString, addressFromPublicKey, hexToBytes, normalizeAddress } from '../symbol/crypto';
import { fetchMultisigInfo } from '../symbol/multisigApi';
import { generateNamespaceId } from 'symbol-sdk/symbol';
import { getNetworkConfig } from '../symbol/network';
import { DAO_KEY, MOSAIC_META, VOTE_BOX_KEYS, VOTE_CLOSED_KEY, VOTE_INDEX_FIRST_KEY, hex16, parseDaoAccess, parseVoteMessage, voteTokenHex } from './daoCore';
import type { DaoAccess, DaoMosaicKind, VoteDoc } from './daoCore';

const PAGE = 100;
const MAX_PAGES = 10;

interface MetaRow {
  metadataEntry: { scopedMetadataKey: string; value: string; sourceAddress: string; targetAddress: string; targetId: string };
}

const decode = (hex: string): string => new TextDecoder().decode(hexToBytes(hex));
const keyOf = (row: MetaRow): bigint => BigInt(`0x${row.metadataEntry.scopedMetadataKey}`);

/** `/metadata?…` を最後のページまで読む。 */
async function metadataRows(query: string): Promise<MetaRow[]> {
  const out: MetaRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data: MetaRow[] }>(`/metadata?${query}&pageSize=${PAGE}&pageNumber=${page}`);
    out.push(...res.data);
    if (res.data.length < PAGE) break;
  }
  return out;
}

export const daoAddressOf = (publicKey: string): string => addressFromPublicKey(publicKey.toUpperCase(), getNetworkConfig().networkByte);

export const isDaoId = (text: string): boolean => /^[0-9a-fA-F]{64}$/.test(text.trim());

// --- DAO 本体 ----------------------------------------------------------------------------------

export interface DaoInfo {
  id: string; // DAO アカウントの公開鍵（URL の :id）
  address: string;
  name: string;
  governanceTokenId: string; // 16 hex
  voteBoxKeys: string[]; // 投票箱 A〜F の公開鍵（無ければ空文字。E・F は以前に作った DAO には無い）
  voteIndex: { key: bigint; txHash: string }[]; // 投票の索引（古い順）
  admins: string[]; // 連署者（管理者）のアドレス
  minApproval: number;
  /** ページに入る条件（DAO 自身が付けたメタデータ。無ければ 'id'）。 */
  access: DaoAccess;
}

async function accountExists(address: string): Promise<boolean> {
  try {
    await nodeRequest(`/accounts/${normalizeAddress(address)}`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

/** DAO アカウントのメタデータとマルチシグから DAO の情報を組み立てる。DAO でなければ Error('not_dao')、アカウントが無ければ Error('not_found')。 */
export async function fetchDao(publicKey: string): Promise<DaoInfo> {
  const id = publicKey.trim().toUpperCase();
  if (!isDaoId(id)) throw new Error('not_dao');
  const address = daoAddressOf(id);
  const rows = await metadataRows(`targetAddress=${address}&metadataType=0`);
  const values = new Map<bigint, string>();
  const index: { key: bigint; txHash: string }[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const text = decode(row.metadataEntry.value);
    if (key >= VOTE_INDEX_FIRST_KEY) index.push({ key, txHash: text.trim().toUpperCase() });
    else values.set(key, text);
  }
  const governanceTokenId = values.get(DAO_KEY.GOVERNANCE_TOKEN_ID)?.trim().toUpperCase();
  if (!governanceTokenId || !/^[0-9A-F]{16}$/.test(governanceTokenId)) {
    // アカウント自体がこのネットワークに無いのか（ネットワークの選び間違いなど）、あるが DAO の印が無いのかを区別する。
    throw new Error((await accountExists(address)) ? 'not_dao' : 'not_found');
  }
  const multisig = await fetchMultisigInfo(address);
  // 入る条件は DAO 自身が付けたものだけを読む（管理者が自分の名前で付けた同じキーは無視）。読めなければ、開けてしまわないよう失敗にする。
  const accessRows = await metadataRows(`targetAddress=${address}&sourceAddress=${address}&metadataType=0&scopedMetadataKey=${hex16(DAO_KEY.ACCESS_MODE)}`);
  const access = parseDaoAccess(accessRows.length > 0 ? decode(accessRows[0].metadataEntry.value) : undefined);
  return {
    id,
    address,
    name: values.get(DAO_KEY.DAO_NAME) ?? '',
    governanceTokenId,
    voteBoxKeys: VOTE_BOX_KEYS.map((k) => (values.get(k) ?? '').trim().toUpperCase()),
    voteIndex: index.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    admins: multisig.cosignatories,
    minApproval: multisig.minApproval,
    access,
  };
}

// --- モザイク（ポイント・特典・ガバナンストークン） -----------------------------------------------

export interface DaoExchangeInfo {
  pointMosaicId: string;
  pointMosaicName: string;
  description: string;
  cost: bigint;
}

export interface DaoMosaic {
  id: string; // 16 hex
  name: string;
  kind: DaoMosaicKind;
  supply: bigint;
  held: bigint; // DAO アカウントの手元にある量（配布できる残り）
  namespace: string; // 紐付いているネームスペース（無ければ ''）
  exchange: DaoExchangeInfo | null; // 特典のうち、交換アイテムに設定されているもの
}

interface MosaicRow {
  mosaic: { id: string; supply: string; divisibility: number; flags: number };
}

/** DAO アカウントが作ったモザイクのうち、ポイント・特典として印の付いたもの。 */
export async function fetchDaoMosaics(dao: Pick<DaoInfo, 'address' | 'governanceTokenId'>): Promise<DaoMosaic[]> {
  const mosaics: MosaicRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data: MosaicRow[] }>(`/mosaics?ownerAddress=${dao.address}&pageSize=${PAGE}&pageNumber=${page}`);
    mosaics.push(...res.data);
    if (res.data.length < PAGE) break;
  }
  const held = await fetchHeld(dao.address);
  const result: DaoMosaic[] = [];
  await Promise.all(mosaics.filter((m) => m.mosaic.id.toUpperCase() !== dao.governanceTokenId).map(async (m) => {
    const id = m.mosaic.id.toUpperCase();
    const rows = await metadataRows(`targetId=${id}&metadataType=1&sourceAddress=${dao.address}`);
    const meta = new Map<bigint, string>(rows.map((r) => [keyOf(r), decode(r.metadataEntry.value)]));
    const type = meta.get(MOSAIC_META.type);
    if (type !== 'point' && type !== 'reward') return;
    const exchangeable = meta.get(MOSAIC_META.exchangeable) === 'true';
    const costText = meta.get(MOSAIC_META.exchangeCost) ?? '';
    result.push({
      id,
      name: meta.get(MOSAIC_META.name) || id,
      kind: type,
      supply: BigInt(m.mosaic.supply),
      held: held.get(id) ?? 0n,
      exchange: type === 'reward' && exchangeable && /^\d+$/.test(costText)
        ? {
          pointMosaicId: (meta.get(MOSAIC_META.pointMosaicId) ?? '').toUpperCase(),
          pointMosaicName: meta.get(MOSAIC_META.pointMosaicName) || (meta.get(MOSAIC_META.pointMosaicId) ?? ''),
          description: meta.get(MOSAIC_META.description) ?? '',
          cost: BigInt(costText),
        }
        : null,
      namespace: '',
    });
  }));
  const names = await fetchMosaicNamespaceNames(result.map((m) => m.id));
  for (const m of result) m.namespace = names[m.id] ?? '';
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** モザイクに紐付いているネームスペース名（モザイク ID → 名前）。紐付いていないもの・読めなかったものは入らない。 */
export async function fetchMosaicNamespaceNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const res = await nodeRequest<{ mosaicNames: Array<{ mosaicId: string; names: string[] }> }>('/namespaces/mosaic/names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mosaicIds: ids }),
    });
    const out: Record<string, string> = {};
    for (const e of res.mosaicNames) if (e.names.length > 0) out[e.mosaicId.toUpperCase()] = e.names[0];
    return out;
  } catch {
    return {};
  }
}

/** ガバナンストークンの発行量と DAO の手元の量・紐付いたネームスペース（ポイント・特典と違い、メタデータの印は無い）。 */
export async function fetchGovernanceToken(dao: Pick<DaoInfo, 'address' | 'governanceTokenId'>): Promise<{ id: string; supply: bigint; held: bigint; namespace: string }> {
  const [info, held, names] = await Promise.all([
    nodeRequest<MosaicRow>(`/mosaics/${dao.governanceTokenId}`),
    fetchHeld(dao.address),
    fetchMosaicNamespaceNames([dao.governanceTokenId]),
  ]);
  return { id: dao.governanceTokenId, supply: BigInt(info.mosaic.supply), held: held.get(dao.governanceTokenId) ?? 0n, namespace: names[dao.governanceTokenId] ?? '' };
}

// --- ネームスペースの紐付け -------------------------------------------------------------------------

/** 入力したネームスペース名で、何ができるか。 */
export type NamespaceLookup =
  | { kind: 'invalid' }
  | { kind: 'owned'; id: string } // DAO が持っていて、そのまま紐付けられる
  | { kind: 'owned_alias' } // DAO のものだが、すでに何かに紐付いている
  | { kind: 'owned_expired' } // DAO のものだが、期限切れ
  | { kind: 'root' } // 新しく作れるルート
  | { kind: 'child'; parentId: string; parentName: string } // 親が DAO のもので、新しく作れる子
  | { kind: 'taken' } // 他の人が使っている
  | { kind: 'no_parent' } // 親がまだ無い（先に親を作る）
  | { kind: 'parent_other' }; // 親が他の人のもの・期限切れで、子を作れない

export const namespaceIdOfName = (labels: string[]): string => {
  let parent = 0n;
  for (const label of labels) parent = BigInt(generateNamespaceId(label, parent));
  return parent.toString(16).toUpperCase().padStart(16, '0');
};

async function namespaceExists(id: string): Promise<boolean> {
  try {
    await nodeRequest(`/namespaces/${id}`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

/** ネームスペース名を調べる。`owned` は DAO が持っている（期限切れ含む）ネームスペースの一覧（fetchOwnedNamespaces）。 */
export async function lookupNamespace(fullName: string, owned: OwnedNamespace[]): Promise<NamespaceLookup> {
  const labels = fullName.trim().toLowerCase().split('.');
  if (labels.length > MAX_NAMESPACE_DEPTH || !labels.every(isValidNamespaceName)) return { kind: 'invalid' };
  const name = labels.join('.');
  const mine = owned.find((n) => n.name === name);
  if (mine) {
    if (mine.expired) return { kind: 'owned_expired' };
    return mine.aliasType === 'none' ? { kind: 'owned', id: mine.id } : { kind: 'owned_alias' };
  }
  if (await namespaceExists(namespaceIdOfName(labels))) return { kind: 'taken' };
  if (labels.length === 1) return { kind: 'root' };
  const parentLabels = labels.slice(0, -1);
  const parentName = parentLabels.join('.');
  const parent = owned.find((n) => n.name === parentName);
  if (parent) return parent.expired ? { kind: 'parent_other' } : { kind: 'child', parentId: parent.id, parentName };
  return (await namespaceExists(namespaceIdOfName(parentLabels))) ? { kind: 'parent_other' } : { kind: 'no_parent' };
}

export { fetchOwnedNamespaces };
export type { OwnedNamespace };

/** アカウントが持っているモザイクの量（モザイク ID → 量）。持っていないアカウントは空。 */
export async function fetchHeld(address: string): Promise<Map<string, bigint>> {
  try {
    const res = await nodeRequest<{ account: { mosaics?: Array<{ id: string; amount: string }> } }>(`/accounts/${normalizeAddress(address)}`);
    return new Map((res.account.mosaics ?? []).map((m) => [m.id.toUpperCase(), BigInt(m.amount)]));
  } catch (e) {
    if ((e as { status?: number }).status === 404) return new Map();
    throw e;
  }
}

export interface Holder {
  address: string;
  amount: bigint;
}

/** モザイクを持っているアカウントの一覧（DAO アカウント自身を除く）。 */
export async function fetchHolders(mosaicId: string, excludeAddress: string): Promise<Holder[]> {
  const id = mosaicId.toUpperCase();
  const out: Holder[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data: Array<{ account: { address: string; mosaics: Array<{ id: string; amount: string }> } }> }>(
      `/accounts?mosaicId=${id}&pageSize=${PAGE}&pageNumber=${page}`,
    );
    for (const row of res.data) {
      const address = addressBytesToString(hexToBytes(row.account.address));
      const amount = row.account.mosaics.find((m) => m.id.toUpperCase() === id)?.amount;
      if (address !== normalizeAddress(excludeAddress) && amount) out.push({ address, amount: BigInt(amount) });
    }
    if (res.data.length < PAGE) break;
  }
  return out;
}

/** ガバナンストークンを持つ人 = DAO の会員。 */
export const fetchMembers = (dao: Pick<DaoInfo, 'address' | 'governanceTokenId'>): Promise<Holder[]> => fetchHolders(dao.governanceTokenId, dao.address);

export interface MyHolding {
  id: string;
  name: string;
  kind: DaoMosaicKind | 'governance';
  amount: bigint;
}

/** 自分が持っている、この DAO のガバナンストークン・ポイント・特典。 */
export async function fetchMyHoldings(dao: DaoInfo, myAddress: string, mosaics: DaoMosaic[]): Promise<MyHolding[]> {
  const mine = await fetchHeld(myAddress);
  const out: MyHolding[] = [];
  const gov = mine.get(dao.governanceTokenId);
  if (gov) out.push({ id: dao.governanceTokenId, name: dao.name, kind: 'governance', amount: gov });
  for (const m of mosaics) {
    const amount = mine.get(m.id);
    if (amount) out.push({ id: m.id, name: m.name, kind: m.kind, amount });
  }
  return out;
}

/** モザイクの現在の供給量・可分性（DAO のモザイクは可分性 0）。 */
export async function fetchDivisibility(ids: string[]): Promise<Record<string, number>> {
  const infos = await getMosaicInfos(ids);
  return Object.fromEntries(ids.map((id) => [id, infos[id]?.divisibility ?? 0]));
}

// --- メタデータの現在値（更新で差分を取るため） -----------------------------------------------------

/** 既にあるメタデータの値（無ければ null）。 */
export async function fetchDaoMetadataValue(query: { sourceAddress: string; key: bigint } & ({ targetAddress: string } | { mosaicId: string })): Promise<Uint8Array | null> {
  const key = query.key.toString(16).toUpperCase().padStart(16, '0');
  const target = 'mosaicId' in query ? `targetId=${query.mosaicId.toUpperCase()}&metadataType=1` : `targetAddress=${normalizeAddress(query.targetAddress)}&metadataType=0`;
  const res = await nodeRequest<{ data: MetaRow[] }>(`/metadata?${target}&sourceAddress=${normalizeAddress(query.sourceAddress)}&scopedMetadataKey=${key}`);
  return res.data.length > 0 ? hexToBytes(res.data[0].metadataEntry.value) : null;
}

// --- 投票 ------------------------------------------------------------------------------------

export interface VoteView {
  index: number; // 0 始まり、古い順
  txHash: string;
  doc: VoteDoc;
  tokenId: string; // 16 hex
  tallies: bigint[]; // 投票箱 A〜F が受け取った投票トークンの量（期限つきで期限を過ぎたものは、期限後に送られた分を除く）
  myBalance: bigint; // 自分がまだ使っていない投票トークン
  /** 投票を作ったアカウント（投票トークンの持ち主）のアドレス。読めなければ空文字。締め切れるのはこのアカウントだけ。 */
  creator: string;
  /** 締め切り済み（作成者が残りの投票トークンを回収した印がチェーン上にある）。 */
  closedOnChain: boolean;
  /** 期限後に投票箱へ送られたため、集計から除いた票の合計。 */
  lateExcluded: bigint;
  /** 期限を過ぎているのに、期限後の送金を調べられなかった（集計に期限後の票が入っているかもしれない）。 */
  lateUnknown: boolean;
}

// --- 期限後の送金を集計から除く ---------------------------------------------------------------------

/**
 * 高さ 1〜chainHeight のうち、ブロックの時刻（UTC ミリ秒）が endMs 以前の最後の高さ。無ければ 0。
 * ブロックの時刻は高さとともに増えるので、補間（時刻から高さを見積もる）と二分探索を交互に行う（最悪でも二分探索の 2 倍の回数）。
 */
export async function searchHeightAtOrBefore(endMs: number, chainHeight: number, timeAt: (height: number) => Promise<number>): Promise<number> {
  if (chainHeight < 1) return 0;
  let lo = 1;
  let tLo = await timeAt(lo);
  if (tLo > endMs) return 0;
  let hi = chainHeight;
  let tHi = await timeAt(hi);
  if (tHi <= endMs) return chainHeight;
  // 不変条件: time(lo) <= endMs < time(hi)
  for (let step = 0; hi - lo > 1; step += 1) {
    let probe = Math.floor((lo + hi) / 2);
    if (step % 2 === 0 && tHi > tLo) probe = lo + Math.floor(((endMs - tLo) / (tHi - tLo)) * (hi - lo));
    probe = Math.min(hi - 1, Math.max(lo + 1, probe));
    const t = await timeAt(probe);
    if (t <= endMs) { lo = probe; tLo = t; } else { hi = probe; tHi = t; }
  }
  return lo;
}

const cutoffCache = new Map<string, number>();

/** 期限（UTC ミリ秒）以前で最後に確定したブロックの高さ。チェーンがまだ期限に届いていなければ null（期限後の送金はまだ無い）。 */
export async function fetchCutoffHeight(endMs: number): Promise<number | null> {
  const cfg = getNetworkConfig();
  const key = `${cfg.networkByte}:${endMs}`;
  const cached = cutoffCache.get(key);
  if (cached !== undefined) return cached;
  const chain = await nodeRequest<{ height: string }>('/chain/info');
  const tip = Number(chain.height);
  const timeAt = async (height: number): Promise<number> => {
    const res = await nodeRequest<{ block: { timestamp: string } }>(`/blocks/${height}`);
    return Number(res.block.timestamp) + cfg.epochAdjustment * 1000;
  };
  if ((await timeAt(tip)) <= endMs) return null;
  const height = await searchHeightAtOrBefore(endMs, tip, timeAt);
  cutoffCache.set(key, height); // 期限より後のブロックができたあとは動かない値
  return height;
}

interface ConfirmedRow {
  meta: { height: string };
  transaction: { mosaics?: Array<{ id: string; amount: string }> };
}

/** 新しい順の取引のうち、cutoffHeight より後のブロックで確定した分の、tokenId の量の合計。古い取引（cutoffHeight 以前）に届いたら done = true。 */
export function sumLateTransfers(rows: ConfirmedRow[], tokenId: string, cutoffHeight: number): { amount: bigint; done: boolean } {
  const id = tokenId.toUpperCase();
  let amount = 0n;
  for (const row of rows) {
    if (Number(row.meta.height) <= cutoffHeight) return { amount, done: true };
    for (const m of row.transaction.mosaics ?? []) if (m.id.toUpperCase() === id) amount += BigInt(m.amount);
  }
  return { amount, done: false };
}

/** 投票箱へ、cutoffHeight より後に届いた tokenId の量（アグリゲートの中の送金も、単独の送金も数える）。 */
async function fetchLateIncoming(boxAddress: string, tokenId: string, cutoffHeight: number): Promise<bigint> {
  let total = 0n;
  for (const embedded of [true, false]) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await nodeRequest<{ data: ConfirmedRow[] }>(
        `/transactions/confirmed?recipientAddress=${normalizeAddress(boxAddress)}&embedded=${embedded}&order=desc&pageSize=${PAGE}&pageNumber=${page}`,
      );
      const part = sumLateTransfers(res.data, tokenId, cutoffHeight);
      total += part.amount;
      if (part.done || res.data.length < PAGE) break;
    }
  }
  return total;
}

/** 投票トークンのモザイクの持ち主（投票を作ったアカウント）。tokenId（16 hex・大文字）→ アドレス。 */
async function fetchMosaicOwners(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await nodeRequest<Array<{ mosaic: { id: string; ownerAddress: string } }>>('/mosaics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mosaicIds: ids }),
  });
  return new Map(rows.map((r) => [r.mosaic.id.toUpperCase(), addressBytesToString(hexToBytes(r.mosaic.ownerAddress))]));
}

/** 作成者が付けた「締め切り済み」の印があるか。 */
async function fetchVoteClosed(tokenId: string, creator: string): Promise<boolean> {
  const rows = await nodeRequest<{ data: unknown[] }>(
    `/metadata?targetId=${tokenId}&metadataType=1&sourceAddress=${normalizeAddress(creator)}&scopedMetadataKey=${hex16(VOTE_CLOSED_KEY)}`,
  );
  return rows.data.length > 0;
}

/** 投票の一覧（索引のメタデータ → 作成トランザクションのメッセージ）と、各投票の集計。 */
export async function fetchVotes(dao: DaoInfo, myAddress: string): Promise<VoteView[]> {
  if (dao.voteIndex.length === 0) return [];
  const confirmed = await nodeRequest<Array<{ meta: { hash: string }; transaction: { transactions?: Array<{ transaction: { message?: string } }> } }>>(
    '/transactions/confirmed',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactionIds: dao.voteIndex.map((v) => v.txHash) }) },
  );
  const byHash = new Map(confirmed.map((c) => [c.meta.hash.toUpperCase(), c]));
  const boxKeys = dao.voteBoxKeys.filter((k) => /^[0-9A-F]{64}$/.test(k));
  const boxes = boxKeys.length > 0
    ? await nodeRequest<Array<{ account: { address: string; mosaics?: Array<{ id: string; amount: string }> } }>>(
      '/accounts',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKeys: boxKeys }) },
    ).catch(() => [])
    : [];
  const boxByAddress = new Map(boxes.map((b) => [addressBytesToString(hexToBytes(b.account.address)), b.account.mosaics ?? []]));
  const mine = await fetchHeld(myAddress);
  const parsed = dao.voteIndex.flatMap((entry, i) => {
    const doc = parseVoteMessage(byHash.get(entry.txHash)?.transaction.transactions?.[0]?.transaction.message);
    return doc ? [{ entry, i, doc, tokenId: voteTokenHex(doc) }] : [];
  });
  const owners = await fetchMosaicOwners(parsed.map((p) => p.tokenId)).catch(() => new Map<string, string>());
  const boxAddresses = dao.voteBoxKeys.map((key) => (/^[0-9A-F]{64}$/.test(key) ? daoAddressOf(key) : ''));
  return Promise.all(parsed.map(async ({ entry, i, doc, tokenId }): Promise<VoteView> => {
    const creator = owners.get(tokenId) ?? '';
    const closedOnChain = creator ? await fetchVoteClosed(tokenId, creator).catch(() => false) : false;
    let tallies = boxAddresses.map((address) => {
      const held = address ? boxByAddress.get(address) : undefined;
      return BigInt(held?.find((m) => m.id.toUpperCase() === tokenId)?.amount ?? 0);
    });
    // 期限つきで、期限が過ぎていて、まだ締め切られていない投票: 期限後に投票箱へ送られた分を集計から除く。
    // （締め切り済みなら、残りの投票トークンは回収されていて、これ以上動かない。）
    let lateExcluded = 0n;
    let lateUnknown = false;
    if (!closedOnChain && doc.end > 0 && Date.now() >= doc.end) {
      try {
        const cutoff = await fetchCutoffHeight(doc.end);
        if (cutoff !== null) {
          const late = await Promise.all(boxAddresses.map((address, j) => (address && tallies[j] > 0n ? fetchLateIncoming(address, tokenId, cutoff) : Promise.resolve(0n))));
          tallies = tallies.map((t, j) => (late[j] > t ? 0n : t - late[j]));
          lateExcluded = late.reduce((s, n) => s + n, 0n);
        }
      } catch {
        lateUnknown = true;
      }
    }
    return { index: i, txHash: entry.txHash, doc, tokenId, tallies, myBalance: mine.get(tokenId) ?? 0n, creator, closedOnChain, lateExcluded, lateUnknown };
  }));
}


/** 会員が自分のアカウントに保存したテーマ名（無ければ null）。 */
export async function fetchTheme(address: string): Promise<string | null> {
  const { THEME_META_KEY } = await import('./daoCore');
  const value = await fetchDaoMetadataValue({ sourceAddress: address, targetAddress: address, key: THEME_META_KEY });
  return value ? new TextDecoder().decode(value) : null;
}
