// アポスティーユ（公証）— NEM Wallet（NanoWallet）の「アポスティーユ」と同じ仕組み。
//   ファイルのハッシュ（公開）または、ハッシュに自分の署名をつけたもの（非公開＝署名つき）を、
//   0 XEM の送金のメッセージに入れて NEM のブロックチェーンに残す。
//   メッセージ = 0xFE 'N' 'T' 'Y' <ハッシュ種別> + (公開: ハッシュ / 署名つき: ハッシュへの署名64バイト)
//   宛先 = 公開: 公証用のシンクアカウント / 署名つき: ファイル名から決まる「専用アカウント」
// ここは通信なしの計算だけ（テスト: dev-tests/nem-apostille.test.ts）。
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256, keccak_512 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import { nemAddressFromPublicKey, verifyNemSignature } from './crypto';
import { nemTransferFeeForLength } from './tx';

export type ApostilleHashName = 'MD5' | 'SHA1' | 'SHA256' | 'SHA3-256' | 'SHA3-512';

export interface ApostilleHashing {
  name: ApostilleHashName;
  /** Version byte of a public apostille (hex). */
  version: string;
  /** Version byte of a signed (private) apostille (hex). */
  signedVersion: string;
}

export const APOSTILLE_HASHINGS: Record<ApostilleHashName, ApostilleHashing> = {
  MD5: { name: 'MD5', version: '01', signedVersion: '81' },
  SHA1: { name: 'SHA1', version: '02', signedVersion: '82' },
  SHA256: { name: 'SHA256', version: '03', signedVersion: '83' },
  'SHA3-256': { name: 'SHA3-256', version: '08', signedVersion: '88' },
  'SHA3-512': { name: 'SHA3-512', version: '09', signedVersion: '89' },
};

/** What a new apostille can use. MD5 / SHA1 are only for checking old apostilles. */
export const APOSTILLE_CREATE_HASHINGS: ApostilleHashName[] = ['SHA256', 'SHA3-256', 'SHA3-512'];

/** The fixed start of every apostille message: 0xFE 'N' 'T' 'Y'. */
export const APOSTILLE_PREFIX = 'fe4e5459';

/** Sink account of public apostilles (NEM mainnet 0x68 / testnet 0x98), base32 without hyphens. */
const APOSTILLE_SINK: Record<number, string> = {
  0x68: 'NCZSJHLTIMESERVBVKOW6US64YDZG2PFGQCSV23J',
  0x98: 'TC7MCY5AGJQXZQ4BN3BOPNXUVIGDJCOHBPGUM2GE',
};

export function apostilleSink(networkByte: number): string {
  const sink = APOSTILLE_SINK[networkByte];
  if (!sink) throw new Error('apostille: unknown network');
  return sink;
}

/**
 * Hash for a version byte. NEM's "SHA3" is Keccak (the pre-standard SHA-3 that crypto-js calls SHA3), not NIST SHA3.
 * Returns null for an unknown byte.
 */
function hashByVersion(versionByte: string, data: Uint8Array): Uint8Array | null {
  switch (versionByte) {
    case '01': case '81': return md5(data);
    case '02': case '82': return sha1(data);
    case '03': case '83': return sha256(data);
    case '08': case '88': return keccak_256(data);
    case '09': case '89': return keccak_512(data);
    default: return null;
  }
}

export function isSignedVersion(versionByte: string): boolean {
  return Object.values(APOSTILLE_HASHINGS).some((h) => h.signedVersion === versionByte);
}

export interface BuiltApostille {
  /** The transfer message (raw bytes, starting with 0xFE 'N' 'T' 'Y'). */
  message: Uint8Array;
  /** The message as lower-case hex (what the node shows as the payload). */
  messageHex: string;
  /** Hash of the file (hex, lower case, no prefix). */
  fileHash: string;
  /** Message without the 5-byte checksum: the hash (public) or the signature (signed). */
  signed: boolean;
}

/**
 * The message for `file`. `privateKey` (the signer's, NEM-wallet convention) is needed for a signed apostille only.
 */
