// NEM keys and addresses, built on the NEM part of the official SDK (symbol-sdk/nem).
// NEM uses Ed25519 with Keccak-512, which the SDK's NEM KeyPair implements. The SDK (like the NEM
// wallets) reverses the private key bytes inside KeyPair, so a private key written down from this
// app imports into any other NEM wallet and gives the same address.
import { PrivateKey, PublicKey, Signature } from 'symbol-sdk';
import { KeyPair, NemFacade, Verifier } from 'symbol-sdk/nem';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { nemHexToBytes, nemMessageBytes, nemNanoMessageBytes } from './signedMessage';

export const NEM_ADDRESS_LENGTH = 40;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const facades: Record<number, NemFacade> = {};
/** Facade for a network byte (0x68 mainnet / 0x98 testnet). */
export function nemFacadeFor(networkByte: number): NemFacade {
  return (facades[networkByte] ??= new NemFacade(networkByte === 0x98 ? 'testnet' : 'mainnet'));
}

export interface NemKeyPair {
  privateKey: string; // 64 hex chars (upper case), in the NEM-wallet convention
  publicKey: string; // 64 hex chars (upper case)
}

export function isValidNemPrivateKey(hex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hex.trim());
}

export function nemKeyPairFromPrivateKey(privateKeyHex: string): NemKeyPair {
  if (!isValidNemPrivateKey(privateKeyHex)) throw new Error('invalid_private_key');
  const hex = privateKeyHex.trim().toUpperCase();
  const keyPair = new KeyPair(new PrivateKey(hex));
  return { privateKey: hex, publicKey: keyPair.publicKey.toString().toUpperCase() };
}

/** `data` に NEM（Ed25519 / Keccak-512）の署名をする。署名は 128 桁の 16 進（大文字）。 */
export function signNemData(privateKeyHex: string, data: Uint8Array): string {
  return new KeyPair(new PrivateKey(privateKeyHex)).sign(data).toString().toUpperCase();
}

/** NEM（Keccak）の署名を検算する。Ledger が返した署名を送る前に確かめるために使う。 */
export function verifyNemSignature(publicKeyHex: string, data: Uint8Array, signature: Uint8Array): boolean {
  return new Verifier(new PublicKey(publicKeyHex)).verify(data, new Signature(signature));
}

/**
 * 署名付きメッセージの文章を検証する。正しい UTF-8 で署名したもの（KASANE）なら 'utf8'、NanoWallet 式の符号化
 * （絵文字などが UTF-16 の 1 単位ずつ 3 バイト）でだけ合うなら 'nanowallet'、どちらでも合わなければ null。
 * 日本語・英数字などの BMP の文字だけなら、2 つの符号化は同じバイト列で、'utf8' になる。
 */
export function verifyNemText(publicKeyHex: string, message: string, signatureHex: string): 'utf8' | 'nanowallet' | null {
  const signature = nemHexToBytes(signatureHex);
  const utf8 = nemMessageBytes(message);
  if (verifyNemSignature(publicKeyHex, utf8, signature)) return 'utf8';
  const nano = nemNanoMessageBytes(message);
  const same = nano.length === utf8.length && nano.every((b, i) => b === utf8[i]);
  if (!same && verifyNemSignature(publicKeyHex, nano, signature)) return 'nanowallet';
  return null;
}

export function nemAddressFromPublicKey(publicKeyHex: string, networkByte: number): string {
  return nemFacadeFor(networkByte).network.publicKeyToAddress(new PublicKey(publicKeyHex)).toString().toUpperCase();
}

/** Strips hyphens / spaces and upper-cases, so "NABC-DEF-..." pasted from other wallets works. */
export function normalizeNemAddress(address: string): string {
  return address.replace(/[-\s]/g, '').toUpperCase();
}

function base32Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of text) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }
  return out;
}

/** The 25 address bytes (network byte, 20-byte hash, 4-byte checksum), or null if malformed. */
export function decodeNemAddress(address: string): Uint8Array | null {
  const normalized = normalizeNemAddress(address);
  if (normalized.length !== NEM_ADDRESS_LENGTH || !/^[A-Z2-7]+$/.test(normalized)) return null;
  const bytes = base32Decode(normalized);
  if (bytes.length !== 25) return null;
  const checksum = keccak_256(bytes.subarray(0, 21)).subarray(0, 4);
  for (let i = 0; i < 4; i += 1) if (bytes[21 + i] !== checksum[i]) return null;
  return bytes;
}

export function isValidNemAddress(address: string, networkByte?: number): boolean {
  const bytes = decodeNemAddress(address);
  if (!bytes) return false;
  return networkByte === undefined || bytes[0] === networkByte;
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The same account's address on another network (0x68 mainnet / 0x98 testnet): only the network
 * byte and the checksum change. Used by view-only (address-only) accounts, which have no public key
 * to derive the address from. Null if `address` is not a well-formed NEM address.
 */
export function convertNemAddressNetwork(address: string, networkByte: number): string | null {
  const bytes = decodeNemAddress(address);
  if (!bytes) return null;
  const next = Uint8Array.from(bytes);
  next[0] = networkByte;
  next.set(keccak_256(next.subarray(0, 21)).subarray(0, 4), 21);
  return base32Encode(next);
}

/** "NABCDE…" -> "NABCDE-FGHIJK-…" (6-char groups, the form NEM wallets display). */
export function prettyNemAddress(address: string): string {
  const n = normalizeNemAddress(address);
  return n.match(/.{1,6}/g)?.join('-') ?? n;
}
