// NEM TransferTransactionV1 built and signed with the official SDK (symbol-sdk/nem).
import { Hash256, PrivateKey, PublicKey, Signature } from 'symbol-sdk';
import { Address, KeyPair, calculateTransactionFee, descriptors, models } from 'symbol-sdk/nem';
import { nemFacadeFor } from './crypto';
import { nemEncryptedPayloadLength } from './message';

const FEE_UNIT = 50_000n; // 0.05 XEM, in micro-XEM

export function nemMessageByteLength(message: string): number {
  return new TextEncoder().encode(message).length;
}

/**
 * Fee of an XEM transfer. NIS1 charges 0.05 XEM per 10,000 XEM sent (at least 0.05, at most
 * 1.25) plus 0.05 XEM per 32 bytes of message (rounded up, a message of 0-31 bytes costs one unit).
 */
export function nemTransferFee(amountMicro: bigint, message: string | undefined, encrypted = false): bigint {
  let units = amountMicro / 1_000_000n / 10_000n;
  if (units < 1n) units = 1n;
  if (units > 25n) units = 25n;
  let fee = units * FEE_UNIT;
  if (message) {
    // The fee follows the size of what goes on the chain: an encrypted message is longer than its text.
    const bytes = encrypted ? nemEncryptedPayloadLength(nemMessageByteLength(message)) : nemMessageByteLength(message);
    fee += BigInt(Math.floor(bytes / 32) + 1) * FEE_UNIT;
  }
  return fee;
}

/** Fee of an XEM transfer whose message is `messageBytes` long (0 = no message): the same rules as nemTransferFee. */
export function nemTransferFeeForLength(amountMicro: bigint, messageBytes: number): bigint {
  let units = amountMicro / 1_000_000n / 10_000n;
  if (units < 1n) units = 1n;
  if (units > 25n) units = 25n;
  let fee = units * FEE_UNIT;
  if (messageBytes > 0) fee += BigInt(Math.floor(messageBytes / 32) + 1) * FEE_UNIT;
  return fee;
}

// --- mosaic transfers (TransferTransactionV2) -------------------------------------------------
/** A mosaic to attach to a transfer: `id` is "namespace:name" (lower case), `quantity` in atomic units (divisibility applied). */
export interface NemMosaicAmount {
  id: string;
  quantity: bigint;
}

/** What NIS1 needs to price a mosaic transfer: the mosaic's supply (whole units) and divisibility. */
export interface NemMosaicFeeInfo {
  supply: bigint;
  divisibility: number;
}

export const NEM_XEM_MOSAIC_ID = 'nem:xem';
export const NEM_XEM_FEE_INFO: NemMosaicFeeInfo = { supply: 8_999_999_999n, divisibility: 6 };
/** In a version 2 transfer `amount` is a multiplier of every attached quantity: 1,000,000 = x1. */
const NEM_MOSAIC_MULTIPLIER_ONE = 1_000_000n;

export function splitNemMosaicId(id: string): { namespace: string; name: string } {
  const i = id.lastIndexOf(':');
  if (i <= 0 || i === id.length - 1) throw new Error(`invalid NEM mosaic id: ${id}`);
  return { namespace: id.slice(0, i), name: id.slice(i + 1) };
}

export interface NemTransferParams {
  publicKey: string;
  networkByte: number;
  recipient: string; // base32 address, 40 chars
  amount: bigint; // micro-XEM (ignored when `mosaics` is given)
  message?: string; // plain text, '' / undefined = none
  /** An already encrypted message payload (message type 2); wins over `message`. */
  encryptedMessage?: Uint8Array;
  /** Raw bytes as a plain-type message (not text), e.g. an apostille; wins over `message`. */
  messageBytes?: Uint8Array;
  fee: bigint; // micro-XEM
  /** Mosaics to attach (version 2 transfer). XEM may be one of them (as "nem:xem", micro-XEM). */
  mosaics?: NemMosaicAmount[];
  /** Seconds the transaction stays valid, counted from this device's clock (default 2 hours; NIS1 allows up to 24 hours). */
  timeoutSeconds?: number;
}

export const NEM_DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;
/**
 * A single "nem:xem" line is just a plain XEM transfer; anything else is a version 2 transfer that
 * carries every line as an attached mosaic. Returns what to put in NemTransferParams.
 */
