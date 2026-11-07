// NEM 版 DAO: 定数と、ネットワークに触れない純粋な関数。
//
// Symbol の DAO は「アカウントメタデータ」「回収可能なモザイク」「アグリゲート」の上に作られているが、NIS1 にはどれも無い。
// そこで NEM 版は次の形にする（Symbol 版と画面・考え方をそろえつつ、NEM にある部品だけで組む）。
//   - DAO = マルチシグのアカウント。作った人が管理者（連署者）。ID は DAO アカウントの公開鍵（Symbol 版と同じ）。
//   - ガバナンストークン = DAO アカウントが自分のルートネームスペースの下に作るモザイク「<名前空間>:gov」。
//     DAO の名前は、このモザイクの「説明」に目印つきの JSON として書く（NIS1 にメタデータが無いので）。
//   - 発行した分は、DAO を作る途中で管理者に渡す。会員への配布は、管理者が自分のアカウントから送る（マルチシグ経由でモザイクを送らずに済む）。
//   - 投票 = 既存の NEM 投票（モザイク保有量で重み付け / 保有者だけ）。投票はガバナンストークンの保有者が対象。

/** DAO の目印（ガバナンストークンの説明の先頭）。 */
export const NEM_DAO_MARK = 'KASANE-DAO:';

/** ガバナンストークンの名前（名前空間の下の名前）。 */
export const NEM_DAO_GOVERNANCE_NAME = 'gov';

/** ガバナンストークンの発行量（Symbol 版と同じ）。可分性は 0。 */
export const NEM_DAO_SUPPLY = 1_000_000n;

export const NEM_DAO_NAME_MAX_BYTES = 100;
/** NIS1 のモザイクの説明の上限（バイト）。 */
export const NEM_DAO_DESCRIPTION_MAX_BYTES = 512;
/** ルートネームスペースの名前の上限。 */
export const NEM_DAO_NAMESPACE_MAX_LENGTH = 16;

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** DAO の ID = DAO アカウントの公開鍵（64 桁の 16 進）。 */
export const isNemDaoId = (value: string): boolean => /^[0-9a-fA-F]{64}$/.test(value.trim());

/** DAO 用のルートネームスペースの名前として使えるか（小文字・数字・'_'・'-'、先頭は英数字、16 文字まで）。 */
export const isValidDaoNamespace = (name: string): boolean =>
  name.length > 0 && name.length <= NEM_DAO_NAMESPACE_MAX_LENGTH && /^[a-z0-9][a-z0-9_-]*$/.test(name);

/** ガバナンストークンのモザイク ID（"名前空間:gov"）。 */
export const governanceMosaicId = (namespace: string): string => `${namespace}:${NEM_DAO_GOVERNANCE_NAME}`;

/** DAO のページに入る条件。id = DAO の ID（公開鍵）だけで入れる（既定）/ token = ID に加えてガバナンストークンの保有が要る。管理者は常に入れる。 */
export type NemDaoAccess = 'id' | 'token';

/** ガバナンストークンの説明（目印 + JSON）。入る条件が 'id'（既定）のときは access を書かない（これまでの形のまま）。 */
export function buildDaoDescription(name: string, access: NemDaoAccess = 'id'): string {
  return `${NEM_DAO_MARK}${JSON.stringify({ v: 1, name, ...(access === 'token' ? { access } : {}) })}`;
}

/** 説明から DAO の名前と入る条件を読む。DAO のものでなければ null。access が無い・知らない値は 'id'。 */
export function parseDaoDescription(description: string | undefined): { name: string; access: NemDaoAccess } | null {
  if (!description || !description.startsWith(NEM_DAO_MARK)) return null;
  try {
    const json = JSON.parse(description.slice(NEM_DAO_MARK.length)) as { v?: unknown; name?: unknown; access?: unknown };
    if (typeof json.name !== 'string') return null;
    return { name: json.name, access: json.access === 'token' ? 'token' : 'id' };
  } catch {
    return null;
  }
}

