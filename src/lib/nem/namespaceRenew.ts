import type { NemOwnedNamespace } from './api';
import { NEM_BLOCKS_PER_DAY, NEM_NAMESPACE_RENEW_WINDOW_BLOCKS } from './tx';

// NEM 「ネームスペースの更新」の対象。公式（NEM Wallet / NanoWallet）の RenewNamespacesCtrl と同じ判定：
//   ルートだけ（名前に '.' を含まない）で、「開始ブロック + 525,600 - 現在ブロック」が 43,200（約30日）以下。
// 下限は無いので、期限が切れたもの（猶予期間のあいだネットワークが返すもの）も対象に残る。

/** Root namespaces that expire within a month, or have already expired. Soonest first. */
export function renewableNemNamespaces(rows: NemOwnedNamespace[]): NemOwnedNamespace[] {
  return rows
    .filter((r) => r.depth === 1 && r.remainingBlocks !== undefined && r.remainingBlocks <= NEM_NAMESPACE_RENEW_WINDOW_BLOCKS)
    .sort((a, b) => (a.remainingBlocks ?? 0) - (b.remainingBlocks ?? 0));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** One renewal adds a year (525,600 blocks of 1 minute = 365 days); the period cannot be chosen on NEM. */
export const NEM_RENEW_DAYS = 365;

/** Whole days left (rounded down); null once expired or when the height is unknown. */
export function nemRemainingDays(r: Pick<NemOwnedNamespace, 'expired' | 'remainingBlocks'>): number | null {
  if (r.expired || r.remainingBlocks === undefined || r.remainingBlocks < 0) return null;
  return Math.floor(r.remainingBlocks / NEM_BLOCKS_PER_DAY);
}

/** Estimated expiry after one renewal: the current expiry plus a year (the end is added on, even in the grace period). */
export function nemExtendedExpiryMs(r: Pick<NemOwnedNamespace, 'expiresAtMs'>): number {
  return r.expiresAtMs + NEM_RENEW_DAYS * DAY_MS;
}
