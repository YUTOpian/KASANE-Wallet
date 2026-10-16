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

/** The fee multiplier of every level, from the node's min / median / highest recent multipliers. */
export function multipliersFromStats(minimum: number, median: number, highest: number): Record<FeeSpeed, number> {
  const min = Math.max(minimum, 1);
  const standard = Math.max(median, min);
  // Halfway between the minimum and the standard.
  const slow = Math.max(min, Math.round((min + standard) / 2));
  // Twice the standard; and the busiest recent block, kept between 3x and 4x so one outlier block
  // cannot make the fastest level absurdly expensive (and it always stays above 'fast').
  const fast = standard * 2;
  const fastest = Math.max(standard * 3, Math.min(highest, standard * 4));
  return { slowest: min, slow, standard, fast, fastest };
}