/** ページに入れるか。管理者は常に入れる。token のときは、ガバナンストークンを 1 つ以上持っている人だけ。 */
export const canEnterNemDao = (access: NemDaoAccess, isAdmin: boolean, governanceHeld: bigint): boolean => access === 'id' || isAdmin || governanceHeld > 0n;

/** ガバナンストークンのモザイク ID か（"…:gov"）。 */
export const isGovernanceMosaicId = (id: string): boolean => id.toLowerCase().endsWith(`:${NEM_DAO_GOVERNANCE_NAME}`);

export type DaoNameIssue = 'empty' | 'too_long' | 'description_too_long';

/** DAO の名前のチェック（問題が無ければ null）。 */
export function checkDaoName(name: string): DaoNameIssue | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (byteLength(trimmed) > NEM_DAO_NAME_MAX_BYTES) return 'too_long';
  if (byteLength(buildDaoDescription(trimmed)) > NEM_DAO_DESCRIPTION_MAX_BYTES) return 'description_too_long';
  return null;
}

// --- 費用（micro-XEM） --------------------------------------------------------------------------
/** ルートネームスペースのレンタル（100 XEM）。DAO アカウントが払う。 */
export const DAO_NAMESPACE_RENTAL = 100_000_000n;
/** モザイクのレンタル（10 XEM）。DAO アカウントが払う。 */
export const DAO_MOSAIC_RENTAL = 10_000_000n;
/** ネームスペース登録・モザイク定義の手数料（それぞれ 0.15 XEM）。 */
export const DAO_PROVISION_FEE = 150_000n;
/** ガバナンストークンを管理者へ渡す送金の手数料の見込み（余裕を持たせる）。 */
export const DAO_HANDOVER_FEE_MARGIN = 1_000_000n;
/** マルチシグ化（連署者の追加）の手数料。 */
export const DAO_MULTISIG_FEE = 500_000n;
/** 作ったあと、DAO アカウントに残しておく余裕（のちのマルチシグ操作の手数料）。 */
export const DAO_SPARE = 2_000_000n;

/** DAO アカウントへ入金する額。DAO アカウント側の支払いをすべて賄う。 */
export const daoDepositMicro = (): bigint =>
  DAO_NAMESPACE_RENTAL + DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE * 2n + DAO_HANDOVER_FEE_MARGIN + DAO_MULTISIG_FEE + DAO_SPARE;

// --- 作成の手順 ---------------------------------------------------------------------------------
/** 作成は、確定を待ちながら順に進める。 */
export const DAO_CREATE_STEPS = ['deposit', 'namespace', 'mosaic', 'handover', 'multisig'] as const;
export type DaoCreateStep = (typeof DAO_CREATE_STEPS)[number];

/** 手順の何番目か（0 始まり）。 */
export const daoStepIndex = (step: DaoCreateStep): number => DAO_CREATE_STEPS.indexOf(step);

// --- 会員（ガバナンストークンの保有者） -----------------------------------------------------------
export interface DaoMember {
  address: string;
  /** ガバナンストークンの保有量（整数。可分性 0）。 */
  amount: bigint;
}

/** 保有量の多い順に並べ、0 は外す。同じアドレスは 1 つにまとめる。 */
export function normalizeMembers(list: DaoMember[]): DaoMember[] {
  const sum = new Map<string, bigint>();
  for (const m of list) sum.set(m.address, (sum.get(m.address) ?? 0n) + m.amount);
  return [...sum.entries()]
    .map(([address, amount]) => ({ address, amount }))
    .filter((m) => m.amount > 0n)
    .sort((a, b) => (a.amount === b.amount ? a.address.localeCompare(b.address) : a.amount > b.amount ? -1 : 1));
}

/** 配布先の入力（改行・空白・カンマ区切り）を、重複なしの一覧にする。 */
export function parseRecipients(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().replace(/-/g, '').toUpperCase()).filter((s) => s !== ''))];
}

