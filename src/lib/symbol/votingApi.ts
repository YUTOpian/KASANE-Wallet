// Symbol の投票: ノードへの問い合わせと、投票・投票の作成（しくみは lib/symbol/voting.ts の先頭）。NEM 版は lib/nem/voting.ts。
import { generateNamespaceId } from 'symbol-sdk/symbol';
import { TX_TYPE_TRANSFER } from './constants';
import { addressBytesToString, addressFromPublicKey, hexToBytes, isValidAddress, normalizeAddress } from './crypto';
import { aggregateSize } from './aggregate';
import type { AggregateItem } from './aggregate';
import { fetchExistingMosaicInfo, feeMultipliers, fetchBalances, nodeRequest, quoteFee, sendTransfer } from './api';
import type { MosaicInfo } from './api';
import { sendAggregate } from './aggregateApi';
import { getDefaultFeeSpeed } from './feeSpeed';
import type { FeeSpeed } from './feeSpeed';
import { getNetworkConfig } from './network';
import {
  CURRENCY_ALIAS_ID, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_SIMPLE, POLL_TYPE_WHITELIST, assemblePoll, buildPollMessages, hasPollForm, holderResults, isPollEnded, normalizeMosaicId, parseImportance, parsePollHeader, parsePollMovement, parsePollTx,
  pollIndexAddress, poiResults, simpleResults, sortNewestFirst, tallyVoters, whitelistResults,
} from './voting';
import { dropZeroHolders, emptyTally, holdingAtEnd } from '../votingHoldings';
import type { NewPollInput, Poll, PollAddressing, PollHeader, PollMessage, PollResults, PollTx, RawPollEntry } from './voting';

/** 使っているネットワークのアドレスの作り方（lib/symbol/voting.ts の PollAddressing）。 */
export function symbolAddressing(networkByte: number = getNetworkConfig().networkByte): PollAddressing {
  return {
    networkByte,
    addressOfKey: (keyHex) => addressFromPublicKey(keyHex, networkByte),
    isValid: (address) => isValidAddress(address, networkByte),
  };
}

// --- reading the transfers that reached an address --------------------------------------------
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // 1 つのアドレスにつき、最大 10,000 件まで読む
const JSON_POST = { 'Content-Type': 'application/json' };

interface RawPage {
  entries: RawPollEntry[];
  /** ノードが 1 ページいっぱいに返したか（まだ先がある）。 */
  full: boolean;
}

/** アドレスに届いた送金の 1 ページ（新しい順）。`embedded` が true なら、アグリゲートの中の送金。 */
async function fetchRawPage(address: string, embedded: boolean, page: number): Promise<RawPage> {
  const path = `/transactions/confirmed?recipientAddress=${normalizeAddress(address)}&type=${TX_TYPE_TRANSFER}&order=desc&pageSize=${PAGE_SIZE}${embedded ? '&embedded=true' : ''}&pageNumber=${page}`;
  const res = await nodeRequest<{ data?: RawPollEntry[] }>(path);
  const entries = res.data ?? [];
  // 中の送金の一覧には、中の送金だけが入る。フラグを無視するノードが通常の一覧を返しても、混ざらないようにしておく。
  return {
    entries: embedded ? entries.filter((e) => e.meta?.aggregateHash !== undefined && e.meta.aggregateHash !== '') : entries,
    full: entries.length >= PAGE_SIZE,
  };
}

async function fetchStream(address: string, embedded: boolean): Promise<RawPollEntry[]> {
  const out: RawPollEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { entries, full } = await fetchRawPage(address, embedded, page);
    out.push(...entries);
    if (!full) break;
  }
  return out;
}

const EMPTY_PAGE: RawPage = { entries: [], full: false };

// --- block time -------------------------------------------------------------------------------
const blockTimeCache = new Map<string, number>();

