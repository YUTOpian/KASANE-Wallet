// Symbol の投票（ポール）。NEM の投票（lib/nem/voting.ts）と同じしくみを、Symbol に当てはめたもの。
//
//   ・投票は、すべて「0 XYM の送金メッセージ」でチェーンに書かれる（NEM と同じ）:
//       - 投票そのもののアドレス（ポールのアドレス）へ   formData: / description: / options: / whitelist: のメッセージ
//       - 投票の「見出し」  poll:{...}  を、投票の索引（インデックス）のアドレスへ
//       - 選択肢ごとにアドレスがあり（ポールのアドレス ＋ 選択肢の文字列から決まる）、そこへ、空の 0 XYM の送金をすると、その選択肢への 1 票。
//         票は、送り主（署名したアカウント）で数える。
//   ・メッセージの形（JSON）は NEM と同じ。アドレスの作り方だけが違う:
//       NEM:    Keccak-256 の結果を「公開鍵」とみなして NEM のアドレスにする
//       Symbol: SHA3-256 の結果を「公開鍵」とみなして Symbol のアドレスにする（Symbol のアドレスの作り方そのまま）
//     どれも、秘密鍵を持つ人はいない（ハッシュから作ったアドレスなので、だれも動かせない）。
//   ・NEM との違い:
//       - NEM には公式の「公開インデックス」のアドレスがあるが、Symbol にはない。そこで索引のアドレスを、決まった文字列のハッシュから作る
//         （POLL_INDEX_SEED。ネットワークごとにアドレスの先頭が変わるので、メインネットとテストネットは別の索引になる）。
//       - 票を数える「終了時刻」は、ブロックの高さではなく、ブロックの時刻で比べる（Symbol は取引の記録に時刻がある）。
//       - 重要度（インポータンス）は、Symbol には「過去のある時点の値」を調べる手段がないので、いつも現在の値で重み付けする。
//       - 投票の作成は、1 つのアグリゲート（完全）にまとめて送る。すべて入るか、すべて入らないかのどちらかで、途中までの投票ができることはない。
//     メッセージの上限は 1023 バイト（NEM は 1024 バイト）。
//
// このファイルは SDK を使わない（アドレスへの変換は呼び出し側から渡す: PollAddressing）。通信は votingApi.ts。
import { sha3_256 } from '@noble/hashes/sha3.js';

// --- constants ------------------------------------------------------------------------------
/** 集計の種類: アカウントの重要度で重み付けする／登録したアドレスの票だけ数える。 */
export const POLL_TYPE_POI = 0;
export const POLL_TYPE_WHITELIST = 1;

/** 索引のアドレスを作る文字列（変えると、別の索引になる）。 */
export const POLL_INDEX_SEED = 'KASANE Symbol poll index v1';

/** 平文メッセージの上限（バイト）。種別バイトは含まない（lib/symbol/tx.ts の MAX_MESSAGE_BYTES と同じ値）。 */
export const POLL_MAX_MESSAGE_BYTES = 1023;
/** 1 つのメッセージに入れるホワイトリストのアドレスの数（NEM と同じ）。 */
export const WHITELIST_ADDRESSES_PER_MESSAGE = 23;
export const POLL_MAX_TITLE_LENGTH = 100;
export const POLL_MAX_OPTION_LENGTH = 50;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
/** 1 つのアグリゲートに入れられる中の取引の数（lib/symbol/aggregate.ts の MAX_AGGREGATE_INNER と同じ値）。 */
export const POLL_MAX_MESSAGES = 100;

const TX_TYPE_TRANSFER = 0x4154;

// --- addresses ------------------------------------------------------------------------------
/** Symbol のアドレスに関わる処理。SDK を使うので、呼び出し側（votingApi.ts）から渡す。 */
export interface PollAddressing {
  networkByte: number;
  /** 32 バイトの「鍵」（16 進）から、このネットワークのアドレス（base32、ハイフンなし）を作る。 */
  addressOfKey(keyHex: string): string;
  /** 形・チェックサム・ネットワークが正しいアドレスか。 */
  isValid(address: string): boolean;
}

export const normalizePollAddress = (address: string): string => address.replace(/[-\s]/g, '').toUpperCase();

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA3-256（UTF-8 の文字列）を、小文字の 16 進 64 桁で。 */
export function sha3Hex(text: string): string {
  return toHex(sha3_256(new TextEncoder().encode(text)));
}

