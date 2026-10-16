// NEM voting — compatible with the poll protocol of the official NEM Wallet ("nem-voting").
//
// A poll lives entirely on NIS1 as 0-XEM transfers carrying plain-text messages:
//   * the poll's own address receives  formData: / description: / options: / whitelist:  messages,
//   * a header  poll:{...}  is sent to a poll index (the shared public index of the network),
//   * every option has an address derived from (poll address + option text); voting for an option
//     is an empty 0-XEM transfer to that address, and the votes are counted from the senders.
// Polls made here therefore show up in the official NEM Wallet, and the other way round.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { announceNemPayload, nodeRequest } from './api';
import { NEM_EPOCH_SECONDS, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress } from './crypto';
import { getNemNetworkConfig } from './network';
import { nemMessageByteLength, nemTransferFee, signNemTransfer } from './tx';
import type { PublicNetwork } from '../symbol/constants';

// --- constants ------------------------------------------------------------------------------
/** Poll types: weighted by account importance, or only the votes of listed addresses. */
export const POLL_TYPE_POI = 0;
export const POLL_TYPE_WHITELIST = 1;

/** The shared public poll index of each network, and the account that makes the official polls. */
export const POLL_INDEX_ADDRESS: Record<PublicNetwork, string> = {
  mainnet: 'NAZN26HYB7C5HVYVJ4SL3KBTDT773NZBAOMGRFZB',
  testnet: 'TAVGTNCVGALLUPZC4JTLKR2WX25RQM2QOK5BHBKC',
};
export const OFFICIAL_POLL_ACCOUNT = 'NCXFX5P56EXXWDRUWAWXDWYJHEFV26WVC5VJ6GY2';

/** A NIS1 message holds at most 1024 bytes. */
export const NEM_MAX_MESSAGE_BYTES = 1024;
/** Whitelist addresses per message (23 of them fit one message). */
export const WHITELIST_ADDRESSES_PER_MESSAGE = 23;
export const POLL_MAX_TITLE_LENGTH = 100;
export const POLL_MAX_OPTION_LENGTH = 50;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;

const PAGE_SIZE = 100; // NIS1 serves up to 100 transactions per page (older nodes: 25)
const MIN_PAGE = 25;
const MAX_PAGES = 300;

// --- hashing / addresses --------------------------------------------------------------------
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Keccak-256 of the UTF-8 text, as lower-case hex (what CryptoJS.SHA3(text, {outputLength: 256}) gives). */
function keccakHex(text: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(text)));
}

/**
 * The NEM address of a "public key" given as hex. The poll protocol feeds hashes in as keys (nobody
 * holds a private key for them), and a 66-character form (a leading 00 byte) is allowed, so this
 * hashes whatever bytes it is given instead of requiring exactly 32.
 */
export function addressFromKeyHex(keyHex: string, networkByte: number): string {
  const hash = ripemd160(keccak_256(hexToBytes(keyHex)));
  const versioned = new Uint8Array(21);
  versioned[0] = networkByte;
  versioned.set(hash, 1);
  const checksum = keccak_256(versioned).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(versioned);
  full.set(checksum, 21);
  return base32Encode(full);
}

/** The address of a poll, from its title and its creator's public key. */
export function generatePollAddress(title: string, creatorPublicKey: string, networkByte: number): string {
  return addressFromKeyHex(keccakHex(creatorPublicKey.toLowerCase() + title), networkByte);
}

/** The address that receives the votes for one option of a poll. */
export function deriveOptionAddress(pollAddress: string, option: string, networkByte: number): string {
  let key = keccakHex(pollAddress + option);
  if (key[0] >= '8') key = `00${key}`; // same rule as the official wallet (keeps the key "positive")
  return addressFromKeyHex(key, networkByte);
}