export function buildApostilleMessage(file: Uint8Array, hashing: ApostilleHashing, signed: boolean, privateKey?: string): BuiltApostille {
  const versionByte = signed ? hashing.signedVersion : hashing.version;
  const hash = hashByVersion(hashing.version, file);
  if (!hash) throw new Error('apostille: unknown hashing');
  const checksum = hexToBytes(`${APOSTILLE_PREFIX}${versionByte}`);
  let body: Uint8Array = hash;
  if (signed) {
    if (!privateKey) throw new Error('apostille: a private key is needed to sign');
    // NEM signs the raw hash bytes (NanoWallet signs the hash's hex string, which it decodes to the same bytes).
    body = new KeyPair(new PrivateKey(privateKey)).sign(hash).bytes;
  }
  const message = new Uint8Array(checksum.length + body.length);
  message.set(checksum, 0);
  message.set(body, checksum.length);
  return { message, messageHex: bytesToHex(message), fileHash: bytesToHex(hash), signed };
}

/** The fee of the 0 XEM transfer carrying `message`. */
export function apostilleFee(message: Uint8Array): bigint {
  return nemTransferFeeForLength(0n, message.length);
}

export interface DedicatedAccount {
  address: string;
  publicKey: string;
}

/**
 * The account a signed apostille is sent to. It depends only on the owner's key and the file name, so the same
 * owner and name always give the same account (this is how an apostille is "updated": a new hash goes to the same account).
 * Its private key = the last 32 bytes of the owner's signature of SHA-256(file name).
 */
export function dedicatedAccount(ownerPrivateKey: string, fileName: string, networkByte: number): DedicatedAccount {
  const digest = sha256(new TextEncoder().encode(fileName));
  const signature = new KeyPair(new PrivateKey(ownerPrivateKey)).sign(digest).bytes;
  const privateKey = bytesToHex(signature.slice(32)).toUpperCase();
  const publicKey = new KeyPair(new PrivateKey(privateKey)).publicKey.toString().toUpperCase();
  return { address: nemAddressFromPublicKey(publicKey, networkByte), publicKey };
}

export type AuditVerdict = 'valid' | 'invalid' | 'not_apostille';

/**
 * Checks `file` against the message of an apostille transaction (`payloadHex`, as the node returns it) sent by `signerPublicKey`.
 * Public: the file's hash equals the hash in the message. Signed: the message holds the signer's signature of that hash.
 */
export function verifyApostille(file: Uint8Array, payloadHex: string, signerPublicKey: string): AuditVerdict {
  const payload = payloadHex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0 || !payload.startsWith(APOSTILLE_PREFIX) || payload.length < 12) return 'not_apostille';
  const versionByte = payload.slice(8, 10);
  const hash = hashByVersion(versionByte, file);
  if (!hash) return 'not_apostille';
  const rest = payload.slice(10);
  if (isSignedVersion(versionByte)) {
    if (rest.length !== 128) return 'invalid';
    try {
      return verifyNemSignature(signerPublicKey, hash, hexToBytes(rest)) ? 'valid' : 'invalid';
    } catch {
      return 'invalid';
    }
  }
  return bytesToHex(hash) === rest ? 'valid' : 'invalid';
}

// --- file names -------------------------------------------------------------------------------
/** "2026-10-12" (local date), as NanoWallet writes it into the renamed file. */
export function shortDate(date: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : '';
}

/** The name the notarized file is saved under: "<name> -- Apostille TX <hash> -- Date <date>.<ext>". */
export function apostilleFileName(originalName: string, txHash: string, date: Date): string {
  const ext = extensionOf(originalName);
  return `${baseName(originalName)} -- Apostille TX ${txHash} -- Date ${shortDate(date)}${ext ? `.${ext}` : ''}`;
}

export interface ParsedApostilleName {
  originalName: string;
  txHash: string;
  date: string;
}

/** Reads a name made by apostilleFileName (or NanoWallet). Null when the name is not in that form. */
export function parseApostilleFileName(fileName: string): ParsedApostilleName | null {
  const ext = extensionOf(fileName);
  const m = /^(.*?) -- (?:Apostille|ApostilleSigned) TX ([0-9A-Fa-f]{64}) -- Date (\S+)$/s.exec(baseName(fileName));
  if (!m) return null;
  return { originalName: ext ? `${m[1]}.${ext}` : m[1], txHash: m[2].toUpperCase(), date: m[3] };
}
