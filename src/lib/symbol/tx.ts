// Symbol TransferTransactionV1 built, signed and parsed with the official SDK (symbol-sdk v3).
import { Hash256, PrivateKey, PublicKey } from 'symbol-sdk';
import { Address, KeyPair, MessageEncoder, SymbolFacade, generateMosaicId, generateNamespaceId, models } from 'symbol-sdk/symbol';
import { bytesToHex, facadeFor, hexToBytes, normalizeAddress } from './crypto';
import { xorValue } from './metadata';
import type { MetadataItem } from './metadata';
import { embeddedRestrictionSize, restrictionFlags } from './restrictions';
import type { RestrictionKind, RestrictionMode, RestrictionRule } from './restrictions';

export interface MosaicAmount {
  id: string; // 16 hex chars
  amount: bigint; // atomic units
}

export interface TransferParams {
  signerPublicKey: string;
  networkByte: number;
  recipient: string; // base32 address
  mosaics: MosaicAmount[];
  message?: string; // plain text, '' / undefined = none
  encryptedMessage?: Uint8Array; // an already encrypted message (type byte included); wins over `message`
  maxFee: bigint;
  deadline: bigint; // ms since the network epoch
}

export const MAX_MESSAGE_BYTES = 1023; // plain message: 1 type byte + up to 1023 bytes
// Encrypted message: 1 type byte + 16 byte AES-GCM tag + 12 byte IV + the ciphertext (as long as the text).
export const ENCRYPTED_MESSAGE_OVERHEAD = 28;
export const MAX_ENCRYPTED_MESSAGE_BYTES = MAX_MESSAGE_BYTES - ENCRYPTED_MESSAGE_OVERHEAD;

export function messageByteLength(message: string): number {
  return new TextEncoder().encode(message).length;
}

export function encodeMessage(message: string | undefined): Uint8Array | undefined {
  if (!message) return undefined;
  const text = new TextEncoder().encode(message);
  if (text.length > MAX_MESSAGE_BYTES) throw new Error('message_too_long');
  return Uint8Array.of(0x00, ...text); // 0x00 = plain text message
}

/**
 * The `message` entry of a transfer descriptor. The SDK throws ("descriptor does not have attribute message")
 * when the key is present with the value undefined, so a transfer without a message must leave the key out.
 */
export function messageField(message: string | undefined): { message?: Uint8Array } {
  const encoded = encodeMessage(message);
  return encoded ? { message: encoded } : {};
}

/**
 * Encrypts `text` for `recipientPublicKey` with the sender's private key (SDK message encoder:
 * a shared key from the two keys, AES-GCM). Returns the message bytes including the type byte.
 */
export function encryptMessage(senderPrivateKey: string, recipientPublicKey: string, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_ENCRYPTED_MESSAGE_BYTES) throw new Error('message_too_long');
  const encoder = new MessageEncoder(new KeyPair(new PrivateKey(senderPrivateKey)));
  return encoder.encode(new PublicKey(recipientPublicKey), bytes);
}

/**
 * Decrypts an encrypted message (hex of the whole message field). `otherPublicKey` is the public key
 * of the other side: the sender's when we received it, the recipient's when we sent it. Returns null
 * when it cannot be decrypted with this key.
 */
export function decryptMessage(myPrivateKey: string, otherPublicKey: string, messageHex: string): string | null {
  try {
    const encoder = new MessageEncoder(new KeyPair(new PrivateKey(myPrivateKey)));
    const result = encoder.tryDecode(new PublicKey(otherPublicKey), hexToBytes(messageHex)) as unknown as {
      isDecoded: boolean;
      message: Uint8Array | string;
    };
    if (!result.isDecoded) return null;
    return typeof result.message === 'string' ? result.message : new TextDecoder().decode(result.message);
  } catch {
    return null;
  }
}

function buildTransfer(p: TransferParams) {
  const facade = facadeFor(p.networkByte);
  // The protocol requires mosaics sorted ascending by id.
  const mosaics = [...p.mosaics]
    .map((m) => ({ mosaicId: BigInt(`0x${m.id}`), amount: m.amount }))
    .sort((a, b) => (a.mosaicId < b.mosaicId ? -1 : a.mosaicId > b.mosaicId ? 1 : 0));
  const tx = facade.transactionFactory.create({
    type: 'transfer_transaction_v1',
    signerPublicKey: p.signerPublicKey,
    fee: p.maxFee,
    deadline: p.deadline,
    recipientAddress: p.recipient,
    mosaics,
    ...(p.encryptedMessage ? { message: p.encryptedMessage } : messageField(p.message)),
  });
  return { facade, tx };
}

// Fixed part of a TransferTransactionV1: 128 bytes of common header + body (size, reserved, signature,
// signer public key, version, network, type, fee, deadline) and 32 bytes of transfer body
// (recipient 24, message size 2, mosaic count 1, two reserved fields 5).
const TRANSFER_BASE_SIZE = 160;
const MOSAIC_ENTRY_SIZE = 16; // mosaic id 8 + amount 8