// --- transactions of an account -------------------------------------------------------------
interface RawTx {
  timeStamp: number;
  amount?: number;
  type: number;
  version?: number;
  signer: string;
  recipient?: string;
  message?: { payload?: string; type?: number };
  mosaics?: unknown[];
  otherTrans?: RawTx;
}
interface RawEntry {
  meta?: { id?: number; height?: number; hash?: { data?: string } };
  transaction: RawTx;
}

/** A confirmed transfer that reached an address (the inner transfer of a multisig transaction). */
export interface PollTx {
  id: number;
  height: number;
  hash: string;
  signer: string; // address of the sender (of the multisig account for multisig votes)
  amount: number;
  hasMosaics: boolean;
  message: string | null; // plain-text message, null when there is none / it is encrypted
}

function hexToText(hex: string): string {
  try {
    return new TextDecoder().decode(hexToBytes(hex));
  } catch {
    return '';
  }
}

function parseEntry(entry: RawEntry): PollTx | null {
  const outer = entry.transaction;
  const tx = outer.type === NEM_TX_TYPE_MULTISIG && outer.otherTrans ? outer.otherTrans : outer;
  if (tx.type !== NEM_TX_TYPE_TRANSFER) return null;
  const networkByte = ((tx.version ?? 0) >>> 24) & 0xff || getNemNetworkConfig().networkByte;
  return {
    id: entry.meta?.id ?? 0,
    height: entry.meta?.height ?? 0,
    hash: entry.meta?.hash?.data ?? '',
    signer: nemAddressFromPublicKey(tx.signer, networkByte),
    amount: tx.amount ?? 0,
    hasMosaics: (tx.mosaics?.length ?? 0) > 0,
    message: tx.message?.type === 1 && tx.message.payload ? hexToText(tx.message.payload) : null,
  };
}

async function fetchRawPage(address: string, lastId?: number): Promise<RawEntry[]> {
  const addr = normalizeNemAddress(address);
  const page = await nodeRequest<{ data?: RawEntry[] }>(
    `/account/transfers/incoming?address=${addr}&pageSize=${PAGE_SIZE}${lastId !== undefined ? `&id=${lastId}` : ''}`,
  );
  return page.data ?? [];
}

/** Every confirmed transfer received by the address, newest first. */
async function fetchAllIncoming(address: string): Promise<PollTx[]> {
  const result: PollTx[] = [];
  let lastId: number | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const entries = await fetchRawPage(address, lastId);
    if (entries.length === 0) break;
    for (const e of entries) {
      const tx = parseEntry(e);
      if (tx) result.push(tx);
    }
    const next = entries[entries.length - 1].meta?.id;
    if (entries.length < MIN_PAGE || next === undefined || next === lastId) break;
    lastId = next;
  }
  return result;
}

// --- time <-> block height ------------------------------------------------------------------
const heightCache = new Map<number, number>();

async function blockTimestamp(height: number): Promise<number> {
  const block = await nodeRequest<{ timeStamp: number }>('/block/at/public', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ height }),
  });
  return block.timeStamp;
}

/** The last block created at or before the given time (ms). Used to cut the votes off at the poll's end. */
export async function heightAtTimestamp(ms: number): Promise<number> {
  const cached = heightCache.get(ms);
  if (cached !== undefined) return cached;
  const target = Math.floor(ms / 1000) - NEM_EPOCH_SECONDS;
  const now = Math.floor(Date.now() / 1000) - NEM_EPOCH_SECONDS;
  const tip = (await nodeRequest<{ height: number }>('/chain/height')).height;
  const memo = new Map<number, number>();
  const stamp = async (h: number) => {
    let v = memo.get(h);
    if (v === undefined) {
      v = await blockTimestamp(h);
      memo.set(h, v);
    }
    return v;
  };
  let lb = 1;
  let ub = tip;
  let lastHeight = tip;
  let lastStamp = now;
  let found = 1;
  for (let i = 0; i < 80; i += 1) {
    if (lb >= ub) {
      found = Math.max(1, Math.min(lb, ub));
      break;
    }
    // Blocks come about once a minute, so the first guess is usually close.
    const guess = Math.min(ub, Math.max(lb, lastHeight + Math.ceil((target - lastStamp) / 60)));
    const ts = await stamp(guess);
    if (ts <= target) {
      if (guess >= tip) {
        found = tip;
        break;
      }
      if ((await stamp(guess + 1)) > target) {
        found = guess;
        break;
      }
      lb = guess + 1;
    } else {
      ub = guess - 1;
    }
    lastHeight = guess;
    lastStamp = ts;
    found = lb;
  }
  heightCache.set(ms, found);
  return found;
}