export function normalizeNemTransferMosaics(mosaics: NemMosaicAmount[]): { amount: bigint; mosaics?: NemMosaicAmount[] } {
  if (mosaics.length === 0) throw new Error('no mosaic to send');
  const seen = new Set<string>();
  for (const m of mosaics) {
    if (m.quantity < 0n) throw new Error(`invalid quantity for ${m.id}`);
    splitNemMosaicId(m.id);
    if (seen.has(m.id)) throw new Error(`duplicated mosaic ${m.id}`);
    seen.add(m.id);
  }
  if (mosaics.length === 1 && mosaics[0].id === NEM_XEM_MOSAIC_ID) return { amount: mosaics[0].quantity };
  return { amount: 0n, mosaics };
}

function mosaicDescriptors(mosaics: NemMosaicAmount[]) {
  return mosaics.map((m) => {
    const { namespace, name } = splitNemMosaicId(m.id);
    return new descriptors.SizePrefixedMosaicDescriptor(
      new descriptors.MosaicDescriptor(new descriptors.MosaicIdDescriptor(new descriptors.NamespaceIdDescriptor(namespace), name), new models.Amount(m.quantity)),
    );
  });
}

function transferDescriptor(p: Pick<NemTransferParams, 'recipient' | 'amount' | 'message' | 'encryptedMessage' | 'messageBytes' | 'mosaics'>) {
  const recipient = new Address(p.recipient);
  const message = p.encryptedMessage
    ? new descriptors.MessageDescriptor(models.MessageType.ENCRYPTED, p.encryptedMessage)
    : p.messageBytes ? new descriptors.MessageDescriptor(models.MessageType.PLAIN, p.messageBytes)
      : p.message ? new descriptors.MessageDescriptor(models.MessageType.PLAIN, p.message) : undefined;
  if (p.mosaics && p.mosaics.length > 0) {
    return new descriptors.TransferTransactionV2Descriptor(recipient, new models.Amount(NEM_MOSAIC_MULTIPLIER_ONE), message, mosaicDescriptors(p.mosaics));
  }
  const amount = new models.Amount(p.amount);
  return message
    ? new descriptors.TransferTransactionV1Descriptor(recipient, amount, message)
    : new descriptors.TransferTransactionV1Descriptor(recipient, amount);
}

/**
 * Fee of a transfer that carries mosaics, from the SDK's own calculator (the rules NIS1 enforces:
 * a small-business mosaic costs one unit, others by their XEM-equivalent value, plus the message).
 * `infos` has the supply / divisibility of every attached mosaic ("nem:xem" is built in); throws when one is missing.
 */
export function nemMosaicTransferFee(networkByte: number, mosaics: NemMosaicAmount[], infos: Record<string, NemMosaicFeeInfo>, message: string | undefined, encrypted = false): bigint {
  const facade = nemFacadeFor(networkByte);
  // Any valid recipient will do: the fee does not depend on it.
  const probeRecipient = NEM_MOSAIC_SINK[networkByte] ?? NEM_MOSAIC_SINK[0x68];
  const transaction = facade.createTransactionFromTypedDescriptor(
    // The calculator only looks at the payload length: an encrypted message is priced as a filler of that size.
    transferDescriptor({ recipient: probeRecipient, amount: 0n, message: message && encrypted ? 'x'.repeat(nemEncryptedPayloadLength(nemMessageByteLength(message))) : message, mosaics }),
    new PublicKey(new Uint8Array(32)),
    0n,
    60,
  );
  return calculateTransactionFee(transaction as Parameters<typeof calculateTransactionFee>[0], { [NEM_XEM_MOSAIC_ID]: NEM_XEM_FEE_INFO, ...infos });
}

/** The fee to show / pay for a list of lines as the send screens build it (XEM-only lines use the plain formula). */
export function nemSendFee(networkByte: number, lines: NemMosaicAmount[], infos: Record<string, NemMosaicFeeInfo>, message: string | undefined, encrypted = false): bigint {
  const n = normalizeNemTransferMosaics(lines);
  return n.mosaics ? nemMosaicTransferFee(networkByte, n.mosaics, infos, message, encrypted) : nemTransferFee(n.amount, message, encrypted);
}