/** 配布数の入力（正の整数）。空・不正は null。 */
export function parseTokenAmount(text: string, max = NEM_DAO_SUPPLY): bigint | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const v = BigInt(s);
  return v > 0n && v <= max ? v : null;
}

// --- 作成の再開（途中で止まっても、同じ名前でもう一度実行すると続きから進む） -------------------------
/** いまチェーン上で分かっている DAO の作成状況。 */
export interface DaoCreationState {
  /** DAO アカウントの XEM（micro-XEM）。 */
  balance: bigint;
  namespaceOwned: boolean;
  mosaicDefined: boolean;
  /** DAO アカウントが持っているガバナンストークンの量（管理者へ渡す前は発行量と同じ）。 */
  daoHolds: bigint;
  multisig: boolean;
}

/** 次の手順で DAO アカウントに最低限そろっていてほしい XEM。 */
export function balanceTarget(state: DaoCreationState): bigint {
  if (!state.namespaceOwned) return daoDepositMicro();
  if (!state.mosaicDefined) return DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE + DAO_HANDOVER_FEE_MARGIN + DAO_MULTISIG_FEE;
  if (state.daoHolds > 0n) return DAO_HANDOVER_FEE_MARGIN + DAO_MULTISIG_FEE;
  return DAO_MULTISIG_FEE;
}

/** 次にやること。終わっていれば null。入金が足りなければ先に 'deposit'。 */
export function nextCreateStep(state: DaoCreationState): DaoCreateStep | null {
  if (state.multisig) return null;
  if (state.balance < balanceTarget(state)) return 'deposit';
  if (!state.namespaceOwned) return 'namespace';
  if (!state.mosaicDefined) return 'mosaic';
  if (state.daoHolds > 0n) return 'handover';
  return 'multisig';
}

/** 入金する額（足りない分）。足りていれば 0。 */
export const depositTopUp = (state: DaoCreationState): bigint => {
  const target = balanceTarget(state);
  return state.balance >= target ? 0n : target - state.balance;
};

// --- ポイント・特典（第 3 段階） -----------------------------------------------------------------------
// NIS1 には「回収可能なモザイク」も「同時に成立する取引」も無いので、Symbol 版とは次のように形を変える。
//   - ポイントと特典は、DAO アカウントが自分のルートネームスペースの下に作る**子ネームスペース**の中の「転送不可」のモザイク。
//     例: DAO のネームスペースが `abc` なら、`abc.coffee` が子ネームスペース、特典のモザイクは `abc.coffee:reward`、ポイントは `abc.cafe:point`。
//     作成者は DAO アカウント（管理者は DAO の名前で、マルチシグ経由で作る）。子ネームスペースは親（DAO のルート）の期限に従う。
//   - NIS1 の転送不可は「作成者との間でしか動かせない」ので、会員どうしで売り買いできず、ポイントを作成者（= DAO アカウント）へ戻すことだけができる。
//   - どの DAO のものか、種類（ポイント / 特典）、交換の条件は、モザイクの説明に目印つきの JSON で書く。
//   - 交換 = 会員が DAO アカウントへポイントを送る（メッセージに欲しい特典と個数）→ 管理者が DAO の名前で特典を送る、の 2 段階。1 つの取引にはならない。

/** ポイント・特典のモザイクの名前（子ネームスペースの下）。 */
export const NEM_DAO_ITEM_MOSAIC_NAME: Record<'point' | 'reward', string> = { point: 'point', reward: 'reward' };
/** 子ネームスペースの名前（ルートの下の 1 つ分）の上限。NIS1 の子ネームスペースの上限と同じ。 */
export const NEM_DAO_ITEM_NAMESPACE_MAX_LENGTH = 64;

export const NEM_DAO_ITEM_MARK = 'KASANE-DAO-ITEM:';
export const NEM_DAO_EXCHANGE_MARK = 'KASANE-DAO-EXCHANGE:';
export const NEM_DAO_FULFIL_MARK = 'KASANE-DAO-FULFIL:';

