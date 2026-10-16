// 投票鍵(Voting Key)のリンク／解除: どのリンクを送るかの判定。通信・SDKなし。
// Symbol の VotingKeyLinkTransaction は「BLS 投票用公開鍵（48バイト＝16進96文字）」と「有効なファイナライズ・エポックの範囲」を持つ。
// 解除は、チェーン上にあるリンクと「公開鍵・開始エポック・終了エポック」が完全に一致していなければ受け付けられない。
// 1つのアカウントに同時にリンクできる数と、1つのリンクの期間（エポック数）にはネットワークの上限／下限がある。

export interface LinkedVotingKey {
  publicKey: string; // 96 hex chars (upper case)
  startEpoch: number;
  endEpoch: number;
}

export interface VotingLink extends LinkedVotingKey {
  link: boolean; // true = link, false = unlink
}

export interface VotingLimits {
  minLifetime: number; // epochs (end - start + 1) at least
  maxLifetime: number; // epochs at most
  maxKeys: number; // links per account at the same time
}

/** Mainnet values; used when /network/properties cannot be read. */
export const DEFAULT_VOTING_LIMITS: VotingLimits = { minLifetime: 28, maxLifetime: 720, maxKeys: 3 };

const MAX_EPOCH = 0xffffffff; // uint32

export type VotingKeyError =
  | 'invalid_key' | 'invalid_epoch' | 'range_reversed' | 'lifetime_short' | 'lifetime_long'
  | 'too_many' | 'overlap' | 'already_linked' | 'not_linked';
export type VotingPlan = { ok: true; links: VotingLink[] } | { ok: false; error: VotingKeyError };

export const isVotingPublicKeyHex = (text: string): boolean => /^[0-9a-fA-F]{96}$/.test(text);

/** An epoch typed by the person: digits only, 1 … 4294967295. */
export function parseEpoch(text: string): number | null {
  if (!/^[0-9]{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_EPOCH ? n : null;
}

/** Number of epochs a link is valid for (both ends count). */
export const votingLifetime = (startEpoch: number, endEpoch: number): number => endEpoch - startEpoch + 1;

const overlaps = (a: LinkedVotingKey, b: LinkedVotingKey): boolean => a.startEpoch <= b.endEpoch && b.startEpoch <= a.endEpoch;

/** Sorted by start epoch, keys in upper case. */
export function sortVotingKeys(keys: LinkedVotingKey[]): LinkedVotingKey[] {
  return keys
    .map((k) => ({ publicKey: k.publicKey.toUpperCase(), startEpoch: k.startEpoch, endEpoch: k.endEpoch }))
    .sort((a, b) => a.startEpoch - b.startEpoch || a.endEpoch - b.endEpoch);
}

/**
 * Checks an epoch range for a new link (the key itself is not looked at): valid epochs, the length within the network's limits,
 * room for one more link, and no overlap with a link that exists (the network refuses overlapping ranges).
 */
export function checkVotingRange(current: LinkedVotingKey[], startEpoch: number, endEpoch: number, limits: VotingLimits = DEFAULT_VOTING_LIMITS): VotingKeyError | null {
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_EPOCH;
  if (!valid(startEpoch) || !valid(endEpoch)) return 'invalid_epoch';
  if (endEpoch < startEpoch) return 'range_reversed';
  const lifetime = votingLifetime(startEpoch, endEpoch);
  if (lifetime < limits.minLifetime) return 'lifetime_short';
  if (lifetime > limits.maxLifetime) return 'lifetime_long';
  if (current.length >= limits.maxKeys) return 'too_many';
  if (current.some((k) => overlaps(k, { publicKey: '', startEpoch, endEpoch }))) return 'overlap';
  return null;
}

/**
 * What to send to link one voting key.
 * - the key must be 96 hex chars (upper-cased) and the epoch range must pass checkVotingRange;
 * - the very same link (key and range) cannot be linked twice.
 */
export function planVotingLink(current: LinkedVotingKey[], input: { publicKey: string; startEpoch: number; endEpoch: number }, limits: VotingLimits = DEFAULT_VOTING_LIMITS): VotingPlan {
  const key = input.publicKey.trim().toUpperCase();
  if (!isVotingPublicKeyHex(key)) return { ok: false, error: 'invalid_key' };
  const { startEpoch, endEpoch } = input;
  const existing = sortVotingKeys(current);
  if (existing.some((k) => k.publicKey === key && k.startEpoch === startEpoch && k.endEpoch === endEpoch)) return { ok: false, error: 'already_linked' };
  const error = checkVotingRange(existing, startEpoch, endEpoch, limits);
  if (error) return { ok: false, error };
  return { ok: true, links: [{ publicKey: key, startEpoch, endEpoch, link: true }] };
}

/**
 * What to send to unlink one voting key. The key and both epochs are taken from the link that is on the chain
 * (an unlink must name exactly what is linked), so the caller passes the chain's entry, never typed values.
 */
export function planVotingUnlink(current: LinkedVotingKey[], target: LinkedVotingKey): VotingPlan {
  const key = target.publicKey.toUpperCase();
  const found = sortVotingKeys(current).find((k) => k.publicKey === key && k.startEpoch === target.startEpoch && k.endEpoch === target.endEpoch);
  if (!found) return { ok: false, error: 'not_linked' };
  return { ok: true, links: [{ ...found, link: false }] };
}

/** True when every unlink in `links` still matches a link that is on the chain now (checked right before signing). */
export function unlinksStillMatch(current: LinkedVotingKey[], links: VotingLink[]): boolean {
  const now = sortVotingKeys(current);
  return links.every((l) => l.link || now.some((k) => k.publicKey === l.publicKey.toUpperCase() && k.startEpoch === l.startEpoch && k.endEpoch === l.endEpoch));
}

/**
 * A starting point for the form: the range begins two epochs after the finalized epoch now (or after the last link ends,
 * if that is later) and lasts the longest the network allows (a longer link means fewer renewals).
 */
export function defaultVotingRange(currentEpoch: number | null, current: LinkedVotingKey[], limits: VotingLimits = DEFAULT_VOTING_LIMITS): { startEpoch: number; endEpoch: number } | null {
  if (currentEpoch === null) return null;
  const lastEnd = sortVotingKeys(current).reduce((max, k) => Math.max(max, k.endEpoch), 0);
  const startEpoch = Math.max(currentEpoch + 2, lastEnd + 1);
  const endEpoch = Math.min(startEpoch + limits.maxLifetime - 1, MAX_EPOCH);
  return { startEpoch, endEpoch };
}