/** 投票の索引のアドレス。 */
export function pollIndexAddress(ad: PollAddressing): string {
  return ad.addressOfKey(sha3Hex(POLL_INDEX_SEED).toUpperCase());
}

/** 投票のアドレス: タイトルと、作った人の公開鍵から決まる（同じ人が同じタイトルで 2 回は作れない）。 */
export function generatePollAddress(title: string, creatorPublicKey: string, ad: PollAddressing): string {
  return ad.addressOfKey(sha3Hex(creatorPublicKey.toLowerCase() + title).toUpperCase());
}

/** 選択肢の票が届くアドレス。 */
export function deriveOptionAddress(pollAddress: string, option: string, ad: PollAddressing): string {
  return ad.addressOfKey(sha3Hex(normalizePollAddress(pollAddress) + option).toUpperCase());
}

// --- a transfer that reached an address -----------------------------------------------------
/** ノードが返す、送金 1 件分（通常の送金も、アグリゲートの中の送金も同じ形）。 */
export interface RawPollEntry {
  /** ノードが付ける、記録の ID（通常の送金と、アグリゲートの中の送金の重複を見分けるのに使う）。 */
  id?: string;
  meta?: {
    hash?: string;
    /** アグリゲートの中の送金のとき、そのアグリゲートのハッシュ。 */
    aggregateHash?: string;
    height?: string;
    index?: number;
    /** ネットワークの起点（epoch）からのミリ秒。 */
    timestamp?: string;
  };
  transaction?: {
    type?: number;
    signerPublicKey?: string;
    /** メッセージ（16 進。先頭 1 バイトが種別で、00 が平文）。 */
    message?: string;
    mosaics?: Array<{ id?: string; amount?: string }>;
  };
}

export interface PollTx {
  height: number;
  index: number; // 同じブロックの中の順番（アグリゲートの中なら、その中の順番）
  /** ブロックの時刻（UNIX ミリ秒）。ノードが教えなかったときは null（votingApi が、ブロックから調べて埋める）。 */
  timeMs: number | null;
  hash: string;
  signer: string; // 送り主のアドレス（アグリゲートの中なら、中の送金に署名したアカウント）
  hasMosaics: boolean; // モザイクを付けた送金は、票ではない
  message: string | null; // 平文のメッセージ。なし・暗号化されているときは null
}

/** メッセージ（16 進、先頭に種別バイト）が平文なら、その文字列。そうでなければ null。 */
export function plainText(messageHex: string | undefined): string | null {
  const hex = (messageHex ?? '').trim();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.slice(0, 2) !== '00') return null;
  const bytes = Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * ノードの 1 件を PollTx にする。送金でないもの・署名者を読めないものは null。
 * `addressOf` は署名者の公開鍵をアドレスにする関数、`epochAdjustment` はネットワークの起点（UNIX 秒）。
 */
export function parsePollTx(entry: RawPollEntry, addressOf: (publicKey: string) => string, epochAdjustment: number): PollTx | null {
  const tx = entry.transaction;
  if (!tx || tx.type !== TX_TYPE_TRANSFER || typeof tx.signerPublicKey !== 'string') return null;
  let signer: string;
  try {
    signer = normalizePollAddress(addressOf(tx.signerPublicKey));
  } catch {
    return null;
  }
  const meta = entry.meta;
  const height = meta?.height !== undefined && /^[0-9]+$/.test(meta.height) ? Number(meta.height) : 0;
  const timeMs = meta?.timestamp !== undefined && /^[0-9]+$/.test(meta.timestamp) ? Number(meta.timestamp) + epochAdjustment * 1000 : null;
  return {
    height,
    index: typeof meta?.index === 'number' ? meta.index : 0,
    timeMs,
    hash: (meta?.hash ?? meta?.aggregateHash ?? '').toUpperCase(),
    signer,
    hasMosaics: (tx.mosaics?.length ?? 0) > 0,
    message: plainText(tx.message),
  };
}

/** 新しい順（ブロックの高さ、同じなら順番）。 */
export function sortNewestFirst(txs: PollTx[]): PollTx[] {
  return [...txs].sort((a, b) => b.height - a.height || b.index - a.index);
}

// --- poll index -----------------------------------------------------------------------------
export interface PollHeader {
  title: string;
  type: number;
  doe: number; // 投票の終わり（UNIX ミリ秒）
  address: string; // 投票のアドレス
  creator: string; // 索引に載せた人
  height: number; // 索引に載った高さ（並べ替え用）
}

