// NEM history in the same shape as the Symbol history (lib/symbol/history.ts HistoryItem), so Home's history panel can
// offer the same tabs / filters / CSV on both chains. Three groups, like Symbol:
//   confirmed   - /account/transfers/all, newest first, paged by transaction id
//   unconfirmed - /account/unconfirmedTransactions, without the multisig ones
//   partial     - multisig transactions waiting for cosignatures (the same list as the multisig screen)
// Plus the harvested blocks (/account/harvests) for the ハーベスト tab.
import { formatAtomic } from '../symbol/amount';
import type { HarvestReward } from '../symbol/api';
import type { HistoryCategory, HistoryItem, HistoryMosaic, HistoryStatus } from '../symbol/history';
import {
  NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_EPOCH_SECONDS, NEM_NATIVE_ID, NEM_TX_TYPE_IMPORTANCE_TRANSFER,
  NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER,
} from './constants';
import { nodeRequest } from './api';
import { nemAddressFromPublicKey, normalizeNemAddress } from './crypto';
import { fetchNemMultisigInfo, fetchNemPending, NEM_TX_TYPE_MULTISIG_MODIFICATION } from './multisigApi';
import type { NemPendingTransaction } from './multisigApi';
import { getNemNetworkConfig } from './network';

const NEM_TX_TYPE_NAMESPACE = 0x2001;
const NEM_TX_TYPE_MOSAIC_DEFINITION = 0x4001;
const NEM_TX_TYPE_MOSAIC_SUPPLY = 0x4002;

/** The kinds of transaction NEM has, in the order the type filter lists them (a subset of the Symbol categories). */
export const NEM_HISTORY_CATEGORIES: HistoryCategory[] = ['transfer', 'mosaic', 'namespace', 'multisig', 'link'];

// Transaction type -> [i18n key suffix under history.type, category].
const TYPE_INFO: Record<number, [string, HistoryCategory]> = {
  [NEM_TX_TYPE_TRANSFER]: ['transfer', 'transfer'],
  [NEM_TX_TYPE_IMPORTANCE_TRANSFER]: ['importance_transfer', 'link'],
  [NEM_TX_TYPE_MULTISIG_MODIFICATION]: ['multisig_modification', 'multisig'],
  [NEM_TX_TYPE_NAMESPACE]: ['namespace_registration', 'namespace'],
  [NEM_TX_TYPE_MOSAIC_DEFINITION]: ['mosaic_definition', 'mosaic'],
  [NEM_TX_TYPE_MOSAIC_SUPPLY]: ['mosaic_supply_change', 'mosaic'],
};

/** The i18n key suffix (under history.type) of a NEM transaction type. */
export function nemTypeKey(type: number): string {
  return TYPE_INFO[type]?.[0] ?? 'unknown';
}

interface RawNemTx {
  timeStamp: number;
  deadline?: number;
  amount?: number;
  fee?: number;
  recipient?: string;
  type: number;
  version?: number;
  signer: string;
  message?: { payload?: string; type?: number };
  mosaics?: Array<{ quantity: number; mosaicId: { namespaceId: string; name: string } }>;
  otherTrans?: RawNemTx;
}
interface RawNemEntry {
  meta?: { id?: number; height?: number; hash?: { data?: string }; data?: string };
  transaction: RawNemTx;
}

function hexToText(hex: string): string {
  try {
    return new TextDecoder().decode(new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16))));
  } catch {
    return '';
  }
}

const atMs = (nemSeconds: number) => (nemSeconds + NEM_EPOCH_SECONDS) * 1000;

function mosaicsOf(tx: RawNemTx): HistoryMosaic[] {
  const multiplier = BigInt(tx.amount ?? 0);
  if (tx.mosaics && tx.mosaics.length > 0) {
    // Version 2 transfer: `amount` is a multiplier (1,000,000 = x1) of each mosaic's quantity.
    return tx.mosaics.map((m) => {
      const id = `${m.mosaicId.namespaceId}:${m.mosaicId.name}`;
      const quantity = (BigInt(m.quantity) * multiplier) / 1_000_000n;
      return id === NEM_NATIVE_ID
        ? { id, symbol: NEM_CURRENCY_SYMBOL, amount: formatAtomic(quantity, NEM_CURRENCY_DIVISIBILITY) }
        : { id, symbol: id, amount: quantity.toString() };
    });
  }
  return [{ id: NEM_NATIVE_ID, symbol: NEM_CURRENCY_SYMBOL, amount: formatAtomic(multiplier, NEM_CURRENCY_DIVISIBILITY) }];
}

