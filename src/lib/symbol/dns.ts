// Symbol の DNS。NEM の DNS（lib/nem/dns.ts）と同じしくみを、Symbol のネームスペースに当てはめたもの。
//
//   ・ネームスペース（例: "kasane"）ごとに「ポインタアカウント」が決まる。秘密鍵は NEM と同じ式で、名前だけから計算できる:
//       秘密鍵 = Keccak-256( SHA-256( UTF-8 の名前 ) )
//     この秘密鍵から、Symbol の鍵（Ed25519 / SHA-512）でアドレスを作る。NEM と秘密鍵は同じでも、アドレスは別物になる。
//     鍵はだれでも計算できるので、ポインタアカウントに資産を置いてはいけない。使うのは「住所」としてだけ。
//   ・ネームスペースの持ち主が、ポインタアカウントへ「モザイクなし」の送金をする。メッセージ（平文）は NEM と同じ JSON:
//       {"dns":"yes","ip1":"...","organization":"...","country":"...","address":"...","phone":"...","email":"...","other":"..."}
//     （空の項目は入れない）。これが「DNS レコード」。Symbol では先頭に種別バイト 0x00（平文）が付く。
//   ・検索は、ポインタアカウントへの送金から、「ネームスペースの持ち主が署名した」最新の DNS メッセージを探す。
//     持ち主以外が送ったものは、中身が DNS 形式でも無視する（偽の登録を防ぐ）。
//     マルチシグが持ち主のときは、アグリゲートの中の送金（署名者はマルチシグアカウント）として届く。
//
// NEM との違い:
//   ・ネームスペース名は、ルートも 64 文字まで（NEM は 16 文字）。深さは 3 まで。「.nem」のような表示用の末尾は付けない
//     （Symbol では「foo.symbol」が「foo」の下の子ネームスペース「symbol」のことがあり、見分けがつかなくなるため）。
//   ・メッセージの上限は 1023 バイト（NEM は 1024 バイト）。
//   ・持ち主は、アカウントの署名者の公開鍵から作ったアドレスで照合する（NEM はマルチシグを外側の署名で包む。Symbol はアグリゲート）。
//
// このファイルは SDK を使わない（アドレスへの変換は呼び出し側から渡す）。通信は dnsApi.ts。
import { emptyNemDnsRecord, nemDnsPointerPrivateKey, parseNemDnsMessage } from '../nem/dns';
import type { NemDnsRecord } from '../nem/dns';

export type SymbolDnsRecord = NemDnsRecord;
export const emptySymbolDnsRecord = emptyNemDnsRecord;

/** 平文のメッセージの上限（バイト）。種別バイトは含まない。lib/symbol/tx.ts の MAX_MESSAGE_BYTES と同じ値（テストで確かめている）。 */
export const SYMBOL_DNS_MAX_MESSAGE_BYTES = 1023;

/** ルートも子も 64 文字まで、深さは 3 まで（lib/symbol/tx.ts の MAX_NAMESPACE_NAME_LENGTH / MAX_NAMESPACE_DEPTH と同じ）。 */
const MAX_PART_LENGTH = 64;
const MAX_DEPTH = 3;
const NAME_PART = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * 入力（"kasane"、"Kasane"、"a.b" など）を Symbol のネームスペース名にそろえる。前後の空白を取り、小文字にする。
 * 形が違えば null。
 */
export function normalizeSymbolDnsName(input: string): string | null {
  const s = input.trim().toLowerCase();
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > MAX_DEPTH) return null;
  for (const part of parts) {
    if (part.length === 0 || part.length > MAX_PART_LENGTH || !NAME_PART.test(part)) return null;
  }
  return parts.join('.');
}

/** ポインタアカウントの秘密鍵（64 桁の 16 進、大文字）。名前（正規化済み）だけから決まる。NEM の式と同じ。 */
export const symbolDnsPointerPrivateKey = nemDnsPointerPrivateKey;

