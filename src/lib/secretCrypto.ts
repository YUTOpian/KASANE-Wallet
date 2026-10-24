// PIN-based encryption for anything this app keeps at rest under a password: Wallet.encryptedSecret,
// encryptedMnemonic, encryptedTestnetSecret, encryptedHarvestKeys (see wallet.ts). Split out of
// storage.ts so this module can be read, tested and reasoned about on its own, with no dependency on
// the Wallet/Wallets data model.
//
// The PIN the person types (4-6 raw digits) is never used directly as an AES key/passphrase.
// It's first stretched through PBKDF2-HMAC-SHA256 with a random per-secret salt and a high
// iteration count, so an attacker who extracts the encrypted blob from IndexedDB still has
// to brute-force the PIN through 210,000 PBKDF2 rounds per guess rather than a single cheap
// AES decrypt. This uses the browser's native Web Crypto API (SubtleCrypto) rather than
// crypto-js's pure-JS PBKDF2: crypto-js took ~2 seconds for one derivation at this iteration
// count in testing (would mean a multi-second freeze on every PIN unlock/send/backup), while
// SubtleCrypto's native implementation does the same work in the low tens of milliseconds.
// AES-GCM (authenticated encryption) also replaces AES-CBC here, so a wrong PIN fails the
// auth tag immediately instead of relying on "did this decrypt to plausible-looking UTF-8?"
// as a proxy.
//
// New format (written by every encryptString call from now on):
//   "v2:" + base64(salt) + ":" + base64(iv) + ":" + base64(ciphertext+authTag)
// Old format (still readable, never written): CryptoJS.AES.encrypt(message, pin).toString()
//   - i.e. CryptoJS's own passphrase mode (EVP_BytesToKey/MD5, embedded salt, AES-CBC).
//   Kept decryptable so wallets created before this change don't lose their secret/
//   mnemonic; they're transparently upgraded to the new format the next time
//   encryptSecret() runs (Settings > PIN変更 flow), since that always re-encrypts through
//   encryptString().
//
// Format v3 (written from now on): the password is stretched with scrypt (memory-hard, so GPU / ASIC
// guessing is far more expensive than with PBKDF2) and the result opens AES-256-GCM:
//   "v3:" + log2(N) + "." + r + "." + p + ":" + base64(salt) + ":" + base64(iv) + ":" + base64(ciphertext+authTag)
// The cost parameters are stored in the value, so they can be raised later without breaking old values.
// v2 (PBKDF2-SHA256 210,000 rounds) and the CryptoJS form stay readable only so they can be moved to v3
// (WalletsHelper.deleteLegacyProfiles removes them); they are never written.
import * as CryptoJS from 'crypto-js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

export const V2_PREFIX = 'v2:';
export const V3_PREFIX = 'v3:';

/** 空でなく、現在の形式（v3:）でもない暗号文 = 更新が要る旧形式（v2 の PBKDF2、または MD5 ベースの鍵導出1回だけの CryptoJS 形式）。 */
export function isLegacyCipher(encrypted: string): boolean {
  return encrypted.length > 0 && !encrypted.startsWith(V3_PREFIX);
}

// scrypt cost for new values: N = 2^16, r = 8, p = 1 (64 MiB, roughly a second on a phone). Raise LOG2_N here
// to make guessing dearer; values already stored keep the cost they were written with.
const SCRYPT_LOG2_N = 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// A stored value can name its own cost; refuse anything far above what we write so a hostile value cannot freeze the page.
const SCRYPT_MAX_LOG2_N = 20;
const PBKDF2_ITERATIONS = 210000; // v2 only (read, never written). OWASP asks 600,000 for SHA-256, which is why v3 uses scrypt.
const SALT_BYTES = 16;
const IV_BYTES = 12; // recommended nonce length for AES-GCM

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesGcmKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function deriveScryptAesKey(password: string, salt: Uint8Array, log2N: number, r: number, p: number): Promise<CryptoKey> {
  const raw = await scryptAsync(new TextEncoder().encode(password), salt, { N: 2 ** log2N, r, p, dkLen: 32 });
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function encryptString(message: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveScryptAesKey(password, salt, SCRYPT_LOG2_N, SCRYPT_R, SCRYPT_P);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(message));
  return `${V3_PREFIX}${SCRYPT_LOG2_N}.${SCRYPT_R}.${SCRYPT_P}:${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptString(encrypted: string, password: string): Promise<string | null> {
  try {
    if (encrypted.startsWith(V3_PREFIX)) {
      const [params, saltB64, ivB64, cipherB64] = encrypted.slice(V3_PREFIX.length).split(':');
      const [log2N, r, p] = (params ?? '').split('.').map(Number);
      if (!saltB64 || !ivB64 || !cipherB64 || !Number.isInteger(log2N) || !Number.isInteger(r) || !Number.isInteger(p)) {
        return null;
      }
      if (log2N < 10 || log2N > SCRYPT_MAX_LOG2_N || r < 1 || r > 16 || p < 1 || p > 4) {
        return null;
      }
      const key = await deriveScryptAesKey(password, base64ToBytes(saltB64), log2N, r, p);
      // A wrong password (or tampered value) fails the GCM tag and throws - caught below, so the result is null.
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivB64) as BufferSource }, key, base64ToBytes(cipherB64) as BufferSource);
      return new TextDecoder().decode(plainBuf);
    }
    if (encrypted.startsWith(V2_PREFIX)) {
      const [saltB64, ivB64, cipherB64] = encrypted.slice(V2_PREFIX.length).split(':');
      if (!saltB64 || !ivB64 || !cipherB64) {
        return null;
      }
      const salt = base64ToBytes(saltB64);
      const iv = base64ToBytes(ivB64);
      const key = await deriveAesGcmKey(password, salt);
      // AES-GCM throws if the auth tag doesn't match (wrong password or tampered data) -
      // caught below, so a wrong PIN reliably yields null rather than garbage plaintext.
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, base64ToBytes(cipherB64) as BufferSource);
      return new TextDecoder().decode(plainBuf);
    }

    // Legacy format from before this change - see block comment above.
    const decrypted = CryptoJS.AES.decrypt(encrypted, password);
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