/** ブロックの時刻（UNIX ミリ秒）。取引の記録に時刻が付いていないときに、ブロックから調べる。 */
async function blockTimeMs(height: number): Promise<number> {
  const cfg = getNetworkConfig();
  const key = `${cfg.generationHash}:${height}`;
  const cached = blockTimeCache.get(key);
  if (cached !== undefined) return cached;
  const res = await nodeRequest<{ block?: { timestamp?: string } }>(`/blocks/${height}`);
  const ts = res.block?.timestamp;
  if (ts === undefined || !/^[0-9]+$/.test(ts)) throw new Error('block_time_unavailable');
  const ms = Number(ts) + cfg.epochAdjustment * 1000;
  blockTimeCache.set(key, ms);
  return ms;
}

async function fillTimes(txs: PollTx[]): Promise<PollTx[]> {
  const heights = [...new Set(txs.filter((tx) => tx.timeMs === null && tx.height > 0).map((tx) => tx.height))];
  if (heights.length === 0) return txs;
  const times = new Map<number, number>();
  for (const h of heights) times.set(h, await blockTimeMs(h));
  return txs.map((tx) => (tx.timeMs === null ? { ...tx, timeMs: times.get(tx.height) ?? null } : tx));
}

/** アドレスに届いた、承認済みの送金すべて（通常の送金と、アグリゲートの中の送金）。新しい順。 */
export async function fetchIncoming(address: string): Promise<PollTx[]> {
  const cfg = getNetworkConfig();
  const addressOf = (publicKey: string) => addressFromPublicKey(publicKey, cfg.networkByte);
  // アグリゲートの中の送金が読めないノードでも、通常の送金だけで続ける。
  const [plain, embedded] = await Promise.all([fetchStream(address, false), fetchStream(address, true).catch((): RawPollEntry[] => [])]);
  const seen = new Set<string>();
  const txs: PollTx[] = [];
  for (const entry of [...plain, ...embedded]) {
    if (entry.id !== undefined) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
    }
    const tx = parsePollTx(entry, addressOf, cfg.epochAdjustment);
    if (tx) txs.push(tx);
  }
  return sortNewestFirst(await fillTimes(txs));
}

// --- poll index -------------------------------------------------------------------------------
export interface PollHeaderPage {
  headers: PollHeader[];
  nextPage?: number; // 渡すと、次の（古い）ページが読める。undefined = もうない
}

/** 投票の索引の 1 ページ分（page は 1 から）。 */
export async function fetchPollHeaders(page = 1): Promise<PollHeaderPage> {
  const cfg = getNetworkConfig();
  const ad = symbolAddressing(cfg.networkByte);
  const index = pollIndexAddress(ad);
  const addressOf = (publicKey: string) => addressFromPublicKey(publicKey, cfg.networkByte);
  const [plain, embedded] = await Promise.all([fetchRawPage(index, false, page), fetchRawPage(index, true, page).catch(() => EMPTY_PAGE)]);
  const seen = new Set<string>();
  const headers: PollHeader[] = [];
  for (const entry of [...plain.entries, ...embedded.entries]) {
    if (entry.id !== undefined) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
    }
    const tx = parsePollTx(entry, addressOf, cfg.epochAdjustment);
    const header = tx ? parsePollHeader(tx, ad) : null;
    if (header) headers.push(header);
  }
  headers.sort((a, b) => b.height - a.height);
  return { headers, nextPage: plain.full || embedded.full ? page + 1 : undefined };
}

// --- a poll -----------------------------------------------------------------------------------
/** チェーンから投票を読む。Error('poll_not_found' | 'poll_invalid' | 'poll_unsupported' | 'poll_wrong_network')。 */
export async function fetchSymbolPoll(pollAddress: string): Promise<Poll> {
  const address = normalizeAddress(pollAddress);
  if (!isValidAddress(address)) throw new Error('poll_not_found');
  if (!isValidAddress(address, getNetworkConfig().networkByte)) throw new Error('poll_wrong_network');
  return assemblePoll(address, await fetchIncoming(address), symbolAddressing());
}

// --- counting ---------------------------------------------------------------------------------
const ACCOUNTS_PER_REQUEST = 50;

interface RawAccount {
  address?: string;
  importance?: string;
  mosaics?: Array<{ id?: string; amount?: string }>;
}
interface RawAccountRow {
  account?: RawAccount;
}

