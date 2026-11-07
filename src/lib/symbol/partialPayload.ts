// 署名待ち（bonded）のアグリゲートを、ノードの JSON（/transactions/partial/{hash}）から、拡張に渡せるバイト列に組み立て直す。
// SSS Extension で連署するには、アグリゲートのバイト列が要る。ノードは中身を JSON でしか返さないので、ここで作り直す。
//
// 安全のための検算（これが通らなければ、連署はしない）:
//   ① 組み立てた内側のトランザクションのハッシュ（transactionsHash）が、JSON の値と同じ。
//   ② 組み立てたアグリゲート全体のハッシュが、ノードが言うハッシュ（連署する対象）と同じ。
// ハッシュは中身のすべてを含むので、1か所でも読み違えたら一致しない。つまり、この2つが一致したバイト列は、ノードにある
// アグリゲートと同じもの。一致しないもの・対応していない種類を含むものは、PartialRebuildError で止める。
import { PublicKey } from 'symbol-sdk';
import { SymbolFacade, models } from 'symbol-sdk/symbol';
import { bytesToHex, facadeFor } from './crypto';

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export type PartialRebuildKind = 'unsupported_type' | 'bad_json' | 'hash_mismatch';

export class PartialRebuildError extends Error {
  readonly kind: PartialRebuildKind;
  constructor(kind: PartialRebuildKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'PartialRebuildError';
    this.kind = kind;
  }
}

/** ノードが返す署名待ちのアグリゲート（使う部分だけ）。 */
export interface RestPartialAggregate {
  meta?: { hash?: string };
  transaction: {
    signature?: string;
    signerPublicKey: string;
    version?: number;
    network: number;
    type?: number;
    maxFee?: string;
    fee?: string;
    deadline: string;
    transactionsHash?: string;
    transactions?: Array<{ transaction: RestEmbedded }>;
  };
}

export interface RestEmbedded {
  type: number;
  signerPublicKey: string;
  recipientAddress?: string;
  mosaics?: Array<{ id: string; amount: string }>;
  message?: string;
  minApprovalDelta?: number;
  minRemovalDelta?: number;
  addressAdditions?: string[];
  addressDeletions?: string[];
  targetAddress?: string;
  targetMosaicId?: string;
  targetNamespaceId?: string;
  scopedMetadataKey?: string;
  valueSizeDelta?: number;
  value?: string;
  id?: string;
  duration?: string;
  nonce?: number;
  flags?: number;
  divisibility?: number;
  mosaicId?: string;
  delta?: string;
  action?: number;
  sourceAddress?: string;
  amount?: string;
  mosaic?: { id?: string; mosaicId?: string; amount: string };
}

const TX = {
  TRANSFER: 0x4154,
  MULTISIG_MODIFICATION: 0x4155,
  ACCOUNT_METADATA: 0x4144,
  MOSAIC_METADATA: 0x4244,
  NAMESPACE_METADATA: 0x4344,
  MOSAIC_DEFINITION: 0x414d,
  MOSAIC_SUPPLY_CHANGE: 0x424d,
  MOSAIC_SUPPLY_REVOCATION: 0x434d,
} as const;

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new PartialRebuildError('bad_json', what);
  return v;
};
const big = (v: string | number | undefined, what: string): bigint => {
  try {
    return BigInt(need(v, what));
  } catch {
    throw new PartialRebuildError('bad_json', what);
  }
};
const idBig = (v: string | undefined, what: string): bigint => {
  const s = need(v, what);
  if (!/^[0-9a-fA-F]{1,16}$/.test(s)) throw new PartialRebuildError('bad_json', what);
  return BigInt(`0x${s}`);
};
/** ノードの JSON の（ネームスペース別名も入りうる）アドレスは 24 バイトの 16 進。 */
const addr = (v: string | undefined, what: string): Uint8Array<ArrayBuffer> => {
  const s = need(v, what);
  if (!/^[0-9a-fA-F]{48}$/.test(s)) throw new PartialRebuildError('bad_json', what);
  return hexToBytes(s);
};
const hexBytes = (v: string | undefined, what: string): Uint8Array => {
  const s = v ?? '';
  if (s !== '' && !/^([0-9a-fA-F]{2})+$/.test(s)) throw new PartialRebuildError('bad_json', what);
  return hexToBytes(s);
};

