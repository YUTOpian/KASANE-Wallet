// NEM harvest statistics for the 「ハーベスト統計」 tab. Pure (no imports from the network code) so it can be tested alone.
// On NEM the harvester receives the whole fee of a block, so the fee of a harvested block is the reward.

export interface NemHarvestBlock {
  height: string;
  timestampMs: number | null;
  /** The fee the block paid (micro-XEM). */
  atomic: bigint;
}

export interface NemHarvestSummary {
  /** Sum of the fees of the listed blocks (micro-XEM). */
  totalFee: bigint;
  /** Mean fee per listed block, or null when there is none. */
  averageFee: bigint | null;
  /** The block with the highest height, or null when there is none. */
  last: NemHarvestBlock | null;
}

const compareHeightDesc = (a: NemHarvestBlock, b: NemHarvestBlock) => {
  const x = BigInt(a.height);
  const y = BigInt(b.height);
  return x > y ? -1 : x < y ? 1 : 0;
};

/** Newest block first (NIS1 already answers that way; this makes the table not depend on it). */
export function sortNemHarvestsNewestFirst<T extends NemHarvestBlock>(blocks: T[]): T[] {
  return [...blocks].sort(compareHeightDesc);
}

export function summarizeNemHarvests(blocks: NemHarvestBlock[]): NemHarvestSummary {
  const totalFee = blocks.reduce((sum, b) => sum + b.atomic, 0n);
  const last = blocks.length === 0 ? null : [...blocks].sort(compareHeightDesc)[0];
  return { totalFee, averageFee: blocks.length === 0 ? null : totalFee / BigInt(blocks.length), last };
}
