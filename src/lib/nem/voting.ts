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
import { announceNemPayload, fetchNamespaceMosaicInfos, fetchNemMosaicInfos, nodeRequest } from './api';
import { isDeviceOffline, isOfflineIssued, issueNemTransactions, readNemAnnounceBody } from '../offline/issue';
import type { NemBodyToIssue } from '../offline/issue';
import type { NemMosaicInfo } from './api';
import { NEM_EPOCH_SECONDS, NEM_NATIVE_ID, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress } from './crypto';
import { getNemNetworkConfig } from './network';
import { nemMessageByteLength, nemTransferFee, signNemTransfer } from './tx';
import type { PublicNetwork } from '../symbol/constants';
import { dropZeroHolders, emptyTally, holdingAtEnd } from '../votingHoldings';

// --- constants ------------------------------------------------------------------------------
/** Poll types: weighted by account importance, or only the votes of listed addresses. */
export const POLL_TYPE_POI = 0;
export const POLL_TYPE_WHITELIST = 1;
/**
 * KASANE's own type: a simple poll (anyone, one account one vote, no weighting). The official NEM
 * Wallet only knows the two types above, so it cannot show or count a poll of this type.
 */
export const POLL_TYPE_SIMPLE = 2;

/**
 * KASANE's own type: weighted by how much of a chosen mosaic each voter holds (the same calculation as
 * the importance-weighted poll, with the holding in place of the importance). Same value as the Symbol
 * poll of this type; the official NEM Wallet does not know it.
 */
export const POLL_TYPE_MOSAIC = 3;

/**
 * KASANE's own type: only holders of a chosen mosaic can vote (any amount; one account one vote, no weighting).
 * The creator chooses whether the mosaic has to be non-transferable (formData.nonTransferableOnly). Same value
 * and same shape as the Symbol poll of this type; the official NEM Wallet does not know it.
 */
export const POLL_TYPE_MOSAIC_HOLDER = 4;

const isKnownPollType = (type: unknown): type is number =>
  type === POLL_TYPE_POI || type === POLL_TYPE_WHITELIST || type === POLL_TYPE_SIMPLE || type === POLL_TYPE_MOSAIC || type === POLL_TYPE_MOSAIC_HOLDER;

/** The types that name a mosaic (weighted / holders). */
export const pollUsesMosaic = (type: unknown): boolean => type === POLL_TYPE_MOSAIC || type === POLL_TYPE_MOSAIC_HOLDER;

/** A NEM mosaic id: "namespace:name" (up to 3 namespace levels, lower case). */
const NEM_MOSAIC_ID = /^[a-z0-9][a-z0-9_-]{0,63}(\.[a-z0-9][a-z0-9_-]{0,63}){0,2}:[a-z0-9][a-z0-9_-]{0,31}$/;
export const isNemMosaicId = (id: unknown): id is string => typeof id === 'string' && NEM_MOSAIC_ID.test(id);
export const normalizeNemMosaicId = (id: string | undefined): string => (id ?? '').trim().toLowerCase();

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
export interface RawTx {
  timeStamp: number;
  amount?: number;
  type: number;
  version?: number;
  signer: string;
  recipient?: string;
  fee?: number;
  message?: { payload?: string; type?: number };
  mosaics?: Array<{ quantity?: number | string; mosaicId?: { namespaceId?: string; name?: string } }>;
  otherTrans?: RawTx;
}
export interface RawEntry {
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
    if (!isKnownPollType(h.type)) return null;
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
  mosaicId: string | null; // mosaic polls only (weighted / holders): the mosaic they name ("namespace:name")
  /** holder polls only: true = a promise that only a non-transferable mosaic counts (the mosaic is checked every time the votes are counted). false for the other types. */
  nonTransferableOnly: boolean;
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

