/**
 * In-memory cache of what Home renders, keyed by wallet address (which already encodes the
 * network). Lets Home show its last-known data immediately when navigating back to it while a
 * fresh fetch silently corrects it in the background.
 */
export interface HomeCacheEntry {
  xymBalance: string;
  mosaicCount: number;
}

let cache: { key: string; entry: HomeCacheEntry } | null = null;

export function getHomeCache(walletAddress: string): HomeCacheEntry | null {
  if (cache == null || cache.key !== walletAddress) return null;
  return cache.entry;
}

export function setHomeCache(walletAddress: string, entry: HomeCacheEntry): void {
  cache = { key: walletAddress, entry };
}

/** メモリ上のキャッシュを捨てる（プロファイル削除時など、削除したアカウントの表示データを残さない）。 */
export function clearHomeCache(): void {
  cache = null;
}
