// NEM の Domain Name System (DNS)。NEM Wallet（NanoWallet）の「DNS」と同じしくみ。
//
//   ・ネームスペース（例: "kasane"）ごとに「ポインタアカウント」が決まる。鍵は名前だけから計算できる:
//       秘密鍵 = Keccak-256( SHA-256( UTF-8 の名前 ) )      （NanoWallet: derivePassSha(SHA256(name), 1)）
//     鍵はだれでも計算できるので、ポインタアカウントに資産を置いてはいけない。使うのは「住所」としてだけ。
//   ・ネームスペースの持ち主が、ポインタアカウントへ 0 XEM の送金をする。メッセージ（平文）が JSON:
//       {"dns":"yes","ip1":"...","organization":"...","country":"...","address":"...","phone":"...","email":"...","other":"..."}
//     （空の項目は入れない）。これが「DNS レコード」。
//   ・検索は、ポインタアカウントの送金履歴から、「ネームスペースの持ち主が署名した」最新の DNS メッセージを探す。
//     持ち主以外が送ったものは、中身が DNS 形式でも無視する（偽の登録を防ぐ）。
//
// このファイルは SDK を使わない（アドレスへの変換は呼び出し側から渡す）。ネットワークとの通信は dnsApi.ts。
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NEM_MAX_MESSAGE_BYTES, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';

export const NEM_DNS_TLD = 'nem';
export const NEM_DNS_MAX_MESSAGE_BYTES = NEM_MAX_MESSAGE_BYTES;

export const NEM_DNS_FIELDS = ['ip1', 'organization', 'country', 'address', 'phone', 'email', 'other'] as const;
export type NemDnsField = (typeof NEM_DNS_FIELDS)[number];
export type NemDnsRecord = Record<NemDnsField, string>;

export const emptyNemDnsRecord = (): NemDnsRecord => ({ ip1: '', organization: '', country: '', address: '', phone: '', email: '', other: '' });

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

// --- names -------------------------------------------------------------------------------------------------------
const NAME_PART = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * 入力（"kasane"、"Kasane.nem"、"a.b" など）を NEM のネームスペース名にそろえる。小文字にし、末尾の ".nem"（DNS の
 * 表示用の名前）を取る。ルートは 16 文字まで、サブは 64 文字まで、深さは 3 まで。形が違えば null。
 */
export function normalizeNemDnsName(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s.endsWith(`.${NEM_DNS_TLD}`)) s = s.slice(0, -(NEM_DNS_TLD.length + 1));
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  for (let i = 0; i < parts.length; i += 1) {
    const max = i === 0 ? 16 : 64;
    if (parts[i].length === 0 || parts[i].length > max || !NAME_PART.test(parts[i])) return null;
  }
  return parts.join('.');
}

/** 画面に出すときの名前（"kasane" → "kasane.nem"）。 */
export const nemDnsDisplayName = (namespace: string) => `${namespace}.${NEM_DNS_TLD}`;

// --- the pointer account ----------------------------------------------------------------------------------------
/** ポインタアカウントの秘密鍵（NEM ウォレットの向きの 64 桁の 16 進、大文字）。名前（正規化済み）だけから決まる。 */
export function nemDnsPointerPrivateKey(namespace: string): string {
  return bytesToHex(keccak_256(sha256(new TextEncoder().encode(namespace))));
}

// --- the record -------------------------------------------------------------------------------------------------
/** DNS レコードのメッセージ（NanoWallet が読める形）。空の項目は入れない。値は前後の空白を取る。 */
export function buildNemDnsMessage(record: NemDnsRecord): string {
  const out: Record<string, string> = { dns: 'yes' };
  for (const key of NEM_DNS_FIELDS) {
    const v = record[key].trim();
    if (v !== '') out[key] = v;
  }
  return JSON.stringify(out);
}

export const nemDnsMessageBytes = (record: NemDnsRecord) => new TextEncoder().encode(buildNemDnsMessage(record)).length;

/** メッセージが DNS レコードならその中身、そうでなければ null（NanoWallet と同じく `"dns":"yes"` が目印）。 */
export function parseNemDnsMessage(text: string): NemDnsRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if (obj.dns !== 'yes') return null;
  const record = emptyNemDnsRecord();
  for (const key of NEM_DNS_FIELDS) {
    const v = obj[key];
    if (typeof v === 'string') record[key] = v;
  }
  return record;
}

/** ホスト欄（"example.com"、"172.16.254.1"、"https://example.com/x"）を開いてよい http(s) の URL にする。だめなら null。 */
export function nemDnsSiteUrl(host: string): string | null {
  const t = host.trim();
  if (t === '' || /\s/.test(t)) return null;
  // 方式（scheme）が書いてあれば http / https だけ。書いてなければ NanoWallet と同じく http://。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

// --- finding the record in the pointer account's history --------------------------------------------------------
interface RawTx {
  type?: number;
  signer?: string; // public key (hex)
  recipient?: string;
  timeStamp?: number;
  message?: { payload?: string; type?: number };
  otherTrans?: RawTx;
}
export interface RawDnsEntry {
  meta?: { id?: number; height?: number; hash?: { data?: string } };
  transaction?: RawTx;
}

export interface FoundNemDnsRecord {
  record: NemDnsRecord;
  hash: string;
  height: number | null;
  timeStamp: number | null; // NEM の秒（NEM_EPOCH からの秒）
}

function hexToUtf8(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 送金履歴（新しい順）から、DNS レコードを探す。次をすべて満たす最初の送金:
 *   ・転送トランザクション（マルチシグの外側なら、その中の送金）で、宛先がポインタアカウント
 *   ・署名したアカウント（マルチシグなら、その名義のアカウント）が、ネームスペースの持ち主
 *   ・平文のメッセージで、DNS 形式
 * `addressOf` は署名者の公開鍵をアドレスにする関数。
 */
export function findNemDnsRecord(
  entries: RawDnsEntry[],
  ownerAddress: string,
  pointerAddress: string,
  addressOf: (publicKey: string) => string,
): FoundNemDnsRecord | null {
  const owner = ownerAddress.replace(/-/g, '').toUpperCase();
  const pointer = pointerAddress.replace(/-/g, '').toUpperCase();
  for (const entry of entries) {
    let tx = entry.transaction;
    if (tx?.type === NEM_TX_TYPE_MULTISIG) tx = tx.otherTrans;
    if (!tx || tx.type !== NEM_TX_TYPE_TRANSFER) continue;
    if ((tx.recipient ?? '').replace(/-/g, '').toUpperCase() !== pointer) continue;
    if (tx.message?.type !== 1 || typeof tx.message.payload !== 'string' || typeof tx.signer !== 'string') continue;
    let signerAddress: string;
    try {
      signerAddress = addressOf(tx.signer).toUpperCase();
    } catch {
      continue;
    }
    if (signerAddress !== owner) continue;
    const text = hexToUtf8(tx.message.payload);
    const record = text === null ? null : parseNemDnsMessage(text);
    if (record === null) continue;
    return {
      record,
      hash: entry.meta?.hash?.data ?? '',
      height: typeof entry.meta?.height === 'number' ? entry.meta.height : null,
      timeStamp: typeof tx.timeStamp === 'number' ? tx.timeStamp : null,
    };
  }
  return null;
}