// --- poll index -----------------------------------------------------------------------------
export interface PollHeader {
  title: string;
  type: number;
  doe: number; // end of the poll, ms since epoch
  address: string; // the poll's address
  creator: string; // who listed the poll
}

function parseHeader(tx: PollTx): PollHeader | null {
  if (!tx.message || !tx.message.startsWith('poll:')) return null;
  try {
    const h = JSON.parse(tx.message.slice(5)) as { title?: unknown; type?: unknown; doe?: unknown; address?: unknown };
    if (typeof h.title !== 'string' || typeof h.address !== 'string' || typeof h.doe !== 'number') return null;
    if (h.type !== POLL_TYPE_POI && h.type !== POLL_TYPE_WHITELIST) return null;
    const address = normalizeNemAddress(h.address);
    if (!isValidNemAddress(address)) return null;
    return { title: h.title, type: h.type, doe: h.doe, address, creator: tx.signer };
  } catch {
    return null;
  }
}

export interface PollHeaderPage {
  headers: PollHeader[];
  nextId?: number; // pass back to get the next (older) page; undefined = no more
}

/** One page (newest first) of the polls listed in an index. */
export async function fetchPollHeaders(indexAddress: string, lastId?: number): Promise<PollHeaderPage> {
  const entries = await fetchRawPage(indexAddress, lastId);
  const headers: PollHeader[] = [];
  for (const e of entries) {
    const tx = parseEntry(e);
    const h = tx ? parseHeader(tx) : null;
    if (h) headers.push(h);
  }
  const next = entries[entries.length - 1]?.meta?.id;
  return { headers, nextId: entries.length >= MIN_PAGE && next !== undefined && next !== lastId ? next : undefined };
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
  whitelist: string[] | null; // whitelist polls only
  creator: string | null; // the first account that wrote to the poll address
  valid: boolean; // every option address is the one derived from the poll address
  endBlock: number | null; // last block that counts, once the poll has ended
}

export function isPollEnded(poll: { doe: number }, nowMs = Date.now()): boolean {
  return poll.doe < nowMs;
}

function lastWithPrefix(txs: PollTx[], prefix: string): string | null {
  // `txs` is newest first; the oldest message is the creator's (anyone could write later).
  for (let i = txs.length - 1; i >= 0; i -= 1) {
    const m = txs[i].message;
    if (m && m.startsWith(prefix)) return m.slice(prefix.length);
  }
  return null;
}

