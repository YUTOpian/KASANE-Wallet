// Key derivation for the chain currently selected: Symbol keys (m/44'/4343'/n'/0'/0') or NEM keys
// (m/44'/43'/n'/0'/0'). Phrase generation / validation is the same for both (BIP39).
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { MnemonicHelper, PrivateKeyHelper, PROFILE_ACCOUNT_COUNT, SYMBOL_TESTNET_COIN_TYPE } from './symbol/hd';
import { nemAccountFromMnemonic, nemAccountsFromMnemonic } from './nem/hd';
import { isValidNemPrivateKey, nemKeyPairFromPrivateKey } from './nem/crypto';

export interface Account {
  privateKey: string;
  publicKey: string;
}

export function accountFromMnemonic(phrase: string, index = 0, chain: ChainKey = getChain()): Account {
  return chain === 'nem' ? nemAccountFromMnemonic(phrase, index) : MnemonicHelper.accountFromMnemonic(phrase, index);
}

export function createNewAccount(chain: ChainKey = getChain()): { phrase: string; account: Account } {
  const phrase = MnemonicHelper.generate();
  return { phrase, account: accountFromMnemonic(phrase, 0, chain) };
}

export function isValidPrivateKeyInput(privateKey: string): boolean {
  return PrivateKeyHelper.isValid(privateKey);
}

export function accountFromPrivateKey(privateKey: string, chain: ChainKey = getChain()): Account {
  if (chain === 'nem') {
    const normalized = PrivateKeyHelper.normalize(privateKey);
    if (!isValidNemPrivateKey(normalized)) throw new Error('invalid_private_key');
    return nemKeyPairFromPrivateKey(normalized);
  }
  return PrivateKeyHelper.accountFromPrivateKey(privateKey);
}

export interface ProfileAccount extends Account {
  index: number;
  chain: ChainKey;
  /** Symbol のみ: 公式ウォレット互換のテストネット鍵（m/44'/1'/n'/0'/0'）。 */
  testnet?: Account;
}

/**
 * The accounts a new profile starts with: indices 0..N-1 of the recovery phrase on Symbol and the
 * same on NEM, so both chains work right away and switching chain never asks for the password.
 * Each Symbol account also carries its official-wallet-compatible testnet key (coin type 1), so a new profile shows
 * the same testnet addresses as the official Symbol wallet.
 */
export function profileAccounts(phrase: string, count: number = PROFILE_ACCOUNT_COUNT): ProfileAccount[] {
  const testnet = MnemonicHelper.accountsFromMnemonic(phrase, count, SYMBOL_TESTNET_COIN_TYPE);
  const symbol = MnemonicHelper.accountsFromMnemonic(phrase, count).map((a, i): ProfileAccount => ({
    ...a,
    chain: 'symbol',
    testnet: { publicKey: testnet[i].publicKey, privateKey: testnet[i].privateKey },
  }));
  const nem = nemAccountsFromMnemonic(phrase, count).map((a): ProfileAccount => ({ ...a, chain: 'nem' }));
  return [...symbol, ...nem];
}