/** アカウントの情報（アドレス → 行）。ノードが知らないアカウント（まだ何も受け取っていない）は入らない。 */
async function fetchAccountRows(addresses: string[]): Promise<Map<string, RawAccount>> {
  const out = new Map<string, RawAccount>();
  const put = (row: RawAccountRow) => {
    const hex = row.account?.address;
    if (typeof hex !== 'string' || !row.account) return;
    try {
      out.set(addressBytesToString(hexToBytes(hex)), row.account);
    } catch {
      // 読めない行は、ないものとして扱う
    }
  };
  for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_REQUEST) {
    const chunk = addresses.slice(i, i + ACCOUNTS_PER_REQUEST);
    try {
      const res = await nodeRequest<RawAccountRow[] | { data?: RawAccountRow[] }>('/accounts', {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ addresses: chunk }),
      });
      for (const row of Array.isArray(res) ? res : res.data ?? []) put(row);
    } catch (e) {
      // 一括で読めないノードは、1 つずつ読む（ノードが落ちているときは、そのまま投げる）。
      const status = (e as { status?: number }).status;
      if (status === undefined || status >= 500) throw e;
      for (const address of chunk) {
        try {
          put(await nodeRequest<RawAccountRow>(`/accounts/${address}`));
        } catch (inner) {
          if ((inner as { status?: number }).status !== 404) throw inner; // 404 = まだ何も受け取っていないアカウント
        }
      }
    }
  }
  return out;
}

/** アカウントの現在の重要度（数）。ノードが知らないアカウントは 0。 */
async function fetchImportances(addresses: string[]): Promise<number[]> {
  const rows = await fetchAccountRows(addresses);
  return addresses.map((a) => parseImportance(rows.get(a)?.importance));
}

/** アカウントが今持っている、指定のモザイクの量（最小単位の数）。持っていない・ノードが知らないアカウントは 0。 */
export async function fetchMosaicHoldings(addresses: string[], mosaicId: string): Promise<number[]> {
  const id = normalizeMosaicId(mosaicId);
  const rows = await fetchAccountRows(addresses);
  return addresses.map((a) => {
    const held = rows.get(a)?.mosaics?.find((m) => m.id?.toUpperCase() === id)?.amount;
    return typeof held === 'string' && /^[0-9]+$/.test(held) ? Number(held) : 0;
  });
}

// --- holdings as of the end of the poll ---------------------------------------------------------
const HOLDING_PARALLEL = 6;

/** アカウントがかかわる送金（受け取りも送りも）の 1 ページ（新しい順）。 */
async function fetchInvolvedPage(address: string, embedded: boolean, page: number): Promise<RawPage> {
  const path = `/transactions/confirmed?address=${normalizeAddress(address)}&type=${TX_TYPE_TRANSFER}&order=desc&pageSize=${PAGE_SIZE}${embedded ? '&embedded=true' : ''}&pageNumber=${page}`;
  const res = await nodeRequest<{ data?: RawPollEntry[] }>(path);
  const entries = res.data ?? [];
  return {
    entries: embedded ? entries.filter((e) => e.meta?.aggregateHash !== undefined && e.meta.aggregateHash !== '') : entries,
    full: entries.length >= PAGE_SIZE,
  };
}

/**
 * 終了時刻（`endMs`）より「あとに」承認された送金による、アカウントの指定モザイクの保有量の増減（最小単位）。
 * 新しい順に読み、終了時刻に届いたところで止める。`complete` は、終了時刻まで読めたか
 * （アグリゲートの中の送金が読めないノード・履歴が長すぎるときは false）。
 */
async function fetchChangeAfter(address: string, ids: ReadonlySet<string>, endMs: number, includeFee: boolean): Promise<{ change: number; complete: boolean }> {
  const cfg = getNetworkConfig();
  const addressOfKey = (publicKey: string) => addressFromPublicKey(publicKey, cfg.networkByte);
  const addressOfHex = (hex: string) => addressBytesToString(hexToBytes(hex));
  const seen = new Set<string>();
  let change = 0;
  let complete = true;
  for (const embedded of [false, true]) {
    let finished = false;
    for (let page = 1; page <= MAX_PAGES && !finished; page += 1) {
      let got: RawPage;
      try {
        got = await fetchInvolvedPage(address, embedded, page);
      } catch (e) {
        if (!embedded) throw e;
        complete = false; // アグリゲートの中の送金が読めないノード
        break;
      }
      let reached = false;
      for (const entry of got.entries) {
        if (entry.id !== undefined) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
        }
        const move = parsePollMovement(entry, address, ids, addressOfKey, addressOfHex, cfg.epochAdjustment, includeFee);
        if (!move) continue;
        const time = move.timeMs ?? (move.height > 0 ? await blockTimeMs(move.height) : null);
        if (time === null || time <= endMs) {
          reached = true;
          continue;
        }
        change += move.change;
      }
      if (reached || !got.full) finished = true;
      else if (page === MAX_PAGES) complete = false;
    }
  }
  return { change, complete };
}

