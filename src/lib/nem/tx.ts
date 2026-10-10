// NEM TransferTransactionV1 built and signed with the official SDK (symbol-sdk/nem).
import { Hash256, PrivateKey, PublicKey } from 'symbol-sdk';
import { Address, KeyPair, descriptors, models } from 'symbol-sdk/nem';
import { nemFacadeFor } from './crypto';

const FEE_UNIT = 50_000n; // 0.05 XEM, in micro-XEM

export function nemMessageByteLength(message: string): number {
  return new TextEncoder().encode(message).length;
}

/**
 * Fee of an XEM transfer. NIS1 charges 0.05 XEM per 10,000 XEM sent (at least 0.05, at most
 * 1.25) plus 0.05 XEM per 32 bytes of message (rounded up, a message of 0-31 bytes costs one unit).
 */
export function nemTransferFee(amountMicro: bigint, message: string | undefined): bigint {
  let units = amountMicro / 1_000_000n / 10_000n;
  if (units < 1n) units = 1n;
  if (units > 25n) units = 25n;
  let fee = units * FEE_UNIT;
  if (message) fee += BigInt(Math.floor(nemMessageByteLength(message) / 32) + 1) * FEE_UNIT;
  return fee;
}

export interface NemTransferParams {
  publicKey: string;
  networkByte: number;
  recipient: string; // base32 address, 40 chars
  amount: bigint; // micro-XEM
  message?: string; // plain text, '' / undefined = none
  fee: bigint; // micro-XEM
}

/** Builds the transfer, signs it, and returns the JSON body for POST /transaction/announce. */
export function signNemTransfer(privateKey: string, p: NemTransferParams): string {
  const facade = nemFacadeFor(p.networkByte);
  const recipient = new Address(p.recipient);
  const amount = new models.Amount(p.amount);
  const descriptor = p.message
    ? new descriptors.TransferTransactionV1Descriptor(recipient, amount, new descriptors.MessageDescriptor(models.MessageType.PLAIN, p.message))
    : new descriptors.TransferTransactionV1Descriptor(recipient, amount);
  // 2 hours until the transaction expires (NIS1 allows up to 24 hours).
  const transaction = facade.createTransactionFromTypedDescriptor(descriptor, new PublicKey(p.publicKey), p.fee, 2 * 60 * 60);
  const signature = facade.signTransaction(new KeyPair(new PrivateKey(privateKey)), transaction);
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
  const descriptor = new descriptors.AccountKeyLinkTransactionV1Descriptor(
    p.activate ? models.LinkAction.LINK : models.LinkAction.UNLINK,
    new PublicKey(p.remotePublicKey),
  );
  return signNemDescriptor(privateKey, p.publicKey, p.networkByte, descriptor, NEM_IMPORTANCE_TRANSFER_FEE);
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
}

/** Signs a mosaic definition (creation). The initial supply is part of the definition. */
export function signNemMosaicCreation(privateKey: string, p: NemMosaicParams): string {
  const sink = new Address(NEM_MOSAIC_SINK[p.networkByte]);
  const property = (name: string, value: string) => new descriptors.SizePrefixedMosaicPropertyDescriptor(new descriptors.MosaicPropertyDescriptor(name, value));
  const definition = new descriptors.MosaicDefinitionDescriptor(
    new PublicKey(p.publicKey),
    new descriptors.MosaicIdDescriptor(new descriptors.NamespaceIdDescriptor(p.namespace), p.name),
    p.description,
    [
      property('divisibility', String(p.divisibility)),
      property('initialSupply', p.initialSupply.toString()),
      property('supplyMutable', String(p.supplyMutable)),
      property('transferable', String(p.transferable)),
    ],
  );
  const descriptor = new descriptors.MosaicDefinitionTransactionV1Descriptor(definition, sink, new models.Amount(NEM_MOSAIC_RENTAL));
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
  | { kind: 'modification'; change: NemMultisigChange };

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
