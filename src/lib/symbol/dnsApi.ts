// Symbol DNS: ノードへの問い合わせと、レコードの登録（しくみは lib/symbol/dns.ts の先頭）。NEM 版は lib/nem/dnsApi.ts。
import { generateNamespaceId } from 'symbol-sdk/symbol';
import { signWithLedger } from '../ledger/session';
import { buildNemDnsMessage } from '../nem/dns';
import { TX_TYPE_TRANSFER } from './constants';
import { addressBytesToString, addressFromPublicKey, bytesToHex, decodeAddress, hexToBytes, keyPairFromPrivateKey, normalizeAddress, verifySignature } from './crypto';
import { getNetworkConfig } from './network';
import { SymbolSendError, announceSigned, networkTimeMs, nodeRequest, quoteFeesForSize } from './api';
import { symbolMessageField } from './apostille';
import {
  SYMBOL_DNS_MAX_MESSAGE_BYTES, findSymbolDnsRecord, newerDnsRecord, normalizeSymbolDnsName, symbolDnsPointerPrivateKey,
} from './dns';
import type { FoundSymbolDnsRecord, RawSymbolDnsEntry, SymbolDnsRecord } from './dns';
import { getDefaultFeeSpeed } from './feeSpeed';
import { quoteMultisigCost, submitMultisig } from './multisigApi';
import type { MultisigCost } from './multisigApi';
import { multisigRawTransferAggregateSize, signTransfer, signTransferWith, transferSizeForMessageField } from './tx';

export interface SymbolDnsPointer {
  namespace: string;
  publicKey: string;
  address: string;
}

/** ネームスペース（正規化済みの名前）のポインタアカウント。使っているネットワークのアドレスで返す。 */
export function symbolDnsPointer(namespace: string, networkByte: number = getNetworkConfig().networkByte): SymbolDnsPointer {
  const { publicKey } = keyPairFromPrivateKey(symbolDnsPointerPrivateKey(namespace));
  return { namespace, publicKey, address: addressFromPublicKey(publicKey, networkByte) };
}

/** code: 'invalid_name'（ネームスペース名の形が違う）／'namespace_not_found'（チェーンにない）。 */
export class SymbolDnsError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface SymbolDnsLookup {
  namespace: string;
  owner: string; // アドレス（base32）
  pointerAddress: string;
  /** ネームスペースの期限が切れているか（切れていると、持ち主が変わっているかもしれない）。 */
  expired: boolean;
  found: (FoundSymbolDnsRecord & { updatedAtMs: number | null }) | null;
}

const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 6;
const ETERNAL_END_HEIGHT = 18446744073709551615n;

/** 名前（"a.b"）のネームスペース ID（16 桁の 16 進、大文字）。 */
function namespaceIdOf(name: string): string {
  let id = 0n;
  for (const label of name.split('.')) id = BigInt(generateNamespaceId(label, id));
  return id.toString(16).toUpperCase().padStart(16, '0');
}

interface RawNamespace {
  meta?: { active?: boolean };
  namespace?: { ownerAddress?: string; endHeight?: string };
}

async function readNamespace(name: string): Promise<RawNamespace> {
  try {
    return await nodeRequest<RawNamespace>(`/namespaces/${namespaceIdOf(name)}`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    // 知らない ID は 404、形が違う ID は 409。ノードに届かないときは status が無いので、そのまま投げる。
    if (status === 404 || status === 409 || status === 400) throw new SymbolDnsError('namespace_not_found');
    throw e;
  }
}

const isExpired = (info: RawNamespace, height: bigint): boolean => {
  const end = info.namespace?.endHeight;
  if (end === undefined || !/^[0-9]+$/.test(end)) return false;
  const endHeight = BigInt(end);
  return endHeight !== ETERNAL_END_HEIGHT && height >= endHeight;
};

/** `base`（問い合わせの条件）で、ポインタアカウントへの送金を新しい方から読み、最初の DNS レコードを返す。 */
async function firstRecord(
  base: string,
  embeddedOnly: boolean,
  owner: string,
  pointerHex: string,
  addressOf: (publicKey: string) => string,
): Promise<FoundSymbolDnsRecord | null> {
  for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
    const res = await nodeRequest<{ data?: RawSymbolDnsEntry[] }>(`${base}&pageNumber=${page}`);
    const entries = res.data ?? [];
    if (entries.length === 0) return null;
    // 中の送金の一覧には、中の送金だけが入る。フラグを無視するノードが通常の一覧を返しても、混ざらないようにしておく。
    const usable = embeddedOnly ? entries.filter((e) => e.meta?.aggregateHash !== undefined && e.meta.aggregateHash !== '') : entries;
    const found = findSymbolDnsRecord(usable, owner, pointerHex, addressOf);
    if (found !== null) return found;
    if (entries.length < HISTORY_PAGE_SIZE) return null;
  }
  return null;
}