/** Reads a poll from the chain. Throws Error('poll_not_found' | 'poll_invalid' | 'poll_unsupported'). */
export async function fetchPoll(pollAddress: string): Promise<Poll> {
  const address = normalizeNemAddress(pollAddress);
  if (!isValidNemAddress(address)) throw new Error('poll_not_found');
  const networkByte = getNemNetworkConfig().networkByte;
  if (!isValidNemAddress(address, networkByte)) throw new Error('poll_wrong_network');

  const txs = await fetchAllIncoming(address);
  const formDataText = lastWithPrefix(txs, 'formData:');
  const descriptionText = lastWithPrefix(txs, 'description:');
  const optionsText = lastWithPrefix(txs, 'options:');
  if (formDataText === null || descriptionText === null || optionsText === null) throw new Error('poll_not_found');

  let formData: { title?: unknown; type?: unknown; doe?: unknown; multiple?: unknown };
  let optionsData: { strings?: unknown; link?: Record<string, string>; addresses?: string[] };
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

  const optionAddresses: Record<string, string> = {};
  let valid = new Set(options).size === options.length;
  if (optionsData.link) {
    for (const option of options) {
      const linked = optionsData.link[option];
      if (typeof linked !== 'string') throw new Error('poll_invalid');
      optionAddresses[option] = normalizeNemAddress(linked);
      if (deriveOptionAddress(address, option, networkByte) !== optionAddresses[option]) valid = false;
    }
  } else if (Array.isArray(optionsData.addresses) && optionsData.addresses.length === options.length) {
    // Old polls: addresses are stored sorted, without the link to their option. They can be read
    // but not verified, so they cannot be voted on.
    const sorted = [...optionsData.addresses].map(normalizeNemAddress).sort();
    options.forEach((option, i) => { optionAddresses[option] = sorted[i]; });
    valid = false;
  } else {
    throw new Error('poll_invalid');
  }
  const distinct = new Set(Object.values(optionAddresses));
  if (distinct.size !== options.length) throw new Error('poll_invalid');

  // The creator is the first account that ever wrote to the poll address.
  const byHeight = [...txs].sort((a, b) => a.height - b.height);
  const creator = byHeight[0]?.signer ?? null;

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
    endBlock: null,
  };

  if (isPollEnded(poll)) poll.endBlock = await heightAtTimestamp(poll.doe);

  if (poll.type === POLL_TYPE_WHITELIST) {
    const list: string[] = [];
    for (const tx of txs) {
      if (tx.signer !== creator || !tx.message || !tx.message.startsWith('whitelist:')) continue;
      if (poll.endBlock !== null && tx.height >= poll.endBlock) continue; // added after the end: ignored
      try {
        const part = JSON.parse(tx.message.slice('whitelist:'.length)) as unknown;
        if (Array.isArray(part)) for (const a of part) if (typeof a === 'string') list.push(normalizeNemAddress(a));
      } catch {
        // a broken message adds nobody
      }
    }
    poll.whitelist = [...new Set(list)];
  }
  return poll;
}

// --- counting -------------------------------------------------------------------------------
export interface PollResultOption {
  text: string;
  votes: number; // valid ballots for this option
  weighted: number; // votes weighted by importance (POI polls) — equal to votes otherwise
  percentage: number;
}
export interface PollResults {
  totalVotes: number;
  options: PollResultOption[];
  /** POI polls: importance could not be read as of the end of the poll, so today's was used. */
  approximateImportance: boolean;
  /** The votes found for the given account (confirmed), by option. */
  myVotes: string[];
}

export interface Tally {
  voters: string[][]; // valid voters per option (same order as poll.options)
  occurrences: Map<string, number>; // how many options each valid voter chose
  unique: string[]; // every valid voter once
}

/** Which votes count: confirmed (and before the end), 0 XEM and no mosaics, from a listed address for whitelist polls. */
export function tallyVoters(poll: Poll, optionTxs: PollTx[][]): Tally {
  const whitelist = poll.type === POLL_TYPE_WHITELIST ? new Set(poll.whitelist ?? []) : null;
  let voters = optionTxs.map((txs) => {
    const set = new Set<string>();
    for (const tx of txs) {
      if (poll.endBlock !== null && tx.height > poll.endBlock) continue;
      if (tx.amount !== 0 || tx.hasMosaics) continue; // payments (e.g. from exchanges) are not votes
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
    // One choice per account: someone who voted for more than one option has no valid vote.
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

/** `importances` is in the order of `tally.unique`. */
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

const JSON_POST = { 'Content-Type': 'application/json' };
const BATCH = 100;

async function currentImportances(addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const res = await nodeRequest<{ data?: Array<{ account?: { address?: string; importance?: number } }> }>('/account/get/batch', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ data: chunk.map((account) => ({ account })) }),
    });
    for (const item of res.data ?? []) if (item.account?.address) out.set(item.account.address, item.account.importance ?? 0);
  }
  return out;
}