  let formData: { title?: unknown; type?: unknown; doe?: unknown; multiple?: unknown; mosaicId?: unknown; nonTransferableOnly?: unknown };
  let optionsData: { strings?: unknown; link?: Record<string, string>; addresses?: string[] };
  try {
    formData = JSON.parse(formDataText);
    optionsData = JSON.parse(optionsText);
  } catch {
    throw new Error('poll_invalid');
  }
  if (typeof formData.title !== 'string' || typeof formData.doe !== 'number') throw new Error('poll_invalid');
  if (!isKnownPollType(formData.type)) throw new Error('poll_unsupported');
  const mosaicId = typeof formData.mosaicId === 'string' ? normalizeNemMosaicId(formData.mosaicId) : null;
  if (pollUsesMosaic(formData.type) && !isNemMosaicId(mosaicId)) throw new Error('poll_invalid');
  // A holder poll is only read when it says outright whether a transferable mosaic is allowed (a missing flag is not read as "allowed").
  if (formData.type === POLL_TYPE_MOSAIC_HOLDER && typeof formData.nonTransferableOnly !== 'boolean') throw new Error('poll_invalid');
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
    mosaicId: pollUsesMosaic(formData.type) ? mosaicId : null,
    nonTransferableOnly: formData.type === POLL_TYPE_MOSAIC_HOLDER && formData.nonTransferableOnly === true,
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
  /** Mosaic polls still running: the result is a provisional one (today's holdings); it is settled with the holdings at the end. */
  provisional?: boolean;
  /** Mosaic polls: voters who hold none of the mosaic (at the end of the poll) — their votes are invalid and not counted. */
  excludedVoters?: string[];
  /** Holder polls: the poll says "non-transferable mosaic only" but the mosaic is transferable now. The rule is not met, so no vote is counted. */
  mosaicRuleBroken?: boolean;
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

/** Simple polls: no weighting, one account one vote — the vote count is the result (counted like a whitelist poll, minus the list). */
export function simpleResults(poll: Poll, tally: Tally): Omit<PollResults, 'myVotes'> {
  return whitelistResults(poll, tally);
}

/**
 * Holder polls: voters who hold the mosaic at the end of the poll count one account one vote
 * (the caller has already dropped the ones who hold none with dropZeroHolders; the amount is not a weight).
 */
export function holderResults(poll: Poll, tally: Tally): Omit<PollResults, 'myVotes'> {
  return simpleResults(poll, tally);
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

// --- mosaic holdings (mosaic-weighted polls) ------------------------------------------------
const HOLDING_PARALLEL = 6;

/** XEM held by each address (micro XEM), from the account list. An address the node does not know holds 0. */
async function xemHoldings(addresses: string[]): Promise<number[]> {
  const out = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const res = await nodeRequest<{ data?: Array<{ account?: { address?: string; balance?: number } }> }>('/account/get/batch', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ data: chunk.map((account) => ({ account })) }),
    });
    for (const item of res.data ?? []) if (item.account?.address) out.set(item.account.address, item.account.balance ?? 0);
  }
  return addresses.map((a) => out.get(a) ?? 0);
}

/** One account's holding of a mosaic (smallest units). Throws when the node cannot say: a missing answer must not count as 0. */
async function ownedHolding(address: string, mosaicId: string): Promise<number> {
  const owned = await nodeRequest<{ data?: Array<{ quantity: number | string; mosaicId: { namespaceId: string; name: string } }> }>(
    `/account/mosaic/owned?address=${normalizeNemAddress(address)}`,
  );
  const hit = (owned.data ?? []).find((m) => `${m.mosaicId.namespaceId}:${m.mosaicId.name}`.toLowerCase() === mosaicId);
  const n = Number(hit?.quantity ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * How much of the mosaic each address holds now (smallest units; none = 0), in the order of `addresses`.
 * NIS1 cannot tell what an account held at an earlier height: for the holding as of the end of a poll see
 * fetchNemMosaicHoldingsAtEnd.
 */
export async function fetchNemMosaicHoldings(addresses: string[], mosaicId: string): Promise<number[]> {
  const id = normalizeNemMosaicId(mosaicId);
  if (addresses.length === 0) return [];
  const list = addresses.map(normalizeNemAddress);
  if (id === NEM_NATIVE_ID) return xemHoldings(list);
  const out = new Array<number>(list.length).fill(0);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      out[i] = await ownedHolding(list[i], id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOLDING_PARALLEL, list.length) }, worker));
  return out;
}