/** Builds the transfer, signs it, and returns the JSON body for POST /transaction/announce. */
export function signNemTransfer(privateKey: string, p: NemTransferParams): string {
  const facade = nemFacadeFor(p.networkByte);
  // 2 hours until the transaction expires (NIS1 allows up to 24 hours).
  const transaction = facade.createTransactionFromTypedDescriptor(transferDescriptor(p), new PublicKey(p.publicKey), p.fee, p.timeoutSeconds ?? NEM_DEFAULT_TIMEOUT_SECONDS);
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), transaction);
  const payload: unknown = facade.transactionFactory.static.attachSignature(transaction, signature);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/**
 * Same transfer as signNemTransfer, but the signature comes from `sign` (e.g. a Ledger) instead of a
 * private key held here. `sign` gets the serialized transaction and returns the 64-byte signature.
 */
export async function signNemTransferWith(sign: (serialized: Uint8Array) => Promise<Uint8Array>, p: NemTransferParams): Promise<string> {
  const facade = nemFacadeFor(p.networkByte);
  const transaction = facade.createTransactionFromTypedDescriptor(transferDescriptor(p), new PublicKey(p.publicKey), p.fee, 2 * 60 * 60);
  const signature = new Signature(await sign(transaction.serialize()));
  const payload: unknown = facade.transactionFactory.static.attachSignature(transaction, signature);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

// --- namespace registration / mosaic creation ------------------------------------------------
// The rental fees are paid to fixed "sink" accounts that nobody holds the key of.
const NEM_NAMESPACE_SINK: Record<number, string> = {
  0x68: 'NAMESPACEWH4MKFMBCVFERDPOOP4FK7MTBXDPZZA',
  0x98: 'TAMESPACEWH4MKFMBCVFERDPOOP4FK7MTDJEYP35',
};
const NEM_MOSAIC_SINK: Record<number, string> = {
  0x68: 'NBMOSAICOD4F54EE5CDMR23CCBGOAM2XSIUX6TRS',
  0x98: 'TBMOSAICOD4F54EE5CDMR23CCBGOAM2XSJBR5OLC',
};

/** The address a mosaic definition's rental fee is paid to (shown read-only on the creation form). */
export function nemMosaicSinkAddress(networkByte: number): string {
  return NEM_MOSAIC_SINK[networkByte] ?? NEM_MOSAIC_SINK[0x68];
}

/** The account the namespace rental fee is paid to (shown on the renewal screen, as in the official wallet). */
export function nemNamespaceSinkAddress(networkByte: number): string {
  return NEM_NAMESPACE_SINK[networkByte] ?? '';
}

export const NEM_ROOT_NAMESPACE_RENTAL = 100_000_000n; // 100 XEM
export const NEM_SUB_NAMESPACE_RENTAL = 10_000_000n; // 10 XEM
export const NEM_MOSAIC_RENTAL = 10_000_000n; // 10 XEM
/** Fee of a namespace registration or a mosaic definition: 3 units of 0.05 XEM. */
export const NEM_PROVISION_TX_FEE = 150_000n;

export const NEM_MAX_ROOT_NAMESPACE_LENGTH = 16;
export const NEM_MAX_SUB_NAMESPACE_LENGTH = 64;
export const NEM_MAX_NAMESPACE_DEPTH = 3; // root + two levels of sub-namespaces
export const NEM_MAX_MOSAIC_NAME_LENGTH = 32;
export const NEM_MAX_MOSAIC_DESCRIPTION_BYTES = 512;
export const NEM_MAX_MOSAIC_INITIAL_SUPPLY = 9_000_000_000n; // whole units
export const NEM_MAX_MOSAIC_DIVISIBILITY = 6;
/** NEM mainnet / testnet: about one block per minute, so a root namespace lasts 365 days. */
export const NEM_BLOCKS_PER_DAY = 1440;
export const NEM_NAMESPACE_DURATION_BLOCKS = 525_600;
/** A root namespace can be renewed during its last month (NanoWallet's 「ネームスペースの更新」 lists the ones inside this window). */
export const NEM_NAMESPACE_RENEW_WINDOW_DAYS = 30;
export const NEM_NAMESPACE_RENEW_WINDOW_BLOCKS = NEM_NAMESPACE_RENEW_WINDOW_DAYS * NEM_BLOCKS_PER_DAY;

/** A namespace part or mosaic name: lower-case letters, digits, '_' and '-', starting with a letter or digit. */
export function isValidNemName(name: string, maxLength: number): boolean {
  return name.length > 0 && name.length <= maxLength && /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

export function nemNamespaceRentalFee(isRoot: boolean): bigint {
  return isRoot ? NEM_ROOT_NAMESPACE_RENTAL : NEM_SUB_NAMESPACE_RENTAL;
}

function signNemDescriptor(privateKey: string, publicKey: string, networkByte: number, descriptor: unknown, fee: bigint = NEM_PROVISION_TX_FEE): string {
  const facade = nemFacadeFor(networkByte);
  const transaction = facade.createTransactionFromTypedDescriptor(
    descriptor as Parameters<typeof facade.createTransactionFromTypedDescriptor>[0],
    new PublicKey(publicKey),
    fee,
    2 * 60 * 60,
  );
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), transaction);
  const payload: unknown = facade.transactionFactory.static.attachSignature(transaction, signature);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

// --- delegated harvesting (importance transfer) ----------------------------------------------
/** Fee of an importance transfer: 3 units of 0.05 XEM (what the official NEM wallet charges). */
export const NEM_IMPORTANCE_TRANSFER_FEE = 150_000n;

export interface NemImportanceTransferParams {
  publicKey: string; // the harvesting (main) account
  networkByte: number;
  remotePublicKey: string; // the delegated (remote) account
  activate: boolean; // true = activate the remote account, false = deactivate it
}

/**
 * Signs an importance transfer that activates / deactivates a remote account.
 * The SDK uses Symbol terminology: NIS1's ImportanceTransfer is `AccountKeyLinkTransactionV1`
 * (mode ACTIVATE = LinkAction.LINK, DEACTIVATE = LinkAction.UNLINK).
 */
export function signNemImportanceTransfer(privateKey: string, p: NemImportanceTransferParams): string {
  return signNemDescriptor(privateKey, p.publicKey, p.networkByte, importanceTransferDescriptor(p.remotePublicKey, p.activate), NEM_IMPORTANCE_TRANSFER_FEE);
}

/** The importance transfer itself (also used as the inner transaction of a multisig account's delegated harvesting). */
function importanceTransferDescriptor(remotePublicKey: string, activate: boolean) {
  return new descriptors.AccountKeyLinkTransactionV1Descriptor(
    activate ? models.LinkAction.LINK : models.LinkAction.UNLINK,
    new PublicKey(remotePublicKey),
  );
}

export interface NemNamespaceParams {
  publicKey: string;
  networkByte: number;
  name: string; // the new part only ("sub" in "root.sub")
  parentName?: string; // full name of the parent; omitted for a root namespace
}

/** Signs a namespace registration (root, or sub-namespace under `parentName`). */
export function signNemNamespaceRegistration(privateKey: string, p: NemNamespaceParams): string {
  const sink = new Address(NEM_NAMESPACE_SINK[p.networkByte]);
  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    sink,
    new models.Amount(nemNamespaceRentalFee(p.parentName === undefined)),
    p.name,
    p.parentName,
  );
  return signNemDescriptor(privateKey, p.publicKey, p.networkByte, descriptor);
}

