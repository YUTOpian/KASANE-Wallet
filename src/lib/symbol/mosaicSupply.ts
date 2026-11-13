// Pure rules for changing a mosaic's supply from its own screen (no network, no SDK), so the form and the
// tests share them. The protocol accepts a supply change only when the mosaic has the supply-mutable flag
// and its owner holds the WHOLE supply; a decrease may not take more than the owner holds, and the supply
// can never pass the network limit.
import { MAX_MOSAIC_SUPPLY, MOSAIC_FLAG_SUPPLY_MUTABLE } from './tx';
import type { SupplyAction } from './tx';

export interface SupplyTarget {
  createdByMe: boolean;
  flags: number;
  expired: boolean;
  supply: bigint; // atomic units
  amount: bigint; // what the owner holds, atomic units
}

/** Why a mosaic cannot have its supply changed now (an i18n key suffix), or null when it can. */
export function supplyBlockedReason(m: SupplyTarget): 'not_mine' | 'not_mutable' | 'expired' | 'not_all_held' | null {
  if (!m.createdByMe) return 'not_mine';
  if ((m.flags & MOSAIC_FLAG_SUPPLY_MUTABLE) === 0) return 'not_mutable';
  if (m.expired) return 'expired';
  if (m.amount < m.supply) return 'not_all_held';
  return null;
}

/** Whether the mosaic is one the owner marked supply-mutable (listed in the picker even when blocked right now). */
export const isSupplyMutableMine = (m: SupplyTarget): boolean => m.createdByMe && (m.flags & MOSAIC_FLAG_SUPPLY_MUTABLE) !== 0 && !m.expired;

/** Problem with the entered change (an i18n key suffix), or null when it is acceptable. */
export function validateSupplyChange(m: SupplyTarget, action: SupplyAction, delta: bigint | null): 'invalid' | 'too_much' | 'over_max' | null {
  if (delta === null || delta <= 0n) return 'invalid';
  if (action === 'decrease') {
    if (delta > m.amount) return 'too_much';
    return null;
  }
  return m.supply + delta > MAX_MOSAIC_SUPPLY ? 'over_max' : null;
}

/** The supply after the change (atomic units). */
export const supplyAfter = (supply: bigint, action: SupplyAction, delta: bigint): bigint => (action === 'increase' ? supply + delta : supply - delta);
