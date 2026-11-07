// NEM (NIS1) delegated harvesting of a MULTISIG account, following the official NEM Nano Wallet's
// "Manage delegated account of multisignature accounts" screen.
//
// A multisig account cannot sign, so a cosigner acts for it:
//  1. the cosigner derives the multisig account's remote (delegated) account - see
//     deriveNemMultisigRemoteAccount - and sends an importance transfer in the name of the multisig
//     account (a multisig transaction: the cosigner signs the wrapper, the multisig account pays the
//     inner 0.15 XEM). Once enough cosigners have signed, it takes effect after about 6 hours.
//  2. the same cosigner then sends the remote account's private key to a node (POST /account/unlock),
//     exactly as for a normal account (startNemHarvesting / stopNemHarvesting in ./harvest).
// Only the cosigner whose derived remote account is the active one can start / stop harvesting: the
// remote key depends on the cosigner's own private key.
import { sha256 } from '@noble/hashes/sha2.js';
import { nodeRequest } from './api';
import { NEM_MIN_HARVEST_VESTED } from './constants';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress, signNemData } from './crypto';
import type { NemRemoteAccount, NemRemoteHarvestStatus, NemRemoteStatus } from './harvest';
import { getNemNetworkConfig } from './network';
import { NEM_IMPORTANCE_TRANSFER_FEE, NEM_MULTISIG_WRAPPER_FEE } from './tx';

/**
 * The remote account of `multisigAddress` for the cosigner who owns `cosignerPrivateKey`. This is the
 * derivation the official NEM Nano Wallet uses, so a remote account activated there is found here too
 * (and the other way round): the remote private key is the last 32 bytes (the S half) of the
 * cosigner's NEM (Ed25519 / Keccak-512) signature over SHA-256 of the multisig address text.
 * Deterministic, so it never has to be stored: it is rebuilt after the password whenever it is needed.
 */
export function deriveNemMultisigRemoteAccount(cosignerPrivateKey: string, multisigAddress: string, networkByte: number): NemRemoteAccount {
  const digest = sha256(new TextEncoder().encode(normalizeNemAddress(multisigAddress)));
  const signature = signNemData(cosignerPrivateKey.trim(), digest); // 128 hex chars: R (32 bytes) then S (32 bytes)
  const pair = nemKeyPairFromPrivateKey(signature.slice(64));
  return { ...pair, address: nemAddressFromPublicKey(pair.publicKey, networkByte) };
}

/**
 * The address of the account `remoteAddress` harvests for (NIS1 /account/get/forwarded), or null when the
 * node does not tell. NIS1 answers with the account itself when `remoteAddress` is not a remote account,
 * so compare the result with the multisig account's address.
 */
export async function fetchNemForwardedAddress(remoteAddress: string): Promise<string | null> {
  try {
    const res = await nodeRequest<{ account?: { address?: string } }>(`/account/get/forwarded?address=${normalizeNemAddress(remoteAddress)}`);
    return res.account?.address ? normalizeNemAddress(res.account.address) : null;
  } catch {
    return null;
  }
}

/** Whether the remote account that was derived for this wallet is the active remote account of `multisigAddress`. null = could not be told. */
export async function fetchNemIsActivator(remoteAddress: string, multisigAddress: string): Promise<boolean | null> {
  const forwarded = await fetchNemForwardedAddress(remoteAddress);
  return forwarded === null ? null : forwarded === normalizeNemAddress(multisigAddress);
}

// --- what the screen may offer ------------------------------------------------------------------
export interface NemMultisigHarvestInput {
  remoteStatus: NemRemoteStatus; // of the multisig account (NIS1 meta.remoteStatus)
  vestedBalance: bigint | null; // of the multisig account, micro-XEM (null = not loaded)
  hasPublicKey: boolean; // the multisig account has made a transaction, so the network knows its public key
  isActivator: boolean | null; // true = this wallet's derived remote account is the active one; null = unknown
  nodeStatus: NemRemoteHarvestStatus; // of that remote account on the chosen node
  nodeValid: boolean; // an HTTPS node is chosen
  slotsFull: boolean; // the chosen node has no free delegated-harvesting slot
  ownBalance: bigint | null; // of this wallet (it pays the 0.15 XEM wrapper)
  multisigBalance: bigint | null; // of the multisig account (it pays the 0.15 XEM importance transfer)
}

export interface NemMultisigHarvestPlan {
  vestedShort: boolean;
  ownShort: boolean;
  multisigShort: boolean;
  canActivate: boolean;
  canDeactivate: boolean;
  canStart: boolean;
  canStop: boolean;
}