/**
 * NIS1 refuses a mosaic definition whose description is empty ("expected value for property description, but none was found",
 * HTTP 500), so a blank description goes out as the mosaic's own id instead.
 */
export function nemMosaicSentDescription(namespace: string, name: string, description: string): string {
  return description.trim() === '' ? `${namespace}:${name}` : description;
}

export interface NemMosaicParams {
  publicKey: string;
  networkByte: number;
  namespace: string; // full name of a namespace the account owns
  name: string; // mosaic name
  description: string;
  divisibility: number; // 0-6
  initialSupply: bigint; // whole units
  supplyMutable: boolean;
  transferable: boolean;
  /** A levy charged to the sender on every transfer. Omitted: the mosaic has none (re-defining without one removes it). */
  levy?: NemMosaicLevyParams;
}

export interface NemMosaicLevyParams {
  feeType: 'absolute' | 'percentile'; // absolute: a fixed amount; percentile: `fee` per 10,000 of the amount sent
  recipient: string; // NEM address that receives the levy
  mosaicId: string; // "namespace:name" of the mosaic the levy is paid in ("nem:xem" for XEM)
  fee: bigint; // smallest units of the levy mosaic (absolute) / units per 10,000 (percentile)
}

/**
 * Signs a mosaic definition (creation). The initial supply is part of the definition.
 * Sending the definition of a mosaic that already exists (same creator, same id) re-defines it (NIS1 rules, see MOSAIC_EDIT.md).
 */