// --- holdings as of the end of the poll ----------------------------------------------------------
/**
 * How much of the mosaic one transfer moved for/against `address` (smallest units): + when it received,
 * - when it sent. For XEM the fee of a transfer the address sent is taken off as well.
 * Not a transfer, or not involving the address: 0.
 */
export function mosaicChangeOfEntry(entry: RawEntry, address: string, mosaicId: string): number {
  const outer = entry.transaction;
  const tx = outer.type === NEM_TX_TYPE_MULTISIG && outer.otherTrans ? outer.otherTrans : outer;
  if (tx.type !== NEM_TX_TYPE_TRANSFER || !tx.recipient) return 0;
  const networkByte = ((tx.version ?? 0) >>> 24) & 0xff || getNemNetworkConfig().networkByte;
  const me = normalizeNemAddress(address);
  const sender = nemAddressFromPublicKey(tx.signer, networkByte);
  const to = normalizeNemAddress(tx.recipient);
  if (sender !== me && to !== me) return 0;
  const native = mosaicId === NEM_NATIVE_ID;
  // NIS1: with a mosaic list, the amount is a multiplier in millionths (1 000 000 = x1) of each quantity;
  // without one, the amount is plain XEM.
  const multiplier = BigInt(Math.trunc(tx.amount ?? 0));
  let moved = 0n;
  if (tx.mosaics && tx.mosaics.length > 0) {
    for (const m of tx.mosaics) {
      const id = `${m.mosaicId?.namespaceId ?? ''}:${m.mosaicId?.name ?? ''}`.toLowerCase();
      if (id === mosaicId) moved += (BigInt(Math.trunc(Number(m.quantity ?? 0))) * multiplier) / 1_000_000n;
    }
  } else if (native) {
    moved = multiplier;
  }
  let change = 0n;
  if (to === me) change += moved;
  if (sender === me) {
    change -= moved;
    if (native) change -= BigInt(Math.trunc(tx.fee ?? 0));
  }
  return Number(change);
}

/**
 * The net change of one account's holding of a mosaic from transfers confirmed AFTER `endBlock`
 * (reads the account's transfers newest first and stops once it reaches the end of the poll).
 * `complete` is false when the history was too long to read to the end of the poll.
 */
