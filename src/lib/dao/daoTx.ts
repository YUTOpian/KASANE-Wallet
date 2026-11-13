// DAO のトランザクションを組み立てて送る。元アプリのサーバー側（master アカウントがアグリゲートを作って署名し、
// ハッシュロックを払って bonded を流す処理）を、ウォレットで開いているアカウントが自分で行う形に置き換えたもの。
//
//  - 発行者（initiator）はいつもウォレットのアカウント。
//  - 内側のトランザクションを DAO アカウント（マルチシグ）が署名者にしているときは、ウォレットのアカウントが連署者で
//    承認が足りるなら complete のまま、足りなければ bonded（ハッシュロック → partial → 他の管理者が連署）で送る。
//  - 作ったばかりの別アカウント（DAO 本体）の連署が要る場合は、その鍵で連署して complete のまま送る（DAO の作成）。
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, SymbolFacade, generateMosaicId, generateNamespaceId, models, Address } from 'symbol-sdk/symbol';
import { announceSigned, feeMultipliers, networkTimeMs } from '../symbol/api';
import { MAX_AGGREGATE_INNER } from '../symbol/aggregate';
import type { AggregateSigner } from '../symbol/aggregate';
import { bytesToHex, facadeFor, normalizeAddress } from '../symbol/crypto';
import { getDefaultFeeSpeed } from '../symbol/feeSpeed';
import { xorValue } from '../symbol/metadata';
import { announceBondedWithLock, fetchHashLockAmount } from '../symbol/multisigApi';
import { getNetworkConfig } from '../symbol/network';
import { signWithAny } from '../symbol/sssSign';
import type { KeylessSigner } from '../symbol/sssSign';
import { BONDED_LIFETIME_MS, COSIGNATURE_SIZE, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE, messageField, signHashLock, signingKeyPair } from '../symbol/tx';
import type { SignedTransaction } from '../symbol/tx';

export type Embedded = ReturnType<SymbolFacade['transactionFactory']['createEmbedded']>;

export const MAX_DAO_INNER = MAX_AGGREGATE_INNER;

// --- 内側のトランザクション -----------------------------------------------------------------------

/** モザイク（または XYM）の送金。メッセージは平文。 */
export function embTransfer(f: SymbolFacade, signerPublicKey: string, recipient: string, mosaicId: string | null, amount: bigint, message?: string): Embedded {
  const mosaics = mosaicId !== null && amount > 0n ? [{ mosaicId: BigInt(`0x${mosaicId}`), amount }] : [];
  return f.transactionFactory.createEmbedded({
    type: 'transfer_transaction_v1',
    signerPublicKey,
    recipientAddress: normalizeAddress(recipient),
    mosaics,
    ...messageField(message),
  });
}

/** モザイク定義（有効期限なし・可分性 0）。 */
export function embMosaicDefinition(f: SymbolFacade, signerPublicKey: string, ownerAddress: string, nonce: number, flags: number): { tx: Embedded; id: string } {
  const id = BigInt(generateMosaicId(new Address(normalizeAddress(ownerAddress)), nonce));
  const tx = f.transactionFactory.createEmbedded({
    type: 'mosaic_definition_transaction_v1',
    signerPublicKey,
    id: new models.MosaicId(id),
    duration: new models.BlockDuration(0n),
    nonce: new models.MosaicNonce(nonce),
    flags: new models.MosaicFlags(flags),
    divisibility: 0,
  });
  return { tx, id: id.toString(16).toUpperCase().padStart(16, '0') };
}

export function embSupplyIncrease(f: SymbolFacade, signerPublicKey: string, mosaicId: string, amount: bigint): Embedded {
  return f.transactionFactory.createEmbedded({
    type: 'mosaic_supply_change_transaction_v1',
    signerPublicKey,
    mosaicId: new models.UnresolvedMosaicId(BigInt(`0x${mosaicId}`)),
    delta: new models.Amount(amount),
    action: models.MosaicSupplyChangeAction.INCREASE,
  });
}