/** 索引への送金（poll:{...}）から、見出しを読む。形が違えば null。 */
export function parsePollHeader(tx: PollTx, ad: PollAddressing): PollHeader | null {
  if (!tx.message || !tx.message.startsWith('poll:')) return null;
  try {
    const h = JSON.parse(tx.message.slice(5)) as { title?: unknown; type?: unknown; doe?: unknown; address?: unknown };
    if (typeof h.title !== 'string' || typeof h.address !== 'string' || typeof h.doe !== 'number') return null;
    if (h.type !== POLL_TYPE_POI && h.type !== POLL_TYPE_WHITELIST) return null;
    const address = normalizePollAddress(h.address);
    if (!ad.isValid(address)) return null;
    return { title: h.title, type: h.type, doe: h.doe, address, creator: tx.signer, height: tx.height };
  } catch {
    return null;
  }
}

// --- a poll ---------------------------------------------------------------------------------
export interface Poll {
  address: string;
  title: string;
  type: number;
  doe: number;
  multiple: boolean;
  description: string;
  options: string[];
  optionAddresses: Record<string, string>;
  whitelist: string[] | null; // ホワイトリストの投票だけ
  creator: string | null; // 投票のアドレスに最初に書いたアカウント
  valid: boolean; // どの選択肢のアドレスも、ポールのアドレスから計算したものと同じ
}

export function isPollEnded(poll: { doe: number }, nowMs = Date.now()): boolean {
  return poll.doe < nowMs;
}

function lastWithPrefix(txs: PollTx[], prefix: string): string | null {
  // `txs` は新しい順。いちばん古いメッセージが作った人のもの（あとからは、だれでも書ける）。
  for (let i = txs.length - 1; i >= 0; i -= 1) {
    const m = txs[i].message;
    if (m && m.startsWith(prefix)) return m.slice(prefix.length);
  }
  return null;
}

/**
 * 投票のアドレスに届いた送金（新しい順）から、投票を組み立てる。
 * Error('poll_not_found' | 'poll_invalid' | 'poll_unsupported' | 'poll_wrong_network') を投げる。
 */
export function assemblePoll(pollAddress: string, txs: PollTx[], ad: PollAddressing): Poll {
  const address = normalizePollAddress(pollAddress);
  const formDataText = lastWithPrefix(txs, 'formData:');
  const descriptionText = lastWithPrefix(txs, 'description:');
  const optionsText = lastWithPrefix(txs, 'options:');
  if (formDataText === null || descriptionText === null || optionsText === null) throw new Error('poll_not_found');

  let formData: { title?: unknown; type?: unknown; doe?: unknown; multiple?: unknown };
  let optionsData: { strings?: unknown; link?: Record<string, string> };
  try {
    formData = JSON.parse(formDataText);
    optionsData = JSON.parse(optionsText);
  } catch {
    throw new Error('poll_invalid');
  }
  if (typeof formData.title !== 'string' || typeof formData.doe !== 'number') throw new Error('poll_invalid');
  if (formData.type !== POLL_TYPE_POI && formData.type !== POLL_TYPE_WHITELIST) throw new Error('poll_unsupported');
  const strings = optionsData.strings;
  if (!Array.isArray(strings) || strings.length === 0 || !strings.every((s) => typeof s === 'string')) throw new Error('poll_invalid');
  const options = strings as string[];
  if (typeof optionsData.link !== 'object' || optionsData.link === null) throw new Error('poll_invalid');

  const optionAddresses: Record<string, string> = {};
  let valid = new Set(options).size === options.length;
  for (const option of options) {
    const linked = optionsData.link[option];
    if (typeof linked !== 'string') throw new Error('poll_invalid');
    optionAddresses[option] = normalizePollAddress(linked);
    if (deriveOptionAddress(address, option, ad) !== optionAddresses[option]) valid = false;
  }
  if (new Set(Object.values(optionAddresses)).size !== options.length) throw new Error('poll_invalid');

  // 作った人は、投票のアドレスに最初に書いたアカウント。
  const oldestFirst = [...txs].sort((a, b) => a.height - b.height || a.index - b.index);
  const creator = oldestFirst[0]?.signer ?? null;

  const poll: Poll = {
    address,
    title: formData.title,
    type: formData.type,
    doe: formData.doe,
    multiple: formData.multiple === true,
    description: descriptionText,
    options,
    optionAddresses,
    whitelist: null,
    creator,
    valid,
  };

  if (poll.type === POLL_TYPE_WHITELIST) {
    const list: string[] = [];
    for (const tx of txs) {
      if (tx.signer !== creator || !tx.message || !tx.message.startsWith('whitelist:')) continue;
      if (tx.timeMs !== null && tx.timeMs > poll.doe) continue; // 終わったあとに足されたものは、無視する
      try {
        const part = JSON.parse(tx.message.slice('whitelist:'.length)) as unknown;
        if (Array.isArray(part)) for (const a of part) if (typeof a === 'string') list.push(normalizePollAddress(a));
      } catch {
        // 壊れたメッセージは、だれも足さない
      }
    }
    poll.whitelist = [...new Set(list)];
  }
  return poll;
}

