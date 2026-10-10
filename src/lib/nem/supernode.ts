// NEM SuperNode Program (https://www.nem.io/supernode): status lookup, enrollment, payout history.
//
// Ported from the official NEM Nano Wallet (module `superNodeProgram` + service `SuperNodeProgram`).
// The program has its own REST API (not a NIS1 node). Enrolling is a plain 0 XEM transfer, signed by
// the node owner's main account, to the address the program currently accepts enrollments at, with
// the message "enroll <node host> <codeword hash>".
import { SymbolSendError } from '../symbol/api';
import { isValidNemAddress, normalizeNemAddress } from './crypto';
import { getNemNetworkConfig } from './network';
import { sendNemTransfer } from './api';
import { nemTransferFee } from './tx';

export const SUPERNODE_API_BASE_URL = 'https://nem.io/supernode/api';
export const SUPERNODE_INFO_URL = 'https://www.nem.io/supernode';

// Page size of the payout history (the official wallet asks the API for 10 per page).
export const SUPERNODE_PAYOUT_PAGE_SIZE = 10;

// --- API ------------------------------------------------------------------------------------------
async function apiGet(path: string, errorCode: string, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPERNODE_API_BASE_URL}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(errorCode) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Node as the program reports it (only the fields this wallet uses). */
export interface SupernodeInfo {
  id: string;
  name: string;
  // true = the node passes the program's checks in the current round.
  active: boolean;
  // Host name of the node (the enrolled endpoint, without protocol and port).
  host: string;
  mainPublicKey: string;
  remotePublicKey: string;
  totalRewardsEarned: bigint; // micro-XEM
  lastPayoutRound: number | null; // null = never paid
  rewardCount: number;
}

interface RawSupernodeInfo {
  id?: string | number;
  name?: string;
  status?: boolean | number | string;
  endpoint?: string;
  mainPublicKey?: string;
  remotePublicKey?: string;
  totalRewardsEarned?: number | string;
  lastPayoutRound?: number;
  rewardCount?: number;
}

function hostOf(endpoint: string | undefined): string {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint.replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
  }
}

/**
 * Node enrolled by a main public key, or null when that key is not enrolled (the API answers 404).
 * Throws on any other failure (network, 5xx), so "not enrolled" is never confused with "unknown".
 */