async function historicalImportances(addresses: string[], height: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const res = await nodeRequest<{ data?: Array<{ data?: Array<{ importance?: number }> }> }>('/account/historical/get/batch', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ accounts: chunk.map((account) => ({ account })), startHeight: height, endHeight: height, incrementBy: 1 }),
    });
    const rows = res.data ?? [];
    if (rows.length !== chunk.length) throw new Error('historical_unavailable');
    chunk.forEach((a, j) => out.set(a, rows[j].data?.[0]?.importance ?? 0));
  }
  return out;
}

/** Importance of each address — as of the end of the poll when the node can tell, otherwise as of now. */
async function importancesFor(addresses: string[], endBlock: number | null): Promise<{ values: number[]; approximate: boolean }> {
  if (addresses.length === 0) return { values: [], approximate: false };
  let map: Map<string, number> | null = null;
  let approximate = false;
  if (endBlock !== null) {
    try {
      map = await historicalImportances(addresses, endBlock);
    } catch {
      approximate = true; // not every node keeps historical account data
    }
  }
  if (!map) map = await currentImportances(addresses);
  return { values: addresses.map((a) => map.get(a) ?? 0), approximate };
}

/** Counts the votes of a poll (and finds the votes of `myAddress`, when given). */
export async function fetchPollResults(poll: Poll, myAddress?: string): Promise<PollResults> {
  const optionTxs = await Promise.all(poll.options.map((option) => fetchAllIncoming(poll.optionAddresses[option])));
  const tally = tallyVoters(poll, optionTxs);
  const me = myAddress ? normalizeNemAddress(myAddress) : null;
  const myVotes = me ? poll.options.filter((_, i) => optionTxs[i].some((tx) => tx.signer === me)) : [];

  if (poll.type === POLL_TYPE_WHITELIST) return { ...whitelistResults(poll, tally), myVotes };
  const { values, approximate } = await importancesFor(tally.unique, poll.endBlock);
  return { ...poiResults(poll, tally, values, approximate), myVotes };
}

// --- voting ---------------------------------------------------------------------------------
/** A vote is an empty 0-XEM transfer: only the standard fee. */
export const NEM_VOTE_FEE = nemTransferFee(0n, undefined);

export interface SendNemVoteInput {
  privateKey: string;
  publicKey: string;
  poll: Poll;
  option: string;
}

/** Votes for one option. Throws Error('poll_ended' | 'poll_invalid' | 'invalid_option') before sending. */
export async function sendNemVote(input: SendNemVoteInput): Promise<{ hash: string }> {
  const { poll, option } = input;
  if (isPollEnded(poll)) throw new Error('poll_ended');
  if (!poll.valid) throw new Error('poll_invalid');
  const recipient = poll.optionAddresses[option];
  if (!recipient) throw new Error('invalid_option');
  const payload = signNemTransfer(input.privateKey, {
    publicKey: input.publicKey,
    networkByte: getNemNetworkConfig().networkByte,
    recipient,
    amount: 0n,
    fee: NEM_VOTE_FEE,
  });
  return announceNemPayload(payload);
}

// --- creating a poll ------------------------------------------------------------------------
export interface NewPollInput {
  title: string;
  description: string;
  options: string[];
  doe: number; // end, ms since epoch
  type: number;
  multiple: boolean;
  whitelist: string[]; // whitelist polls only
}

export interface PollMessage {
  recipient: string;
  message: string;
  fee: bigint;
}

export type NewPollIssue =
  | 'title_empty' | 'title_long' | 'options_few' | 'options_many' | 'option_empty' | 'option_long' | 'option_duplicate'
  | 'end_past' | 'whitelist_empty' | 'whitelist_invalid' | 'message_too_large';