export type DaoItemKind = 'point' | 'reward';

export const ITEM_NAME_MAX_BYTES = 50;
export const ITEM_DESCRIPTION_MAX_BYTES = 200;

/** 子ネームスペースの名前（"coffee"）として使えるか（小文字・数字・'_'・'-'、先頭は英数字）。 */
export const isValidItemNamespacePart = (part: string): boolean =>
  part.length > 0 && part.length <= NEM_DAO_ITEM_NAMESPACE_MAX_LENGTH && /^[a-z0-9][a-z0-9_-]*$/.test(part);

/** 子ネームスペースの全体の名前（DAO のネームスペース + "." + 名前）。 */
export const itemNamespace = (daoNamespace: string, part: string): string => `${daoNamespace}.${part}`;

/** ポイント・特典のモザイク ID（"abc.coffee:reward"）。 */
export const itemMosaicId = (daoNamespace: string, part: string, kind: DaoItemKind): string => `${itemNamespace(daoNamespace, part)}:${NEM_DAO_ITEM_MOSAIC_NAME[kind]}`;

/** モザイク ID の名前空間（"abc.coffee:reward" → "abc.coffee"）。 */
export const mosaicNamespaceOf = (mosaicId: string): string => mosaicId.slice(0, mosaicId.lastIndexOf(':'));

/** そのモザイクが、この DAO のネームスペースの子ネームスペースの下にあるか（"abc.x:…" は abc の子。"abc:gov" や他人の "abd.x:…" は違う）。 */
export const isUnderDaoNamespace = (mosaicId: string, daoNamespace: string): boolean => {
  const ns = mosaicNamespaceOf(mosaicId).toLowerCase();
  return ns.startsWith(`${daoNamespace.toLowerCase()}.`) && ns.length > daoNamespace.length + 1;
};

// --- ポイント・特典を作る費用（micro-XEM。すべて DAO アカウントが払う。管理者はマルチシグの外側の手数料を払う） ---
/** 子ネームスペースのレンタル（10 XEM）。 */
export const DAO_SUB_NAMESPACE_RENTAL = 10_000_000n;
/** 作成の途中で DAO アカウントに残っていてほしい XEM の余裕（次の手順の手数料）。 */
export const DAO_ITEM_FEE_MARGIN = 1_000_000n;

/** 子ネームスペース + モザイクを作るために、DAO アカウントにそろっていてほしい XEM（足りない分を管理者が入金する）。 */
export const daoItemDepositMicro = (): bigint => DAO_SUB_NAMESPACE_RENTAL + DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE * 2n + DAO_ITEM_FEE_MARGIN;

/** ポイント・特典の作成の手順。入金 → 子ネームスペース → モザイク。確定を待ちながら順に進める。 */
export const DAO_ITEM_CREATE_STEPS = ['deposit', 'namespace', 'mosaic'] as const;
export type DaoItemCreateStep = (typeof DAO_ITEM_CREATE_STEPS)[number];

/** いまチェーン上で分かっているポイント・特典の作成状況。 */
export interface DaoItemCreationState {
  /** DAO アカウントの XEM（micro-XEM）。 */
  balance: bigint;
  namespaceOwned: boolean;
  mosaicDefined: boolean;
}

/** 次の手順で DAO アカウントに最低限そろっていてほしい XEM。 */
export function itemBalanceTarget(state: Pick<DaoItemCreationState, 'namespaceOwned' | 'mosaicDefined'>): bigint {
  if (!state.namespaceOwned) return daoItemDepositMicro();
  return DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE + DAO_ITEM_FEE_MARGIN;
}

/** 次にやること。終わっていれば null。入金が足りなければ先に 'deposit'。 */
export function nextItemStep(state: DaoItemCreationState): DaoItemCreateStep | null {
  if (state.mosaicDefined) return null;
  if (state.balance < itemBalanceTarget(state)) return 'deposit';
  if (!state.namespaceOwned) return 'namespace';
  return 'mosaic';
}