export async function fetchSupernodeInfo(mainPublicKey: string): Promise<SupernodeInfo | null> {
  let res: Response;
  try {
    res = await apiGet(`/node/${mainPublicKey}`, 'failed_to_get_node_info');
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
  const raw = (await res.json()) as RawSupernodeInfo | null;
  if (!raw || (raw.id === undefined && !raw.mainPublicKey)) return null;
  return {
    id: String(raw.id ?? ''),
    name: raw.name ?? '',
    active: raw.status === true || raw.status === 1 || raw.status === 'active',
    host: hostOf(raw.endpoint),
    mainPublicKey: raw.mainPublicKey ?? mainPublicKey,
    remotePublicKey: raw.remotePublicKey ?? '',
    totalRewardsEarned: BigInt(Math.trunc(Number(raw.totalRewardsEarned ?? 0))),
    lastPayoutRound: raw.lastPayoutRound === undefined || raw.lastPayoutRound === -1 ? null : raw.lastPayoutRound,
    rewardCount: raw.rewardCount ?? 0,
  };
}

/** Whether `address` is the address the program accepts enrollments at right now. */
export async function checkEnrollmentAddress(address: string): Promise<boolean> {
  const res = await apiGet(`/enrollment/check/address/${address}`, 'failed_to_validate_enroll_address');
  return (await res.text()).trim() === 'true';
}

/** Whether a main public key already holds a successful enrollment in the current period. */
export async function checkEnrollmentStatus(mainPublicKey: string): Promise<boolean> {
  const res = await apiGet(`/enrollment/successes/${mainPublicKey}?count=1`, 'failed_to_get_success_enrollments');
  const successes = (await res.json()) as Array<{ recipientAddress?: string }>;
  if (!Array.isArray(successes) || successes.length === 0) return false;
  const address = successes[0].recipientAddress;
  return address ? checkEnrollmentAddress(address) : false;
}

/** The current period's codeword hash for this key (64 hex characters; it goes into the message). */
export async function fetchCodewordHash(mainPublicKey: string): Promise<string> {
  const res = await apiGet(`/codeword/${mainPublicKey}`, 'failed_to_get_codeword_hash');
  return (await res.text()).trim();
}

export interface SupernodePayout {
  fromRound: number;
  toRound: number;
  amount: bigint; // micro-XEM
  isPaid: boolean;
  transactionHash: string;
  timestampMs: number | null;
}

interface RawPayout {
  fromRoundId?: number;
  toRoundId?: number;
  amount?: number | string;
  isPaid?: boolean;
  transactionHash?: string;
  timestamp?: number | string;
}

/** One page (0-based) of the node's payouts, newest first as the API returns them. */
export async function fetchSupernodePayouts(nodeId: string, page: number, count = SUPERNODE_PAYOUT_PAGE_SIZE): Promise<SupernodePayout[]> {
  const res = await apiGet(`/node/${nodeId}/payouts?count=${count}&offset=${count * page}`, 'failed_to_get_payouts_page');
  const raw = (await res.json()) as RawPayout[];
  return (Array.isArray(raw) ? raw : []).map((p) => {
    const time = p.timestamp === undefined ? NaN : new Date(p.timestamp).getTime();
    return {
      fromRound: p.fromRoundId ?? 0,
      toRound: p.toRoundId ?? 0,
      amount: BigInt(Math.trunc(Number(p.amount ?? 0))),
      isPaid: p.isPaid === true,
      transactionHash: p.transactionHash ?? '',
      timestampMs: Number.isFinite(time) ? time : null,
    };
  });
}

// --- enrollment -------------------------------------------------------------------------------------
/** Host name only: no protocol, no port, no path (the program checks the node by its host name or IP). */
export function isValidNodeHost(host: string): boolean {
  const h = host.trim();
  if (h === '') return false;
  if (/^https?:\/\//i.test(h) || /:\d{1,5}$/.test(h) || /[/\s]/.test(h)) return false;
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h);
}

/** Address the user typed for the enrollment: well-formed and on the network the wallet is using. */
export function isValidEnrollAddress(address: string): boolean {
  const a = address.trim();
  if (a.length !== 40 && a.length !== 46) return false;
  return isValidNemAddress(a, getNemNetworkConfig().networkByte);
}

const ZERO_HASH = '0'.repeat(64);

export function supernodeEnrollMessage(nodeHost: string, codewordHash: string = ZERO_HASH): string {
  return `enroll ${nodeHost.trim()} ${codewordHash}`;
}

/** Fee of the enrollment transfer (0 XEM, so the minimum fee plus the message). Needs no network. */
export function supernodeEnrollFee(nodeHost: string): bigint {
  return nemTransferFee(0n, supernodeEnrollMessage(nodeHost));
}

export type SupernodeEnrollErrorKind =
  | 'invalid_host'
  | 'invalid_address'
  | 'address_not_accepted'
  | 'already_enrolled'
  | 'codeword_unavailable';

export class SupernodeEnrollError extends Error {
  kind: SupernodeEnrollErrorKind;
  constructor(kind: SupernodeEnrollErrorKind) {
    super(kind);
    this.kind = kind;
  }
}

export interface EnrollInput {
  privateKey: string;
  publicKey: string; // the signer's main public key (the one that is enrolled)
  enrollAddress: string;
  nodeHost: string;
  // Host the account is already enrolled with, when known: enrolling the same host again is refused.
  currentHost?: string;
}

/**
 * Checks everything the program checks (host format, enrollment address, existing enrollment,
 * codeword), then announces the enrollment. Throws SupernodeEnrollError for a problem the user can
 * fix, SymbolSendError when the NIS1 node rejects the transaction.
 */
export async function enrollInSupernodeProgram(input: EnrollInput): Promise<{ hash: string }> {
  const host = input.nodeHost.trim();
  if (!isValidNodeHost(host)) throw new SupernodeEnrollError('invalid_host');
  if (!isValidEnrollAddress(input.enrollAddress)) throw new SupernodeEnrollError('invalid_address');
  const enrollAddress = normalizeNemAddress(input.enrollAddress);

  const [enrolled, addressAccepted, codewordHash] = await Promise.all([
    checkEnrollmentStatus(input.publicKey),
    checkEnrollmentAddress(enrollAddress),
    fetchCodewordHash(input.publicKey),
  ]);
  if (enrolled && input.currentHost && input.currentHost.toLowerCase() === host.toLowerCase()) {
    throw new SupernodeEnrollError('already_enrolled');
  }
  if (!addressAccepted) throw new SupernodeEnrollError('address_not_accepted');
  if (!/^[0-9a-fA-F]{64}$/.test(codewordHash)) throw new SupernodeEnrollError('codeword_unavailable');

  try {
    return await sendNemTransfer({
      privateKey: input.privateKey,
      publicKey: input.publicKey,
      recipient: enrollAddress,
      amount: 0n,
      message: supernodeEnrollMessage(host, codewordHash),
    });
  } catch (e) {
    if (e instanceof SymbolSendError) throw e;
    throw new SymbolSendError('announce_failed', (e as Error).message);
  }
}
