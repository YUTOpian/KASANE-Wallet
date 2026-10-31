// Aggregate (まとめて送信): several transactions of the same account sent as ONE AggregateCompleteTransactionV3.
// Either every inner transaction is applied or none is. Ported from the official Symbol Desktop Wallet's
// "Aggregate" page (staged transfer / mosaic definition / supply change / namespace registration), rebuilt on
// symbol-sdk v3. Every inner transaction is signed by the wallet itself, so the aggregate is "complete"
// (no cosignatures, no hash lock); aggregates that need other accounts' signatures are the multisig screens.
import { Address, SymbolFacade, generateMosaicId, generateNamespaceId, models } from 'symbol-sdk/symbol';
import { bytesToHex, facadeFor, normalizeAddress } from './crypto';
import { COSIGNATURE_SIZE, isValidNamespaceName, MAX_MESSAGE_BYTES, messageField, signingKeyPair } from './tx';
import type { SignedTransaction } from './tx';

/** The network accepts at most this many inner transactions in one aggregate (maxTransactionsPerAggregate). */
export const MAX_AGGREGATE_INNER = 100;

/**
 * An account other than the wallet that a transfer is sent from. Its signature is needed, so the aggregate
 * either becomes a bonded one (cosigners sign later, after a hash lock) or, for a multisig account the wallet
 * can approve alone (minApproval 1), stays a complete one.
 */
export interface AggregateSigner {
  address: string; // base32
  publicKey: string; // 64 hex chars
  multisig: boolean; // a multisig account (the wallet signs for it as a cosigner)
  selfSufficient: boolean; // the wallet's own signature is enough (multisig account with minApproval 1 and the wallet as cosigner)
  cosignatures: number; // signatures still to be collected from others, for the fee
}

export type AggregateItem =
  | {
    uid: string;
    kind: 'transfer';
    signer?: AggregateSigner; // omitted = sent from the wallet itself
    recipient: string; // base32 address (an alias typed in the form is looked up once and the real address is stored here)
    recipientAlias?: string; // namespace the recipient was typed as ("nem.group"), for display only
    mosaicId: string; // 16 hex chars
    mosaicSymbol: string; // for display
    divisibility: number;
    amount: bigint; // atomic units
    message: string; // plain text, '' = none
  }
  | {
    uid: string;
    kind: 'mosaic_definition';
    nonce: number; // uint32; with the owner's address it fixes the mosaic id
    divisibility: number;
    flags: number;
    durationBlocks: bigint; // 0n = never expires
  }
  | {
    uid: string;
    kind: 'mosaic_supply';
    mosaicId: string; // 16 hex chars
    mosaicSymbol: string; // for display
    divisibility: number;
    action: 'increase' | 'decrease';
    delta: bigint; // atomic units
  }
  | {
    uid: string;
    kind: 'namespace';
    name: string; // this level's name only
    parent?: { id: string; name: string }; // set for a sub-namespace (full name of the parent for display)
    durationBlocks: bigint; // root namespaces only
  };

export type AggregateItemKind = AggregateItem['kind'];

const hex16 = (value: bigint) => value.toString(16).toUpperCase().padStart(16, '0');

/** Id of the mosaic that a definition with this owner and nonce creates (16 hex chars). */
export function aggregateMosaicId(ownerAddress: string, nonce: number): string {
  return hex16(BigInt(generateMosaicId(new Address(normalizeAddress(ownerAddress)), nonce)));
}

/** Id (16 hex chars) of the namespace `name` registered under `parentId` (omitted = root). */
export function aggregateNamespaceId(name: string, parentId?: string): string {
  return hex16(BigInt(generateNamespaceId(name, parentId ? BigInt(`0x${parentId}`) : 0n)));
}

/** Full name of a namespace item, e.g. "company.team". */
export function namespaceFullName(item: Extract<AggregateItem, { kind: 'namespace' }>): string {
  return item.parent ? `${item.parent.name}.${item.name}` : item.name;
}

