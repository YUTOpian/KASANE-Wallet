// NEM (NIS1) multisig: account state, pending transactions, and announcing multisig transactions.
import { NEM_EPOCH_SECONDS, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import { announceNemPayload, nodeRequest } from './api';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress } from './crypto';
import { getNemNetworkConfig } from './network';
import {
  signNemCosignature, signNemMultisigConversion, signNemMultisigWrapped,
} from './tx';
import type { NemMultisigChange, NemMultisigInner } from './tx';

export const NEM_TX_TYPE_MULTISIG_MODIFICATION = 0x1001;

export interface NemCosigner { address: string; publicKey: string }

export interface NemMultisigInfo {
  address: string;
  publicKey: string | null; // null until the account has made a transaction
  isMultisig: boolean;
  minCosignatories: number; // 0 = every cosigner must sign
  cosignatories: NemCosigner[];
  multisigOf: NemCosigner[]; // the multisig accounts this account cosigns for
}

interface RawAccount { address?: string; publicKey?: string; multisigInfo?: { cosignatoriesCount?: number; minCosignatories?: number } }
const upper = (v: string | undefined) => (v ?? '').toUpperCase();
const toCosigner = (a: RawAccount): NemCosigner => ({ address: normalizeNemAddress(a.address ?? ''), publicKey: upper(a.publicKey) });

export async function fetchNemMultisigInfo(address: string): Promise<NemMultisigInfo> {
  const addr = normalizeNemAddress(address);
  const res = await nodeRequest<{ account?: RawAccount; meta?: { cosignatories?: RawAccount[]; cosignatoryOf?: RawAccount[] } }>(`/account/get?address=${addr}`);
  const cosignatories = (res.meta?.cosignatories ?? []).map(toCosigner);
  return {
    address: addr,
    publicKey: res.account?.publicKey ? upper(res.account.publicKey) : null,
    isMultisig: cosignatories.length > 0,
    minCosignatories: res.account?.multisigInfo?.minCosignatories ?? 0,
    cosignatories,
    multisigOf: (res.meta?.cosignatoryOf ?? []).map(toCosigner),
  };
}

/** The public key of an address, or null when the network has not seen it yet. */
export async function fetchNemPublicKey(address: string): Promise<string | null> {
  const res = await nodeRequest<{ account?: RawAccount }>(`/account/get?address=${normalizeNemAddress(address)}`);
  return res.account?.publicKey ? upper(res.account.publicKey) : null;
}

/** A cosigner typed as a 64-hex public key or as an address (whose public key is looked up). */
export async function resolveNemCosigner(input: string, networkByte: number): Promise<NemCosigner | 'invalid' | 'no_public_key'> {
  const text = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { publicKey: text.toUpperCase(), address: nemAddressFromPublicKey(text, networkByte) };
  }
  if (!isValidNemAddress(text, networkByte)) return 'invalid';
  try {
    const key = await fetchNemPublicKey(text);
    return key ? { publicKey: key, address: normalizeNemAddress(text) } : 'no_public_key';
  } catch {
    return 'no_public_key';
  }
}

// --- pending ------------------------------------------------------------------------------
export interface NemPendingTransaction {
  innerHash: string;
  multisigAddress: string;
  initiator: string; // address of the cosigner who started it
  deadlineMs: number;
  signedCount: number; // signatures so far, the initiator's included
  signedByMe: boolean;
  summary: { kind: 'transfer'; recipient: string; amount: string; message: string } | { kind: 'modification'; additions: string[]; deletions: string[]; delta: number } | { kind: 'other' };
}

interface RawPending {
  meta?: { innerHash?: { data?: string }; data?: string };
  transaction: {
    type: number; signer: string; deadline: number; version?: number;
    signatures?: Array<{ signer: string }>;
    otherTrans?: {
      type: number; signer: string; amount?: number; recipient?: string;
      message?: { payload?: string; type?: number };
      modifications?: Array<{ modificationType: number; cosignatoryAccount: string }>;
      minCosignatories?: { relativeChange?: number };
    };
  };
}

function hexText(hex: string): string {
  try {
    return new TextDecoder().decode(new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16))));
  } catch {
    return '';
  }
}

/** Multisig transactions waiting for signatures that involve this wallet or the accounts it cosigns for. */
export async function fetchNemPending(walletAddress: string, walletPublicKey: string, multisigAddresses: string[]): Promise<NemPendingTransaction[]> {
  const networkByte = getNemNetworkConfig().networkByte;
  const found = new Map<string, NemPendingTransaction>();
  for (const address of [walletAddress, ...multisigAddresses]) {
    let data: RawPending[] = [];
    try {
      data = (await nodeRequest<{ data?: RawPending[] }>(`/account/unconfirmedTransactions?address=${normalizeNemAddress(address)}`)).data ?? [];
    } catch {
      continue;
    }
    for (const entry of data) {
      const outer = entry.transaction;
      const inner = outer.otherTrans;
      const innerHash = entry.meta?.innerHash?.data;
      if (outer.type !== NEM_TX_TYPE_MULTISIG || !inner || !innerHash || found.has(innerHash)) continue;
      const me = upper(walletPublicKey);
      const signedByMe = upper(outer.signer) === me || (outer.signatures ?? []).some((s) => upper(s.signer) === me);
      let summary: NemPendingTransaction['summary'] = { kind: 'other' };
      if (inner.type === NEM_TX_TYPE_TRANSFER) {
        const micro = BigInt(inner.amount ?? 0);
        const whole = micro / 1_000_000n;
        const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
        summary = {
          kind: 'transfer',
          recipient: normalizeNemAddress(inner.recipient ?? ''),
          amount: `${whole}${frac ? `.${frac}` : ''} XEM`,
          message: inner.message?.type === 1 && inner.message.payload ? hexText(inner.message.payload) : '',
        };
      } else if (inner.type === NEM_TX_TYPE_MULTISIG_MODIFICATION) {
        const mods = inner.modifications ?? [];
        summary = {
          kind: 'modification',
          additions: mods.filter((m) => m.modificationType === 1).map((m) => nemAddressFromPublicKey(m.cosignatoryAccount, networkByte)),
          deletions: mods.filter((m) => m.modificationType === 2).map((m) => nemAddressFromPublicKey(m.cosignatoryAccount, networkByte)),
          delta: inner.minCosignatories?.relativeChange ?? 0,
        };
      }
      found.set(innerHash, {
        innerHash,
        multisigAddress: nemAddressFromPublicKey(inner.signer, networkByte),
        initiator: nemAddressFromPublicKey(outer.signer, networkByte),
        deadlineMs: (outer.deadline + NEM_EPOCH_SECONDS) * 1000,
        signedCount: 1 + (outer.signatures?.length ?? 0),
        signedByMe,
        summary,
      });
    }
  }
  return Array.from(found.values());
}

// --- announcing -----------------------------------------------------------------------------
const networkByte = () => getNemNetworkConfig().networkByte;

export function sendNemMultisigConversion(privateKey: string, publicKey: string, change: NemMultisigChange) {
  return announceNemPayload(signNemMultisigConversion(privateKey, publicKey, networkByte(), change));
}

export function sendNemMultisigWrapped(privateKey: string, publicKey: string, multisigPublicKey: string, inner: NemMultisigInner) {
  return announceNemPayload(signNemMultisigWrapped(privateKey, publicKey, networkByte(), multisigPublicKey, inner));
}

export function sendNemCosignature(privateKey: string, publicKey: string, multisigAddress: string, innerHash: string) {
  return announceNemPayload(signNemCosignature(privateKey, publicKey, networkByte(), multisigAddress, innerHash));
}