/** Everything wrong with the form (empty = fine to send). */
export function validateNewPoll(input: NewPollInput, networkByte: number, nowMs = Date.now()): NewPollIssue[] {
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
    if (input.whitelist.some((a) => !isValidNemAddress(a, networkByte))) issues.push('whitelist_invalid');
  }
  if (issues.length === 0) {
    const built = buildPollMessages(input, '0'.repeat(64), networkByte, POLL_INDEX_ADDRESS.mainnet);
    if (built.messages.some((m) => nemMessageByteLength(m.message) > NEM_MAX_MESSAGE_BYTES)) issues.push('message_too_large');
  }
  return issues;
}

/**
 * The messages that make a poll, in the order they are sent: the three that describe it, the
 * whitelist (if any), and the header in the index last, so the poll only shows up once it is complete.
 */
export function buildPollMessages(
  input: NewPollInput,
  creatorPublicKey: string,
  networkByte: number,
  indexAddress: string,
): { pollAddress: string; messages: PollMessage[] } {
  const title = input.title.trim();
  const options = input.options.map((o) => o.trim());
  const pollAddress = generatePollAddress(title, creatorPublicKey, networkByte);
  const link: Record<string, string> = {};
  for (const option of options) link[option] = deriveOptionAddress(pollAddress, option, networkByte);

  const to = (recipient: string, message: string): PollMessage => ({ recipient, message, fee: nemTransferFee(0n, message) });
  const messages: PollMessage[] = [
    to(pollAddress, `formData:${JSON.stringify({ title, doe: input.doe, type: input.type, multiple: input.multiple })}`),
    to(pollAddress, `description:${input.description}`),
    to(pollAddress, `options:${JSON.stringify({ strings: options, link })}`),
  ];
  if (input.type === POLL_TYPE_WHITELIST) {
    const addresses = [...new Set(input.whitelist.map(normalizeNemAddress))];
    for (let i = 0; i < addresses.length; i += WHITELIST_ADDRESSES_PER_MESSAGE) {
      messages.push(to(pollAddress, `whitelist:${JSON.stringify(addresses.slice(i, i + WHITELIST_ADDRESSES_PER_MESSAGE))}`));
    }
  }
  messages.push(to(indexAddress, `poll:${JSON.stringify({ title, type: input.type, doe: input.doe, address: pollAddress })}`));
  return { pollAddress, messages };
}

export function totalPollFee(messages: PollMessage[]): bigint {
  return messages.reduce((sum, m) => sum + m.fee, 0n);
}

/** True when something is already written to the poll address as a poll (same creator + same title). */
export async function pollAddressInUse(pollAddress: string): Promise<boolean> {
  const entries = await fetchRawPage(pollAddress);
  return entries.some((e) => parseEntry(e)?.message?.startsWith('formData:'));
}

/** Thrown when sending stops part-way: `sent` messages went out before this one failed. */
export class PollBroadcastError extends Error {
  readonly sent: number;
  readonly reason: unknown;
  constructor(sent: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.sent = sent;
    this.reason = cause;
  }
}

/** Sends the messages one after another; resolves with the hash of each. */
export async function sendNemPoll(
  privateKey: string,
  publicKey: string,
  messages: PollMessage[],
  onProgress?: (sent: number, total: number) => void,
): Promise<string[]> {
  const networkByte = getNemNetworkConfig().networkByte;
  const hashes: string[] = [];
  for (const m of messages) {
    try {
      const payload = signNemTransfer(privateKey, { publicKey, networkByte, recipient: m.recipient, amount: 0n, message: m.message, fee: m.fee });
      hashes.push((await announceNemPayload(payload)).hash);
    } catch (e) {
      throw new PollBroadcastError(hashes.length, e);
    }
    onProgress?.(hashes.length, messages.length);
  }
  return hashes;
}
