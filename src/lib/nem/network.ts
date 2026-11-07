import { getNetwork } from '../symbol/network';
import { NEM_NETWORKS } from './constants';
import type { NemNetworkConfig } from './constants';
import type { PublicNetwork, SymbolNetwork } from '../symbol/constants';

// Hand-entered NIS node per network ('' = pick one automatically). The mainnet / testnet choice
// itself is shared with Symbol (lib/symbol/network.ts).
const customNodes: Record<PublicNetwork, string> = { mainnet: '', testnet: '' };

// NEM (NIS1) has no mijin v2. The app never sits on NEM while the network is mijin (the store moves it back to
// mainnet), so this mapping is only a type-level fallback.
export const nemNetworkOf = (network: SymbolNetwork): PublicNetwork => (network === 'mijin' ? 'mainnet' : network);
const listeners = new Set<() => void>();

export function getNemNetworkConfig(network: SymbolNetwork = getNetwork()): NemNetworkConfig {
  return NEM_NETWORKS[nemNetworkOf(network)];
}

export function getNemCustomNode(network: SymbolNetwork = getNetwork()): string {
  return customNodes[nemNetworkOf(network)];
}

export function setNemCustomNodeUrl(network: PublicNetwork, url: string) {
  customNodes[network] = url.trim().replace(/\/+$/, '');
  listeners.forEach((l) => l());
}

export function onNemNodeSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