function embeddedFromRest(facade: SymbolFacade, t: RestEmbedded) {
  const signerPublicKey = need(t.signerPublicKey, 'signerPublicKey');
  switch (t.type) {
    case TX.TRANSFER: {
      const message = hexBytes(t.message, 'message');
      return facade.transactionFactory.createEmbedded({
        type: 'transfer_transaction_v1',
        signerPublicKey,
        recipientAddress: addr(t.recipientAddress, 'recipientAddress'),
        mosaics: (t.mosaics ?? []).map((m) => ({ mosaicId: idBig(m.id, 'mosaic id'), amount: big(m.amount, 'mosaic amount') })),
        ...(message.length > 0 ? { message } : {}),
      });
    }
    case TX.MULTISIG_MODIFICATION:
      return facade.transactionFactory.createEmbedded({
        type: 'multisig_account_modification_transaction_v1',
        signerPublicKey,
        minApprovalDelta: need(t.minApprovalDelta, 'minApprovalDelta'),
        minRemovalDelta: need(t.minRemovalDelta, 'minRemovalDelta'),
        addressAdditions: (t.addressAdditions ?? []).map((a) => addr(a, 'addressAdditions')),
        addressDeletions: (t.addressDeletions ?? []).map((a) => addr(a, 'addressDeletions')),
      });
    case TX.ACCOUNT_METADATA:
      return facade.transactionFactory.createEmbedded({
        type: 'account_metadata_transaction_v1',
        signerPublicKey,
        targetAddress: addr(t.targetAddress, 'targetAddress'),
        scopedMetadataKey: idBig(t.scopedMetadataKey, 'scopedMetadataKey'),
        valueSizeDelta: need(t.valueSizeDelta, 'valueSizeDelta'),
        value: hexBytes(t.value, 'value'),
      });
    case TX.MOSAIC_METADATA:
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_metadata_transaction_v1',
        signerPublicKey,
        targetAddress: addr(t.targetAddress, 'targetAddress'),
        scopedMetadataKey: idBig(t.scopedMetadataKey, 'scopedMetadataKey'),
        targetMosaicId: new models.UnresolvedMosaicId(idBig(t.targetMosaicId, 'targetMosaicId')),
        valueSizeDelta: need(t.valueSizeDelta, 'valueSizeDelta'),
        value: hexBytes(t.value, 'value'),
      });
    case TX.NAMESPACE_METADATA:
      return facade.transactionFactory.createEmbedded({
        type: 'namespace_metadata_transaction_v1',
        signerPublicKey,
        targetAddress: addr(t.targetAddress, 'targetAddress'),
        scopedMetadataKey: idBig(t.scopedMetadataKey, 'scopedMetadataKey'),
        targetNamespaceId: new models.NamespaceId(idBig(t.targetNamespaceId, 'targetNamespaceId')),
        valueSizeDelta: need(t.valueSizeDelta, 'valueSizeDelta'),
        value: hexBytes(t.value, 'value'),
      });
    case TX.MOSAIC_DEFINITION:
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_definition_transaction_v1',
        signerPublicKey,
        id: new models.MosaicId(idBig(t.id, 'id')),
        duration: new models.BlockDuration(big(t.duration, 'duration')),
        nonce: new models.MosaicNonce(Number(need(t.nonce, 'nonce'))),
        flags: new models.MosaicFlags(Number(need(t.flags, 'flags'))),
        divisibility: Number(need(t.divisibility, 'divisibility')),
      });
    case TX.MOSAIC_SUPPLY_CHANGE:
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_supply_change_transaction_v1',
        signerPublicKey,
        mosaicId: new models.UnresolvedMosaicId(idBig(t.mosaicId, 'mosaicId')),
        delta: new models.Amount(big(t.delta, 'delta')),
        action: Number(need(t.action, 'action')),
      });
    case TX.MOSAIC_SUPPLY_REVOCATION: {
      // ノードの JSON は、モザイクを 1 つのオブジェクトにしているものと、別々の項目にしているものがある。
      const mosaicId = t.mosaic?.id ?? t.mosaic?.mosaicId ?? t.mosaicId;
      const amount = t.mosaic?.amount ?? t.amount;
      return facade.transactionFactory.createEmbedded({
        type: 'mosaic_supply_revocation_transaction_v1',
        signerPublicKey,
        sourceAddress: addr(t.sourceAddress, 'sourceAddress'),
        mosaic: { mosaicId: idBig(mosaicId, 'mosaicId'), amount: big(amount, 'amount') },
      });
    }
    default:
      throw new PartialRebuildError('unsupported_type', `0x${t.type.toString(16)}`);
  }
}

export interface RebuiltPartial {
  payload: string; // hex（署名つき。連署は含まない）
  hash: string; // アグリゲートのハッシュ（連署する対象）
}

/** 署名待ちのアグリゲートをバイト列に組み立て直す。ノードが言うハッシュと一致しなければ、PartialRebuildError。 */
export function rebuildPartialPayload(raw: RestPartialAggregate, networkByte: number, expectedHash: string): RebuiltPartial {
  const tx = raw.transaction;
  if (!tx || !Array.isArray(tx.transactions) || tx.transactions.length === 0) throw new PartialRebuildError('bad_json', 'transactions');
  if (tx.network !== networkByte) throw new PartialRebuildError('bad_json', 'network');
  const facade = facadeFor(networkByte);
  const embedded = tx.transactions.map((e) => embeddedFromRest(facade, e.transaction));
  const transactionsHash = SymbolFacade.hashEmbeddedTransactions(embedded);
  if (tx.transactionsHash && tx.transactionsHash.toUpperCase() !== transactionsHash.toString().toUpperCase()) {
    throw new PartialRebuildError('hash_mismatch', 'transactionsHash');
  }
  const signature = need(tx.signature, 'signature');
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) throw new PartialRebuildError('bad_json', 'signature');
  const aggregate = facade.transactionFactory.create({
    type: 'aggregate_bonded_transaction_v3',
    signerPublicKey: new PublicKey(need(tx.signerPublicKey, 'signerPublicKey')),
    fee: big(tx.maxFee ?? tx.fee, 'maxFee'),
    deadline: big(tx.deadline, 'deadline'),
    transactionsHash,
    transactions: embedded,
  });
  aggregate.signature = new models.Signature(hexToBytes(signature));
  const hash = facade.hashTransaction(aggregate).toString().toUpperCase();
  if (hash !== expectedHash.toUpperCase()) throw new PartialRebuildError('hash_mismatch', 'aggregate');
  return { payload: bytesToHex(aggregate.serialize()).toUpperCase(), hash };
}