/** One node entry as seen from `me` (the wallet, or a multisig account it cosigns for). A multisig wrapper is read through to what it carries. */
function toItem(raw: RawNemEntry, me: string, status: HistoryStatus): HistoryItem {
  const outer = raw.transaction;
  const wrapped = outer.type === NEM_TX_TYPE_MULTISIG && outer.otherTrans !== undefined;
  const tx = wrapped && outer.otherTrans ? outer.otherTrans : outer;
  const networkByte = ((tx.version ?? 0) >>> 24) & 0xff || getNemNetworkConfig().networkByte;
  const signerAddress = nemAddressFromPublicKey(tx.signer, networkByte);
  const initiator = wrapped ? nemAddressFromPublicKey(outer.signer, networkByte) : signerAddress;
  const mine = normalizeNemAddress(me);
  const [key, category] = TYPE_INFO[tx.type] ?? ['unknown', 'other' as HistoryCategory];
  const isTransfer = tx.type === NEM_TX_TYPE_TRANSFER && !!tx.recipient;
  const recipient = isTransfer && tx.recipient ? normalizeNemAddress(tx.recipient) : '';
  const encrypted = isTransfer && tx.message?.type === 2;
  return {
    hash: raw.meta?.hash?.data ?? raw.meta?.data ?? '',
    status,
    type: tx.type,
    typeKey: key,
    category,
    timestampMs: atMs(outer.timeStamp),
    deadlineMs: outer.deadline === undefined ? null : atMs(outer.deadline),
    height: raw.meta?.height === undefined ? '' : String(raw.meta.height),
    signerAddress,
    signerPublicKey: tx.signer.toUpperCase(),
    isOutgoing: signerAddress === mine || initiator === mine,
    fee: formatAtomic(BigInt(outer.fee ?? 0), NEM_CURRENCY_DIVISIBILITY),
    recipient,
    isReception: isTransfer && recipient === mine && signerAddress !== mine,
    mosaics: isTransfer ? mosaicsOf(tx) : [],
    received: [],
    message: isTransfer && !encrypted && tx.message?.payload ? hexToText(tx.message.payload) : '',
    encryptedMessage: encrypted,
    encryptedPayload: encrypted ? (tx.message?.payload ?? '') : '',
  };
}

/** A multisig transaction waiting for cosignatures, as a history row. */
function pendingToItem(p: NemPendingTransaction, me: string): HistoryItem {
  const s = p.summary;
  const [key, category, type]: [string, HistoryCategory, number] = s.kind === 'transfer'
    ? ['transfer', 'transfer', NEM_TX_TYPE_TRANSFER]
    : s.kind === 'modification' ? ['multisig_modification', 'multisig', NEM_TX_TYPE_MULTISIG_MODIFICATION]
      : s.kind === 'importance' ? ['importance_transfer', 'link', NEM_TX_TYPE_IMPORTANCE_TRANSFER]
        : ['unknown', 'other', NEM_TX_TYPE_MULTISIG];
  // The summary carries the amount as "10.5 XEM".
  const amount = s.kind === 'transfer' ? s.amount.replace(/\s*XEM$/, '') : '';
  return {
    hash: p.innerHash,
    status: 'partial',
    type,
    typeKey: key,
    category,
    timestampMs: null,
    deadlineMs: p.deadlineMs,
    height: '',
    signerAddress: p.initiator, // who asked for the signature
    signerPublicKey: '',
    isOutgoing: normalizeNemAddress(p.initiator) === normalizeNemAddress(me),
    viaAccount: p.multisigAddress,
    fee: '',
    recipient: s.kind === 'transfer' ? s.recipient : '',
    isReception: false,
    mosaics: s.kind === 'transfer' ? [{ id: NEM_NATIVE_ID, symbol: NEM_CURRENCY_SYMBOL, amount }] : [],
    received: [],
    message: s.kind === 'transfer' ? s.message : '',
    encryptedMessage: false,
    encryptedPayload: '',
  };
}

// --- paging ---------------------------------------------------------------------------------

/** Where each account's confirmed list continues: the id to ask for next, or 'end' when it has been read to the end. */
export type NemHistoryCursors = Record<string, number | 'end' | undefined>;

export interface NemHistoryPage {
  items: HistoryItem[];
  cursors: NemHistoryCursors;
  hasMore: boolean;
}

const PAGE = 25; // NIS1 returns up to 25 per request

/** The accounts whose multisig transactions this wallet can sign for (it cosigns for them). Empty when they cannot be read. */
export async function fetchNemCosignedAccounts(address: string): Promise<string[]> {
  try {
    return (await fetchNemMultisigInfo(address)).multisigOf.map((a) => a.address);
  } catch (e) {
    console.warn('Could not look up the multisig accounts', e); // the wallet's own history is still shown
    return [];
  }
}