export function planNemMultisigHarvest(i: NemMultisigHarvestInput): NemMultisigHarvestPlan {
  const vestedShort = i.vestedBalance !== null && i.vestedBalance < NEM_MIN_HARVEST_VESTED;
  const active = i.remoteStatus === 'ACTIVE';
  const mine = i.isActivator === true;
  return {
    vestedShort,
    ownShort: i.ownBalance !== null && i.ownBalance < NEM_MULTISIG_WRAPPER_FEE,
    multisigShort: i.multisigBalance !== null && i.multisigBalance < NEM_IMPORTANCE_TRANSFER_FEE,
    // Only an account that has no remote account yet can be given one, and only with enough vested XEM.
    canActivate: i.hasPublicKey && i.remoteStatus === 'INACTIVE' && !vestedShort,
    // Deactivating names the remote account in the transaction: only the cosigner whose remote account it is can do it,
    // and only once the node has stopped harvesting for it.
    canDeactivate: i.hasPublicKey && active && mine && i.nodeStatus !== 'UNLOCKED',
    canStart: active && mine && !vestedShort && i.nodeValid && i.nodeStatus !== 'UNLOCKED' && !i.slotsFull,
    // Stopping needs the remote key only, so it is always offered for what the node reports as running.
    canStop: i.nodeValid && i.nodeStatus === 'UNLOCKED',
  };
}

// --- a remote account chosen by its public key (NanoWallet's 「カスタムされた公開鍵を使用」) --------------
// Instead of the remote account KASANE derives, the cosigner names one by its PUBLIC key: to link a remote account
// prepared elsewhere, or - the usual reason - to deactivate the remote account another cosigner activated (that cosigner
// reads its public key on the 「委任鍵」 tab). KASANE never holds the private key of such an account, so it cannot start or
// stop harvesting for it.
export type NemCustomRemoteIssue = 'format' | 'multisig_itself';

export interface NemCustomRemoteCheck {
  key: string; // the entered key, trimmed and upper-cased
  valid: boolean;
  issue: NemCustomRemoteIssue | null; // null while nothing is entered, or when valid
}

export function checkNemCustomRemoteKey(input: string, multisigPublicKey: string | null): NemCustomRemoteCheck {
  const key = input.trim().toUpperCase();
  if (key === '') return { key, valid: false, issue: null };
  if (!/^[0-9A-F]{64}$/.test(key)) return { key, valid: false, issue: 'format' };
  // The multisig account cannot be its own remote account.
  if (multisigPublicKey && key === multisigPublicKey.toUpperCase()) return { key, valid: false, issue: 'multisig_itself' };
  return { key, valid: true, issue: null };
}

export interface NemCustomRemoteInput {
  remoteStatus: NemRemoteStatus;
  vestedBalance: bigint | null;
  hasPublicKey: boolean;
  keyValid: boolean; // checkNemCustomRemoteKey(...).valid
  isActiveRemote: boolean | null; // true = NIS says this key's account is the active remote account of the multisig account
}

/** What may be sent with a named remote account: link one to an account that has none, or unlink the one that is active. */
export function planNemCustomRemote(i: NemCustomRemoteInput): { canActivate: boolean; canDeactivate: boolean } {
  const vestedShort = i.vestedBalance !== null && i.vestedBalance < NEM_MIN_HARVEST_VESTED;
  return {
    canActivate: i.hasPublicKey && i.keyValid && i.remoteStatus === 'INACTIVE' && !vestedShort,
    // Deactivating names the account that is linked now, so it is only offered once NIS has confirmed that it is.
    canDeactivate: i.hasPublicKey && i.keyValid && i.remoteStatus === 'ACTIVE' && i.isActiveRemote === true,
  };
}

// --- the remote account's public key (remembered on this device) ------------------------------
// The remote account can only be derived after the password. Its PUBLIC key is not secret, so it is kept
// to show the remote address and the node status without asking for the password again.
const remoteKey = (walletId: string, multisigAddress: string) =>
  `kasane.nem.multisigRemote.${getNemNetworkConfig().key}.${walletId}.${normalizeNemAddress(multisigAddress)}`;

export function loadNemMultisigRemote(walletId: string, multisigAddress: string): string {
  try {
    const value = (localStorage.getItem(remoteKey(walletId, multisigAddress)) ?? '').trim().toUpperCase();
    return /^[0-9A-F]{64}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

export function saveNemMultisigRemote(walletId: string, multisigAddress: string, publicKey: string): void {
  try {
    localStorage.setItem(remoteKey(walletId, multisigAddress), publicKey.toUpperCase());
  } catch { /* remembering the key is optional */ }
}
