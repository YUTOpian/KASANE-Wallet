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
export function createCipheriv(): never { return unused('createCipheriv'); }
export function createDecipheriv(): never { return unused('createDecipheriv'); }

export default {
  createHmac, randomBytes, createCipheriv, createDecipheriv,
};