/** Why the item cannot be sent as it is (an i18n key under `aggregate.`), or null when it is fine. */
export function validateItem(item: AggregateItem): string | null {
  switch (item.kind) {
    case 'transfer':
      if (item.amount <= 0n && !item.message) return 'item_transfer_empty';
      if (new TextEncoder().encode(item.message).length > MAX_MESSAGE_BYTES) return 'item_message_too_long';
      return null;
    case 'mosaic_supply':
      return item.delta > 0n ? null : 'item_supply_zero';
    case 'namespace':
      return isValidNamespaceName(item.name) ? null : 'item_namespace_name';
    default:
      return null;
  }
}

/** Whether the aggregate must be bonded: some inner transaction is signed by an account the wallet cannot sign for alone. */
export function needsBonded(items: AggregateItem[]): boolean {
  return items.some((i) => i.kind === 'transfer' && i.signer !== undefined && !i.signer.selfSufficient);
}

/** Signatures to be collected from others (counted once per signing account), which the fee has to leave room for. */
export function cosignatureCount(items: AggregateItem[]): number {
  const seen = new Map<string, number>();
  for (const i of items) if (i.kind === 'transfer' && i.signer && !i.signer.selfSufficient) seen.set(i.signer.address, i.signer.cosignatures);
  return [...seen.values()].reduce((sum, n) => sum + n, 0);
}

/** The other accounts whose signature the aggregate needs (distinct, in order of first use). */
export function otherSigners(items: AggregateItem[]): AggregateSigner[] {
  const out = new Map<string, AggregateSigner>();
  for (const i of items) if (i.kind === 'transfer' && i.signer && !out.has(i.signer.address)) out.set(i.signer.address, i.signer);
  return [...out.values()];
}

export interface AggregateParams {
  signerPublicKey: string;
  ownerAddress: string; // base32 address of the signer
  networkByte: number;
  items: AggregateItem[];
  feeMultiplier: number;
  deadline: bigint; // ms since the network epoch
  bonded?: boolean; // AggregateBonded instead of AggregateComplete (default: decided by needsBonded)
}

function buildEmbedded(facade: SymbolFacade, signerPublicKey: string, ownerAddress: string, item: AggregateItem) {
  switch (item.kind) {
    case 'transfer': {
      // The protocol wants mosaics sorted by id; a transfer here carries at most one.
      const mosaics = item.amount > 0n ? [{ mosaicId: BigInt(`0x${item.mosaicId}`), amount: item.amount }] : [];
      return facade.transactionFactory.createEmbedded({
        type: 'transfer_transaction_v1',
        signerPublicKey: item.signer?.publicKey ?? signerPublicKey,
        recipientAddress: normalizeAddress(item.recipient),
        mosaics,
        ...messageField(item.message),
      });
    }
    case 'mosaic_definition': {
      const id = BigInt(`0x${aggregateMosaicId(ownerAddress, item.nonce)}`);
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_definition_transaction_v1',
        signerPublicKey,
        id: new models.MosaicId(id),
        duration: new models.BlockDuration(item.durationBlocks),
        nonce: new models.MosaicNonce(item.nonce),
        flags: new models.MosaicFlags(item.flags),
        divisibility: item.divisibility,
      });
    }
    case 'mosaic_supply':
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_supply_change_transaction_v1',
        signerPublicKey,
        mosaicId: new models.UnresolvedMosaicId(BigInt(`0x${item.mosaicId}`)),
        delta: new models.Amount(item.delta),
        action: item.action === 'increase' ? models.MosaicSupplyChangeAction.INCREASE : models.MosaicSupplyChangeAction.DECREASE,
      });
    default: {
      const common = {
        signerPublicKey,
        id: new models.NamespaceId(BigInt(`0x${aggregateNamespaceId(item.name, item.parent?.id)}`)),
        name: new TextEncoder().encode(item.name),
      };
      return item.parent
        ? facade.transactionFactory.createEmbedded({
          type: 'namespace_registration_transaction_v1',
          ...common,
          registrationType: models.NamespaceRegistrationType.CHILD,
          parentId: new models.NamespaceId(BigInt(`0x${item.parent.id}`)),
        })
        : facade.transactionFactory.createEmbedded({
          type: 'namespace_registration_transaction_v1',
          ...common,
          registrationType: models.NamespaceRegistrationType.ROOT,
          duration: new models.BlockDuration(item.durationBlocks),
        });
    }
  }
}

