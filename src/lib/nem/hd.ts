// HD derivation for NEM: the same BIP39 phrase as Symbol, BIP44 path m/44'/43'/n'/0'/0' (the
// path NEM hardware / software wallets use), SLIP-0010 for Ed25519.
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '../symbol/crypto';
import { MnemonicHelper, slip10Ed25519 } from '../symbol/hd';
import { nemKeyPairFromPrivateKey } from './crypto';
import type { NemKeyPair } from './crypto';

export function nemPath(index = 0): string {
  return `m/44'/43'/${index}'/0'/0'`;
}

function nemAccountFromSeed(seed: Uint8Array, index: number): NemKeyPair {
  const raw = slip10Ed25519(seed, [44, 43, index, 0, 0]);
  // The SDK's NEM KeyPair reverses the private key, and BIP32 keys are meant to be used as they
  // are, so reverse here to cancel that (the same thing the SDK's own NEM BIP32 helper does).
  return nemKeyPairFromPrivateKey(bytesToHex(Uint8Array.from(raw).reverse()));
}

export function nemAccountFromMnemonic(phrase: string, index = 0): NemKeyPair {
  return nemAccountFromSeed(mnemonicToSeedSync(MnemonicHelper.normalize(phrase), ''), index);
}

/** Accounts 0..count-1 of a phrase (the seed is computed once). */
export function nemAccountsFromMnemonic(phrase: string, count: number): Array<NemKeyPair & { index: number }> {
  const seed = mnemonicToSeedSync(MnemonicHelper.normalize(phrase), '');
  const accounts: Array<NemKeyPair & { index: number }> = [];
  for (let index = 0; index < count; index += 1) accounts.push({ index, ...nemAccountFromSeed(seed, index) });
  return accounts;
}
