// Which blockchain the app is currently working with. Symbol is the default; NEM (NIS1) can be
// picked from the logo in the side menu. Like lib/symbol/network.ts, plain (non-React) modules read
// this module-level copy; the zustand store keeps it in sync and persists it.
export type ChainKey = 'symbol' | 'nem';

export const CHAIN_ORDER: ChainKey[] = ['symbol', 'nem'];

export interface ChainMeta {
  key: ChainKey;
  name: string;
  currencySymbol: string;
  currencyDivisibility: number;
  // Length of an address of this chain (Symbol 39, NEM 40).
  addressLength: number;
}

export const CHAINS: Record<ChainKey, ChainMeta> = {
  symbol: { key: 'symbol', name: 'Symbol', currencySymbol: 'XYM', currencyDivisibility: 6, addressLength: 39 },
  nem: { key: 'nem', name: 'NEM', currencySymbol: 'XEM', currencyDivisibility: 6, addressLength: 40 },
};

let currentChain: ChainKey = 'symbol';
const listeners = new Set<() => void>();

export function getChain(): ChainKey {
  return currentChain;
}

export function setChain(chain: ChainKey) {
  if (chain === currentChain) return;
  currentChain = chain;
  listeners.forEach((l) => l());
}

export function chainMeta(chain: ChainKey = currentChain): ChainMeta {
  return CHAINS[chain];
}

export function isNem(): boolean {
  return currentChain === 'nem';
}

export function onChainChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