function buildAggregate(p: AggregateParams) {
  if (p.items.length === 0) throw new Error('no_items');
  if (p.items.length > MAX_AGGREGATE_INNER) throw new Error('too_many_items');
  const facade = facadeFor(p.networkByte);
  const embedded = p.items.map((item) => buildEmbedded(facade, p.signerPublicKey, p.ownerAddress, item));
  const bonded = p.bonded ?? needsBonded(p.items);
  const tx = facade.transactionFactory.create({
    type: bonded ? 'aggregate_bonded_transaction_v3' : 'aggregate_complete_transaction_v3',
    signerPublicKey: p.signerPublicKey,
    fee: 0n,
    deadline: p.deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  // The cosignatures that are attached later make the transaction bigger, so the fee leaves room for them.
  tx.fee = new models.Amount(BigInt(tx.size + COSIGNATURE_SIZE * cosignatureCount(p.items)) * BigInt(p.feeMultiplier));
  return { facade, tx };
}

/**
 * Size in bytes the fee is computed from: the real (unsigned) aggregate plus room for the cosignatures that others
 * will attach. Exact for any mix of items and needs neither the private key nor a node.
 */
export function aggregateSize(signerPublicKey: string, ownerAddress: string, networkByte: number, items: AggregateItem[]): number {
  return buildAggregate({ signerPublicKey, ownerAddress, networkByte, items, feeMultiplier: 0, deadline: 0n }).tx.size
    + COSIGNATURE_SIZE * cosignatureCount(items);
}

export interface SignedAggregate extends SignedTransaction {
  fee: bigint; // atomic XYM, the maximum fee that was signed
  bonded: boolean;
}

export function signAggregate(privateKey: string, generationHash: string, p: AggregateParams): SignedAggregate {
  const { facade, tx } = buildAggregate(p);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== generationHash.toUpperCase()) {
    throw new Error('generation_hash_mismatch');
  }
  const signature = facade.signTransaction(signingKeyPair(privateKey), tx);
  tx.signature = new models.Signature(signature.bytes);
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString(), fee: BigInt(tx.fee.value), bonded: p.bonded ?? needsBonded(p.items) };
}

/** The mosaic or namespace id that an item creates, or null for items that create nothing. */
export function createdId(item: AggregateItem, ownerAddress: string): string | null {
  if (item.kind === 'mosaic_definition') return aggregateMosaicId(ownerAddress, item.nonce);
  if (item.kind === 'namespace') return aggregateNamespaceId(item.name, item.parent?.id);
  return null;
}

/**
 * Uids to remove together when `uid` is removed: the item itself plus everything that uses the mosaic /
 * namespace it creates (supply changes, transfers of the new mosaic, sub-namespaces below a new namespace).
 */
export function uidsToRemove(items: AggregateItem[], uid: string, ownerAddress: string): string[] {
  const removed = new Set<string>([uid]);
  let grew = true;
  while (grew) {
    grew = false;
    const ids = new Set(items.filter((i) => removed.has(i.uid)).map((i) => createdId(i, ownerAddress)).filter((id): id is string => id !== null));
    for (const item of items) {
      if (removed.has(item.uid)) continue;
      const uses = (item.kind === 'transfer' || item.kind === 'mosaic_supply') ? ids.has(item.mosaicId)
        : item.kind === 'namespace' && item.parent ? ids.has(item.parent.id) : false;
      if (uses) { removed.add(item.uid); grew = true; }
    }
  }
  return [...removed];
}