async function confirmedOf(account: string, cursor: number | undefined): Promise<{ items: HistoryItem[]; next: number | 'end' }> {
  const addr = normalizeNemAddress(account);
  const res = await nodeRequest<{ data?: RawNemEntry[] }>(`/account/transfers/all?address=${addr}${cursor !== undefined ? `&id=${cursor}` : ''}`);
  const entries = res.data ?? [];
  const last = entries[entries.length - 1]?.meta?.id;
  return {
    items: entries.map((e) => toItem(e, addr, 'confirmed')),
    next: entries.length >= PAGE && last !== undefined ? last : 'end',
  };
}

async function unconfirmedOf(account: string): Promise<HistoryItem[]> {
  const addr = normalizeNemAddress(account);
  const res = await nodeRequest<{ data?: RawNemEntry[] }>(`/account/unconfirmedTransactions?address=${addr}`);
  // Multisig transactions are listed under 署名待ち (they wait for cosignatures).
  return (res.data ?? []).filter((e) => e.transaction.type !== NEM_TX_TYPE_MULTISIG).map((e) => toItem(e, addr, 'unconfirmed'));
}

const when = (item: HistoryItem) => item.timestampMs ?? item.deadlineMs ?? 0;

/**
 * One page (newest first) of the wallet's transactions in one group. With `multisigAccounts` (設定「マルチシグ口座の取引を表示」)
 * the same page of each of those accounts is merged in; a transaction in both lists is shown once, as the wallet's own, and
 * rows of the other accounts carry `viaAccount`. An account that cannot be read is left out rather than failing the page.
 * 署名待ち always covers the multisig accounts the wallet cosigns for.
 */
export async function fetchNemHistoryPage(params: {
  address: string;
  publicKey: string;
  multisigAccounts: string[];
  status: HistoryStatus;
  cursors?: NemHistoryCursors;
}): Promise<NemHistoryPage> {
  const { address, publicKey, multisigAccounts, status } = params;
  const own = normalizeNemAddress(address);

  if (status === 'partial') {
    const pending = await fetchNemPending(own, publicKey, multisigAccounts);
    const items = pending.map((p) => pendingToItem(p, own)).sort((a, b) => when(b) - when(a));
    return { items, cursors: {}, hasMore: false };
  }

  const accounts = [own, ...multisigAccounts.map(normalizeNemAddress)];
  const cursors: NemHistoryCursors = { ...params.cursors };
  const seen = new Set<string>();
  const items: HistoryItem[] = [];
  const results = await Promise.all(accounts.map(async (account, index) => {
    if (cursors[account] === 'end') return { account, index, items: [] as HistoryItem[], failed: false };
    try {
      if (status === 'unconfirmed') {
        cursors[account] = 'end';
        return { account, index, items: await unconfirmedOf(account), failed: false };
      }
      const cursor = cursors[account];
      const page = await confirmedOf(account, typeof cursor === 'number' ? cursor : undefined);
      cursors[account] = page.next;
      return { account, index, items: page.items, failed: false };
    } catch (e) {
      if (index === 0) throw e; // the wallet's own list failing is an error; another account's is not
      console.warn('Could not read the history of a multisig account', e);
      cursors[account] = 'end';
      return { account, index, items: [] as HistoryItem[], failed: true };
    }
  }));
  for (const r of results) {
    for (const item of r.items) {
      const key = item.hash || `${when(item)}:${item.signerAddress}:${item.recipient}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(r.index === 0 ? item : { ...item, viaAccount: r.account });
    }
  }
  items.sort((a, b) => when(b) - when(a));
  return { items, cursors, hasMore: accounts.some((a) => cursors[a] !== 'end') };
}

// --- harvest --------------------------------------------------------------------------------

/** The latest blocks the account harvested, with the fees each paid (the NEM counterpart of fetchHarvestRewards). */
export async function fetchNemHarvests(address: string, count: number): Promise<HarvestReward[]> {
  const res = await nodeRequest<{ data?: Array<{ timeStamp: number; height: number; totalFee: number }> }>(
    `/account/harvests?address=${normalizeNemAddress(address)}`,
  );
  return (res.data ?? []).slice(0, count).map((h) => {
    const atomic = BigInt(h.totalFee ?? 0);
    return { height: String(h.height), timestampMs: atMs(h.timeStamp), amount: formatAtomic(atomic, NEM_CURRENCY_DIVISIBILITY), atomic };
  });
}