// --- counting -------------------------------------------------------------------------------
export interface PollResultOption {
  text: string;
  votes: number; // この選択肢の有効票
  weighted: number; // 重要度で重み付けした票（重要度で重み付けする投票）。ホワイトリストでは votes と同じ
  percentage: number;
}
export interface PollResults {
  totalVotes: number;
  options: PollResultOption[];
  /** 重要度で重み付けする投票が終わっているとき: 終了時点の重要度は調べられないので、現在の重要度で数えている。 */
  approximateImportance: boolean;
  /** 指定したアカウントの、承認済みの票（選択肢）。 */
  myVotes: string[];
}

export interface Tally {
  voters: string[][]; // 選択肢ごとの有効な投票者（poll.options と同じ並び）
  occurrences: Map<string, number>; // 有効な投票者が、いくつの選択肢を選んだか
  unique: string[]; // 有効な投票者（重複なし）
}

/**
 * 数える票: 承認済み・終了時刻より前・モザイクなし（モザイクつきの送金は、ただの送金）・ホワイトリストの投票ならリストのアドレスから。
 * 1 つだけ選べる投票で、複数の選択肢に投票したアカウントは、どの票も無効。
 */
export function tallyVoters(poll: Poll, optionTxs: PollTx[][]): Tally {
  const whitelist = poll.type === POLL_TYPE_WHITELIST ? new Set(poll.whitelist ?? []) : null;
  let voters = optionTxs.map((txs) => {
    const set = new Set<string>();
    for (const tx of txs) {
      if (tx.timeMs !== null && tx.timeMs > poll.doe) continue;
      if (tx.hasMosaics) continue;
      if (whitelist && !whitelist.has(tx.signer)) continue;
      set.add(tx.signer);
    }
    return [...set];
  });

  const count = new Map<string, number>();
  for (const list of voters) for (const a of list) count.set(a, (count.get(a) ?? 0) + 1);

  const occurrences = new Map<string, number>();
  if (poll.multiple) {
    for (const [a, n] of count) occurrences.set(a, n);
  } else {
    const nullified = new Set([...count].filter(([, n]) => n > 1).map(([a]) => a));
    voters = voters.map((list) => list.filter((a) => !nullified.has(a)));
    for (const [a, n] of count) if (n === 1) occurrences.set(a, 1);
  }
  return { voters, occurrences, unique: [...occurrences.keys()].sort() };
}

export function whitelistResults(poll: Poll, tally: Tally): Omit<PollResults, 'myVotes'> {
  const total = tally.voters.reduce((sum, list) => sum + list.length, 0);
  return {
    totalVotes: total,
    approximateImportance: false,
    options: poll.options.map((text, i) => ({
      text,
      votes: tally.voters[i].length,
      weighted: tally.voters[i].length,
      percentage: total === 0 ? 0 : (tally.voters[i].length * 100) / total,
    })),
  };
}

/** `importances` は `tally.unique` と同じ並び。複数の選択肢を選んだ人の重要度は、選んだ数で割って配る（NEM と同じ）。 */
export function poiResults(poll: Poll, tally: Tally, importances: number[], approximate: boolean): Omit<PollResults, 'myVotes'> {
  const importanceOf = new Map<string, number>();
  tally.unique.forEach((a, i) => importanceOf.set(a, importances[i] ?? 0));
  const totalImportance = importances.reduce((a, b) => a + b, 0);
  const totalVotes = tally.voters.reduce((sum, list) => sum + list.length, 0);
  return {
    totalVotes,
    approximateImportance: approximate,
    options: poll.options.map((text, i) => {
      const weighted = tally.voters[i].reduce((sum, a) => sum + (importanceOf.get(a) ?? 0) / (tally.occurrences.get(a) ?? 1), 0);
      return { text, votes: tally.voters[i].length, weighted, percentage: totalImportance === 0 ? 0 : (weighted * 100) / totalImportance };
    }),
  };
}

