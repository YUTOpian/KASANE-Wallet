// 事前オプトイン（NEM Wallet 2.5.0 の「Symbolオプトイン」）のデモ用：オプトインの移行先アカウントの導出。
//
// 当時の NEM Wallet は、オプトイン画面で「Symbol アカウント」を新しく作り、そのアドレスとニーモニックを見せていた
// （symbol-hd-wallets の Wallet.getChildAccount で m/44'/4343'/0'/0'/0'、VRF は m/44'/4343'/0'/1'/0'）。
// このデモも同じ：ニーモニックはオプトイン画面の中で新しく作る（このプロファイルのニーモニックは開かない）。
// アドレスは BIP32（ed25519 は SLIP-0010 のハードン導出）で、下のパスから導く。
// いま開いているアカウントのインデックスや、選んでいるチェーン（Symbol / NEM）には左右されない。
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { MnemonicHelper, slip10Ed25519 } from '../symbol/hd';
import { addressFromPublicKey, bytesToHex, keyPairFromPrivateKey, prettyAddress } from '../symbol/crypto';

/** オプトイン先の Symbol アカウント（当時のオプトイン機能の DEFAULT_ACCOUNT_PATH）。 */
export const OPTIN_ACCOUNT_PATH = "m/44'/4343'/0'/0'/0'";
/** VRF キー用のアカウント（当時の VRF_ACCOUNT_PATH）。 */
export const OPTIN_VRF_PATH = "m/44'/4343'/0'/1'/0'";

/**
 * BIP32 のパス文字列（例 "m/44'/4343'/0'/0'/0'"）を、ハードンの印を除いた番号の並びにする。
 * ed25519 の BIP32（SLIP-0010）はハードン導出だけなので、すべての段に ' が付いていないものは受け付けない。
 */
export function parseBip32Path(path: string): number[] {
  const parts = path.trim().split('/');
  if (parts[0] !== 'm' || parts.length < 2) throw new Error(`invalid BIP32 path: ${path}`);
  return parts.slice(1).map((part) => {
    const m = /^(\d+)'$/.exec(part);
    if (!m) throw new Error(`invalid BIP32 path (every level must be hardened): ${path}`);
    const index = Number(m[1]);
    if (!Number.isSafeInteger(index) || index >= 0x80000000) throw new Error(`invalid BIP32 path index: ${path}`);
    return index;
  });
}

const ACCOUNT_PATH = parseBip32Path(OPTIN_ACCOUNT_PATH);
const VRF_PATH = parseBip32Path(OPTIN_VRF_PATH);

/** 画面でカーソル（指）を動かして集めた値。ここでは座標と時刻を並べた数列として受け取る。 */
export type EntropySamples = ArrayLike<number>;

/**
 * オプトイン用の新しいニーモニック（24 語・256 ビット）を作る。
 * 元になるのは端末の乱数（32 バイト）で、カーソルの動きは**それに混ぜるだけ**。
 * 動きが少なくても、偏っていても、乱数より弱くはならない。
 */
export function createOptinMnemonic(samples: EntropySamples = []): string {
  const random = randomBytes(32);
  const moves = new Uint8Array(samples.length * 4);
  const view = new DataView(moves.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt32(i * 4, Math.round(samples[i] * 1000) | 0, false);
  const input = new Uint8Array(random.length + moves.length);
  input.set(random, 0);
  input.set(moves, random.length);
  return entropyToMnemonic(sha256(input), wordlist);
}

export interface OptinDestination {
  mnemonic: string;
  /** ハイフン区切りのアドレス（当時の画面と同じ表示）。 */
  address: string;
  publicKey: string;
  privateKey: string;
  vrfAddress: string;
  vrfPublicKey: string;
  vrfPrivateKey: string;
}

/**
 * ニーモニックから、BIP32 でオプトイン先のアカウントと VRF アカウントを作る。
 * `networkByte` は Symbol のネットワークバイト（メインネット 0x68 / テストネット 0x98）。
 * 当時も NEM のネットワークに合わせて Symbol のネットワークを決めていた。
 */
export function deriveOptinDestination(phrase: string, networkByte: number): OptinDestination {
  const mnemonic = MnemonicHelper.normalize(phrase);
  const seed = mnemonicToSeedSync(mnemonic, '');
  const account = keyPairFromPrivateKey(bytesToHex(slip10Ed25519(seed, ACCOUNT_PATH)));
  const vrf = keyPairFromPrivateKey(bytesToHex(slip10Ed25519(seed, VRF_PATH)));
  return {
    mnemonic,
    address: prettyAddress(addressFromPublicKey(account.publicKey, networkByte)),
    publicKey: account.publicKey,
    privateKey: account.privateKey,
    vrfAddress: prettyAddress(addressFromPublicKey(vrf.publicKey, networkByte)),
    vrfPublicKey: vrf.publicKey,
    vrfPrivateKey: vrf.privateKey,
  };
}

/** 手数料（XEM）。当時の calculateFee と同じ：基本 0.2、ネームスペース 1 つにつき 0.85、VRF キーで 0.85。 */
export function optinFee(namespaceCount: number, includeVrf: boolean): number {
  return (200000 + namespaceCount * 850000 + (includeVrf ? 850000 : 0)) / 1_000_000;
}
