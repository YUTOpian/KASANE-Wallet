// アポスティーユ（Symbol）の通信: 取引ハッシュから記録を読む（監査）、公証用のシンクアカウントに届いた記録の一覧（エクスプローラー）、送る。
// NEM 版は lib/nem/apostilleExplorer.ts と lib/nem/api.ts の fetchNemTransactionByHash。
import { TX_TYPE_TRANSFER } from './constants';
import { addressFromPublicKey, normalizeAddress } from './crypto';
import { getNetworkConfig } from './network';
import { announceSigned, networkTimeMs, nodeRequest, quoteFeesForSize } from './api';
import { apostilleHexFromMessageField } from './apostilleMessage';
import { symbolMessageField } from './apostille';
import { multisigRawTransferAggregateSize, signTransfer, signTransferWith, transferSizeForMessageField } from './tx';
import { getDefaultFeeSpeed } from './feeSpeed';
import { verifySignature } from './crypto';
import { signWithLedger } from '../ledger/session';
import { quoteMultisigCost, submitMultisig } from './multisigApi';
import type { MultisigCost } from './multisigApi';
import type { ApostilleExplorerPage, ApostilleExplorerRow } from '../nem/apostilleExplorer';

/** Same size as the NEM explorer's list, so both look alike. The node allows 10 to 100. */
export const SYMBOL_APOSTILLE_EXPLORER_PAGE_SIZE = 25;

interface RawInner {
  transaction?: { type?: number; signerPublicKey?: string; recipientAddress?: string; message?: string };
}

interface RawEntry {
  // `aggregateHash` is set on a transaction that sits inside an aggregate (an embedded one has no hash of its own).
  meta?: { hash?: string; timestamp?: string; aggregateHash?: string };
  transaction?: {
    type?: number; signerPublicKey?: string; recipientAddress?: string; message?: string;
    /** The inner transactions, when the node includes them in the answer for an aggregate. */
    transactions?: RawInner[];
  };
}

/** Aggregate complete / bonded: the apostille of a multisig account travels inside one of these. */
const AGGREGATE_TYPES = new Set([0x4141, 0x4241]);

export interface SymbolApostilleTx {
  hash: string;
  /** The signer's public key (hex, upper case). */
  signer: string;
  /** The apostille message (hex, starting with fe4e5459); empty when the transfer carries none. */
  payloadHex: string;
  confirmed: boolean;
}

/** The transfer behind `hash` (confirmed first, then still waiting). Null when the node does not know it. */
export async function fetchSymbolApostilleTx(hash: string): Promise<SymbolApostilleTx | null> {
  const id = hash.toUpperCase();
  for (const group of ['confirmed', 'unconfirmed'] as const) {
    let raw: RawEntry;
    try {
      raw = await nodeRequest<RawEntry>(`/transactions/${group}/${encodeURIComponent(id)}`);
    } catch (e) {
      // The node answers an unknown hash with 404 (or 409 for a hash that is not well formed); an unreachable node is a different failure.
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409 || status === 400) continue;
      throw e;
    }
    const tx = raw.transaction;
    if (!tx || !tx.signerPublicKey) continue;
    if (tx.type !== undefined && AGGREGATE_TYPES.has(tx.type)) {
      // Sent in the name of a multisig account: the apostille is the inner transfer, and its signer is the multisig account.
      const inner = (tx.transactions ?? []).find((i) => i.transaction?.type === TX_TYPE_TRANSFER && apostilleHexFromMessageField(i.transaction.message) !== '');
      if (!inner?.transaction?.signerPublicKey) continue;
      return {
        hash: id,
        signer: inner.transaction.signerPublicKey.toUpperCase(),
        payloadHex: apostilleHexFromMessageField(inner.transaction.message),
        confirmed: group === 'confirmed',
      };
    }
    return {
      hash: id,
      signer: tx.signerPublicKey.toUpperCase(),
      payloadHex: tx.type === TX_TYPE_TRANSFER ? apostilleHexFromMessageField(tx.message) : '',
      confirmed: group === 'confirmed',
    };
  }
  return null;
}

/** Keeps only the apostille transfers of a node answer, in the order the node gave them. */
export function parseSymbolApostilleEntries(entries: RawEntry[]): ApostilleExplorerRow[] {
  const rows: ApostilleExplorerRow[] = [];
  const epochMs = getNetworkConfig().epochAdjustment * 1000;
  for (const entry of entries) {
    const tx = entry.transaction;
    // An embedded transfer (inside an aggregate) is shown under the aggregate's hash: that is the one a person can look up.
    const hash = entry.meta?.hash ?? entry.meta?.aggregateHash;
    if (!tx || !hash || tx.type !== TX_TYPE_TRANSFER || !tx.signerPublicKey) continue;
    const payloadHex = apostilleHexFromMessageField(tx.message);
    if (!payloadHex) continue;
    rows.push({
      txHash: hash.toUpperCase(),
      signer: tx.signerPublicKey.toUpperCase(),
      payloadHex,
      timestampMs: Number(entry.meta?.timestamp ?? 0) + epochMs,
    });
  }
  return rows;
}

/**
 * One page of the sink's incoming transfers, newest first. `cursor` is the page number (1 = the newest), as the node counts them;
 * `nextId` of the answer is the number to pass for the next, older page.
 */