/** 名前（"kasane" / "a.b"）の DNS レコードを調べる。 */
export async function lookupSymbolDns(input: string): Promise<SymbolDnsLookup> {
  const namespace = normalizeSymbolDnsName(input);
  if (namespace === null) throw new SymbolDnsError('invalid_name');
  const cfg = getNetworkConfig();
  const pointer = symbolDnsPointer(namespace, cfg.networkByte);

  const info = await readNamespace(namespace);
  const ownerHex = info.namespace?.ownerAddress ?? '';
  if (ownerHex === '') throw new SymbolDnsError('namespace_not_found');
  const owner = addressBytesToString(hexToBytes(ownerHex));

  // 期限は、ルートの期限（子は親の期限に従う）。調べられなくても、記録を隠す理由にはしない。
  let expired = info.meta?.active === false;
  try {
    const { height } = await nodeRequest<{ height: string }>('/chain/info');
    const now = BigInt(height);
    expired = expired || isExpired(info, now);
    const root = namespace.split('.')[0];
    if (!expired && root !== namespace) expired = isExpired(await readNamespace(root), now);
  } catch {
    // 期限が分からないときは、切れていない扱い。
  }

  const addressOf = (publicKey: string) => addressFromPublicKey(publicKey, cfg.networkByte);
  const pointerBytes = decodeAddress(pointer.address);
  if (pointerBytes === null) throw new Error('invalid_pointer_address');
  const pointerHex = bytesToHex(pointerBytes).toUpperCase();
  const base = `/transactions/confirmed?recipientAddress=${normalizeAddress(pointer.address)}&type=${TX_TYPE_TRANSFER}&order=desc&pageSize=${HISTORY_PAGE_SIZE}`;
  // 持ち主が通常のアカウントなら通常の送金、マルチシグなら、アグリゲートの中の送金（embedded=true）として届く。
  const [plain, embedded] = await Promise.all([
    firstRecord(base, false, owner, pointerHex, addressOf),
    firstRecord(`${base}&embedded=true`, true, owner, pointerHex, addressOf).catch((): null => null),
  ]);
  const best = newerDnsRecord(plain, embedded);
  const found = best === null
    ? null
    : { ...best, updatedAtMs: best.epochMs === null ? null : best.epochMs + cfg.epochAdjustment * 1000 };
  return { namespace, owner, pointerAddress: pointer.address, expired, found };
}

// --- registering ------------------------------------------------------------------------------------------------
const dnsMessageBytes = (record: SymbolDnsRecord): Uint8Array => new TextEncoder().encode(buildNemDnsMessage(record));

/** レコードを送る送金の手数料（XYM の最小単位）。メッセージの長さと、設定の「手数料の既定値」の段階で決まる。 */
export async function quoteSymbolDnsFee(record: SymbolDnsRecord): Promise<bigint> {
  const size = transferSizeForMessageField(dnsMessageBytes(record).length + 1);
  return (await quoteFeesForSize(size))[getDefaultFeeSpeed()].fee;
}

/** マルチシグ名義のとき: アグリゲート（連署の分の余白つき）の手数料と、他の人の署名が要るときのハッシュロック。 */
export function quoteSymbolDnsFromMultisig(record: SymbolDnsRecord, cosignatureCount: number, bonded: boolean): Promise<MultisigCost> {
  return quoteMultisigCost(multisigRawTransferAggregateSize(dnsMessageBytes(record).length + 1), cosignatureCount, bonded);
}

export interface PublishSymbolDnsInput {
  namespace: string; // 正規化済み
  record: SymbolDnsRecord;
  /** 署名するアカウントの鍵（マルチシグ名義なら、連署者としての自分）。Ledger なら privateKey は空文字にして ledgerIndex を入れる。 */
  privateKey: string;
  publicKey: string;
  ledgerIndex?: number;
  /** ネームスペースの持ち主がマルチシグアカウントのとき、その公開鍵。このとき bonded と cosignatureCount も要る。 */
  multisigPublicKey?: string;
  /** 自分の署名だけでは足りないとき true（ハッシュロックを払い、ほかの連署者が署名する）。 */
  bonded?: boolean;
  cosignatureCount?: number;
}

/**
 * DNS レコードを登録（更新）する: ポインタアカウントへ、DNS メッセージを付けた、モザイクなしの送金をする。
 * 送るのは、ネームスペースの持ち主のアカウント（マルチシグなら、その名義のアグリゲートの中）から。持ち主でないと、検索では無視される。
 * 返す hash は、通常は送金のハッシュ、マルチシグ名義ではアグリゲートのハッシュ。
 */
export async function publishSymbolDns(input: PublishSymbolDnsInput): Promise<{ hash: string; bonded: boolean }> {
  const bytes = dnsMessageBytes(input.record);
  if (bytes.length > SYMBOL_DNS_MAX_MESSAGE_BYTES) throw new SymbolSendError('message_too_long');
  const cfg = getNetworkConfig();
  const recipient = symbolDnsPointer(input.namespace, cfg.networkByte).address;
  const field = symbolMessageField(bytes);

  if (input.multisigPublicKey !== undefined) {
    // 鍵のないアカウント（Ledger）は、マルチシグのアグリゲートに署名できない。
    if (input.ledgerIndex !== undefined || input.privateKey === '') throw new SymbolSendError('ledger_multisig_unsupported');
    const sent = await submitMultisig({
      privateKey: input.privateKey,
      publicKey: input.publicKey,
      inner: { kind: 'transfer', accountPublicKey: input.multisigPublicKey, recipient, mosaics: [], rawMessage: field },
      bonded: input.bonded ?? true,
      cosignatureCount: input.cosignatureCount ?? 1,
    });
    return { hash: sent.hash, bonded: sent.bonded };
  }

  const fee = (await quoteFeesForSize(transferSizeForMessageField(field.length)))[getDefaultFeeSpeed()].fee;
  const deadline = BigInt(await networkTimeMs()) + 2n * 60n * 60n * 1000n;
  const params = {
    signerPublicKey: input.publicKey,
    networkByte: cfg.networkByte,
    recipient,
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
  return { hash: signed.hash, bonded: false };
}
