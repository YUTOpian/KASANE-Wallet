// Keystore file: the account's private key + public key (+ address) as a small JSON file the person
// can keep, so the account can be restored without the recovery phrase. Built entirely on this
// device - nothing is uploaded and nothing is written to storage.
//
// Two flavours:
//   - encrypted (default, "kasane-keystore"): the private key is sealed with a password
//     (scrypt -> AES-256-GCM). The public key and address stay readable so the file can be told apart
//     without the password.
//   - plain ("kasane-keypair"): private and public key as readable hex. Whoever gets the file owns the
//     account - the screen warns about this.
import { NETWORKS } from './symbol/constants';
import type { SymbolNetwork } from './symbol/constants';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import type { ChainKey } from './chain';
import { addressFromPublicKey, addressNetworkByte, bytesToHex, hexToBytes, isSupportedNetworkByte, keyPairFromPrivateKey, normalizeAddress } from './symbol/crypto';
import { NEM_NETWORKS } from './nem/constants';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from './nem/crypto';

export const KEYSTORE_MIN_PASSWORD = 8;
export const KEYSTORE_FORMAT = 'kasane-keystore';
export const KEYPAIR_FORMAT = 'kasane-keypair';

// scrypt cost: 2^15 x r8 = 32 MiB, a good fit for phones. Reading refuses anything far above this so a
// hostile file cannot freeze the page.
const SCRYPT = { n: 1 << 15, r: 8, p: 1, dklen: 32 };
const SCRYPT_MAX_N = 1 << 20;

export interface KeystoreAccount {
  chain: ChainKey;
  network: SymbolNetwork;
  address: string;
  /** 64 hex chars. */
  privateKey: string;
  /** 64 hex chars. */
  publicKey: string;
}

interface KeystoreFile {
  format: typeof KEYSTORE_FORMAT;
  version: 1;
  chain: ChainKey;
  network: SymbolNetwork;
  address: string;
  publicKey: string;
  crypto: {
    cipher: 'aes-256-gcm';
    /** Cipher text followed by the 16-byte GCM tag, hex. */
    ciphertext: string;
    nonce: string;
    kdf: 'scrypt';
    kdfparams: { n: number; r: number; p: number; dklen: number; salt: string };
  };
  createdAt: string;
}

/** What a file we are about to validate might contain: every field optional, `format` unchecked. */
type RawKeystore = Partial<Omit<KeystoreFile, 'format' | 'crypto'>> & {
  format?: string;
  privateKey?: string;
  crypto?: KeystoreFile['crypto'];
};

interface KeypairFile {
  format: typeof KEYPAIR_FORMAT;
  version: 1;
  chain: ChainKey;
  network: SymbolNetwork;
  address: string;
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

const encoder = new TextEncoder();

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function isKey(hex: unknown): hex is string {
  return typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex);
}

// The chain and address are bound to the cipher text (GCM "additional data"), so editing them in the
// file makes the password check fail instead of silently pairing the key with another address.
function aad(chain: string, network: string, address: string): Uint8Array {
  return encoder.encode(`${KEYSTORE_FORMAT}|1|${chain}|${network}|${address}`);
}

async function deriveKey(password: string, salt: Uint8Array, p: { n: number; r: number; p: number; dklen: number }): Promise<Uint8Array> {
  return scryptAsync(encoder.encode(password.normalize('NFKC')), salt, { N: p.n, r: p.r, p: p.p, dkLen: p.dklen });
}

function assertAccount(account: KeystoreAccount): void {
  if (!isKey(account.privateKey) || !isKey(account.publicKey)) throw new Error('keystore: invalid key');
}

/** The JSON text of a password-encrypted keystore for the account. */
export async function buildKeystore(account: KeystoreAccount, password: string, now: Date = new Date()): Promise<string> {
  assertAccount(account);
  if (password.length < KEYSTORE_MIN_PASSWORD) throw new Error('keystore: password too short');
  const salt = random(16);
  const nonce = random(12);
  const key = await deriveKey(password, salt, SCRYPT);
  const sealed = gcm(key, nonce, aad(account.chain, account.network, account.address)).encrypt(hexToBytes(account.privateKey));
  const file: KeystoreFile = {
    format: KEYSTORE_FORMAT,
    version: 1,
    chain: account.chain,
    network: account.network,
    address: account.address,
    publicKey: account.publicKey.toUpperCase(),
    crypto: {
      cipher: 'aes-256-gcm',
      ciphertext: bytesToHex(sealed),
      nonce: bytesToHex(nonce),
      kdf: 'scrypt',
      kdfparams: { ...SCRYPT, salt: bytesToHex(salt) },
    },
    createdAt: now.toISOString(),
  };
  return JSON.stringify(file, null, 2);
}