/** 連署者の追加（最小承認数・最小削除数は同じだけ増やす = 全員の承認が要る形を保つ）。 */
export function embMultisigAdd(f: SymbolFacade, multisigPublicKey: string, additions: string[]): Embedded {
  return f.transactionFactory.createEmbedded({
    type: 'multisig_account_modification_transaction_v1',
    signerPublicKey: multisigPublicKey,
    minApprovalDelta: additions.length,
    minRemovalDelta: additions.length,
    addressAdditions: additions.map(normalizeAddress),
    addressDeletions: [],
  });
}

/** 前の値（無ければ空）との差分で書く、アカウントメタデータ。 */
export function embAccountMetadata(f: SymbolFacade, signerPublicKey: string, targetAddress: string, key: bigint, value: Uint8Array, previous: Uint8Array | null = null): Embedded {
  const old = previous ?? new Uint8Array(0);
  return f.transactionFactory.createEmbedded({
    type: 'account_metadata_transaction_v1',
    signerPublicKey,
    targetAddress: normalizeAddress(targetAddress),
    scopedMetadataKey: key,
    valueSizeDelta: value.length - old.length,
    value: xorValue(old, value),
  });
}

export function embMosaicMetadata(f: SymbolFacade, signerPublicKey: string, targetAddress: string, mosaicId: string, key: bigint, value: Uint8Array, previous: Uint8Array | null = null): Embedded {
  const old = previous ?? new Uint8Array(0);
  return f.transactionFactory.createEmbedded({
    type: 'mosaic_metadata_transaction_v1',
    signerPublicKey,
    targetAddress: normalizeAddress(targetAddress),
    scopedMetadataKey: key,
    targetMosaicId: new models.UnresolvedMosaicId(BigInt(`0x${mosaicId}`)),
    valueSizeDelta: value.length - old.length,
    value: xorValue(old, value),
  });
}

/** 持ち主から、DAO が作った（回収可の）モザイクを取り戻す。 */
export function embRevoke(f: SymbolFacade, signerPublicKey: string, sourceAddress: string, mosaicId: string, amount: bigint): Embedded {
  return f.transactionFactory.createEmbedded({
    type: 'mosaic_supply_revocation_transaction_v1',
    signerPublicKey,
    sourceAddress: normalizeAddress(sourceAddress),
    mosaic: { mosaicId: BigInt(`0x${mosaicId}`), amount },
  });
}

/** ネームスペースの登録（ルートは期間をブロック数で、子は親の ID で）。ID は名前（と親）から決まる。 */
export function embNamespaceRegistration(f: SymbolFacade, signerPublicKey: string, name: string, parentId: string | null, durationBlocks: bigint): { tx: Embedded; id: string } {
  const parent = parentId === null ? undefined : BigInt(`0x${parentId}`);
  const id = BigInt(generateNamespaceId(name, parent ?? 0n));
  const common = { signerPublicKey, id: new models.NamespaceId(id), name: new TextEncoder().encode(name) };
  const tx = parent === undefined
    ? f.transactionFactory.createEmbedded({ type: 'namespace_registration_transaction_v1', ...common, registrationType: models.NamespaceRegistrationType.ROOT, duration: new models.BlockDuration(durationBlocks) })
    : f.transactionFactory.createEmbedded({ type: 'namespace_registration_transaction_v1', ...common, registrationType: models.NamespaceRegistrationType.CHILD, parentId: new models.NamespaceId(parent) });
  return { tx, id: id.toString(16).toUpperCase().padStart(16, '0') };
}

/** ネームスペースをモザイクに紐付ける（署名者がネームスペースとモザイクの両方の持ち主であること）。 */
export function embMosaicAlias(f: SymbolFacade, signerPublicKey: string, namespaceId: string, mosaicId: string): Embedded {
  return f.transactionFactory.createEmbedded({
    type: 'mosaic_alias_transaction_v1',
    signerPublicKey,
    namespaceId: new models.NamespaceId(BigInt(`0x${namespaceId}`)),
    mosaicId: new models.MosaicId(BigInt(`0x${mosaicId}`)),
    aliasAction: models.AliasAction.LINK,
  });
}