/**
 * 各アドレスが、投票の終了時刻（`endMs`、UNIX ミリ秒）に持っていた指定モザイクの量（`addresses` と同じ並び）。
 * Symbol は過去の保有量を調べられないので、いまの保有量から、終了後の送金を巻き戻して求める。
 * `endMs` が null なら、投票の途中: いまの保有量。
 * `approximate` は、数字がずれるかもしれないとき: XYM は、収穫の報酬・ロックなど、送金に出ない増減がある。
 * 読めなかったときは、投げる（0 とは数えない）。
 */
export async function fetchMosaicHoldingsAtEnd(addresses: string[], mosaicId: string, endMs: number | null): Promise<{ holdings: number[]; approximate: boolean }> {
  const id = normalizeMosaicId(mosaicId);
  const current = await fetchMosaicHoldings(addresses, id);
  if (endMs === null || addresses.length === 0) return { holdings: current, approximate: false };
  const native = id === getNetworkConfig().currencyMosaicId.toUpperCase();
  const ids = new Set<string>([id]);
  if (native) ids.add(CURRENCY_ALIAS_ID);
  const holdings = new Array<number>(addresses.length).fill(0);
  let approximate = native;
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) {
      const i = next;
      next += 1;
      const { change, complete } = await fetchChangeAfter(addresses[i], ids, endMs, native);
      if (!complete) approximate = true;
      holdings[i] = holdingAtEnd(current[i], change);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOLDING_PARALLEL, addresses.length) }, worker));
  return { holdings, approximate };
}

// --- the mosaic a poll is weighted by -------------------------------------------------------
export type MosaicInputError = 'mosaic_invalid' | 'mosaic_not_found' | 'namespace_not_found' | 'alias_not_mosaic';

const NAMESPACE_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function namespaceIdOf(name: string): string {
  let id = 0n;
  for (const label of name.split('.')) id = BigInt(generateNamespaceId(label, id));
  return id.toString(16).toUpperCase().padStart(16, '0');
}

/**
 * 入力（モザイク ID の 16 桁、または、モザイクに紐付いたネームスペース名。"xym" も可）から、モザイクを決める。
 * Error(MosaicInputError) を投げる。ノードに届かないときは、そのエラーをそのまま投げる。
 */
export async function resolveMosaicInput(raw: string): Promise<MosaicInfo> {
  const text = raw.trim();
  if (text === '') throw new Error('mosaic_invalid');
  let id: string;
  if (/^[0-9a-fA-F]{16}$/.test(text)) {
    id = text.toUpperCase();
  } else if (/^(xym|symbol\.xym)$/i.test(text)) {
    id = getNetworkConfig().currencyMosaicId.toUpperCase();
  } else {
    const name = text.toLowerCase();
    const labels = name.split('.');
    if (labels.length > 3 || !labels.every((l) => NAMESPACE_LABEL.test(l))) throw new Error('mosaic_invalid');
    try {
      const res = await nodeRequest<{ namespace?: { alias?: { type?: number; mosaicId?: string } } }>(`/namespaces/${namespaceIdOf(name)}`);
      const alias = res.namespace?.alias;
      if (alias?.type !== 1 || typeof alias.mosaicId !== 'string') throw new Error('alias_not_mosaic');
      id = alias.mosaicId.toUpperCase();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409 || status === 400) throw new Error('namespace_not_found');
      throw e;
    }
  }
  const info = await fetchExistingMosaicInfo(id);
  if (!info) throw new Error('mosaic_not_found');
  return info;
}

