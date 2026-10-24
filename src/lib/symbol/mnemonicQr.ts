// Password-encrypted mnemonic QR code, in the envelope the official Symbol wallets use (Symbol QR v3, type 5):
//   { "v": 3, "type": 5, "network_id": 104, "chain_id": "<generation hash>", "data": { "ciphertext": "...", "salt": "..." } }
// (the paper wallet's unencrypted QR holds { "plainMnemonic": "..." } in the same envelope - read here too).
//
// The cipher is AES-256-CBC with a key stretched from the password by PBKDF2 (CryptoJS, like the official library).
// The exact parameters of the official library (hash, iteration count, how the IV travels inside `ciphertext`) are
// kept as data in VARIANTS below. Making a QR uses VARIANTS[0]; reading tries every variant and accepts the first
// one whose result is a valid BIP39 phrase, so a wrong password or a wrong guess can never produce a bogus phrase.
import * as CryptoJS from 'crypto-js';
import { getNetworkConfig } from './network';
import { MnemonicHelper } from './hd';

export const MNEMONIC_QR_TYPE = 5;
export const MNEMONIC_QR_MIN_PASSWORD = 8;

export type MnemonicQr = { encrypted: false; mnemonic: string } | { encrypted: true; ciphertext: string; salt: string };

interface Variant {
  kdf: 'pbkdf2' | 'openssl';
  hasher?: 'SHA1' | 'SHA256' | 'SHA512';
  iterations?: number;
  saltAs?: 'hex' | 'utf8';
  /** hex_iv_base64: 32 hex chars of IV, then the base64 cipher text. base64_iv_body: base64 of IV (16 bytes) + cipher text. */
  layout?: 'hex_iv_base64' | 'base64_iv_body';
}

const VARIANTS: Variant[] = [
  { kdf: 'pbkdf2', hasher: 'SHA1', iterations: 1000, saltAs: 'hex', layout: 'hex_iv_base64' },
  { kdf: 'pbkdf2', hasher: 'SHA1', iterations: 1000, saltAs: 'hex', layout: 'base64_iv_body' },
  ...(['SHA1', 'SHA256', 'SHA512'] as const).flatMap((hasher) => [100, 1000, 5000, 10000].flatMap((iterations) =>
    (['hex', 'utf8'] as const).flatMap((saltAs) => (['hex_iv_base64', 'base64_iv_body'] as const).map((layout) => ({ kdf: 'pbkdf2' as const, hasher, iterations, saltAs, layout }))))),
  { kdf: 'openssl' },
];

const HASHERS = { SHA1: CryptoJS.algo.SHA1, SHA256: CryptoJS.algo.SHA256, SHA512: CryptoJS.algo.SHA512 };
const AES_CFG = { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 };

function randomWords(bytes: number): CryptoJS.lib.WordArray {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return CryptoJS.enc.Hex.parse(Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(''));
}

function deriveKey(password: string, salt: string, v: Variant): CryptoJS.lib.WordArray {
  const saltWords = v.saltAs === 'utf8' ? CryptoJS.enc.Utf8.parse(salt) : CryptoJS.enc.Hex.parse(salt);
  return CryptoJS.PBKDF2(password, saltWords, { keySize: 256 / 32, iterations: v.iterations, hasher: HASHERS[v.hasher ?? 'SHA1'] });
}

/** Encrypts the phrase with the password: what goes into `data.ciphertext` and `data.salt`. */
export function encryptMnemonic(mnemonic: string, password: string): { ciphertext: string; salt: string } {
  const v = VARIANTS[0];
  const salt = randomWords(16).toString(); // 32 hex chars
  const iv = randomWords(16);
  const body = CryptoJS.AES.encrypt(MnemonicHelper.normalize(mnemonic), deriveKey(password, salt, v), { iv, ...AES_CFG }).toString(); // base64
  return { ciphertext: iv.toString() + body, salt };
}

function tryVariant(ciphertext: string, salt: string, password: string, v: Variant): string | null {
  try {
    let plain: string;
    if (v.kdf === 'openssl') {
      plain = CryptoJS.AES.decrypt(ciphertext, password).toString(CryptoJS.enc.Utf8);
    } else {
      let iv: CryptoJS.lib.WordArray;
      let body: CryptoJS.lib.WordArray;
      if (v.layout === 'hex_iv_base64') {
        if (!/^[0-9a-fA-F]{32}/.test(ciphertext)) return null;
        iv = CryptoJS.enc.Hex.parse(ciphertext.slice(0, 32));
        body = CryptoJS.enc.Base64.parse(ciphertext.slice(32));
      } else {
        const all = CryptoJS.enc.Base64.parse(ciphertext);
        if (all.sigBytes <= 16) return null;
        iv = CryptoJS.lib.WordArray.create(all.words.slice(0, 4), 16);
        body = CryptoJS.lib.WordArray.create(all.words.slice(4), all.sigBytes - 16);
      }
      if (body.sigBytes === 0 || body.sigBytes % 16 !== 0) return null;
      const params = CryptoJS.lib.CipherParams.create({ ciphertext: body });
      plain = CryptoJS.AES.decrypt(params, deriveKey(password, salt, v), { iv, ...AES_CFG }).toString(CryptoJS.enc.Utf8);
    }
    return plain !== '' && MnemonicHelper.isValid(plain) ? MnemonicHelper.normalize(plain) : null;
  } catch {
    return null; // malformed UTF-8 / padding: the key was wrong
  }
}

/** The phrase inside an encrypted mnemonic QR, or null when the password is wrong (or the QR is not understood). */
export async function decryptMnemonic(qr: { ciphertext: string; salt: string }, password: string): Promise<string | null> {
  for (let i = 0; i < VARIANTS.length; i += 1) {
    const phrase = tryVariant(qr.ciphertext, qr.salt, password, VARIANTS[i]);
    if (phrase !== null) return phrase;
    // Give the screen a turn now and then: a wrong password walks the whole list.
    if (i % 4 === 3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

/** The text of an encrypted mnemonic QR for this phrase. */
export function buildMnemonicQr(mnemonic: string, password: string): string {
  const cfg = getNetworkConfig();
  return JSON.stringify({ v: 3, type: MNEMONIC_QR_TYPE, network_id: cfg.networkByte, chain_id: cfg.generationHash, data: encryptMnemonic(mnemonic, password) });
}

/** Reads a type-5 mnemonic QR (encrypted, or the paper wallet's plain one). Anything else: null. */
export function parseMnemonicQr(text: string): MnemonicQr | null {
  try {
    const json = JSON.parse(text.trim()) as { type?: unknown; data?: Record<string, unknown> };
    if (json === null || typeof json !== 'object' || json.type !== MNEMONIC_QR_TYPE || typeof json.data !== 'object' || json.data === null) return null;
    const { ciphertext, salt, plainMnemonic } = json.data;
    if (typeof ciphertext === 'string' && typeof salt === 'string' && ciphertext !== '' && salt !== '') return { encrypted: true, ciphertext, salt };
    if (typeof plainMnemonic === 'string' && plainMnemonic.trim() !== '') return { encrypted: false, mnemonic: plainMnemonic };
    return null;
  } catch {
    return null;
  }
}