/** 管理者が DAO アカウントへ入れる額（足りない分）。足りていれば 0。 */
export const itemDepositTopUp = (state: DaoItemCreationState): bigint => {
  const target = itemBalanceTarget(state);
  return state.balance >= target ? 0n : target - state.balance;
};

/** DAO の名前でモザイクを送るとき、DAO アカウントに最低限あってほしい XEM（1 件ぶんの手数料の余裕。足りないと送信が取り込まれない）。 */
export const DAO_SEND_FEE_MARGIN = 300_000n;

/** ポイント・特典のモザイクの説明に書く内容。 */
export interface DaoItemDoc {
  dao: string; // DAO の ID（公開鍵、大文字）
  kind: DaoItemKind;
  name: string;
  /** 特典だけ: 説明、交換に使うポイントのモザイク ID、特典 1 つあたりのポイント。 */
  description?: string;
  point?: string;
  cost?: string; // 10 進の整数（文字列）
}

export const buildItemDescription = (doc: DaoItemDoc): string => `${NEM_DAO_ITEM_MARK}${JSON.stringify({ v: 1, ...doc })}`;

/** 説明から読む。形が違うもの、種類に合わない欠けがあるものは null。 */
export function parseItemDescription(description: string | undefined): DaoItemDoc | null {
  if (!description || !description.startsWith(NEM_DAO_ITEM_MARK)) return null;
  try {
    const j = JSON.parse(description.slice(NEM_DAO_ITEM_MARK.length)) as Partial<DaoItemDoc> & { v?: unknown };
    if (typeof j.dao !== 'string' || !isNemDaoId(j.dao) || typeof j.name !== 'string') return null;
    if (j.kind !== 'point' && j.kind !== 'reward') return null;
    const doc: DaoItemDoc = { dao: j.dao.toUpperCase(), kind: j.kind, name: j.name };
    if (j.kind === 'reward') {
      if (typeof j.point !== 'string' || typeof j.cost !== 'string' || !/^\d+$/.test(j.cost) || BigInt(j.cost) <= 0n) return null;
      doc.point = j.point.toLowerCase();
      doc.cost = j.cost;
      doc.description = typeof j.description === 'string' ? j.description : '';
    }
    return doc;
  } catch {
    return null;
  }
}

export type ItemIssue = 'name_empty' | 'name_long' | 'description_long' | 'description_too_long' | 'amount' | 'cost' | 'point' | 'namespace_part';

/** ポイント・特典の作成の入力チェック（問題が無ければ空）。 */
export function checkNewItem(p: { kind: DaoItemKind; name: string; part: string; amount: bigint | null; description: string; point: string; cost: bigint | null; dao: string }): ItemIssue[] {
  const issues: ItemIssue[] = [];
  if (!isValidItemNamespacePart(p.part)) issues.push('namespace_part');
  const name = p.name.trim();
  if (name === '') issues.push('name_empty');
  else if (byteLength(name) > ITEM_NAME_MAX_BYTES) issues.push('name_long');
  if (p.amount === null) issues.push('amount');
  if (p.kind === 'reward') {
    if (byteLength(p.description.trim()) > ITEM_DESCRIPTION_MAX_BYTES) issues.push('description_long');
    if (p.cost === null) issues.push('cost');
    if (!/^[a-z0-9][a-z0-9_.-]*\.[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_-]*$/.test(p.point)) issues.push('point');
  }
  if (issues.length === 0) {
    const doc: DaoItemDoc = p.kind === 'point'
      ? { dao: p.dao, kind: 'point', name }
      : { dao: p.dao, kind: 'reward', name, description: p.description.trim(), point: p.point, cost: (p.cost ?? 0n).toString() };
    if (byteLength(buildItemDescription(doc)) > NEM_DAO_DESCRIPTION_MAX_BYTES) issues.push('description_too_long');
  }
  return issues;
}

