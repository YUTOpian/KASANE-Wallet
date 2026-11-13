// Stub for Node's built-in 'crypto' module, aliased in vite.config.ts.
//
// symbol-sdk statically imports this in a few internal files. Most of them this app still
// never exercises: Bip32.js (mnemonic->key derivation - see lib/symbolAccount.ts for why
// this app derives keys by hand instead) and Cipher.js/CipherHelpers.js (Symbol's
// encrypted-message support, which this app doesn't use - only plain-text transfer
// messages are supported, see lib/symbolChain.ts). None of the actual account/transaction
// code this app calls (symbol-sdk's symbol/ and facade/ modules) touches those at all.
//
// `randomBytes` is the one exception: CryptoTypes.js's `PrivateKey.random()` calls
// `crypto.randomBytes()`, and lib/symbolHarvest.ts's generateHarvestingKeyPairs() (used by
// the delegated-harvesting setup screen) calls exactly that, to create the throwaway
// remote/VRF key pairs handed to the harvesting node. Previously this was stubbed to throw
// unconditionally like the others below, on the (no-longer-true) assumption that this app
// only ever constructs PrivateKey from already-derived bytes - the effect in the browser
// was that tapping a node on the harvest setup screen silently (or, after error-handling
// was added, visibly) failed every time, since key generation crashed before the screen
// could move on. Implemented for real here using the Web Crypto API's
// `getRandomValues` (a browser standard, needs no Node polyfill or extra dependency) rather
// than pulling in crypto-browserify - see below for why that's avoided.
//
// Polyfilling the rest of this module properly (crypto-browserify) pulls in a large legacy
// dependency chain (cipher-base, asn1.js, browserify-sign, elliptic, ...) whose own
// top-level module code assumes further Node builtins (stream, vm) exist - when those are
// left unpolyfilled, that top-level code throws immediately at app startup (e.g.
// cipher-base's `inherits(CipherBase, require('stream').Transform)` throws when `stream`
// resolves to nothing), which is what crashed the app the first time before this stub was
// added. None of that dependency tree is needed for the codepaths this app actually runs,
// so the rest stays stubbed out at the source.
//
// AES-256-GCM is the other exception: symbol-sdk's MessageEncoder (Symbol encrypted transfer
// messages - the "encrypt message" option on the send screen) calls
// createCipheriv/createDecipheriv('aes-256-gcm') synchronously through Cipher.js. It is
// implemented below with @noble/ciphers (small, pure JS, synchronous - Web Crypto's AES is
// async-only and cannot back the SDK's sync calls). Only the minimal surface the SDK uses is
// provided (single update(), final(), getAuthTag()/setAuthTag()); any other algorithm still throws.
import { gcm } from '@noble/ciphers/aes.js';

function unused(name: string): never {
  throw new Error(`Node's crypto module is stubbed out in this build; ${name} should never be called (see src/shims/crypto-stub.ts).`);
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    return unused('randomBytes (Web Crypto API unavailable in this environment)');
  }
  webCrypto.getRandomValues(bytes);
  return bytes;
}

export function createHmac(): never { return unused('createHmac'); }

const GCM_TAG_SIZE = 16;
const EMPTY = new Uint8Array(0);
// Same message Node's decipher.final() throws on a bad tag; symbol-sdk's tryDecode matches on it
// to tell "not for this key" apart from real errors.
const AUTH_FAIL = 'Unsupported state or unable to authenticate data';

function toU8(data: ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : Uint8Array.from(data);
}

function requireGcm(fn: string, algorithm: string, key: ArrayLike<number>, iv: ArrayLike<number>): { key: Uint8Array; iv: Uint8Array } {
  if (algorithm !== 'aes-256-gcm') return unused(`${fn}(${algorithm})`);
  const k = toU8(key);
  if (k.length !== 32) throw new Error('Invalid key length');
  return { key: k, iv: toU8(iv) };
}

export function createCipheriv(algorithm: string, key: ArrayLike<number>, iv: ArrayLike<number>) {
  const params = requireGcm('createCipheriv', algorithm, key, iv);
  let tag: Uint8Array | null = null;
  return {
    update(data: ArrayLike<number>): Uint8Array {
      if (tag) throw new Error('crypto-stub: only a single update() is supported for aes-256-gcm');
      const sealed = gcm(params.key, params.iv).encrypt(toU8(data)); // ciphertext || 16-byte tag
      tag = sealed.slice(sealed.length - GCM_TAG_SIZE);
      return sealed.slice(0, sealed.length - GCM_TAG_SIZE);
    },
    final(): Uint8Array {
      return EMPTY; // GCM has no padding
    },
    getAuthTag(): Uint8Array {
      if (!tag) throw new Error('Invalid state for getAuthTag');
      return tag;
    },
  };
}

export function createDecipheriv(algorithm: string, key: ArrayLike<number>, iv: ArrayLike<number>) {
  const params = requireGcm('createDecipheriv', algorithm, key, iv);
  let tag: Uint8Array | null = null;
  let clear: Uint8Array | null = null;
  return {
    setAuthTag(t: ArrayLike<number>): void {
      const u = toU8(t);
      // Buffer.from(arrayBuffer, offset) in symbol-sdk yields a view to the end of the buffer.
      tag = u.slice(0, GCM_TAG_SIZE);
    },
    update(data: ArrayLike<number>): Uint8Array {
      if (!tag) throw new Error(AUTH_FAIL);
      if (clear) throw new Error('crypto-stub: only a single update() is supported for aes-256-gcm');
      const d = toU8(data);
      const sealed = new Uint8Array(d.length + GCM_TAG_SIZE);
      sealed.set(d, 0);
      sealed.set(tag, d.length);
      try {
        clear = gcm(params.key, params.iv).decrypt(sealed);
      } catch {
        throw new Error(AUTH_FAIL);
      }
      return clear;
    },
    final(): Uint8Array {
      return EMPTY;
    },
  };
}

export default {
  createHmac, randomBytes, createCipheriv, createDecipheriv,
};
