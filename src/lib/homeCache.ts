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

// Which mosaic the Home balance card shows ('' = the currency, XYM / XEM). A per-device display choice, kept per chain and network.
const BALANCE_PREF_KEY = (chain: string, network: string) => `kasane.balanceCardMosaic:${chain}:${network}`;

export function getBalanceCardMosaic(chain: string, network: string): string {
  try {
    return localStorage.getItem(BALANCE_PREF_KEY(chain, network)) ?? '';
  } catch {
    return '';
  }
}

export function setBalanceCardMosaic(chain: string, network: string, id: string): void {
  try {
    if (id === '') localStorage.removeItem(BALANCE_PREF_KEY(chain, network));
    else localStorage.setItem(BALANCE_PREF_KEY(chain, network), id);
  } catch {
    // storage unavailable: the choice just does not outlive this session
  }
}

// Whether the balance card hides its amount (a per-device convenience, kept across reloads).
const BALANCE_HIDDEN_KEY = 'kasane.balanceHidden';

export function getBalanceHidden(): boolean {
  try {
    return localStorage.getItem(BALANCE_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setBalanceHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(BALANCE_HIDDEN_KEY, '1');
    else localStorage.removeItem(BALANCE_HIDDEN_KEY);
  } catch {
    // storage unavailable: the choice just does not outlive this session
  }
}
