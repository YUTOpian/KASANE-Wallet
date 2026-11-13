// DAO（symbol_book_v3_demo_dao の移植）: 定数と、ネットワークに触れない純粋な関数。
// 元のデモは「サーバーの秘密鍵(master)が手数料を立て替えて署名する」作りだったが、ここではウォレットで開いているアカウントが
// その役（アグリゲートの発行者・手数料の支払い・DAO アカウントへの入金）を自分で務める。サーバーは要らない。
import { generateMetadataKey } from '../symbol/metadata';
import { MOSAIC_FLAG_RESTRICTABLE, MOSAIC_FLAG_REVOKABLE, MOSAIC_FLAG_TRANSFERABLE } from '../symbol/tx';

/** DAO アカウント自身に付けるアカウントメタデータのキー（元アプリの METADATA_KEYS と同じ値）。 */
export const DAO_KEY = {
  VOTE_A: 1n,
  VOTE_B: 2n,
  VOTE_C: 3n,
  VOTE_D: 4n,
  GOVERNANCE_TOKEN_ID: 5n,
  DAO_NAME: 6n,
  /** DAO のページに入る条件（'token' のとき、ガバナンストークンの保有が要る。無ければ ID だけで入れる）。DAO 自身が付ける。 */
  ACCESS_MODE: 7n,
  /** 投票箱 E・F（選択肢を 6 つまでに広げたときに足した）。以前に作った DAO には無く、E・F を使う投票を作るときに書き足す。 */
  VOTE_E: 8n,
  VOTE_F: 9n,
} as const;

/** DAO のページに入る条件。id = DAO の ID（公開鍵）だけで入れる（既定）/ token = ID に加えてガバナンストークンの保有が要る。管理者は常に入れる。 */
export type DaoAccess = 'id' | 'token';

/** メタデータの値から入る条件を読む。値が無い・知らない値は 'id'（元アプリの DAO は ID だけで入れた）。 */
export const parseDaoAccess = (value: string | undefined | null): DaoAccess => (value?.trim() === 'token' ? 'token' : 'id');

/** ページに入れるか。管理者は常に入れる。token のときは、ガバナンストークンを 1 つ以上持っている人だけ。 */
export const canEnterDao = (access: DaoAccess, isAdmin: boolean, governanceHeld: bigint): boolean => access === 'id' || isAdmin || governanceHeld > 0n;

/** 投票箱アカウント（A〜F）の公開鍵を入れておくキー。 */
export const VOTE_BOX_KEYS: readonly bigint[] = [DAO_KEY.VOTE_A, DAO_KEY.VOTE_B, DAO_KEY.VOTE_C, DAO_KEY.VOTE_D, DAO_KEY.VOTE_E, DAO_KEY.VOTE_F];

/** 1 つの投票に付けられる選択肢の最大数（A〜F）。 */
export const MAX_VOTE_OPTIONS = VOTE_BOX_KEYS.length;

/** 投票の索引（作成時の署名トランザクションのハッシュ）を入れるキーの先頭。n 件目はこの値 + n（元アプリと同じ並び）。 */
export const VOTE_INDEX_FIRST_KEY = 99n;

/** ガバナンストークンの発行量（元アプリの TOKEN_AMOUNT）。 */
export const GOVERNANCE_SUPPLY = 1_000_000n;

/** DAO アカウントへ入れておく最低額（元アプリは 50 XYM）。モザイクの作成費（レンタル手数料）は DAO アカウントが払う。 */
export const DAO_MIN_DEPOSIT = 50_000_000n;
/** レンタル手数料のほかに残しておく額。 */
export const DAO_DEPOSIT_MARGIN = 40_000_000n;

export const daoDeposit = (mosaicRentalFee: bigint): bigint => {
  const wanted = mosaicRentalFee + DAO_DEPOSIT_MARGIN;
  return wanted > DAO_MIN_DEPOSIT ? wanted : DAO_MIN_DEPOSIT;
};

/** ポイント・特典モザイクと交換アイテムに付けるモザイクメタデータのキー（元アプリは文字列からキーを作る）。 */
export const MOSAIC_META = {
  name: generateMetadataKey('name'),
  type: generateMetadataKey('type'),
  exchangeable: generateMetadataKey('exchangeable'),
  description: generateMetadataKey('description'),
  pointMosaicId: generateMetadataKey('pointMosaicId'),
  pointMosaicName: generateMetadataKey('pointMosaicName'),
  exchangeCost: generateMetadataKey('exchangeCost'),
} as const;

/** 会員が自分のアカウントに保存するテーマ（特別会員限定の見本機能）。 */
export const THEME_META_KEY = generateMetadataKey('theme');

export type DaoMosaicKind = 'point' | 'reward';

/** モザイクのフラグ（元アプリと同じ）: ガバナンス/ポイント = 回収可、特典 = なし、投票トークン = 転送可・制限可・回収可。 */
export const DAO_FLAGS = {
  governance: MOSAIC_FLAG_REVOKABLE,
  point: MOSAIC_FLAG_REVOKABLE,
  reward: 0,
  vote: MOSAIC_FLAG_TRANSFERABLE | MOSAIC_FLAG_RESTRICTABLE | MOSAIC_FLAG_REVOKABLE,
} as const;

