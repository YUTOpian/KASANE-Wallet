// NEM wallet file (.wlt) - the format of the official NEM wallet (Nano Wallet / nem-sdk).
//
// A .wlt file is the Base64 of a UTF-8 JSON text:
//   { "name": "...", "accounts": { "0": { "brain": false, "algo": "pass:enc", "encrypted": "<hex>", "iv": "<hex>",
//                                          "address": "N...", "label": "Primary", "network": 104 } } }
// The private key of the primary account is sealed with a password the same way nem-sdk does it:
//   key = Keccak-256 applied 20 times to the UTF-8 password (the result of one round is the input of the next)
//   cipher text = AES-256-CBC (PKCS#7) of the 32 private-key bytes, with a random 16-byte IV
// network is 104 (mainnet) or -104 (testnet); the official wallet also knows 96 (mijin), which KASANE does not.
//
// Everything here is a pure function: nothing is stored or uploaded. See docs/FEATURES.md (ウォレットファイル).
import { keccak_256 } from '@noble/hashes/sha3.js';
import { cbc } from '@noble/ciphers/aes.js';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from './crypto';

export const WLT_MIN_PASSWORD = 8;
const MAINNET_ID = 104;
const TESTNET_ID = -104;
const NETWORK_BYTE: Record<number, number> = { [MAINNET_ID]: 0x68, [TESTNET_ID]: 0x98 };

/** What a .wlt file says about its primary account - the private key is still sealed. */
export interface ParsedWlt {
  name: string;
  /** Plain (no hyphens), upper case. */
  address: string;
  /** 0x68 (mainnet) or 0x98 (testnet). */
  networkByte: number;
  algo: 'pass:enc' | 'pass:bip32' | 'pass:6k';
  /** Hex cipher text; empty for a brain wallet (the private key comes from the passphrase alone). */
  encrypted: string;
  iv: string;
}

export interface WltAccount {
  name: string;
  address: string;
  networkByte: number;
  /** 64 hex chars, upper case. */
  privateKey: string;
  /** 64 hex chars, upper case. */
  publicKey: string;
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid_wlt');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** nem-sdk's derivePassSha: Keccak-256 of the password, then of each result, `count` times. */
export function derivePassSha(password: string, count: number): Uint8Array {
  let data: Uint8Array = encoder.encode(password);
  for (let i = 0; i < count; i += 1) data = keccak_256(data);
  return data;
}

function toBase64(text: string): string {
  const bytes = encoder.encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The text of a .wlt file for the account: its private key sealed with `password` (algo pass:enc, like importing a key in the official wallet). */
export function buildWlt(account: { name: string; privateKey: string; publicKey: string; networkByte: number }, password: string): string {
  const name = account.name.trim();
  if (name === '') throw new Error('invalid_name');
  if (password.length < WLT_MIN_PASSWORD) throw new Error('password_too_short');
  const networkId = account.networkByte === 0x98 ? TESTNET_ID : MAINNET_ID;
  // Ties the key to the address: a key that does not belong to the public key must never be written out.
  const pair = nemKeyPairFromPrivateKey(account.privateKey);
  if (pair.publicKey !== account.publicKey.toUpperCase()) throw new Error('key_mismatch');
  const iv = randomBytes(16);
  const sealed = cbc(derivePassSha(password, 20), iv).encrypt(fromHex(pair.privateKey));
  const wallet = {
    name,
    accounts: {
      0: {
        brain: false,
        algo: 'pass:enc',
        encrypted: toHex(sealed),
        iv: toHex(iv),
        address: nemAddressFromPublicKey(pair.publicKey, account.networkByte === 0x98 ? 0x98 : 0x68),
        label: 'Primary',
        network: networkId,
      },
    },
  };
  return toBase64(JSON.stringify(wallet));
}

/** Reads the text of a .wlt file (without the password). Throws 'invalid_wlt' or 'unsupported_wlt'. */
export function parseWlt(text: string): ParsedWlt {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let json: unknown;
  try {
    // The official wallet writes Base64; a plain JSON text is accepted too.
    json = JSON.parse(trimmed.startsWith('{') ? trimmed : fromBase64(trimmed.replace(/\s+/g, '')));
  } catch {
    throw new Error('invalid_wlt');
  }
  if (json === null || typeof json !== 'object') throw new Error('invalid_wlt');
  const wallet = json as { name?: unknown; accounts?: Record<string, Record<string, unknown>> };
  const account = wallet.accounts?.['0'];
  if (typeof wallet.name !== 'string' || account == null || typeof account !== 'object') throw new Error('invalid_wlt');
  const { algo, address, network } = account;
  if (typeof address !== 'string' || typeof network !== 'number') throw new Error('invalid_wlt');
  // Hardware wallets (trezor / ledger) hold no key in the file.
  if (algo !== 'pass:enc' && algo !== 'pass:bip32' && algo !== 'pass:6k') throw new Error('unsupported_wlt');
  const networkByte = NETWORK_BYTE[network];
  if (networkByte === undefined) throw new Error('unsupported_wlt');
  const encrypted = typeof account.encrypted === 'string' ? account.encrypted : '';
  const iv = typeof account.iv === 'string' ? account.iv : '';
  if (algo === 'pass:6k') {
    // A brain wallet has neither; one of the two alone means a damaged file.
    if ((encrypted === '') !== (iv === '')) throw new Error('invalid_wlt');
  } else if (encrypted === '' || iv === '') {
    throw new Error('invalid_wlt');
  }
  if (encrypted !== '') {
    try { fromHex(encrypted); fromHex(iv); } catch { throw new Error('invalid_wlt'); }
  }
  return { name: wallet.name, address: normalizeNemAddress(address), networkByte, algo, encrypted, iv };
}

/** Opens a parsed .wlt with its password. Throws 'wrong_password' when the password does not give the file's own address. */
export function openWlt(wlt: ParsedWlt, password: string): WltAccount {
  if (password === '') throw new Error('wrong_password');
  let privateKey: string;
  try {
    if (wlt.algo === 'pass:6k' && wlt.encrypted === '') {
      privateKey = toHex(derivePassSha(password, 6000));
    } else {
      // A wrong password usually breaks the padding (throws); when it does not, the address check below catches it.
      privateKey = toHex(cbc(derivePassSha(password, 20), fromHex(wlt.iv)).decrypt(fromHex(wlt.encrypted)));
    }
    // nem-sdk allows a leading "00" byte in front of the 32 key bytes.
    if (privateKey.length === 66 && privateKey.startsWith('00')) privateKey = privateKey.slice(2);
    const pair = nemKeyPairFromPrivateKey(privateKey);
    if (nemAddressFromPublicKey(pair.publicKey, wlt.networkByte) !== wlt.address) throw new Error('wrong_password');
    return { name: wlt.name, address: wlt.address, networkByte: wlt.networkByte, privateKey: pair.privateKey, publicKey: pair.publicKey };
  } catch {
    throw new Error('wrong_password');
  }
}

/** `<name>.wlt`, like the official wallet, with characters a file system rejects replaced. */
export function wltFilename(name: string): string {
  // Control characters are dropped, the characters a file system rejects become "_".
  const safe = Array.from(name.trim()).filter((c) => c.charCodeAt(0) >= 0x20).join('').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return `${safe === '' ? 'wallet' : safe}.wlt`;
}
