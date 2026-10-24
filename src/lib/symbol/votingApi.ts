// Symbol の投票: ノードへの問い合わせと、投票・投票の作成（しくみは lib/symbol/voting.ts の先頭）。NEM 版は lib/nem/voting.ts。
import { TX_TYPE_TRANSFER } from './constants';
import { addressBytesToString, addressFromPublicKey, hexToBytes, isValidAddress, normalizeAddress } from './crypto';
import { aggregateSize } from './aggregate';
import type { AggregateItem } from './aggregate';
import { feeMultipliers, fetchBalances, nodeRequest, quoteFee, sendTransfer } from './api';
import { sendAggregate } from './aggregateApi';
import { getDefaultFeeSpeed } from './feeSpeed';
import type { FeeSpeed } from './feeSpeed';
import { getNetworkConfig } from './network';
import {
  POLL_TYPE_WHITELIST, assemblePoll, buildPollMessages, hasPollForm, isPollEnded, parseImportance, parsePollHeader, parsePollTx,
  pollIndexAddress, poiResults, sortNewestFirst, tallyVoters, whitelistResults,
} from './voting';
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

interface RawAccountRow {
  account?: { address?: string; importance?: string };
}

/** アカウントの現在の重要度（数）。ノードが知らないアカウントは 0。 */
async function fetchImportances(addresses: string[]): Promise<number[]> {
  const out = new Map<string, number>();
  const put = (row: RawAccountRow) => {
    const hex = row.account?.address;
    if (typeof hex !== 'string') return;
    try {
      out.set(addressBytesToString(hexToBytes(hex)), parseImportance(row.account?.importance));
    } catch {
      // 読めない行は、重要度 0 のまま
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
  return addresses.map((a) => out.get(a) ?? 0);
}

/** 投票を数える（`myAddress` を渡すと、そのアカウントの票も探す）。 */
export async function fetchSymbolPollResults(poll: Poll, myAddress?: string): Promise<PollResults> {
  const optionTxs = await Promise.all(poll.options.map((option) => fetchIncoming(poll.optionAddresses[option])));
  const tally = tallyVoters(poll, optionTxs);
  const me = myAddress ? normalizeAddress(myAddress) : null;
  const myVotes = me ? poll.options.filter((_, i) => optionTxs[i].some((tx) => tx.signer === me)) : [];

  if (poll.type === POLL_TYPE_WHITELIST) return { ...whitelistResults(poll, tally), myVotes };
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
  privateKey: string;
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
  privateKey: string;
  publicKey: string;
  address: string; // 自分のアドレス
  input: NewPollInput;
}

/** 投票を作る: メッセージを 1 つのアグリゲートにまとめて送る（全部入るか、全部入らないか）。 */
export async function createSymbolPoll(args: CreateSymbolPollInput): Promise<{ hash: string; pollAddress: string }> {
  const { pollAddress, messages } = buildPollMessages(args.input, args.publicKey, symbolAddressing());
  const sent = await sendAggregate({
    privateKey: args.privateKey,
    publicKey: args.publicKey,
    address: args.address,
    items: toItems(messages),
    feeSpeed: getDefaultFeeSpeed(),
  });
  return { hash: sent.hash, pollAddress };
}