// --- finding the record in the pointer account's history --------------------------------------------------------
/** ノードが返す、送金 1 件分（通常の送金も、アグリゲートの中の送金も同じ形）。 */
export interface RawSymbolDnsEntry {
  meta?: {
    hash?: string;
    /** アグリゲートの中の送金のとき、そのアグリゲートのハッシュ（中の送金は自分のハッシュを持たない）。 */
    aggregateHash?: string;
    height?: string;
    index?: number;
    /** ネットワークの起点（epoch）からのミリ秒。 */
    timestamp?: string;
  };
  transaction?: {
    type?: number;
    signerPublicKey?: string;
    /** 宛先のアドレス（16 進。base32 ではない）。 */
    recipientAddress?: string;
    /** メッセージ（16 進。先頭 1 バイトが種別で、00 が平文）。 */
    message?: string;
  };
}

export interface FoundSymbolDnsRecord {
  record: SymbolDnsRecord;
  /** 取引のハッシュ。アグリゲートの中の送金は、アグリゲートのハッシュ（探せるのはこちら）。 */
  hash: string;
  height: bigint | null;
  index: number | null;
  /** ネットワークの起点からのミリ秒。 */
  epochMs: number | null;
}

/** メッセージ（16 進、先頭に種別バイト）が平文なら、その文字列。そうでなければ null。 */
export function plainTextOfMessageField(messageHex: string | undefined): string | null {
  const hex = (messageHex ?? '').trim();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.slice(0, 2) !== '00') return null;
  const bytes = Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const TX_TYPE_TRANSFER = 0x4154;

/**
 * 送金の並び（新しい順）から、DNS レコードを探す。次をすべて満たす最初の送金:
 *   ・転送トランザクションで、宛先がポインタアカウント（`pointerHex` = 宛先アドレスの 16 進、大文字）
 *   ・署名したアカウントが、ネームスペースの持ち主（`ownerAddress` = base32）
 *   ・平文のメッセージで、DNS 形式
 * `addressOf` は署名者の公開鍵をアドレス（base32）にする関数。
 */
export function findSymbolDnsRecord(
  entries: RawSymbolDnsEntry[],
  ownerAddress: string,
  pointerHex: string,
  addressOf: (publicKey: string) => string,
): FoundSymbolDnsRecord | null {
  const owner = ownerAddress.replace(/-/g, '').toUpperCase();
  const pointer = pointerHex.toUpperCase();
  for (const entry of entries) {
    const tx = entry.transaction;
    if (!tx || tx.type !== TX_TYPE_TRANSFER) continue;
    if ((tx.recipientAddress ?? '').toUpperCase() !== pointer) continue;
    if (typeof tx.signerPublicKey !== 'string') continue;
    let signerAddress: string;
    try {
      signerAddress = addressOf(tx.signerPublicKey).replace(/-/g, '').toUpperCase();
    } catch {
      continue;
    }
    if (signerAddress !== owner) continue;
    const text = plainTextOfMessageField(tx.message);
    const record = text === null ? null : parseNemDnsMessage(text);
    if (record === null) continue;
    const meta = entry.meta;
    const hash = meta?.hash ?? meta?.aggregateHash ?? '';
    return {
      record,
      hash: hash.toUpperCase(),
      height: meta?.height !== undefined && /^[0-9]+$/.test(meta.height) ? BigInt(meta.height) : null,
      index: typeof meta?.index === 'number' ? meta.index : null,
      epochMs: meta?.timestamp !== undefined && /^[0-9]+$/.test(meta.timestamp) ? Number(meta.timestamp) : null,
    };
  }
  return null;
}

/** `a` は `b` より新しいか（ブロックの高さ、同じなら順番）。比べられなければ false。 */
export function isNewerDnsRecord(a: FoundSymbolDnsRecord, b: FoundSymbolDnsRecord): boolean {
  if (a.height !== null && b.height !== null && a.height !== b.height) return a.height > b.height;
  if (a.index !== null && b.index !== null) return a.index > b.index;
  return false;
}

/**
 * 通常の送金の一覧と、アグリゲートの中の送金の一覧（どちらも新しい順）から出た「それぞれの最新」のうち、新しい方。
 * マルチシグの持ち主が登録したものは後者にしか出ないので、両方を見る。
 */
export function newerDnsRecord(plain: FoundSymbolDnsRecord | null, embedded: FoundSymbolDnsRecord | null): FoundSymbolDnsRecord | null {
  if (plain === null) return embedded;
  if (embedded === null) return plain;
  return isNewerDnsRecord(embedded, plain) ? embedded : plain;
}