export async function fetchSymbolApostilleExplorerPage(sink: string, cursor?: number): Promise<ApostilleExplorerPage> {
  const pageNumber = cursor ?? 1;
  const base = `/transactions/confirmed?recipientAddress=${normalizeAddress(sink)}&type=${TX_TYPE_TRANSFER}&order=desc&pageSize=${SYMBOL_APOSTILLE_EXPLORER_PAGE_SIZE}&pageNumber=${pageNumber}`;
  type Page = { data?: RawEntry[] };
  // Transfers sent by an ordinary account, and (embedded=true) transfers sent inside an aggregate, i.e. in the name of a multisig account.
  const [plain, embedded] = await Promise.all([
    nodeRequest<Page>(base),
    nodeRequest<Page>(`${base}&embedded=true`).catch((): Page => ({ data: [] })),
  ]);
  const plainEntries = plain.data ?? [];
  // The embedded list also holds nothing that is not embedded, but keep the check: a node that ignores the flag answers with the plain list again.
  const embeddedEntries = (embedded.data ?? []).filter((e) => e.meta?.aggregateHash !== undefined && e.meta.aggregateHash !== '');
  const rows = [...parseSymbolApostilleEntries(plainEntries), ...parseSymbolApostilleEntries(embeddedEntries)]
    .sort((a, b) => b.timestampMs - a.timestampMs);
  const full = plainEntries.length >= SYMBOL_APOSTILLE_EXPLORER_PAGE_SIZE || (embedded.data ?? []).length >= SYMBOL_APOSTILLE_EXPLORER_PAGE_SIZE;
  return { rows, nextId: full ? pageNumber + 1 : undefined, hasMore: full };
}

/** The fee (atomic XYM) of the transfer that carries `apostilleMessage` (no mosaic), at the fee level chosen in the settings. */
export async function quoteSymbolApostilleFee(apostilleMessage: Uint8Array): Promise<bigint> {
  const size = transferSizeForMessageField(apostilleMessage.length + 1);
  return (await quoteFeesForSize(size))[getDefaultFeeSpeed()].fee;
}

export interface SendSymbolApostilleInput {
  /** '' for a Ledger account: then `ledgerIndex` is set and the device signs. */
  privateKey: string;
  ledgerIndex?: number;
  publicKey: string;
  recipient: string;
  /** The apostille message (without the type byte). */
  message: Uint8Array;
}

/** Signs and announces the transfer: no mosaic, the apostille as the message. Returns the transaction hash. */
export async function sendSymbolApostille(input: SendSymbolApostilleInput): Promise<{ hash: string }> {
  const cfg = getNetworkConfig();
  const field = symbolMessageField(input.message);
  const fee = (await quoteFeesForSize(transferSizeForMessageField(field.length)))[getDefaultFeeSpeed()].fee;
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const params = {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    recipient: input.recipient,
    mosaics: [],
    allowNoMosaics: true,
    rawMessage: field,
    maxFee: fee,
    deadline,
  };
  const ledgerIndex = input.ledgerIndex;
  const signed = ledgerIndex !== undefined
    ? await signTransferWith(
      (payload) => signWithLedger('symbol', ledgerIndex, input.publicKey, cfg.networkByte, payload, verifySignature),
      cfg.generationHash,
      params,
    )
    : signTransfer(input.privateKey, cfg.generationHash, params);
  await announceSigned(signed);
  return { hash: signed.hash };
}

/** The address of a signer's public key on the current network. */
export function symbolAddressOfSigner(publicKey: string): string {
  return addressFromPublicKey(publicKey, getNetworkConfig().networkByte);
}


/** What it takes to send an apostille in the name of a multisig account: the aggregate (with room for the cosignatures), and the hash lock when others must sign. */
export function quoteSymbolApostilleFromMultisig(apostilleMessage: Uint8Array, cosignatureCount: number, bonded: boolean): Promise<MultisigCost> {
  return quoteMultisigCost(multisigRawTransferAggregateSize(apostilleMessage.length + 1), cosignatureCount, bonded);
}

export interface SendSymbolApostilleFromMultisigInput {
  /** The wallet's key: it signs the aggregate and pays the fee (and the lock). */
  privateKey: string;
  publicKey: string;
  /** The multisig account the apostille is sent from (its public key). */
  multisigPublicKey: string;
  recipient: string;
  message: Uint8Array;
  /** False only when the wallet's signature alone approves the multisig account. */
  bonded: boolean;
  cosignatureCount: number;
}

/**
 * Sends a public apostille from a multisig account: an aggregate whose one inner transfer is signed in the multisig account's name.
 * When others must sign, the aggregate is bonded: the hash lock is paid and the other cosigners sign it from the multisig screen.
 * `hash` is the aggregate's hash (the apostille is looked up by it). Only a public apostille can go this way: a signed one needs the signer's own key.
 */
export async function sendSymbolApostilleFromMultisig(input: SendSymbolApostilleFromMultisigInput): Promise<{ hash: string; bonded: boolean }> {
  const sent = await submitMultisig({
    privateKey: input.privateKey,
    publicKey: input.publicKey,
    inner: {
      kind: 'transfer',
      accountPublicKey: input.multisigPublicKey,
      recipient: input.recipient,
      mosaics: [],
      rawMessage: symbolMessageField(input.message),
    },
    bonded: input.bonded,
    cosignatureCount: input.cosignatureCount,
  });
  return { hash: sent.hash, bonded: sent.bonded };
}