/** 交換に払うポイント = 個数 × 1 個あたり。 */
export const exchangeCost = (quantity: bigint, cost: bigint): bigint => quantity * cost;

/** 会員が管理者へ送る申請メッセージ。 */
export const buildExchangeMessage = (reward: string, quantity: bigint): string => `${NEM_DAO_EXCHANGE_MARK}${JSON.stringify({ v: 1, reward, qty: quantity.toString() })}`;

export function parseExchangeMessage(message: string | null | undefined): { reward: string; quantity: bigint } | null {
  if (!message || !message.startsWith(NEM_DAO_EXCHANGE_MARK)) return null;
  try {
    const j = JSON.parse(message.slice(NEM_DAO_EXCHANGE_MARK.length)) as { reward?: unknown; qty?: unknown };
    if (typeof j.reward !== 'string' || typeof j.qty !== 'string' || !/^\d+$/.test(j.qty)) return null;
    const quantity = BigInt(j.qty);
    return quantity > 0n ? { reward: j.reward.toLowerCase(), quantity } : null;
  } catch {
    return null;
  }
}

/** 管理者が特典を渡すときに添えるメッセージ（どの申請への返事かを、申請のトランザクションハッシュで示す）。 */
export const buildFulfilMessage = (requestHash: string): string => `${NEM_DAO_FULFIL_MARK}${JSON.stringify({ v: 1, req: requestHash.toUpperCase() })}`;

export function parseFulfilMessage(message: string | null | undefined): string | null {
  if (!message || !message.startsWith(NEM_DAO_FULFIL_MARK)) return null;
  try {
    const j = JSON.parse(message.slice(NEM_DAO_FULFIL_MARK.length)) as { req?: unknown };
    return typeof j.req === 'string' && /^[0-9A-F]{64}$/.test(j.req.toUpperCase()) ? j.req.toUpperCase() : null;
  } catch {
    return null;
  }
}

export type RequestStatus = 'ready' | 'short' | 'unknown_item' | 'done';

/** 申請の状態: ready = 管理者が特典を渡せる / short = 払ったポイントが足りない / unknown_item = この DAO にその特典が無い / done = 渡し済み。 */
export function requestStatus(p: { paid: bigint; quantity: bigint; cost: bigint | null; fulfilled: boolean }): RequestStatus {
  if (p.fulfilled) return 'done';
  if (p.cost === null) return 'unknown_item';
  return p.paid >= exchangeCost(p.quantity, p.cost) ? 'ready' : 'short';
}

// --- ネームスペースの期限 ----------------------------------------------------------------------
// ガバナンストークン `<名前空間>:gov` は DAO アカウントのルートネームスペースの下にあるので、期限が切れるとトークンが使えなくなる。
// 公式ウォレットの更新画面と同じ「期限まで 30 日以内」を警告の目安にする（更新画面はこの範囲のルートだけを一覧に出す）。

/** 1 日のブロック数と、更新できる範囲（期限まで 30 日以内）。tx.ts と同じ値（ここは通信も暗号も読み込まない）。 */
export const DAO_BLOCKS_PER_DAY = 1440;
export const DAO_RENEW_WINDOW_BLOCKS = 30 * DAO_BLOCKS_PER_DAY;

export type DaoNamespaceState = 'ok' | 'soon' | 'expired' | 'lost' | 'unknown';
export interface DaoNamespaceStatus { state: DaoNamespaceState; remainingBlocks?: number; remainingDays?: number }

/** ガバナンストークンの名前空間の部分（"abc:gov" → "abc"）。 */
export const daoNamespaceOf = (mosaicId: string): string => mosaicId.split(':')[0] ?? '';

/** 期限が切れた（'expired'）か、もうDAOアカウントのものではない（'lost'）DAO は、解散した扱いにする。 */
export const isDaoDissolved = (status: DaoNamespaceStatus | null | undefined): boolean => status?.state === 'expired' || status?.state === 'lost';

