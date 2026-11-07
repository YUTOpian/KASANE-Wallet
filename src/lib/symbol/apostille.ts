// アポスティーユ（公証）— Symbol 版。NEM 版（lib/nem/apostille.ts）と同じ仕組み。
//   ファイルのハッシュ（公開）または、ハッシュに自分の署名をつけたもの（非公開＝署名つき）を、
//   モザイクを含まない送金のメッセージに入れて Symbol のブロックチェーンに残す。
//   アポスティーユのメッセージ = 0xFE 'N' 'T' 'Y' <ハッシュ種別> + (公開: ハッシュ / 署名つき: ハッシュへの署名64バイト)
//   NEM との違い:
//   ・Symbol の送金のメッセージは先頭に「種別バイト」が付くので、実際に載せるのは 0x00 + 上のメッセージ（NEM は上のメッセージそのまま）
//   ・署名は Symbol の鍵（Ed25519 / SHA-512）、NEM の署名は Keccak 版。同じ秘密鍵でも、署名は別物
//   ・宛先 = 公開: 公証用のシンクアカウント / 署名つき: ファイル名から決まる「専用アカウント」（決め方は NEM と同じ）
//   ・シンクアカウントは NEM のように決まったものが無いので、ネットワークのバイトから計算で決める（下の symbolApostilleSink）
// ここは通信なしの計算だけ（テスト: dev-tests/symbol-apostille.test.ts）。
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex as toLowerHex } from '@noble/hashes/utils.js';
import { PrivateKey, PublicKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { APOSTILLE_PREFIX, hashByVersion, verifyApostille } from '../nem/apostille';
import type { ApostilleHashing, AuditVerdict, BuiltApostille } from '../nem/apostille';
import { apostilleHexFromMessageField } from './apostilleMessage';
import { addressFromPublicKey, bytesToHex, facadeFor, hexToBytes, verifySignature } from './crypto';

/** Message type byte of a Symbol transfer: 0x00 = plain message (the apostille bytes follow it as they are). */
export const SYMBOL_PLAIN_MESSAGE_TYPE = 0x00;

/**
 * The account public apostilles are sent to. Nobody holds its key: it is the address of the "public key" SHA3-256("KASANE apostille sink" + network byte),
 * which is not a key anyone generated (finding a key that hashes to it is as hard as breaking SHA3-256). Anyone can recompute it from the network byte.
 * It is KASANE's own choice: another wallet that picks a different sink does not show up in this wallet's explorer, and the other way round.
 */
export function symbolApostilleSink(networkByte: number): string {
  const seed = new TextEncoder().encode(`KASANE apostille sink ${networkByte}`);
  const notAKey = sha3_256(seed);
  return facadeFor(networkByte).network.publicKeyToAddress(new PublicKey(notAKey)).toString();
}

/** The message field of the transfer: the type byte, then the apostille message. */
export function symbolMessageField(apostilleMessage: Uint8Array): Uint8Array {
  const out = new Uint8Array(apostilleMessage.length + 1);
  out[0] = SYMBOL_PLAIN_MESSAGE_TYPE;
  out.set(apostilleMessage, 1);
  return out;
}

/**
 * The message for `file` (the apostille message itself, without Symbol's type byte; see symbolMessageField).
 * `privateKey` (the signer's Symbol key) is needed for a signed apostille only.
 */
export function buildSymbolApostilleMessage(file: Uint8Array, hashing: ApostilleHashing, signed: boolean, privateKey?: string): BuiltApostille {
  const versionByte = signed ? hashing.signedVersion : hashing.version;
  const hash = hashByVersion(hashing.version, file);
  if (!hash) throw new Error('apostille: unknown hashing');
  const head = hexToBytes(`${APOSTILLE_PREFIX}${versionByte}`);
  let body: Uint8Array = hash;
  if (signed) {
    if (!privateKey) throw new Error('apostille: a private key is needed to sign');
    body = new KeyPair(new PrivateKey(privateKey)).sign(hash).bytes;
  }
  const message = new Uint8Array(head.length + body.length);
  message.set(head, 0);
  message.set(body, head.length);
  // Lower-case hex, like the NEM side: this is what the history, the .nty file and the audit compare.
  return { message, messageHex: toLowerHex(message), fileHash: toLowerHex(hash), signed };
}

export interface SymbolDedicatedAccount {
  address: string;
  publicKey: string;
}

/**
 * The account a signed apostille is sent to. It depends only on the owner's key and the file name, so the same owner and name
 * always give the same account (this is how an apostille is "updated": a new hash goes to the same account). Same rule as NEM:
 * its private key = the last 32 bytes of the owner's signature of SHA-256(file name), here with the Symbol key pair.
 */
export function symbolDedicatedAccount(ownerPrivateKey: string, fileName: string, networkByte: number): SymbolDedicatedAccount {
  const digest = sha256(new TextEncoder().encode(fileName));
  const signature = new KeyPair(new PrivateKey(ownerPrivateKey)).sign(digest).bytes;
  const privateKey = bytesToHex(signature.slice(32)).toUpperCase();
  const publicKey = new KeyPair(new PrivateKey(privateKey)).publicKey.toString().toUpperCase();
  return { address: addressFromPublicKey(publicKey, networkByte), publicKey };
}

/**
 * Checks `file` against an apostille message (`payloadHex`, starting with fe4e5459) sent by `signerPublicKey`.
 * Public: the file's hash equals the hash in the message. Signed: the message holds the signer's (Symbol) signature of that hash.
 * The checking itself is the same as NEM's; only the signature scheme differs.
 */
export function verifySymbolApostille(file: Uint8Array, payloadHex: string, signerPublicKey: string): AuditVerdict {
  return verifyApostille(file, payloadHex, signerPublicKey, verifySignature);
}

export { apostilleHexFromMessageField };