export function signNemMosaicCreation(privateKey: string, p: NemMosaicParams): string {
  const sink = new Address(NEM_MOSAIC_SINK[p.networkByte]);
  const property = (name: string, value: string) => new descriptors.SizePrefixedMosaicPropertyDescriptor(new descriptors.MosaicPropertyDescriptor(name, value));
  let levy: InstanceType<typeof descriptors.MosaicLevyDescriptor> | undefined;
  if (p.levy) {
    const { namespace, name } = splitNemMosaicId(p.levy.mosaicId);
    levy = new descriptors.MosaicLevyDescriptor(
      p.levy.feeType === 'percentile' ? models.MosaicTransferFeeType.PERCENTILE : models.MosaicTransferFeeType.ABSOLUTE,
      new Address(p.levy.recipient),
      new descriptors.MosaicIdDescriptor(new descriptors.NamespaceIdDescriptor(namespace), name),
      new models.Amount(p.levy.fee),
    );
  }
  const definition = new descriptors.MosaicDefinitionDescriptor(
    new PublicKey(p.publicKey),
    new descriptors.MosaicIdDescriptor(new descriptors.NamespaceIdDescriptor(p.namespace), p.name),
    nemMosaicSentDescription(p.namespace, p.name, p.description),
    [
      property('divisibility', String(p.divisibility)),
      property('initialSupply', p.initialSupply.toString()),
      property('supplyMutable', String(p.supplyMutable)),
      property('transferable', String(p.transferable)),
    ],
    levy,
  );
  const descriptor = new descriptors.MosaicDefinitionTransactionV1Descriptor(definition, sink, new models.Amount(NEM_MOSAIC_RENTAL));
  return signNemDescriptor(privateKey, p.publicKey, p.networkByte, descriptor);
}

export interface NemMosaicSupplyChangeParams {
  publicKey: string; // the mosaic's creator
  networkByte: number;
  mosaicId: string; // "namespace:name"
  action: 'increase' | 'decrease';
  delta: bigint; // whole units (not divisible), as NIS1 counts supply
}

/** Signs a mosaic supply change (NIS1 MosaicSupplyChange, 0x4002): only the creator of a mosaic whose supply is mutable can send it. */
export function signNemMosaicSupplyChange(privateKey: string, p: NemMosaicSupplyChangeParams): string {
  const { namespace, name } = splitNemMosaicId(p.mosaicId);
  const descriptor = new descriptors.MosaicSupplyChangeTransactionV1Descriptor(
    new descriptors.MosaicIdDescriptor(new descriptors.NamespaceIdDescriptor(namespace), name),
    p.action === 'increase' ? models.MosaicSupplyChangeAction.INCREASE : models.MosaicSupplyChangeAction.DECREASE,
    new models.Amount(p.delta),
  );
  return signNemDescriptor(privateKey, p.publicKey, p.networkByte, descriptor);
}

// --- multisig ---------------------------------------------------------------------------------
export const NEM_MAX_MULTISIG_COSIGNERS = 32;
/** 0.5 XEM (10 units) for a multisig account modification; 0.15 XEM for the multisig wrapper / a cosignature. */
export const NEM_MULTISIG_MODIFICATION_FEE = 500_000n;
export const NEM_MULTISIG_WRAPPER_FEE = 150_000n;
export const NEM_COSIGNATURE_FEE = 150_000n;

export interface NemMultisigChange {
  minCosignatoriesDelta: number; // relative change of the number of signatures needed
  additions: string[]; // cosigner public keys (hex)
  deletions: string[]; // cosigner public keys (hex)
}

function modificationDescriptor(change: NemMultisigChange) {
  const mod = (type: typeof models.MultisigAccountModificationType.ADD_COSIGNATORY, key: string) =>
    new descriptors.SizePrefixedMultisigAccountModificationDescriptor(new descriptors.MultisigAccountModificationDescriptor(type, new PublicKey(key)));
  return new descriptors.MultisigAccountModificationTransactionV2Descriptor(change.minCosignatoriesDelta, [
    ...change.additions.map((k) => mod(models.MultisigAccountModificationType.ADD_COSIGNATORY, k)),
    ...change.deletions.map((k) => mod(models.MultisigAccountModificationType.DELETE_COSIGNATORY, k)),
  ]);
}

