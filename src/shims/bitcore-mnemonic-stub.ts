// symbol-sdk's Bip32 class imports bitcore-mnemonic (a Node-oriented dependency). This app derives
// accounts itself (lib/symbol/hd.ts: BIP39 via @scure/bip39 + SLIP-0010, checked against the SDK's
// own Bip32 output), so the browser build replaces the package with this inert stub.
export default class Mnemonic {
  constructor() { throw new Error('bitcore-mnemonic is not available in the browser build'); }
  static fromSeed() { throw new Error('bitcore-mnemonic is not available in the browser build'); }
}
