// Fee levels of a Symbol transaction. Five steps, like the official Symbol wallet: 'slowest' pays
// the network minimum, 'standard' the median of recent blocks and 'fastest' the most (so harvesters
// pick the transaction up first). The one used when the person did not pick a level is the
// 「手数料の既定値」 of 設定; this module keeps a module-level copy of it (store/appStore.ts keeps
// it in sync) so plain functions - the transaction builders - can read it without importing React.
export type FeeSpeed = 'slowest' | 'slow' | 'standard' | 'fast' | 'fastest';
export const FEE_SPEEDS: FeeSpeed[] = ['slowest', 'slow', 'standard', 'fast', 'fastest'];
export const FEE_SPEED_FALLBACK: FeeSpeed = 'standard';

export function isFeeSpeed(value: unknown): value is FeeSpeed {
  return typeof value === 'string' && (FEE_SPEEDS as string[]).includes(value);
}

/** Levels below the average fee: a transaction may sit unconfirmed and finally expire. */
export function isBelowAverageFee(speed: FeeSpeed): boolean {
  return speed === 'slowest' || speed === 'slow';
}

let defaultSpeed: FeeSpeed = FEE_SPEED_FALLBACK;

export function getDefaultFeeSpeed(): FeeSpeed {
  return defaultSpeed;
}

export function setDefaultFeeSpeed(speed: FeeSpeed): void {
  defaultSpeed = isFeeSpeed(speed) ? speed : FEE_SPEED_FALLBACK;
}

// minFeeMultiplier/medianFeeMultiplier/highestFeeMultiplier come straight from whatever node the
// person has selected (GET /network/fees/transaction) - including a custom node URL they typed in,
// which a malicious or MITM'd node fully controls. Previously only `highest` was bounded (relative
// to `standard`, 3x-4x below); `minimum` and `median` had no ceiling at all, and every level here is
// derived from them, so a node simply lying about minFeeMultiplier/medianFeeMultiplier (e.g. reporting
// 50,000,000 instead of the real ~100) silently inflates every fee tier - including 'slowest' - to a
// point where the computed fee for an ordinary transfer could consume most or all of the sender's
// balance. The transaction gets signed locally with exactly that fee, so nothing about the signing
// path itself catches this; it relies entirely on the person noticing the number on the confirmation
// screen before approving. FEE_SANITY_CEILING is a circuit breaker against that: a value no genuine
// Symbol node has ever reported (real-world minFeeMultiplier has sat around 100, with congestion
// spikes reported in the thousands - this is ~1000x that), so it only ever clips an implausible/
// malicious value and never affects a real, even badly congested, network.
const FEE_SANITY_CEILING = 1_000_000;

/** The fee multiplier of every level, from the node's min / median / highest recent multipliers. */
export function multipliersFromStats(minimum: number, median: number, highest: number): Record<FeeSpeed, number> {
  const min = Math.min(Math.max(minimum, 1), FEE_SANITY_CEILING);
  const standard = Math.min(Math.max(median, min), FEE_SANITY_CEILING);
  // Halfway between the minimum and the standard.
  const slow = Math.max(min, Math.round((min + standard) / 2));
  // Twice the standard; and the busiest recent block, kept between 3x and 4x so one outlier block
  // cannot make the fastest level absurdly expensive (and it always stays above 'fast'). Both capped
  // too: `standard` can sit right at the ceiling, so standard * 2 (or * 4) would otherwise still
  // overshoot it.
  const fast = Math.min(standard * 2, FEE_SANITY_CEILING);
  const fastest = Math.min(Math.max(standard * 3, Math.min(highest, standard * 4)), FEE_SANITY_CEILING);
  return { slowest: min, slow, standard, fast, fastest };
}