/**
 * モザイクが「移転できる」設定か（モザイクの定義のフラグ。作ったあとは変えられない）。
 * 読めなかったときは投げる（「移転できる」とも「できない」とも決めない）。モザイクがチェーンにないときは Error('mosaic_not_found')。
 */
export async function fetchMosaicTransferable(mosaicId: string): Promise<boolean> {
  const id = normalizeMosaicId(mosaicId);
  if (id === getNetworkConfig().currencyMosaicId.toUpperCase()) return true; // XYM は移転できる
  let res: { mosaic?: { flags?: number } };
  try {
    res = await nodeRequest<{ mosaic?: { flags?: number } }>(`/mosaics/${id}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error('mosaic_not_found');
    throw e;
  }
  const flags = res.mosaic?.flags;
  if (typeof flags !== 'number') throw new Error('mosaic_not_found');
  return (flags & 2) !== 0;
}

/** 投票を数える（`myAddress` を渡すと、そのアカウントの票も探す）。 */
export async function fetchSymbolPollResults(poll: Poll, myAddress?: string): Promise<PollResults> {
  const optionTxs = await Promise.all(poll.options.map((option) => fetchIncoming(poll.optionAddresses[option])));
  const tally = tallyVoters(poll, optionTxs);
  const me = myAddress ? normalizeAddress(myAddress) : null;
  const myVotes = me ? poll.options.filter((_, i) => optionTxs[i].some((tx) => tx.signer === me)) : [];

  if (poll.type === POLL_TYPE_WHITELIST) return { ...whitelistResults(poll, tally), myVotes };
  // 簡易投票は重要度を使わない（重要度の問い合わせもしない）。
  if (poll.type === POLL_TYPE_SIMPLE) return { ...simpleResults(poll, tally), myVotes };
  // モザイクで重み付けする投票: 重要度のかわりに、指定のモザイクの保有量で、同じ計算式で数える。
  // 重みは、投票が「終わった時点」の保有量（終わるまでに手放した人は、減ったあとの量）。その時点で持っていないアカウントの票は無効。
  // 投票の途中は、現在の保有量で数える暫定の結果（終わった時点の量で確定する）。
  if (poll.type === POLL_TYPE_MOSAIC && poll.mosaicId) {
    const ended = isPollEnded(poll);
    const { holdings, approximate } = await fetchMosaicHoldingsAtEnd(tally.unique, poll.mosaicId, ended ? poll.doe : null);
    const counted = dropZeroHolders(tally, holdings);
    return { ...poiResults(poll, counted.tally, counted.holdings, ended && approximate), myVotes, provisional: !ended, excludedVoters: counted.excluded };
  }
  // モザイク保有者の投票: 終了時点で指定のモザイクを持っているアカウントの票を、1 アカウント 1 票で数える（量は重みにしない）。
  // 「移転できないモザイクのみ」の投票は、数えるたびに、モザイクが本当に移転できない設定かを確かめる。
  // 移転できる設定なら、条件を満たさないので、票は 1 つも数えない（だれかが移すだけで票を増やせてしまうため）。
  if (poll.type === POLL_TYPE_MOSAIC_HOLDER && poll.mosaicId) {
    const ended = isPollEnded(poll);
    if (poll.nonTransferableOnly && (await fetchMosaicTransferable(poll.mosaicId))) {
      return { ...holderResults(poll, emptyTally(poll.options.length)), approximateImportance: false, myVotes, provisional: !ended, excludedVoters: tally.unique, mosaicRuleBroken: true };
    }
    const { holdings, approximate } = await fetchMosaicHoldingsAtEnd(tally.unique, poll.mosaicId, ended ? poll.doe : null);
    const counted = dropZeroHolders(tally, holdings);
    return { ...holderResults(poll, counted.tally), approximateImportance: ended && approximate, myVotes, provisional: !ended, excludedVoters: counted.excluded };
  }
  // Symbol は、過去の重要度を調べられない。終わった投票は、現在の重要度で数える（その旨を画面に出す）。
  const importances = await fetchImportances(tally.unique);
  return { ...poiResults(poll, tally, importances, isPollEnded(poll)), myVotes };
}

// --- voting -----------------------------------------------------------------------------------
/** 1 票の手数料（XYM の最小単位）。モザイクもメッセージもない、いちばん小さい送金。設定の「手数料の既定値」の段階で決まる。 */
export async function quoteSymbolVoteFee(): Promise<bigint> {
  return (await quoteFee(0, undefined)).fee;
}

export interface SendSymbolVoteInput {
  /** SSS Extension のアカウントは空文字にして `sss` を true にする（署名は拡張が行う）。 */
  privateKey: string;
  sss?: boolean;
  publicKey: string;
  poll: Poll;
  option: string;
}

/** 1 つの選択肢に投票する（空の 0 XYM の送金）。送る前に Error('poll_ended' | 'poll_invalid' | 'invalid_option') を投げる。 */
export async function sendSymbolVote(input: SendSymbolVoteInput): Promise<{ hash: string }> {
  const { poll, option } = input;
  if (isPollEnded(poll)) throw new Error('poll_ended');
  if (!poll.valid) throw new Error('poll_invalid');
  const recipient = poll.optionAddresses[option];
  if (!recipient) throw new Error('invalid_option');
  return sendTransfer({
    privateKey: input.privateKey,
    sss: input.sss,
    publicKey: input.publicKey,
    recipient,
    mosaics: [],
    allowNoMosaics: true,
  });
}

// --- creating a poll --------------------------------------------------------------------------
/** メッセージを、モザイクなしの送金のアイテム（アグリゲートの中身）にする。 */
function toItems(messages: PollMessage[]): AggregateItem[] {
  return messages.map((m, i): AggregateItem => ({
    uid: `poll-${i}`,
    kind: 'transfer',
    recipient: m.recipient,
    mosaicId: '0000000000000000',
    mosaicSymbol: '',
    divisibility: 0,
    amount: 0n, // 0 のときは、モザイクを付けない
    message: m.message,
  }));
}

/** アグリゲートの手数料の、速さごとの 1 バイトあたりの倍率（作成画面を開いたとき 1 回だけ読む）。 */
export async function fetchPollFeeMultiplier(speed: FeeSpeed = getDefaultFeeSpeed()): Promise<number> {
  return (await feeMultipliers())[speed];
}

/** 投票の作成の手数料（XYM の最小単位）。送るアグリゲートの実際の大きさから計算する（ネットワークへの問い合わせなし）。 */
export function symbolPollFee(messages: PollMessage[], publicKey: string, address: string, multiplier: number): bigint {
  const size = aggregateSize(publicKey, address, getNetworkConfig().networkByte, toItems(messages));
  return BigInt(size) * BigInt(multiplier);
}

/** 自分のアカウントの XYM の残高（最小単位）。 */
export async function fetchXymBalance(address: string): Promise<bigint> {
  const currency = getNetworkConfig().currencyMosaicId.toUpperCase();
  const balances = await fetchBalances(address);
  return balances.find((b) => b.id.toUpperCase() === currency)?.amount ?? 0n;
}

/** すでに、このアドレスに投票が書かれているか（同じ人が同じタイトルで作ろうとしたとき）。 */
export async function pollAddressInUse(pollAddress: string): Promise<boolean> {
  return hasPollForm(await fetchIncoming(pollAddress));
}

export interface CreateSymbolPollInput {
  /** SSS Extension のアカウントは空文字にして `keyless` を付ける（署名は拡張が行う）。 */
  privateKey: string;
  keyless?: { kind: 'sss' };
  publicKey: string;
  address: string; // 自分のアドレス
  input: NewPollInput;
}

/** 投票を作る: メッセージを 1 つのアグリゲートにまとめて送る（全部入るか、全部入らないか）。 */
export async function createSymbolPoll(args: CreateSymbolPollInput): Promise<{ hash: string; pollAddress: string }> {
  const { pollAddress, messages } = buildPollMessages(args.input, args.publicKey, symbolAddressing());
  const sent = await sendAggregate({
    privateKey: args.privateKey,
    keyless: args.keyless,
    publicKey: args.publicKey,
    address: args.address,
    items: toItems(messages),
    feeSpeed: getDefaultFeeSpeed(),
  });
  return { hash: sent.hash, pollAddress };
}
