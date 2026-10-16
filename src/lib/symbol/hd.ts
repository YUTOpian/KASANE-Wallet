// BIP39 mnemonic + SLIP-0010 (ed25519) derivation as used by Symbol wallets.
//   path: m/44'/4343'/<account>'/0'/0'   (4343 = Symbol's registered SLIP-44 coin type)
//   公式Symbolウォレットのテストネットは、同じ形でコイン種別だけ 1 を使う（m/44'/1'/<account>'/0'/0'）。
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, keyPairFromPrivateKey } from './crypto';
import type { SymbolKeyPair } from './crypto';

const HARDENED = 0x80000000;

export function slip10Ed25519(seed: Uint8Array, path: number[]): Uint8Array {
  let digest = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = digest.slice(0, 32);
  let chain = digest.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0, false);
    digest = hmac(sha512, chain, data);
    key = digest.slice(0, 32);
    chain = digest.slice(32);
  }
  return key;
}

/** Symbol メインネットの BIP44 コイン種別。 */
export const SYMBOL_MAINNET_COIN_TYPE = 4343;
/** 公式Symbolウォレットがテストネットで使うコイン種別（SLIP-44 のテストネット共通値）。 */
export const SYMBOL_TESTNET_COIN_TYPE = 1;

export function symbolPath(index = 0, coinType: number = SYMBOL_MAINNET_COIN_TYPE): string {
  return `m/44'/${coinType}'/${index}'/0'/0'`;
}

// 1つのプロファイル（=1つのニーモニック）を作るときに、あらかじめ導出しておくアカウント数
// （インデックス 0〜N-1）。ウォレット切り替え画面は、パスワードを求めずにこの中から選ぶだけ。
export const PROFILE_ACCOUNT_COUNT = 10;

export class MnemonicHelper {
  /** New random 24-word phrase (Symbol's official wallets use 24 words / 256 bits). */
  static generate(): string {
    return generateMnemonic(wordlist, 256);
  }

  static normalize(phrase: string): string {
    return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  static isValid(phrase: string): boolean {
    return validateMnemonic(MnemonicHelper.normalize(phrase), wordlist);
  }

  static isValidWord(word: string): boolean {
    const w = word.trim().toLowerCase();
    return w.length === 0 || wordlist.includes(w);
  }

  static accountFromMnemonic(phrase: string, index = 0, coinType: number = SYMBOL_MAINNET_COIN_TYPE): SymbolKeyPair {
    const seed = mnemonicToSeedSync(MnemonicHelper.normalize(phrase), '');
    const priv = slip10Ed25519(seed, [44, coinType, index, 0, 0]);
    return keyPairFromPrivateKey(bytesToHex(priv));
  }

  /** Accounts 0..count-1 of one phrase (the seed is only stretched once, not once per index). */
  static accountsFromMnemonic(phrase: string, count: number, coinType: number = SYMBOL_MAINNET_COIN_TYPE): { index: number; publicKey: string; privateKey: string }[] {
    const seed = mnemonicToSeedSync(MnemonicHelper.normalize(phrase), '');
    const accounts: { index: number; publicKey: string; privateKey: string }[] = [];
    for (let index = 0; index < count; index++) {
      const account = keyPairFromPrivateKey(bytesToHex(slip10Ed25519(seed, [44, coinType, index, 0, 0])));
      accounts.push({ index, publicKey: account.publicKey, privateKey: account.privateKey });
    }
    return accounts;
  }

  static createNew(): { phrase: string; account: SymbolKeyPair } {
    const phrase = MnemonicHelper.generate();
    return { phrase, account: MnemonicHelper.accountFromMnemonic(phrase, 0) };
  }
}

export class PrivateKeyHelper {
  static normalize(privateKey: string): string {
    return privateKey.trim().replace(/^0x/i, '').toUpperCase();
  }

  static isValid(privateKey: string): boolean {
    return /^[0-9A-F]{64}$/.test(PrivateKeyHelper.normalize(privateKey));
  }

  static accountFromPrivateKey(privateKey: string): SymbolKeyPair {
    return keyPairFromPrivateKey(PrivateKeyHelper.normalize(privateKey));
  }
}