function payloadOf(facade: ReturnType<typeof nemFacadeFor>, privateKey: string, transaction: Parameters<ReturnType<typeof nemFacadeFor>['signTransaction']>[1]): string {
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), transaction);
  const payload: unknown = facade.transactionFactory.static.attachSignature(transaction, signature);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/**
 * Makes the signer's own account multisig (a plain transaction signed by that account).
 * `minCosignatoriesDelta` is the number of signatures needed (the account starts at 0 = "all").
 */
export function signNemMultisigConversion(privateKey: string, publicKey: string, networkByte: number, change: NemMultisigChange): string {
  const facade = nemFacadeFor(networkByte);
  const tx = facade.createTransactionFromTypedDescriptor(modificationDescriptor(change), new PublicKey(publicKey), NEM_MULTISIG_MODIFICATION_FEE, 2 * 60 * 60);
  return payloadOf(facade, privateKey, tx);
}

export type NemMultisigInner =
  | { kind: 'transfer'; recipient: string; amount: bigint; message?: string }
  | { kind: 'modification'; change: NemMultisigChange }
  | { kind: 'namespace'; name: string } // (re)registers a root namespace of the multisig account: how a root is renewed
  // Delegated harvesting of the multisig account: activate / deactivate its remote account (0.15 XEM, paid by the multisig account).
  | { kind: 'importance'; remotePublicKey: string; activate: boolean };

/**
 * A transaction in the name of a multisig account, started by one cosigner. The inner transaction
 * is signed by nobody; the cosigner signs the wrapper. Other cosigners add their signature later.
 */
export function signNemMultisigWrapped(
  cosignerPrivateKey: string,
  cosignerPublicKey: string,
  networkByte: number,
  multisigPublicKey: string,
  inner: NemMultisigInner,
): string {
  const facade = nemFacadeFor(networkByte);
  const deadline = 2 * 60 * 60;
  let innerDescriptor: unknown;
  let innerFee: bigint;
  if (inner.kind === 'transfer') {
    const amount = new models.Amount(inner.amount);
    innerDescriptor = inner.message
      ? new descriptors.TransferTransactionV1Descriptor(new Address(inner.recipient), amount, new descriptors.MessageDescriptor(models.MessageType.PLAIN, inner.message))
      : new descriptors.TransferTransactionV1Descriptor(new Address(inner.recipient), amount);
    innerFee = nemTransferFee(inner.amount, inner.message);
  } else if (inner.kind === 'namespace') {
    innerDescriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
      new Address(NEM_NAMESPACE_SINK[networkByte]),
      new models.Amount(nemNamespaceRentalFee(true)),
      inner.name,
    );
    innerFee = NEM_PROVISION_TX_FEE;
  } else if (inner.kind === 'importance') {
    innerDescriptor = importanceTransferDescriptor(inner.remotePublicKey, inner.activate);
    innerFee = NEM_IMPORTANCE_TRANSFER_FEE;
  } else {
    innerDescriptor = modificationDescriptor(inner.change);
    innerFee = NEM_MULTISIG_MODIFICATION_FEE;
  }
  const innerTx = facade.createTransactionFromTypedDescriptor(innerDescriptor as object, new PublicKey(multisigPublicKey), innerFee, deadline);
  const nonVerifiable = facade.transactionFactory.static.toNonVerifiableTransaction(innerTx);
  const outer = facade.createTransactionFromTypedDescriptor(
    new descriptors.MultisigTransactionV1Descriptor(nonVerifiable),
    new PublicKey(cosignerPublicKey),
    NEM_MULTISIG_WRAPPER_FEE,
    deadline,
  );
  return payloadOf(facade, cosignerPrivateKey, outer);
}

/** A cosignature for a pending multisig transaction (`innerHash` from the node, hex). */
export function signNemCosignature(
  cosignerPrivateKey: string,
  cosignerPublicKey: string,
  networkByte: number,
  multisigAddress: string,
  innerHash: string,
): string {
  const facade = nemFacadeFor(networkByte);
  const tx = facade.createTransactionFromTypedDescriptor(
    new descriptors.CosignatureV1Descriptor(new Hash256(innerHash), new Address(multisigAddress)),
    new PublicKey(cosignerPublicKey),
    NEM_COSIGNATURE_FEE,
    2 * 60 * 60,
  );
  return payloadOf(facade, cosignerPrivateKey, tx);
}