/** The JSON text of an unencrypted key file (private + public key). */
export function buildPlainKeyFile(account: KeystoreAccount, now: Date = new Date()): string {
  assertAccount(account);
  const file: KeypairFile = {
    format: KEYPAIR_FORMAT,
    version: 1,
    chain: account.chain,
    network: account.network,
    address: account.address,
    privateKey: account.privateKey.toUpperCase(),
    publicKey: account.publicKey.toUpperCase(),
    createdAt: now.toISOString(),
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Re-derives the public key and the address from the private key and checks them against what the file says.
 * The file's own `publicKey` / `address` are never trusted: in a plain key file nothing protects them, and in an
 * encrypted one only the address is bound to the cipher text. Throws 'key_mismatch' when they disagree; returns the
 * derived (canonical) values.
 */
function verifiedAccount(chain: ChainKey, network: SymbolNetwork, address: string, publicKey: string, privateKey: string): KeystoreAccount {
  let derivedPublic: string;
  let derivedAddress: string;
  try {
    if (chain === 'nem') {
      if (network === 'mijin') throw new Error('invalid_keystore');
      derivedPublic = nemKeyPairFromPrivateKey(privateKey).publicKey;
      derivedAddress = nemAddressFromPublicKey(derivedPublic, NEM_NETWORKS[network].networkByte);
      if (normalizeNemAddress(address) !== normalizeNemAddress(derivedAddress)) throw new Error('key_mismatch');
    } else {
      derivedPublic = keyPairFromPrivateKey(privateKey).publicKey;
      // mijin v2 has no fixed network byte (it is read from the person's node): take it from the address, but only a known one.
      const networkByte = network === 'mijin' ? addressNetworkByte(address) : NETWORKS[network].networkByte;
      if (networkByte === null || !isSupportedNetworkByte(networkByte)) throw new Error('key_mismatch');
      derivedAddress = addressFromPublicKey(derivedPublic, networkByte);
      if (normalizeAddress(address) !== normalizeAddress(derivedAddress)) throw new Error('key_mismatch');
    }
  } catch (e) {
    if (e instanceof Error && (e.message === 'key_mismatch' || e.message === 'invalid_keystore')) throw e;
    throw new Error('invalid_keystore'); // malformed key / address the SDK cannot read
  }
  if (derivedPublic.toUpperCase() !== publicKey.toUpperCase()) throw new Error('key_mismatch');
  return { chain, network, address: derivedAddress, privateKey: privateKey.toUpperCase(), publicKey: derivedPublic.toUpperCase() };
}

/** Reads a keystore (either flavour). `password` is only needed for the encrypted one. Throws 'wrong_password' / 'invalid_keystore' / 'key_mismatch' (the keys and the address in the file do not belong together). */
export async function readKeystore(text: string, password = ''): Promise<KeystoreAccount> {
  // Not `Partial<KeystoreFile & KeypairFile>`: the two `format` literals conflict and the intersection collapses to `never`.
  let json: RawKeystore;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('invalid_keystore');
  }
  if (json === null || typeof json !== 'object') throw new Error('invalid_keystore');
  const { chain, network, address, publicKey } = json;
  if ((chain !== 'symbol' && chain !== 'nem') || (network !== 'mainnet' && network !== 'testnet' && !(network === 'mijin' && chain === 'symbol')) || typeof address !== 'string' || !isKey(publicKey)) {
    throw new Error('invalid_keystore');
  }
  if (json.format === KEYPAIR_FORMAT) {
    if (!isKey(json.privateKey)) throw new Error('invalid_keystore');
    return verifiedAccount(chain, network, address, publicKey, json.privateKey);
  }
  const c = json.crypto;
  if (json.format !== KEYSTORE_FORMAT || !c || c.cipher !== 'aes-256-gcm' || c.kdf !== 'scrypt' || !c.kdfparams) throw new Error('invalid_keystore');
  const p = c.kdfparams;
  if (![p.n, p.r, p.p, p.dklen].every((v) => Number.isInteger(v) && v > 0) || p.n > SCRYPT_MAX_N || p.n & (p.n - 1) || p.dklen !== 32 || p.r > 32 || p.p > 16) {
    throw new Error('invalid_keystore');
  }
  let sealed: Uint8Array;
  let nonce: Uint8Array;
  let salt: Uint8Array;
  try {
    sealed = hexToBytes(c.ciphertext);
    nonce = hexToBytes(c.nonce);
    salt = hexToBytes(p.salt);
  } catch {
    throw new Error('invalid_keystore');
  }
  if (nonce.length !== 12 || sealed.length !== 32 + 16) throw new Error('invalid_keystore');
  const key = await deriveKey(password, salt, p);
  let plain: Uint8Array;
  try {
    plain = gcm(key, nonce, aad(chain, network, address)).decrypt(sealed);
  } catch {
    throw new Error('wrong_password');
  }
  return verifiedAccount(chain, network, address, publicKey, bytesToHex(plain));
}

/** A file name that tells accounts apart without revealing more than the public address. */
export function keystoreFilename(account: Pick<KeystoreAccount, 'chain' | 'address'>, encrypted: boolean, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `kasane-${encrypted ? 'keystore' : 'keypair'}-${account.chain}-${account.address.slice(0, 6)}-${day}.json`;
}