export const hex16 = (value: bigint): string => value.toString(16).toUpperCase().padStart(16, '0');

export const DAO_NAME_MAX_BYTES = 100;
export const MOSAIC_NAME_MAX_BYTES = 50;
export const DESCRIPTION_MAX_BYTES = 200;
export const VOTE_TITLE_MAX_BYTES = 200;
export const VOTE_OPTION_MAX_BYTES = 60;

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 投票を締め切ったことの印: 投票トークン（モザイク）に、その持ち主（投票の作成者）自身が付けるモザイクメタデータのキー。
 * 値は '1'。締め切りの操作の最後のアグリゲートで書く（途中で止まった締め切りは、印が無いので「締切済み」にならない）。
 */
export const VOTE_CLOSED_KEY = generateMetadataKey('voteClosed');

/** 会員のテーマ見本（元アプリの themePresets）。 */
export const THEME_PRESETS: Record<string, { primary: string; secondary: string; active: string }> = {
  default: { primary: '#0C1228', secondary: '#181F39', active: '#F88D4B' },
  mustard: { primary: '#CDA74A', secondary: '#E2BD5D', active: '#715859' },
  pink: { primary: '#E99891', secondary: '#4D4D4D', active: '#EDD2D0' },
  red: { primary: '#DC2E29', secondary: '#D46B43', active: '#5E3C00' },
  purple: { primary: '#625A81', secondary: '#8E5568', active: '#D58B6D' },
  green: { primary: '#545b30', secondary: '#668068', active: '#DFDAC8' },
  brown: { primary: '#132439', secondary: '#BE842E', active: '#0F5154' },
};

// --- 投票（ガバナンス） -----------------------------------------------------------------------

/** 投票の索引メッセージ（DAO アカウント宛の 0 コイン送金に JSON で載る）。 */
export interface VoteDoc {
  version: string;
  token: string; // 投票トークンのモザイク ID（10進数の文字列。元アプリの形式）
  title: string;
  a: string;
  b: string;
  c: string;
  d: string;
  /** 5 つ目・6 つ目の選択肢。古い索引には無いので空文字として読む。 */
  e: string;
  f: string;
  /** 投票の終了日時（UTC のミリ秒）。0 = 期限なし。古い索引には無いので 0 として読む。 */
  end: number;
  /** 票の重み: true = ガバナンストークンの保有量どおり（元アプリと同じ・既定）、false = 1 人 1 票。古い索引には無いので true として読む。 */
  weighted: boolean;
}

export const voteTokenHex = (doc: Pick<VoteDoc, 'token'>): string => hex16(BigInt(doc.token));

export function buildVoteDoc(tokenId: bigint, title: string, options: readonly string[], weighted = true, endsAt = 0): VoteDoc {
  // 重み付けありは元アプリと同じ形のまま（weighted を書かない）。1 人 1 票のときだけ weighted: false を足す。
  // 5 つ目・6 つ目（e・f）は、使うときだけ書く（4 つまでの投票は、これまでと全く同じ形のまま）。
  const at = (i: number): string => options[i] ?? '';
  return {
    version: '1.0.0', token: tokenId.toString(), title, a: at(0), b: at(1), c: at(2), d: at(3),
    ...(at(4) ? { e: at(4) } : {}), ...(at(5) ? { f: at(5) } : {}),
    ...(endsAt > 0 ? { end: endsAt } : {}),
    ...(weighted ? {} : { weighted: false }),
  } as VoteDoc;
}

/** 選択肢を A〜F の順に並べた配列（常に MAX_VOTE_OPTIONS 個。使わないものは空文字）。 */
export const voteTexts = (doc: VoteDoc): string[] => [doc.a, doc.b, doc.c, doc.d, doc.e, doc.f];

/** メッセージ欄（16進）から投票の索引を読む。形が違うものは null。 */
export function parseVoteMessage(messageHex: string | undefined): VoteDoc | null {
  if (!messageHex || messageHex.length < 4) return null;
  try {
    const bytes = new Uint8Array(messageHex.match(/../g)!.map((h) => parseInt(h, 16)));
    if (bytes[0] !== 0x00) return null;
    const json = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as Partial<VoteDoc>;
    if (typeof json.token !== 'string' || !/^\d+$/.test(json.token)) return null;
    if (typeof json.title !== 'string') return null;
    const opt = (v: unknown) => (typeof v === 'string' ? v : '');
    return { version: String(json.version ?? ''), token: json.token, title: json.title, a: opt(json.a), b: opt(json.b), c: opt(json.c), d: opt(json.d), e: opt(json.e), f: opt(json.f), end: typeof json.end === 'number' && Number.isFinite(json.end) && json.end > 0 ? json.end : 0, weighted: json.weighted !== false };
  } catch {
    return null;
  }
}

/** 投票の期限が過ぎているか（期限なしは常に false）。期限ちょうどから終了。 */
export const isVoteClosed = (doc: Pick<VoteDoc, 'end'>, now: number = Date.now()): boolean => doc.end > 0 && now >= doc.end;

/** 空でない選択肢の添字（A=0 … F=5）。 */
export const voteOptionIndexes = (doc: VoteDoc): number[] => voteTexts(doc).map((o, i) => (o.trim() ? i : -1)).filter((i) => i >= 0);

export const VOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