/** ノードの重要度（"7'842'928'625'000'000" のように区切りが入ることもある文字列）を数にする。読めなければ 0。 */
export function parseImportance(raw: string | undefined): number {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits === '') return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

// --- creating a poll ------------------------------------------------------------------------
export interface NewPollInput {
  title: string;
  description: string;
  options: string[];
  doe: number; // 終わり（UNIX ミリ秒）
  type: number;
  multiple: boolean;
  whitelist: string[]; // ホワイトリストの投票だけ
}

export interface PollMessage {
  recipient: string;
  message: string;
}

export type NewPollIssue =
  | 'title_empty' | 'title_long' | 'options_few' | 'options_many' | 'option_empty' | 'option_long' | 'option_duplicate'
  | 'end_past' | 'whitelist_empty' | 'whitelist_invalid' | 'message_too_large';

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** フォームの問題をすべて（空なら、送ってよい）。 */
export function validateNewPoll(input: NewPollInput, ad: PollAddressing, nowMs = Date.now()): NewPollIssue[] {
  const issues: NewPollIssue[] = [];
  const title = input.title.trim();
  if (title === '') issues.push('title_empty');
  if (title.length > POLL_MAX_TITLE_LENGTH) issues.push('title_long');
  const options = input.options.map((o) => o.trim());
  if (options.length < POLL_MIN_OPTIONS) issues.push('options_few');
  if (options.length > POLL_MAX_OPTIONS) issues.push('options_many');
  if (options.some((o) => o === '')) issues.push('option_empty');
  if (options.some((o) => o.length > POLL_MAX_OPTION_LENGTH)) issues.push('option_long');
  if (new Set(options).size !== options.length) issues.push('option_duplicate');
  if (input.doe <= nowMs) issues.push('end_past');
  if (input.type === POLL_TYPE_WHITELIST) {
    if (input.whitelist.length === 0) issues.push('whitelist_empty');
    if (input.whitelist.some((a) => !ad.isValid(a))) issues.push('whitelist_invalid');
  }
  if (issues.length === 0) {
    const built = buildPollMessages(input, '0'.repeat(64), ad);
    if (built.messages.length > POLL_MAX_MESSAGES || built.messages.some((m) => byteLength(m.message) > POLL_MAX_MESSAGE_BYTES)) {
      issues.push('message_too_large');
    }
  }
  return issues;
}

/**
 * 投票を作るメッセージ。送る順に: 投票を説明する 3 つ、ホワイトリスト（あれば）、最後に索引への見出し。
 * Symbol では、これを 1 つのアグリゲートにまとめて送るので、見出しだけが先に載ることはない。
 */
export function buildPollMessages(
  input: NewPollInput,
  creatorPublicKey: string,
  ad: PollAddressing,
): { pollAddress: string; messages: PollMessage[] } {
  const title = input.title.trim();
  const options = input.options.map((o) => o.trim());
  const pollAddress = generatePollAddress(title, creatorPublicKey, ad);
  const link: Record<string, string> = {};
  for (const option of options) link[option] = deriveOptionAddress(pollAddress, option, ad);

  const to = (recipient: string, message: string): PollMessage => ({ recipient, message });
  const messages: PollMessage[] = [
    to(pollAddress, `formData:${JSON.stringify({ title, doe: input.doe, type: input.type, multiple: input.multiple })}`),
    to(pollAddress, `description:${input.description}`),
    to(pollAddress, `options:${JSON.stringify({ strings: options, link })}`),
  ];
  if (input.type === POLL_TYPE_WHITELIST) {
    const addresses = [...new Set(input.whitelist.map(normalizePollAddress))];
    for (let i = 0; i < addresses.length; i += WHITELIST_ADDRESSES_PER_MESSAGE) {
      messages.push(to(pollAddress, `whitelist:${JSON.stringify(addresses.slice(i, i + WHITELIST_ADDRESSES_PER_MESSAGE))}`));
    }
  }
  messages.push(to(pollIndexAddress(ad), `poll:${JSON.stringify({ title, type: input.type, doe: input.doe, address: pollAddress })}`));
  return { pollAddress, messages };
}

/** すでに、このアドレスに投票として書かれたものがあるか（同じ人・同じタイトル）。 */
export function hasPollForm(txs: PollTx[]): boolean {
  return txs.some((tx) => tx.message?.startsWith('formData:') === true);
}