async function fetchChangeAfter(address: string, mosaicId: string, endBlock: number): Promise<{ change: number; complete: boolean }> {
  const addr = normalizeNemAddress(address);
  let change = 0;
  let lastId: number | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await nodeRequest<{ data?: RawEntry[] }>(
      `/account/transfers/all?address=${addr}&pageSize=${PAGE_SIZE}${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = page.data ?? [];
    if (entries.length === 0) return { change, complete: true };
    let reached = false;
    for (const e of entries) {
      if ((e.meta?.height ?? 0) <= endBlock) {
        reached = true;
        continue;
      }
      change += mosaicChangeOfEntry(e, addr, mosaicId);
    }
    const next = entries[entries.length - 1].meta?.id;
    if (reached || entries.length < MIN_PAGE || next === undefined || next === lastId) return { change, complete: true };
    lastId = next;
  }
  return { change, complete: false };
}

/**
 * How much of the mosaic each address held at the end of the poll (`endBlock`), in the order of `addresses`.
 * NIS1 cannot tell a past holding, so it is worked back from today's holding by undoing the transfers made
 * after the end. `endBlock` null = the poll is still running: today's holding. `approximate` is true when the
 * figure may be off: XEM also moves by harvesting rewards, which the transfers do not show, and a very long
 * history may not be readable to the end. A failed lookup throws (never counted as 0).
 */
export async function fetchNemMosaicHoldingsAtEnd(
  addresses: string[],
  mosaicId: string,
  endBlock: number | null,
): Promise<{ holdings: number[]; approximate: boolean }> {
  const id = normalizeNemMosaicId(mosaicId);
  const current = await fetchNemMosaicHoldings(addresses, id);
  if (endBlock === null || addresses.length === 0) return { holdings: current, approximate: false };
  const list = addresses.map(normalizeNemAddress);
  const holdings = new Array<number>(list.length).fill(0);
  let approximate = id === NEM_NATIVE_ID;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      const { change, complete } = await fetchChangeAfter(list[i], id, endBlock);
      if (!complete) approximate = true;
      holdings[i] = holdingAtEnd(current[i], change);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOLDING_PARALLEL, list.length) }, worker));
  return { holdings, approximate };
}

// --- the mosaic a poll is weighted by ---------------------------------------------------------
export type NemMosaicInputError = 'mosaic_invalid' | 'mosaic_not_found';

/**
 * The mosaic a person typed ("namespace:name", or "xem") checked against the chain. Throws
 * Error(NemMosaicInputError); when the node cannot be reached the node's own error is thrown.
 */
export async function resolveNemMosaicInput(raw: string): Promise<NemMosaicInfo> {
  const text = normalizeNemMosaicId(raw);
  const id = text === 'xem' ? NEM_NATIVE_ID : text;
  if (!isNemMosaicId(id)) throw new Error('mosaic_invalid');
  if (id === NEM_NATIVE_ID) {
    // XEM is built in: the node serves no definition for it.
    const xem = (await fetchNemMosaicInfos([id]))[id];
    if (!xem) throw new Error('mosaic_not_found');
    return xem;
  }
  const cut = id.lastIndexOf(':');
  let infos: NemMosaicInfo[];
  try {
    infos = await fetchNamespaceMosaicInfos(id.slice(0, cut), new Set([id]));
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400 || status === 404) throw new Error('mosaic_not_found');
    throw e;
  }
  const info = infos.find((i) => i.id === id);
  if (!info) throw new Error('mosaic_not_found');
  return info;
}

/** Whether the mosaic is transferable now (its newest definition). Throws when it cannot be read: a missing answer is neither yes nor no. */
export async function fetchNemMosaicTransferable(mosaicId: string): Promise<boolean> {
  return (await resolveNemMosaicInput(mosaicId)).transferable;
}

/** Counts the votes of a poll (and finds the votes of `myAddress`, when given). */
export async function fetchPollResults(poll: Poll, myAddress?: string): Promise<PollResults> {
  const optionTxs = await Promise.all(poll.options.map((option) => fetchAllIncoming(poll.optionAddresses[option])));
  const tally = tallyVoters(poll, optionTxs);
  const me = myAddress ? normalizeNemAddress(myAddress) : null;
  const myVotes = me ? poll.options.filter((_, i) => optionTxs[i].some((tx) => tx.signer === me)) : [];

  if (poll.type === POLL_TYPE_WHITELIST) return { ...whitelistResults(poll, tally), myVotes };
  if (poll.type === POLL_TYPE_SIMPLE) return { ...simpleResults(poll, tally), myVotes };
  // Mosaic-weighted: the same calculation as the importance-weighted poll, with the holding in place of the importance.
  // The weight is the holding at the END of the poll (anyone who gave the mosaic away before then counts with what is left),
  // and a voter who holds none at that point has no valid vote. While the poll runs, today's holding gives a provisional result.
  if (poll.type === POLL_TYPE_MOSAIC && poll.mosaicId) {
    const ended = isPollEnded(poll);
    const { holdings, approximate } = await fetchNemMosaicHoldingsAtEnd(tally.unique, poll.mosaicId, ended ? poll.endBlock : null);
    const counted = dropZeroHolders(tally, holdings);
    return {
      ...poiResults(poll, counted.tally, counted.holdings, ended && (approximate || poll.endBlock === null)),
      myVotes,
      provisional: !ended,
      excludedVoters: counted.excluded,
    };
  }
  // Mosaic holders: whoever holds the mosaic at the END of the poll has one vote (the amount does not matter).
  // A "non-transferable only" poll checks the mosaic's definition every time it is counted (NEM lets the creator re-define a
  // mosaic): when the mosaic is transferable, the rule is not met and no vote is counted — anyone could otherwise hand the
  // mosaic on to as many accounts as they like and vote with each of them.
  if (poll.type === POLL_TYPE_MOSAIC_HOLDER && poll.mosaicId) {
    const ended = isPollEnded(poll);
    if (poll.nonTransferableOnly && (await fetchNemMosaicTransferable(poll.mosaicId))) {
      return { ...holderResults(poll, emptyTally(poll.options.length) as Tally), myVotes, provisional: !ended, excludedVoters: tally.unique, mosaicRuleBroken: true };
    }
    const { holdings, approximate } = await fetchNemMosaicHoldingsAtEnd(tally.unique, poll.mosaicId, ended ? poll.endBlock : null);
    const counted = dropZeroHolders(tally, holdings);
    return {
      ...holderResults(poll, counted.tally),
      approximateImportance: ended && (approximate || poll.endBlock === null),
      myVotes,
      provisional: !ended,
      excludedVoters: counted.excluded,
    };
  }
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
  mosaicId?: string; // mosaic polls only ("namespace:name")
  /** holder polls only: true = non-transferable mosaic only. Written into the poll. */
  nonTransferableOnly?: boolean;
  /** holder polls, for the check only (not written): whether the chosen mosaic is transferable; undefined = not confirmed. */
  mosaicTransferable?: boolean;
}

export interface PollMessage {
  recipient: string;
  message: string;
  fee: bigint;
}

export type NewPollIssue =
  | 'title_empty' | 'title_long' | 'options_few' | 'options_many' | 'option_empty' | 'option_long' | 'option_duplicate'
  | 'end_past' | 'whitelist_empty' | 'whitelist_invalid' | 'mosaic_invalid' | 'mosaic_transferable' | 'message_too_large';

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
  if (pollUsesMosaic(input.type) && !isNemMosaicId(normalizeNemMosaicId(input.mosaicId))) issues.push('mosaic_invalid');
  // "Non-transferable only" cannot name a transferable mosaic (or one that has not been confirmed).
  if (input.type === POLL_TYPE_MOSAIC_HOLDER && input.nonTransferableOnly === true && input.mosaicTransferable !== false && isNemMosaicId(normalizeNemMosaicId(input.mosaicId))) {
    issues.push('mosaic_transferable');
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
    to(pollAddress, `formData:${JSON.stringify({ title, doe: input.doe, type: input.type, multiple: input.multiple, ...(pollUsesMosaic(input.type) ? { mosaicId: normalizeNemMosaicId(input.mosaicId) } : {}), ...(input.type === POLL_TYPE_MOSAIC_HOLDER ? { nonTransferableOnly: input.nonTransferableOnly === true } : {}) })}`),
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
  // オフラインなら、全部に署名して、ひとまとめのQRにする（1通ずつ送る処理は、オンラインの端末が読み込んで行う）。
  if (isDeviceOffline()) {
    const bodies: NemBodyToIssue[] = [];
    for (const m of messages) {
      const body = readNemAnnounceBody(signNemTransfer(privateKey, { publicKey, networkByte, recipient: m.recipient, amount: 0n, message: m.message, fee: m.fee }));
      if (body !== null) bodies.push(body);
    }
    if (bodies.length === messages.length && bodies.length > 0) issueNemTransactions(bodies, 'offline');
  }
  for (const m of messages) {
    try {
      const payload = signNemTransfer(privateKey, { publicKey, networkByte, recipient: m.recipient, amount: 0n, message: m.message, fee: m.fee });
      hashes.push((await announceNemPayload(payload)).hash);
    } catch (e) {
      // オフラインで送れなかった（QRにした）ときは、途中まで送ったわけではないので、そのまま伝える。
      if (isOfflineIssued(e)) throw e;
      throw new PollBroadcastError(hashes.length, e);
    }
    onProgress?.(hashes.length, messages.length);
  }
  return hashes;
}
