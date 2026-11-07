// symbol-sdk imports its WebAssembly crypto from 'symbol-crypto-wasm-node', a Node-only package.
// In the browser build the SDK is forced onto its pure-JS Ed25519 implementation instead
// (see `define` in vite.config.ts), so this stub only has to satisfy the imports.
const unavailable = () => { throw new Error('symbol-crypto-wasm is not available in the browser build'); };
export const HashMode = { Sha2_512: 0, Sha3_512: 1 } as const;
export const crypto_private_sign = unavailable;
export const crypto_private_verify = unavailable;
export const crypto_sign_keypair = unavailable;
export const crypto_sign_verify = unavailable;
