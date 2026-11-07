// Pure rules for extending a root namespace (ネームスペースの更新), shared by the screen, the expiry notice and the tests.
// Symbol has no separate "renew" transaction: the owner registers the root again under the same name and the period
// is added to the current one. The total remaining period may not pass the network's longest rental (5 years).
import { MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS } from './tx';
import type { OwnedNamespace } from './api';

export const DAY_MS = 24 * 60 * 60 * 1000; // 2,880 blocks of 30 s
/** A root that expires within this many days is flagged (the same one month as NEM's warning). */
export const RENEW_WINDOW_DAYS = 30;

type RenewRow = Pick<OwnedNamespace, 'depth' | 'eternal' | 'expired' | 'expiresAtMs'>;

/** Roots that can be extended: not a sub-namespace, not eternal. Expired ones stay (the owner may still be inside the grace period). */
export const isRenewableRoot = (r: RenewRow): boolean => r.depth === 1 && !r.eternal && r.expiresAtMs !== null;

/** Whole days left (rounded down, never below 0); null for an expired or eternal one. */
export function remainingDays(r: RenewRow, nowMs: number): number | null {
  if (r.expired || r.eternal || r.expiresAtMs === null) return null;
  return Math.max(0, Math.floor((r.expiresAtMs - nowMs) / DAY_MS));
}

/** Active root expiring within the window. */
export function isExpiringSoon(r: RenewRow, nowMs: number): boolean {
  if (!isRenewableRoot(r) || r.expired || r.expiresAtMs === null) return false;
  return r.expiresAtMs - nowMs <= RENEW_WINDOW_DAYS * DAY_MS;
}

/** The roots worth warning about: expiring within the window, soonest first. */
export function expiringRoots<T extends RenewRow>(rows: T[], nowMs: number): T[] {
  return rows
    .filter((r) => isExpiringSoon(r, nowMs))
    .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0));
}

/** How many days can still be added: the 5-year ceiling minus what is left. An expired root restarts from the ceiling. */
export function maxExtensionDays(r: RenewRow, nowMs: number): number {
  const left = remainingDays(r, nowMs);
  return left === null ? MAX_NAMESPACE_DAYS : Math.max(0, MAX_NAMESPACE_DAYS - left - 1);
}

/** The period cannot be extended at all right now (less than the shortest rental fits under the ceiling). */
export const isMaxedOut = (r: RenewRow, nowMs: number): boolean => maxExtensionDays(r, nowMs) < MIN_NAMESPACE_DAYS;

/** Estimated expiry after adding `days` to an active root; null for an expired one (where the end is not simply added on). */
export function extendedExpiryMs(r: RenewRow, days: number): number | null {
  if (r.expired || r.eternal || r.expiresAtMs === null) return null;
  return r.expiresAtMs + days * DAY_MS;
}

/** Problem with the entered number of days (an i18n key suffix), or null when it is acceptable. */
export function validateRenewDays(r: RenewRow, text: string, nowMs: number): 'invalid' | 'range' | 'over_max' | null {
  if (!/^\d+$/.test(text)) return 'invalid';
  const days = Number(text);
  if (days < MIN_NAMESPACE_DAYS || days > MAX_NAMESPACE_DAYS) return 'range';
  if (days > maxExtensionDays(r, nowMs)) return 'over_max';
  return null;
}
