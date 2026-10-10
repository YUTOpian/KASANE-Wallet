// Symbol cryptography on top of the official Symbol SDK v3 (symbol-sdk).
// Keys, addresses and signatures all come from the SDK; this file only adapts them to the plain
// hex-string / Uint8Array shapes the rest of the app uses.
import { PrivateKey, PublicKey, Signature } from 'symbol-sdk';
import { Address, KeyPair, SymbolFacade, Verifier } from 'symbol-sdk/symbol';
import { sha3_256 } from '@noble/hashes/sha3.js';

export const ADDRESS_BYTES = 24;
export const ADDRESS_LENGTH = 39;

const facades: Record<number, SymbolFacade> = {};
/** Facade for a network byte (0x68 mainnet / 0x98 testnet). */
export function facadeFor(networkByte: number): SymbolFacade {
  return (facades[networkByte] ??= new SymbolFacade(networkByte === 0x98 ? 'testnet' : 'mainnet'));
}

// --- hex helpers -------------------------------------------------------------------------
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid_hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// --- keys ---------------------------------------------------------------------------------
export interface SymbolKeyPair {
  privateKey: string; // 64 hex chars (upper case)
  publicKey: string; // 64 hex chars (upper case)
}

export function isValidPrivateKey(hex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hex.trim());
}

export function keyPairFromPrivateKey(privateKeyHex: string): SymbolKeyPair {
  if (!isValidPrivateKey(privateKeyHex)) throw new Error('invalid_private_key');
  const keyPair = new KeyPair(new PrivateKey(privateKeyHex.trim()));
  return { privateKey: keyPair.privateKey.toString(), publicKey: keyPair.publicKey.toString() };
}

export function signData(privateKeyHex: string, data: Uint8Array): Uint8Array {
  return new KeyPair(new PrivateKey(privateKeyHex)).sign(data).bytes;
}

export function verifySignature(publicKeyHex: string, data: Uint8Array, signature: Uint8Array): boolean {
  return new Verifier(new PublicKey(publicKeyHex)).verify(data, new Signature(signature));
}

// --- addresses ----------------------------------------------------------------------------
export function addressFromPublicKey(publicKeyHex: string, networkByte: number): string {
  return facadeFor(networkByte).network.publicKeyToAddress(new PublicKey(publicKeyHex)).toString();
}

export function addressBytesToString(bytes: Uint8Array): string {
  if (bytes.length !== ADDRESS_BYTES) throw new Error('invalid_address_bytes');
  return new Address(bytes).toString();
}

/** Strips hyphens / spaces and upper-cases, so "NABC-DEF-..." pasted from other wallets works. */
export function normalizeAddress(address: string): string {
  return address.replace(/[-\s]/g, '').toUpperCase();
}

/** Returns the 24 address bytes, or null if the string is not a well-formed Symbol address. */
export function decodeAddress(address: string): Uint8Array | null {
  const normalized = normalizeAddress(address);
  if (normalized.length !== ADDRESS_LENGTH || !/^[A-Z2-7]+$/.test(normalized)) return null;
  try {
    const bytes = Uint8Array.from(new Address(normalized).bytes);
    // The SDK constructor only decodes; verify the 3-byte checksum explicitly.
    const checksum = sha3_256(bytes.subarray(0, 21)).subarray(0, 3);
    for (let i = 0; i < 3; i += 1) if (bytes[21 + i] !== checksum[i]) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function isValidAddress(address: string, networkByte?: number): boolean {
  const bytes = decodeAddress(address);
  if (!bytes) return false;
  return networkByte === undefined || bytes[0] === networkByte;
}

/** Network byte (0x68 mainnet / 0x98 testnet) of a valid address, else null. */
export function addressNetworkByte(address: string): number | null {
  const bytes = decodeAddress(address);
  return bytes ? bytes[0] : null;
}

/** "NABCDE…" -> "NABCDE-FGHIJK-…" (6-char groups, the form Symbol wallets display). */
export function prettyAddress(address: string): string {
  const n = normalizeAddress(address);
  return n.match(/.{1,6}/g)?.join('-') ?? n;
}

// --- hex helpers re-exported for callers that only need bytes <-> hex ----------------------
