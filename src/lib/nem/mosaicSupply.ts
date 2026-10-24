import { NEM_MAX_MOSAIC_INITIAL_SUPPLY } from './tx';

export type NemSupplyAction = 'increase' | 'decrease';
export type NemSupplyProblem = 'invalid' | 'over_max' | 'too_much' | 'not_held';

/** The supply (whole units) once the change is applied. */
export function nemSupplyAfter(current: bigint, action: NemSupplyAction, delta: bigint): bigint {
  return action === 'increase' ? current + delta : current - delta;
}

/**
 * Checks a supply change before it is sent. `creatorWhole` is what the creator holds in whole units (null = unknown):
 * NIS1 only lets the creator remove what the creator holds.
 */
export function validateNemSupplyChange(p: { current: bigint; creatorWhole: bigint | null; action: NemSupplyAction; delta: bigint | null }): NemSupplyProblem | null {
  if (p.delta === null || p.delta <= 0n) return 'invalid';
  if (p.action === 'increase') return p.current + p.delta > NEM_MAX_MOSAIC_INITIAL_SUPPLY ? 'over_max' : null;
  if (p.delta > p.current) return 'too_much';
  if (p.creatorWhole !== null && p.delta > p.creatorWhole) return 'not_held';
  return null;
}
