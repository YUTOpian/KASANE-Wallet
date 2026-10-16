// Reads a serialized Symbol transaction (hex) into what a person needs to see before signing or announcing it:
// who signs, what it does, when it expires, the fee and the hash. Used by the signing-QR screen, so nothing
// here trusts the QR: the hash is recomputed from the bytes and the transfer / multisig details come from the
// bytes too.
import { SymbolFacade, models } from 'symbol-sdk/symbol';
import { addressBytesToString, addressFromPublicKey, bytesToHex, facadeFor, hexToBytes, isSupportedNetworkByte } from './crypto';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL, TX_TYPE_AGGREGATE_BONDED, TX_TYPE_AGGREGATE_COMPLETE, TX_TYPE_TRANSFER, XYM_NAMESPACE_ID } from './constants';
import { formatAtomic } from './amount';
import { getNetworkConfig } from './network';
import { getMosaicInfos, resolveMosaicId } from './api';
import { resolveMetadataValue } from './multisigApi';
import type { PartialItem } from './multisigApi';
import { metadataTypeOfTx } from './metadata';
import { RESTRICTION_TX_TYPE, parseRestrictionChange } from './restrictions';

const TX_TYPE_MULTISIG_MODIFICATION = 0x4155;

// The few fields of a deserialized transaction this file reads (the SDK's classes are much larger).
interface LooseEmbedded {
  type: { value: number };
  network: { value: number } | number;
  signerPublicKey: { toString(): string };
  recipientAddress?: { bytes: Uint8Array };
  mosaics?: Array<{ mosaicId: { value: bigint }; amount: { value: bigint } }>;
  message?: Uint8Array;
  minApprovalDelta?: number;
  minRemovalDelta?: number;
  addressAdditions?: Array<{ bytes: Uint8Array }>;
  addressDeletions?: Array<{ bytes: Uint8Array }>;
  // account restriction transactions: the values are addresses (bytes), mosaic ids (value) or transaction types (value)
  restrictionFlags?: { value: number } | number;
  restrictionAdditions?: LooseRestrictionValue[];
  restrictionDeletions?: LooseRestrictionValue[];
  // metadata transactions
  targetAddress?: { bytes: Uint8Array };
  targetMosaicId?: { value: bigint };
  targetNamespaceId?: { value: bigint };
  scopedMetadataKey?: bigint;
  valueSizeDelta?: number;
  value?: Uint8Array;
}
type LooseRestrictionValue = { bytes: Uint8Array } | { value: bigint | number };
interface LooseTx extends LooseEmbedded {
  signature: { bytes: Uint8Array };
  fee: { value: bigint };
  deadline: { value: bigint };
  transactions?: LooseEmbedded[];
  transactionsHash?: { toString(): string };
  cosignatures?: unknown[];
}

const numberOf = (v: { value: number } | number): number => (typeof v === 'number' ? v : v.value);

export interface PayloadSummary {
  typeValue: number;
  isAggregate: boolean;
  bonded: boolean; // an aggregate that still needs cosignatures through a hash lock
  signerPublicKey: string;
  signerAddress: string;
  networkByte: number;
  deadlineMs: number; // unix ms
  fee: bigint; // atomic XYM, the maximum fee in the payload
  signed: boolean; // the signature field is not all zeros
  hash: string; // recomputed from the bytes
  cosignatureCount: number; // cosignatures already attached to an aggregate
  /**
   * An aggregate's hash covers only its header and the hash of its inner transactions, so a payload whose inner
   * transactions were swapped keeps the same hash. false when the inner transactions do not match that hash:
   * what `items` shows is then NOT what a signature over `hash` would approve. Always true for a plain transaction.
   */
  contentsMatchHash: boolean;
  items: PartialItem[]; // the transfer itself, or the aggregate's inner transactions
}

/** Options for reading a payload without a node (the offline cosign screen). */
export interface SummarizeOptions {
  /** Never ask a node: mosaics are named from the network currency and `knownMosaics` only; others show their id and the raw amount. */
  offline?: boolean;
  /** Mosaics this device remembers (id -> symbol and divisibility). Only used offline. */
  knownMosaics?: Record<string, { symbol: string; divisibility: number }>;
}

async function transferItem(account: string, e: LooseEmbedded, opts: SummarizeOptions): Promise<PartialItem> {
  const recipientBytes = Uint8Array.from(e.recipientAddress?.bytes ?? []);
  const mosaics = e.mosaics ?? [];
  const rawIds = mosaics.map((m) => m.mosaicId.value.toString(16).toUpperCase().padStart(16, '0'));
  let ids: string[];
  let infos: Record<string, { symbol: string; divisibility: number }>;
  if (opts.offline) {
    const cfg = getNetworkConfig();
    ids = rawIds.map((id) => (id === XYM_NAMESPACE_ID ? cfg.currencyMosaicId.toUpperCase() : id));
    infos = { [cfg.currencyMosaicId.toUpperCase()]: { symbol: CURRENCY_SYMBOL, divisibility: CURRENCY_DIVISIBILITY }, ...(opts.knownMosaics ?? {}) };
  } else {
    ids = await Promise.all(rawIds.map((id) => resolveMosaicId(id)));
    infos = ids.length > 0 ? await getMosaicInfos(ids) : {};
  }
  const bytes = e.message ?? new Uint8Array(0);
  const encrypted = bytes.length > 0 && bytes[0] === 1;
  return {
    kind: 'transfer',
    account,
    // The first address byte's lowest bit marks a namespace alias, which has no plain address.
    recipient: recipientBytes.length === 24 && (recipientBytes[0] & 1) === 0 ? addressBytesToString(recipientBytes) : '@namespace',
    mosaics: mosaics.map((m, i) => {
      const info = infos[ids[i]];
      return { symbol: info?.symbol ?? ids[i], amount: formatAtomic(m.amount.value, info?.divisibility ?? 0) };
    }),
    message: bytes.length > 0 && !encrypted ? new TextDecoder().decode(bytes.slice(1)) : '',
    encrypted,
  };
}