/**
 * DAO アカウントが持つネームスペースの一覧から、DAO のルートネームスペースの状態を決める。
 *   - 一覧にルートが無い = もうDAOアカウントのものではない（猶予を過ぎて他の人に取られた）→ 'lost'
 *   - 期限が分からない（開始ブロックを読めなかった）→ 'unknown'（解散にはしない）
 * 一覧そのものを読めなかったときは、呼ぶ側で 'unknown' にする（ここには来ない）。
 */
export function daoNamespaceStatus(rows: Array<{ name: string; remainingBlocks?: number }>, namespace: string): DaoNamespaceStatus {
  const root = rows.find((r) => r.name === namespace);
  if (!root) return { state: 'lost' };
  if (root.remainingBlocks === undefined) return { state: 'unknown' };
  const remainingBlocks = root.remainingBlocks;
  if (remainingBlocks <= 0) return { state: 'expired', remainingBlocks };
  const remainingDays = Math.floor(remainingBlocks / DAO_BLOCKS_PER_DAY);
  return { state: remainingBlocks <= DAO_RENEW_WINDOW_BLOCKS ? 'soon' : 'ok', remainingBlocks, remainingDays };
}

// --- この DAO のポイント・特典を選ぶ（画面とボットで同じ読み方にする） -----------------------------------------

/** 説明つきで読み出したモザイク（DAO アカウントが作ったもの）。 */
export interface CreatedMosaicRow { id: string; description: string; transferable: boolean }

export interface DaoItemRow extends DaoItemDoc {
  id: string; // モザイク ID
  creator: string; // 作ったアカウント = DAO アカウントのアドレス
}

/**
 * DAO アカウントが作ったモザイクのうち、この DAO のポイント・特典として読めるもの: 説明の目印が合い、転送不可で、DAO のネームスペースの子の下にある。
 * 特典は、同じ DAO のポイントを指しているものだけ。
 */
export function selectDaoItems(created: CreatedMosaicRow[], daoId: string, daoAddress: string, daoNamespace: string): DaoItemRow[] {
  const all: DaoItemRow[] = [];
  for (const m of created) {
    const doc = parseItemDescription(m.description);
    if (doc && doc.dao === daoId.toUpperCase() && !m.transferable && isUnderDaoNamespace(m.id, daoNamespace)) all.push({ ...doc, id: m.id, creator: daoAddress });
  }
  return all.filter((i) => i.kind === 'point' || all.some((p) => p.kind === 'point' && p.id === i.point));
}

// --- 特別会員限定（テーマの見本） ------------------------------------------------------------------------------
// Symbol 版は、特典を持っている人だけが開けるページで、テーマの色を自分のアカウントのメタデータに保存する。
// NIS1 にメタデータは無いので、NEM 版は「自分宛ての 0 XEM の送金」のメッセージにテーマ名を書いて残す（最新のものを読む）。

export const NEM_DAO_THEME_MARK = 'KASANE-DAO-THEME:';

export const buildThemeMessage = (theme: string): string => `${NEM_DAO_THEME_MARK}${JSON.stringify({ v: 1, theme })}`;

export function parseThemeMessage(message: string | null | undefined): string | null {
  if (!message || !message.startsWith(NEM_DAO_THEME_MARK)) return null;
  try {
    const j = JSON.parse(message.slice(NEM_DAO_THEME_MARK.length)) as { theme?: unknown };
    return typeof j.theme === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(j.theme) ? j.theme : null;
  } catch {
    return null;
  }
}

/** 「特別会員限定」を開けるか: 管理者、またはこの DAO の特典を 1 つ以上持っている人。 */
export const canOpenLimited = (isAdmin: boolean, rewardHoldings: Array<bigint | null>): boolean => isAdmin || rewardHoldings.some((h) => h !== null && h > 0n);