/**
 * Size in bytes of the transfer, used to compute the fee before signing. It is worked out from the
 * layout (a one-mosaic transfer without a message is the well-known 176 bytes) rather than by
 * building a dummy transaction, so it needs no recipient, amount or key and cannot fail.
 */
export function transferSize(mosaicCount: number, message: string | undefined, encrypted = false): number {
  const messageSize = message ? 1 + (encrypted ? ENCRYPTED_MESSAGE_OVERHEAD : 0) + messageByteLength(message) : 0; // 1 type byte + text
  return TRANSFER_BASE_SIZE + MOSAIC_ENTRY_SIZE * mosaicCount + messageSize;
}

export interface SignedTransaction {
  payload: string; // hex, ready for PUT /transactions
  hash: string;
}

export function signTransfer(privateKey: string, generationHash: string, p: TransferParams): SignedTransaction {
  const { facade, tx } = buildTransfer(p);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

/** Symbol: 署名の対象は、ジェネレーションハッシュ(32) ＋ ヘッダー(108バイト)より後ろ。 */
export const SYMBOL_VERIFIABLE_OFFSET = 108;

export function symbolSigningPayload(generationHash: string, serializedTx: Uint8Array): Uint8Array {
  const gen = hexToBytes(generationHash);
  const out = new Uint8Array(gen.length + serializedTx.length - SYMBOL_VERIFIABLE_OFFSET);
  out.set(gen, 0);
  out.set(serializedTx.subarray(SYMBOL_VERIFIABLE_OFFSET), gen.length);
  return out;
}

/**
 * Same transfer as signTransfer, but the signature comes from `sign` (e.g. a Ledger) instead of a private
 * key held here. `sign` gets the bytes to sign (see symbolSigningPayload) and returns the 64-byte signature.
 */
export async function signTransferWith(sign: (payload: Uint8Array) => Promise<Uint8Array>, generationHash: string, p: TransferParams): Promise<SignedTransaction> {
  const { facade, tx } = buildTransfer(p);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const signature = await sign(symbolSigningPayload(generationHash, tx.serialize()));
  tx.signature = new models.Signature(Uint8Array.from(signature));
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

/**
 * The unsigned transfer (signature left as zeros) as hex. This is what a transaction URI carries: whoever
 * opens the URI reviews it and signs it themselves, so it contains no signature.
 */
export function serializeUnsignedTransfer(p: TransferParams): string {
  const { tx } = buildTransfer(p);
  return bytesToHex(tx.serialize());
}

export interface ParsedTransfer {
  recipient: Uint8Array; // 24 bytes
  mosaics: MosaicAmount[];
  message: string;
  encryptedMessage: boolean;
}

/** Reads the transfer body out of a serialized transaction (used by transaction-request QR codes). */
export function parseTransferPayload(payloadHex: string): ParsedTransfer | null {
  try {
    const tx = models.TransactionFactory.deserialize(hexToBytes(payloadHex)) as InstanceType<typeof models.TransferTransactionV1>;
    if (tx.type.value !== models.TransactionType.TRANSFER.value) return null;
    const bytes = tx.message ?? new Uint8Array(0);
    const encryptedMessage = bytes.length > 0 && bytes[0] === 1;
    return {
      recipient: Uint8Array.from(tx.recipientAddress.bytes),
      mosaics: tx.mosaics.map((m) => ({
        id: m.mosaicId.value.toString(16).toUpperCase().padStart(16, '0'),
        amount: m.amount.value,
      })),
      message: bytes.length > 0 && !encryptedMessage ? new TextDecoder().decode(bytes.slice(1)) : '',
      encryptedMessage,
    };
  } catch {
    return null;
  }
}

// --- metadata -------------------------------------------------------------------------------
// Metadata is attached with Account/Mosaic/NamespaceMetadataTransactionV1. These can only be sent
// inside an aggregate, so each one is an embedded transaction. The signer is the "source" of the
// entry. When the source is also the owner of the target (the wallet's own address / mosaic /
// namespace) the aggregate is complete and needs no co-signature. For another account's address,
// mosaic or namespace the owner of the target has to co-sign too, so the aggregate is bonded
// (hash lock first, then the owner signs it as a partial transaction).

export type MetadataTarget =
  | { type: 'account' }
  | { type: 'mosaic'; mosaicId: string } // 16 hex chars
  | { type: 'namespace'; namespaceId: string }; // 16 hex chars

export interface MetadataChange {
  /** The account the metadata is attached to (the owner of the mosaic / namespace). Omitted = the signer's own account. */
  targetAddress?: string;
  target: MetadataTarget;
  key: bigint; // scoped metadata key
  oldValue: Uint8Array; // value currently stored (empty when the key is new)
  newValue: Uint8Array;
}

/** Embedded metadata transaction; the target account is `c.targetAddress`, or `ownerAddress` (the source) when omitted. */
function createMetadataEmbedded(facade: SymbolFacade, signerPublicKey: string, ownerAddress: string, c: MetadataChange) {
  const common = {
    signerPublicKey,
    targetAddress: normalizeAddress(c.targetAddress ?? ownerAddress),
    scopedMetadataKey: c.key, // a plain bigint in SDK v3
    valueSizeDelta: c.newValue.length - c.oldValue.length,
    value: xorValue(c.oldValue, c.newValue),
  };
  if (c.target.type === 'mosaic') {
    return facade.transactionFactory.createEmbedded({
      type: 'mosaic_metadata_transaction_v1',
      ...common,
      targetMosaicId: new models.UnresolvedMosaicId(BigInt(`0x${c.target.mosaicId}`)),
    });
  }
  if (c.target.type === 'namespace') {
    return facade.transactionFactory.createEmbedded({
      type: 'namespace_metadata_transaction_v1',
      ...common,
      targetNamespaceId: new models.NamespaceId(BigInt(`0x${c.target.namespaceId}`)),
    });
  }
  return facade.transactionFactory.createEmbedded({ type: 'account_metadata_transaction_v1', ...common });
}

/** Brand-new entries (no previous value) for one target, as embedded transactions. */
function newMetadataEmbedded(facade: SymbolFacade, signerPublicKey: string, ownerAddress: string, target: MetadataTarget, items: MetadataItem[]) {
  return items.map((item) =>
    createMetadataEmbedded(facade, signerPublicKey, ownerAddress, { target, key: item.key, oldValue: new Uint8Array(0), newValue: item.value }));
}

export interface MetadataParams {
  signerPublicKey: string;
  ownerAddress: string; // base32 address of the signer
  networkByte: number;
  changes: MetadataChange[];
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
  /** AggregateBonded instead of AggregateComplete: the owner of another account's target still has to co-sign. */
  bonded?: boolean;
  /** Signatures still to be collected from others; the fee leaves room for them. */
  cosignatureCount?: number;
}

export interface SignedMetadata extends SignedTransaction {
  fee: bigint; // atomic XYM, the maximum fee that was signed
}

export function signMetadata(privateKey: string, generationHash: string, p: MetadataParams): SignedMetadata {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (p.changes.length === 0) throw new Error('no_metadata');
  const embedded = p.changes.map((c) => createMetadataEmbedded(facade, p.signerPublicKey, p.ownerAddress, c));
  const tx = facade.transactionFactory.create({
    type: p.bonded ? 'aggregate_bonded_transaction_v3' : 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  // The cosignatures that are attached later make the transaction bigger, so the fee leaves room for them.
  tx.fee = new models.Amount(BigInt(tx.size + COSIGNATURE_SIZE * (p.cosignatureCount ?? 0)) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString(), fee: BigInt(tx.fee.value) };
}

// --- mosaic creation ----------------------------------------------------------------------
// A mosaic is created by one AggregateCompleteTransactionV3 that holds two embedded transactions,
// both signed by the owner: MosaicDefinition (id, flags, divisibility, duration) followed by
// MosaicSupplyChange (the initial supply). Creating it in one aggregate means either both are
// applied or neither is.

// Mosaic flag bits (the protocol's MosaicFlags).
export const MOSAIC_FLAG_SUPPLY_MUTABLE = 1;
export const MOSAIC_FLAG_TRANSFERABLE = 2;
export const MOSAIC_FLAG_RESTRICTABLE = 4;
export const MOSAIC_FLAG_REVOKABLE = 8;

export const MAX_MOSAIC_DIVISIBILITY = 6;
export const MAX_MOSAIC_SUPPLY = 9_000_000_000_000_000n; // atomic units (network limit)
export const BLOCKS_PER_DAY = 2880; // 30 second blocks

// Size of the aggregate: 128 (common header) + 40 (aggregate body) + two embedded transactions of
// 72 bytes each (48 header + 22 / 17 body, each padded to a multiple of 8). Only used to show the
// fee before signing; the signed fee is computed from the real transaction size.
export const MOSAIC_CREATION_SIZE = 312;

export interface MosaicCreationParams {
  signerPublicKey: string;
  ownerAddress: string; // base32 address of the signer (the mosaic id is derived from it)
  networkByte: number;
  nonce: number; // uint32, makes the mosaic id unique per owner
  divisibility: number; // 0..6
  flags: number; // OR of the MOSAIC_FLAG_* bits
  duration: bigint; // blocks, 0n = never expires
  supply: bigint; // initial supply in atomic units
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
  metadata?: MetadataItem[]; // optional entries set on the new mosaic in the same aggregate
}

/** A random uint32 for the mosaic nonce. */
export function newMosaicNonce(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0];
}

export interface SignedMosaicCreation extends SignedTransaction {
  mosaicId: string; // 16 hex chars
}

export function signMosaicCreation(privateKey: string, generationHash: string, p: MosaicCreationParams): SignedMosaicCreation {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const mosaicId = BigInt(generateMosaicId(new Address(p.ownerAddress), p.nonce));
  const embedded = [
    facade.transactionFactory.createEmbedded({
      type: 'mosaic_definition_transaction_v1',
      signerPublicKey: p.signerPublicKey,
      id: new models.MosaicId(mosaicId),
      duration: new models.BlockDuration(p.duration),
      nonce: new models.MosaicNonce(p.nonce),
      flags: new models.MosaicFlags(p.flags),
      divisibility: p.divisibility,
    }),
    facade.transactionFactory.createEmbedded({
      type: 'mosaic_supply_change_transaction_v1',
      signerPublicKey: p.signerPublicKey,
      mosaicId: new models.UnresolvedMosaicId(mosaicId),
      delta: new models.Amount(p.supply),
      action: models.MosaicSupplyChangeAction.INCREASE,
    }),
    // Optional metadata on the mosaic being created (the definition above runs first).
    ...newMetadataEmbedded(
      facade, p.signerPublicKey, p.ownerAddress,
      { type: 'mosaic', mosaicId: mosaicId.toString(16).toUpperCase().padStart(16, '0') },
      p.metadata ?? [],
    ),
  ];
  const tx = facade.transactionFactory.create({
    type: 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return {
    payload: bytesToHex(tx.serialize()),
    hash: facade.hashTransaction(tx).toString(),
    mosaicId: mosaicId.toString(16).toUpperCase().padStart(16, '0'),
  };
}

// --- mosaic supply change (standalone) --------------------------------------------------------
// One MosaicSupplyChangeTransactionV1 signed by the mosaic's owner (inside an aggregate it is the
// embedded variant built by lib/symbol/aggregate.ts). The protocol only accepts it when the mosaic was
// created with the supply-mutable flag AND the owner holds the whole supply.

// 128 (common header) + mosaic id 8 + delta 8 + action 1 (padded by the SDK, which reports the real size).
export const MOSAIC_SUPPLY_CHANGE_SIZE = 145;

export type SupplyAction = 'increase' | 'decrease';

export interface MosaicSupplyChangeParams {
  signerPublicKey: string;
  networkByte: number;
  mosaicId: string; // 16 hex chars
  action: SupplyAction;
  delta: bigint; // atomic units, > 0
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

export function signMosaicSupplyChange(privateKey: string, generationHash: string, p: MosaicSupplyChangeParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (p.delta <= 0n) throw new Error('supply_delta_zero');
  const tx = facade.transactionFactory.create({
    type: 'mosaic_supply_change_transaction_v1',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    mosaicId: new models.UnresolvedMosaicId(BigInt(`0x${p.mosaicId}`)),
    delta: new models.Amount(p.delta),
    action: p.action === 'increase' ? models.MosaicSupplyChangeAction.INCREASE : models.MosaicSupplyChangeAction.DECREASE,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

// --- alias link / unlink (エイリアス) ------------------------------------------------------------
// AddressAliasTransactionV1 / MosaicAliasTransactionV1: points a namespace the signer owns at an address or a
// mosaic (link), or takes the alias away again (unlink). Unlinking must name exactly what is linked now.

// 128 (common header) + namespace id 8 + target (address 24 / mosaic id 8) + action 1.
export const ADDRESS_ALIAS_SIZE = 161;
export const MOSAIC_ALIAS_SIZE = 145;

export type AliasAction = 'link' | 'unlink';
export type AliasTarget = { type: 'address'; address: string } | { type: 'mosaic'; mosaicId: string };

export interface AliasParams {
  signerPublicKey: string;
  networkByte: number;
  namespaceId: string; // 16 hex chars
  action: AliasAction;
  target: AliasTarget; // what is linked (link) / what is linked now (unlink)
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

export function aliasTransactionSize(type: AliasTarget['type']): number {
  return type === 'address' ? ADDRESS_ALIAS_SIZE : MOSAIC_ALIAS_SIZE;
}

export function signAlias(privateKey: string, generationHash: string, p: AliasParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const common = {
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    namespaceId: new models.NamespaceId(BigInt(`0x${p.namespaceId}`)),
    aliasAction: p.action === 'link' ? models.AliasAction.LINK : models.AliasAction.UNLINK,
  };
  const tx = p.target.type === 'address'
    ? facade.transactionFactory.create({ type: 'address_alias_transaction_v1', ...common, address: normalizeAddress(p.target.address) })
    : facade.transactionFactory.create({ type: 'mosaic_alias_transaction_v1', ...common, mosaicId: new models.MosaicId(BigInt(`0x${p.target.mosaicId}`)) });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

// --- namespace registration -----------------------------------------------------------------
// One NamespaceRegistrationTransactionV1. A root namespace is rented for a number of blocks; a
// child namespace (parent.child, at most 3 levels in total) has no duration of its own.

export const MAX_NAMESPACE_NAME_LENGTH = 64;
export const MIN_NAMESPACE_DAYS = 30;
export const MAX_NAMESPACE_DAYS = 1825; // 5 years
export const MAX_NAMESPACE_DEPTH = 3;
// One part of a namespace name: lower-case letters, digits, '_' and '-', not starting with '_' or '-'.
export const NAMESPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidNamespaceName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAMESPACE_NAME_LENGTH && NAMESPACE_NAME_PATTERN.test(name);
}

/** Size of the transaction: 128 common header + 18 fixed body fields + the name bytes. */
export function namespaceRegistrationSize(name: string): number {
  return 128 + 18 + new TextEncoder().encode(name).length;
}

export interface NamespaceRegistrationParams {
  signerPublicKey: string;
  ownerAddress?: string; // base32 address of the signer; needed only when `metadata` is given
  networkByte: number;
  name: string; // this level's name only (e.g. "company", not "parent.company")
  parentId?: string; // 16 hex chars; omitted for a root namespace
  duration?: bigint; // blocks; root namespaces only
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
  metadata?: MetadataItem[]; // optional entries set on the new namespace in the same aggregate
}

export interface SignedNamespaceRegistration extends SignedTransaction {
  namespaceId: string; // 16 hex chars
}

export function signNamespaceRegistration(privateKey: string, generationHash: string, p: NamespaceRegistrationParams): SignedNamespaceRegistration {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (!isValidNamespaceName(p.name)) throw new Error('invalid_namespace_name');
  const parent = p.parentId ? BigInt(`0x${p.parentId}`) : undefined;
  const namespaceId = BigInt(generateNamespaceId(p.name, parent ?? 0n));
  const namespaceIdHex = namespaceId.toString(16).toUpperCase().padStart(16, '0');
  const common = {
    signerPublicKey: p.signerPublicKey,
    id: new models.NamespaceId(namespaceId),
    name: new TextEncoder().encode(p.name),
  };
  const registrationType = parent === undefined ? models.NamespaceRegistrationType.ROOT : models.NamespaceRegistrationType.CHILD;
  const metadata = p.metadata ?? [];

  let tx;
  if (metadata.length === 0) {
    // Plain registration: one transaction.
    const body = { ...common, fee: 0n, deadline: p.deadline };
    tx = parent === undefined
      ? facade.transactionFactory.create({
        type: 'namespace_registration_transaction_v1',
        ...body,
        registrationType,
        duration: new models.BlockDuration(p.duration ?? 0n),
      })
      : facade.transactionFactory.create({
        type: 'namespace_registration_transaction_v1',
        ...body,
        registrationType,
        parentId: new models.NamespaceId(parent),
      });
  } else {
    // With metadata: the registration and the metadata entries travel in one aggregate, so either
    // everything is applied or nothing is. The registration is first, so the namespace exists
    // by the time its metadata is set.
    if (!p.ownerAddress) throw new Error('owner_address_required');
    const registration = parent === undefined
      ? facade.transactionFactory.createEmbedded({
        type: 'namespace_registration_transaction_v1',
        ...common,
        registrationType,
        duration: new models.BlockDuration(p.duration ?? 0n),
      })
      : facade.transactionFactory.createEmbedded({
        type: 'namespace_registration_transaction_v1',
        ...common,
        registrationType,
        parentId: new models.NamespaceId(parent),
      });
    const embedded = [
      registration,
      ...newMetadataEmbedded(facade, p.signerPublicKey, p.ownerAddress, { type: 'namespace', namespaceId: namespaceIdHex }, metadata),
    ];
    tx = facade.transactionFactory.create({
      type: 'aggregate_complete_transaction_v3',
      signerPublicKey: p.signerPublicKey,
      fee: 0n,
      deadline: p.deadline,
      transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
      transactions: embedded,
    });
  }
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return {
    payload: bytesToHex(tx.serialize()),
    hash: facade.hashTransaction(tx).toString(),
    namespaceId: namespaceIdHex,
  };
}

/** Size of the registration as an embedded transaction inside an aggregate: 48 header + 18 body + name. */
export function namespaceRegistrationEmbeddedSize(name: string): number {
  return Math.ceil((48 + 18 + new TextEncoder().encode(name).length) / 8) * 8;
}

// --- harvesting (remote / delegated) ---------------------------------------------------------
// Delegated harvesting needs two things from the main account:
//  1. one AggregateCompleteTransactionV3 holding three key links (or unlinks): AccountKeyLink
//     (the remote account that signs blocks), VrfKeyLink (the VRF account) and NodeKeyLink (the
//     node that harvests for us);
//  2. a TransferTransaction to the node's address whose message is the "persistent harvesting
//     delegation request": the remote and VRF private keys, encrypted for the node's public key.
// The remote and VRF accounts are throw-away keys that can only harvest, never move funds.

export type HarvestLinkKind = 'remote' | 'vrf' | 'node';

export interface HarvestLink {
  kind: HarvestLinkKind;
  publicKey: string; // 64 hex chars of the linked key
  link: boolean; // true = link, false = unlink
}

// Size of the aggregate: 128 (common header) + 40 (aggregate body) + one embedded link per key
// (48 header + 33 body = 81, padded to 88).
export function harvestLinkSize(linkCount: number): number {
  return 128 + 40 + 88 * linkCount;
}

// Marker 8 + ephemeral public key 32 + AES-GCM tag 16 + IV 12 + encrypted private keys 64.
export const HARVEST_DELEGATION_MESSAGE_BYTES = 8 + 32 + 16 + 12 + 64;

/** Size of the delegation request (a transfer without mosaics carrying the encrypted message). */
export function harvestDelegationSize(): number {
  return TRANSFER_BASE_SIZE + HARVEST_DELEGATION_MESSAGE_BYTES;
}

/** A fresh random key pair for the remote or VRF account. */
export function newHarvestKeyPair(): { privateKey: string; publicKey: string } {
  const keyPair = new KeyPair(PrivateKey.random());
  return { privateKey: keyPair.privateKey.toString(), publicKey: keyPair.publicKey.toString() };
}

/** The public key (64 hex chars, upper case) of a remote / VRF private key; null when the text is not 64 hex chars. */
export function harvestPublicKeyOf(privateKey: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) return null;
  return new KeyPair(new PrivateKey(privateKey)).publicKey.toString().toUpperCase();
}

const HARVEST_LINK_TYPES: Record<HarvestLinkKind, 'account_key_link_transaction_v1' | 'vrf_key_link_transaction_v1' | 'node_key_link_transaction_v1'> = {
  remote: 'account_key_link_transaction_v1',
  vrf: 'vrf_key_link_transaction_v1',
  node: 'node_key_link_transaction_v1',
};

export interface HarvestLinkParams {
  signerPublicKey: string;
  networkByte: number;
  links: HarvestLink[];
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

export function signHarvestLinks(privateKey: string, generationHash: string, p: HarvestLinkParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (p.links.length === 0) throw new Error('no_links');
  const embedded = p.links.map((l) => facade.transactionFactory.createEmbedded({
    type: HARVEST_LINK_TYPES[l.kind],
    signerPublicKey: p.signerPublicKey,
    linkedPublicKey: new PublicKey(l.publicKey),
    linkAction: l.link ? models.LinkAction.LINK : models.LinkAction.UNLINK,
  }));
  const tx = facade.transactionFactory.create({
    type: 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

// --- voting key link (finalization voting) -------------------------------------------------------
// VotingKeyLinkTransaction: a BLS voting public key (48 bytes) valid for a range of finalization epochs. Link and unlink
// are sent in one AggregateCompleteTransactionV3 like the harvest keys, so a replacement (unlink + link) is one transaction.
export interface VotingKeyLink {
  publicKey: string; // 96 hex chars
  startEpoch: number;
  endEpoch: number;
  link: boolean; // true = link, false = unlink
}

// Size of the aggregate: 128 + 40 + one embedded voting link each
// (48 header + 48 key + 4 + 4 epochs + 1 action = 105, padded to 112).
export function votingLinkSize(linkCount: number): number {
  return 128 + 40 + 112 * linkCount;
}

export interface VotingKeyLinkParams {
  signerPublicKey: string;
  networkByte: number;
  links: VotingKeyLink[];
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

export function signVotingKeyLinks(privateKey: string, generationHash: string, p: VotingKeyLinkParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (p.links.length === 0) throw new Error('no_links');
  const embedded = p.links.map((l) => {
    if (!/^[0-9a-fA-F]{96}$/.test(l.publicKey)) throw new Error('invalid_voting_key');
    return facade.transactionFactory.createEmbedded({
      type: 'voting_key_link_transaction_v1',
      signerPublicKey: p.signerPublicKey,
      linkedPublicKey: new models.VotingPublicKey(Uint8Array.from(hexToBytes(l.publicKey))),
      startEpoch: new models.FinalizationEpoch(l.startEpoch),
      endEpoch: new models.FinalizationEpoch(l.endEpoch),
      linkAction: l.link ? models.LinkAction.LINK : models.LinkAction.UNLINK,
    });
  });
  const tx = facade.transactionFactory.create({
    type: 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

export interface HarvestDelegationParams {
  signerPublicKey: string;
  networkByte: number;
  nodePublicKey: string; // the node's public key (from its /node/info)
  remotePrivateKey: string;
  vrfPrivateKey: string;
  feeMultiplier: number;
  deadline: bigint;
}

export function signHarvestDelegation(privateKey: string, generationHash: string, p: HarvestDelegationParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const nodeKey = new PublicKey(p.nodePublicKey);
  // The ephemeral key pair inside the encoder is only a placeholder: the delegation message is
  // encrypted with a fresh ephemeral key whose public half travels in the message itself.
  const message = new MessageEncoder(new KeyPair(PrivateKey.random())).encodePersistentHarvestingDelegation(
    nodeKey,
    new KeyPair(new PrivateKey(p.remotePrivateKey)),
    new KeyPair(new PrivateKey(p.vrfPrivateKey)),
  );
  const tx = facade.transactionFactory.create({
    type: 'transfer_transaction_v1',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    recipientAddress: facade.network.publicKeyToAddress(nodeKey),
    mosaics: [],
    message,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

// --- multisig -----------------------------------------------------------------------------------
// Two kinds of aggregate are used:
//  - complete: every signature is already there (one cosigner is enough for an M-of-N account with
//    minApproval 1), announced directly;
//  - bonded: the others still have to cosign. It is announced as a "partial" transaction after a
//    hash lock (10 XYM, refunded when the aggregate is confirmed) has been confirmed.
// The embedded transaction is always signed in the name of the multisig account; the wallet signs
// the aggregate itself.

export const MAX_MULTISIG_COSIGNERS = 25;
export const COSIGNATURE_SIZE = 104; // public key 32 + signature 64 + version 8
export const HASH_LOCK_SIZE = 184; // 128 header + mosaic 16 + duration 8 + hash 32
export const DEFAULT_HASH_LOCK_AMOUNT = 10_000_000n; // 10 XYM
// A bonded aggregate may live at most 48 hours and its lock at most 5,760 blocks; stay below both.
export const HASH_LOCK_DURATION_BLOCKS = 5000n; // about 41.7 hours
export const BONDED_LIFETIME_MS = 40n * 60n * 60n * 1000n;

const AGGREGATE_HEADER_SIZE = 168; // 128 common header + 40 aggregate body

export interface MultisigChange {
  minApprovalDelta: number; // int8, change from the current value
  minRemovalDelta: number;
  additions: string[]; // base32 addresses of cosigners to add
  deletions: string[]; // base32 addresses of cosigners to remove
}

export type MultisigInner =
  | { kind: 'modification'; accountPublicKey: string; change: MultisigChange }
  | { kind: 'transfer'; accountPublicKey: string; recipient: string; mosaics: MosaicAmount[]; message?: string }
  // アカウント制限 of the multisig account itself: values are canonical (base32 address / 16 hex mosaic id / 4 hex type)
  | { kind: 'restriction'; accountPublicKey: string; rule: RestrictionRule; mode: RestrictionMode; additions: string[]; deletions: string[] };

/** Aggregate size (before cosignatures) of a multisig modification: 48 header + 8 body + 24 per address. */
export function multisigModificationAggregateSize(addressCount: number): number {
  return AGGREGATE_HEADER_SIZE + 56 + 24 * addressCount;
}

/** Aggregate size (before cosignatures) of a transfer sent in the name of a multisig account. */
export function multisigTransferAggregateSize(mosaicCount: number, message: string | undefined): number {
  const body = 32 + MOSAIC_ENTRY_SIZE * mosaicCount + (message ? 1 + messageByteLength(message) : 0);
  return AGGREGATE_HEADER_SIZE + Math.ceil((48 + body) / 8) * 8;
}

/** Aggregate size (before cosignatures) of an account restriction change made in the name of a multisig account. */
export function multisigRestrictionAggregateSize(kind: RestrictionKind, additionCount: number, deletionCount: number): number {
  return AGGREGATE_HEADER_SIZE + embeddedRestrictionSize(kind, additionCount, deletionCount);
}

function createMultisigEmbedded(facade: SymbolFacade, inner: MultisigInner) {
  if (inner.kind === 'restriction') {
    if (inner.additions.length === 0 && inner.deletions.length === 0) throw new Error('no_changes');
    return facade.transactionFactory.createEmbedded(restrictionDescriptor({
      signerPublicKey: inner.accountPublicKey,
      rule: inner.rule,
      mode: inner.mode,
      additions: inner.additions,
      deletions: inner.deletions,
    }));
  }
  if (inner.kind === 'modification') {
    const c = inner.change;
    return facade.transactionFactory.createEmbedded({
      type: 'multisig_account_modification_transaction_v1',
      signerPublicKey: inner.accountPublicKey,
      minApprovalDelta: c.minApprovalDelta,
      minRemovalDelta: c.minRemovalDelta,
      addressAdditions: c.additions.map((a) => normalizeAddress(a)),
      addressDeletions: c.deletions.map((a) => normalizeAddress(a)),
    });
  }
  const mosaics = [...inner.mosaics]
    .map((m) => ({ mosaicId: BigInt(`0x${m.id}`), amount: m.amount }))
    .sort((a, b) => (a.mosaicId < b.mosaicId ? -1 : a.mosaicId > b.mosaicId ? 1 : 0));
  return facade.transactionFactory.createEmbedded({
    type: 'transfer_transaction_v1',
    signerPublicKey: inner.accountPublicKey,
    recipientAddress: normalizeAddress(inner.recipient),
    mosaics,
    ...messageField(inner.message),
  });
}

export interface MultisigAggregateParams {
  signerPublicKey: string; // the wallet (initiator / cosigner)
  networkByte: number;
  inner: MultisigInner;
  bonded: boolean;
  cosignatureCount: number; // how many cosignatures the fee should allow for
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

export interface SignedMultisigAggregate extends SignedTransaction {
  fee: bigint; // atomic XYM, the maximum fee that was signed
}

export function signMultisigAggregate(privateKey: string, generationHash: string, p: MultisigAggregateParams): SignedMultisigAggregate {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const embedded = [createMultisigEmbedded(facade, p.inner)];
  const tx = facade.transactionFactory.create({
    type: p.bonded ? 'aggregate_bonded_transaction_v3' : 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  // The fee must also cover the cosignatures that will be attached later.
  tx.fee = new models.Amount(BigInt(tx.size + COSIGNATURE_SIZE * p.cosignatureCount) * BigInt(p.feeMultiplier));
  const fee = BigInt(tx.size + COSIGNATURE_SIZE * p.cosignatureCount) * BigInt(p.feeMultiplier);
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString(), fee };
}

export interface HashLockParams {
  signerPublicKey: string;
  networkByte: number;
  currencyMosaicId: string; // 16 hex chars
  amount: bigint; // atomic XYM to lock
  duration: bigint; // blocks
  aggregateHash: string; // hash of the bonded aggregate
  feeMultiplier: number;
  deadline: bigint;
}

export function signHashLock(privateKey: string, generationHash: string, p: HashLockParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const tx = facade.transactionFactory.create({
    type: 'hash_lock_transaction_v1',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    mosaic: { mosaicId: BigInt(`0x${p.currencyMosaicId}`), amount: p.amount },
    duration: new models.BlockDuration(p.duration),
    hash: new Hash256(p.aggregateHash),
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}

export interface CosignatureBody {
  parentHash: string;
  signature: string; // 128 hex chars
  signerPublicKey: string;
  version: string;
}

/** A cosignature is the cosigner's signature over the aggregate's hash. */
export function cosignAggregateHash(privateKey: string, aggregateHash: string): CosignatureBody {
  const keyPair = new KeyPair(new PrivateKey(privateKey));
  return {
    parentHash: aggregateHash.toUpperCase(),
    signature: bytesToHex(keyPair.sign(hexToBytes(aggregateHash)).bytes),
    signerPublicKey: keyPair.publicKey.toString(),
    version: '0',
  };
}

// --- account restrictions -------------------------------------------------------------------------
// アカウント制限: AccountAddress / AccountMosaic / AccountOperation RestrictionTransactionV1. Each one is a plain
// transaction (not an aggregate) signed by the account whose rules change. One transaction edits ONE list:
// the flags pick what is restricted (address / mosaic id / transaction type), the direction and allow vs block;
// additions and deletions are the values to put on / take off that list.

export interface AccountRestrictionParams {
  signerPublicKey: string;
  networkByte: number;
  rule: RestrictionRule;
  mode: RestrictionMode;
  /** Canonical values: base32 addresses / 16 hex mosaic ids / 4 hex transaction types. */
  additions: string[];
  deletions: string[];
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
}

/** What an account restriction transaction says; shared by the plain transaction and the one embedded in an aggregate. */
function restrictionDescriptor(p: {
  signerPublicKey: string;
  rule: RestrictionRule;
  mode: RestrictionMode;
  additions: string[];
  deletions: string[];
}): Record<string, unknown> {
  const common = {
    signerPublicKey: p.signerPublicKey,
    restrictionFlags: new models.AccountRestrictionFlags(restrictionFlags(p.rule, p.mode)),
  };
  const mosaicId = (id: string) => new models.UnresolvedMosaicId(BigInt(`0x${id}`));
  const operation = (code: string) => new models.TransactionType(parseInt(code, 16));
  if (p.rule.kind === 'address') {
    return {
      type: 'account_address_restriction_transaction_v1',
      ...common,
      restrictionAdditions: p.additions.map((a) => normalizeAddress(a)),
      restrictionDeletions: p.deletions.map((a) => normalizeAddress(a)),
    };
  }
  if (p.rule.kind === 'mosaic') {
    return {
      type: 'account_mosaic_restriction_transaction_v1',
      ...common,
      restrictionAdditions: p.additions.map(mosaicId),
      restrictionDeletions: p.deletions.map(mosaicId),
    };
  }
  return {
    type: 'account_operation_restriction_transaction_v1',
    ...common,
    restrictionAdditions: p.additions.map(operation),
    restrictionDeletions: p.deletions.map(operation),
  };
}

export function signAccountRestriction(privateKey: string, generationHash: string, p: AccountRestrictionParams): SignedTransaction {
  const facade = facadeFor(p.networkByte);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  if (p.additions.length === 0 && p.deletions.length === 0) throw new Error('no_changes');
  const tx = facade.transactionFactory.create({
    ...restrictionDescriptor(p),
    fee: 0n,
    deadline: p.deadline,
  });
  tx.fee = new models.Amount(BigInt(tx.size) * BigInt(p.feeMultiplier));
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString() };
}