export const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text);

// --- アグリゲート ----------------------------------------------------------------------------------

export interface DaoSubmitInput {
  publicKey: string; // ウォレットのアカウント（発行者）
  /** 内側のトランザクションを組み立てる。facade はネットワークに合わせたもの。 */
  build: (facade: SymbolFacade) => Embedded[];
  /** 内側の署名者に DAO（マルチシグ）がいるときの承認の状況。無い（ウォレットの署名だけで済む）なら省く。 */
  dao?: AggregateSigner | null;
  /** 連署に使う、作ったばかりのアカウントの秘密鍵（DAO の作成）。complete のまま、これで連署して送る。 */
  tempKeys?: string[];
}

export interface DaoQuote {
  bonded: boolean;
  size: number;
  fee: bigint; // アグリゲートの手数料（連署の分を含む）
  lockFee: bigint; // ハッシュロックの手数料（bonded のときだけ）
  lockAmount: bigint; // ハッシュロックで預ける額（確定すると戻る）
  /** 開始に必要な XYM（手数料 + ロック）。内側の送金（DAO への入金など）は含まない。 */
  totalNeeded: bigint;
  cosignatures: number;
}

function prepare(input: DaoSubmitInput, multiplier: number, deadline: bigint) {
  const cfg = getNetworkConfig();
  const facade = facadeFor(cfg.networkByte);
  const embedded = input.build(facade);
  if (embedded.length === 0) throw new Error('no_items');
  if (embedded.length > MAX_DAO_INNER) throw new Error('too_many_items');
  const bonded = !!input.dao && !input.dao.selfSufficient;
  const cosignatures = bonded ? input.dao!.cosignatures : (input.tempKeys?.length ?? 0);
  const tx = facade.transactionFactory.create({
    type: bonded ? 'aggregate_bonded_transaction_v3' : 'aggregate_complete_transaction_v3',
    signerPublicKey: input.publicKey,
    fee: 0n,
    deadline,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  // 後から付く連署の分だけ大きくなるので、手数料はその分も見込む。
  tx.fee = new models.Amount(BigInt(tx.size + COSIGNATURE_SIZE * cosignatures) * BigInt(multiplier));
  return { cfg, facade, tx, bonded, cosignatures };
}

/** 手数料とロックの見積もり（鍵は要らない）。 */
export async function quoteDao(input: DaoSubmitInput): Promise<DaoQuote> {
  const multiplier = (await feeMultipliers())[getDefaultFeeSpeed()];
  const { tx, bonded, cosignatures } = prepare(input, multiplier, 0n);
  const lockAmount = bonded ? await fetchHashLockAmount() : 0n;
  const fee = BigInt(tx.fee.value);
  const lockFee = bonded ? BigInt(HASH_LOCK_SIZE) * BigInt(multiplier) : 0n;
  return { bonded, size: tx.size + COSIGNATURE_SIZE * cosignatures, fee, lockFee, lockAmount, totalNeeded: fee + lockFee + lockAmount, cosignatures };
}

export interface SignedDao extends SignedTransaction {
  bonded: boolean;
}

/**
 * 組み立てて署名する（送らない）。連署用の鍵があれば、発行者の署名の後で連署を付ける。
 * `skipTempCosign` は SSS Extension など外で署名するとき用: 連署のハッシュは発行者の署名を含むので、署名が入る前に連署すると
 * 1回目と2回目で中身が変わってしまう。連署は署名が入ったあとで `addTempCosignatures` が付ける（手数料は連署の分を見込んだまま）。
 */
export function signDao(privateKey: string, input: DaoSubmitInput, multiplier: number, deadline: bigint, skipTempCosign = false): SignedDao {
  const { cfg, facade, tx, bonded } = prepare(input, multiplier, deadline);
  if (facade.network.generationHashSeed.toString().toUpperCase() !== cfg.generationHash.toUpperCase()) throw new Error('generation_hash_mismatch');
  const signature = facade.signTransaction(signingKeyPair(privateKey), tx);
  tx.signature = new models.Signature(signature.bytes);
  // 連署は署名の後（ハッシュは署名を含むので）。
  const aggregate = tx as models.AggregateCompleteTransactionV3;
  if (!skipTempCosign) for (const key of input.tempKeys ?? []) aggregate.cosignatures.push(facade.cosignTransaction(new KeyPair(new PrivateKey(key)), tx));
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString(), bonded };
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** 署名の入ったアグリゲートに、作ったばかりのアカウント（DAO 本体）の連署を付ける（SSS など外で署名したとき）。 */
export function addTempCosignatures(signed: SignedDao, tempKeys: string[]): SignedDao {
  if (tempKeys.length === 0) return signed;
  const cfg = getNetworkConfig();
  const facade = facadeFor(cfg.networkByte);
  const tx = models.TransactionFactory.deserialize(hexToBytes(signed.payload)) as models.AggregateCompleteTransactionV3;
  for (const key of tempKeys) tx.cosignatures.push(facade.cosignTransaction(new KeyPair(new PrivateKey(key)), tx));
  return { payload: bytesToHex(tx.serialize()), hash: facade.hashTransaction(tx).toString(), bonded: signed.bonded };
}

/**
 * 秘密鍵があればそれで、空文字（SSS Extension のアカウント）か `keyless` ならその署名者で署名する。
 * 外で署名するときは、署名の後で連署（tempKeys）を付ける。
 */
export async function signDaoWith(privateKey: string, keyless: KeylessSigner | undefined, input: DaoSubmitInput, multiplier: number, deadline: bigint): Promise<SignedDao> {
  if (privateKey !== '' && keyless === undefined) return signDao(privateKey, input, multiplier, deadline);
  const cfg = getNetworkConfig();
  const signed = await signWithAny(privateKey, keyless ?? { kind: 'sss' }, input.publicKey, cfg.networkByte, () => signDao(privateKey, input, multiplier, deadline, true));
  return addTempCosignatures(signed, input.tempKeys ?? []);
}

export interface DaoSubmitResult {
  hash: string;
  bonded: boolean; // true = 他の管理者の連署を待っている
}

/**
 * 送る。complete はそのままアナウンス。bonded はハッシュロックを払い、確定するのを待ってから partial として流す
 * （他の管理者は「マルチシグ」の連署待ち一覧から署名できる）。
 */
export async function submitDao(privateKey: string, input: DaoSubmitInput, keyless?: KeylessSigner): Promise<DaoSubmitResult> {
  const cfg = getNetworkConfig();
  const multiplier = (await feeMultipliers())[getDefaultFeeSpeed()];
  const now = BigInt(await networkTimeMs());
  const bondedPlanned = !!input.dao && !input.dao.selfSufficient;
  const signed = await signDaoWith(privateKey, keyless, input, multiplier, now + (bondedPlanned ? BONDED_LIFETIME_MS : 2n * 60n * 60n * 1000n));
  if (!signed.bonded) {
    await announceSigned(signed);
    return { hash: signed.hash, bonded: false };
  }
  // SSS で署名するときは、時刻や量を呼ぶ前に決めておく（2回呼んで同じ中身になる必要がある）。
  const lockParams = {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    currencyMosaicId: cfg.currencyMosaicId,
    amount: await fetchHashLockAmount(),
    duration: HASH_LOCK_DURATION_BLOCKS,
    aggregateHash: signed.hash,
    feeMultiplier: multiplier,
    deadline: now + 2n * 60n * 60n * 1000n,
  };
  const lock = await signWithAny(privateKey, keyless, input.publicKey, cfg.networkByte, () => signHashLock(privateKey, cfg.generationHash, lockParams));
  await announceBondedWithLock(lock, signed);
  return { hash: signed.hash, bonded: true };
}