/** A restriction value in the form the node's REST answer uses (48 hex address / 16 hex mosaic id / type number). */
function restrictionRawValue(v: LooseRestrictionValue): string | number {
  if ('bytes' in v) return bytesToHex(Uint8Array.from(v.bytes));
  return typeof v.value === 'bigint' ? v.value.toString(16).toUpperCase().padStart(16, '0') : v.value;
}

async function itemOf(e: LooseEmbedded, opts: SummarizeOptions): Promise<PartialItem> {
  const type = e.type.value;
  const account = addressFromPublicKey(e.signerPublicKey.toString(), numberOf(e.network));
  if (type === TX_TYPE_TRANSFER) return transferItem(account, e, opts);
  if (type === TX_TYPE_MULTISIG_MODIFICATION) {
    return {
      kind: 'multisig',
      account,
      minApprovalDelta: e.minApprovalDelta ?? 0,
      minRemovalDelta: e.minRemovalDelta ?? 0,
      additions: (e.addressAdditions ?? []).map((a) => addressBytesToString(Uint8Array.from(a.bytes))),
      deletions: (e.addressDeletions ?? []).map((a) => addressBytesToString(Uint8Array.from(a.bytes))),
    };
  }
  const metadataType = metadataTypeOfTx(type);
  if (metadataType !== null && e.targetAddress && e.scopedMetadataKey !== undefined) {
    const hex16 = (v: bigint) => v.toString(16).toUpperCase().padStart(16, '0');
    const change = Uint8Array.from(e.value ?? []);
    const delta = Number(e.valueSizeDelta ?? 0);
    const id = metadataType === 'mosaic' ? e.targetMosaicId?.value : metadataType === 'namespace' ? e.targetNamespaceId?.value : undefined;
    return {
      kind: 'metadata',
      account,
      targetType: metadataType,
      targetAddress: addressBytesToString(Uint8Array.from(e.targetAddress.bytes)),
      targetId: id === undefined ? undefined : hex16(id),
      key: hex16(BigInt(e.scopedMetadataKey)),
      valueSizeDelta: delta,
      changeHex: bytesToHex(change),
      // Offline the stored value is unknown: only a brand-new key (the change IS the value) can be shown as text.
      value: resolveMetadataValue(change, delta, 'new'),
    };
  }
  if (Object.values(RESTRICTION_TX_TYPE).includes(type) && e.restrictionFlags !== undefined) {
    const change = parseRestrictionChange(
      type,
      numberOf(e.restrictionFlags),
      (e.restrictionAdditions ?? []).map(restrictionRawValue),
      (e.restrictionDeletions ?? []).map(restrictionRawValue),
    );
    if (change) return { kind: 'restriction', account, ...change };
  }
  return { kind: 'other', account, type };
}

/** Throws Error('invalid_payload') when the hex is not a transaction this network understands. */
export async function summarizePayload(payloadHex: string, opts: SummarizeOptions = {}): Promise<PayloadSummary> {
  let tx: ReturnType<typeof models.TransactionFactory.deserialize>;
  try {
    tx = models.TransactionFactory.deserialize(hexToBytes(payloadHex));
  } catch {
    throw new Error('invalid_payload');
  }
  const loose = tx as unknown as LooseTx;
  const networkByte = numberOf(loose.network);
  if (!isSupportedNetworkByte(networkByte)) throw new Error('invalid_payload');
  const typeValue = loose.type.value;
  const isAggregate = typeValue === TX_TYPE_AGGREGATE_COMPLETE || typeValue === TX_TYPE_AGGREGATE_BONDED;
  const signerPublicKey = loose.signerPublicKey.toString().toUpperCase();
  let hash: string;
  try {
    hash = facadeFor(networkByte).hashTransaction(tx).toString().toUpperCase();
  } catch {
    throw new Error('invalid_payload');
  }
  let contentsMatchHash = true;
  if (isAggregate) {
    try {
      contentsMatchHash = SymbolFacade.hashEmbeddedTransactions(loose.transactions as never).toString().toUpperCase() === (loose.transactionsHash?.toString() ?? '').toUpperCase();
    } catch {
      contentsMatchHash = false;
    }
  }
  const items = isAggregate ? await Promise.all((loose.transactions ?? []).map((e) => itemOf(e, opts))) : [await itemOf(loose, opts)];
  return {
    typeValue,
    isAggregate,
    bonded: typeValue === TX_TYPE_AGGREGATE_BONDED,
    signerPublicKey,
    signerAddress: addressFromPublicKey(signerPublicKey, networkByte),
    networkByte,
    deadlineMs: Number(loose.deadline.value) + getNetworkConfig().epochAdjustment * 1000,
    fee: loose.fee.value,
    signed: loose.signature.bytes.some((b) => b !== 0),
    hash,
    cosignatureCount: loose.cosignatures?.length ?? 0,
    contentsMatchHash,
    items,
  };
}
