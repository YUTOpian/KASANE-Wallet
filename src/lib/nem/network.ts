import { getNetwork } from '../symbol/network';
import { NEM_NETWORKS } from './constants';
import type { NemNetworkConfig } from './constants';
import type { SymbolNetwork } from '../symbol/constants';

// Hand-entered NIS node per network ('' = pick one automatically). The mainnet / testnet choice
// itself is shared with Symbol (lib/symbol/network.ts).
const customNodes: Record<SymbolNetwork, string> = { mainnet: '', testnet: '' };
const listeners = new Set<() => void>();

export function getNemNetworkConfig(network: SymbolNetwork = getNetwork()): NemNetworkConfig {
  return NEM_NETWORKS[network];
}

export function getNemCustomNode(network: SymbolNetwork = getNetwork()): string {
  return customNodes[network];
}

export function setNemCustomNodeUrl(network: SymbolNetwork, url: string) {
  customNodes[network] = url.trim().replace(/\/+$/, '');
  listeners.forEach((l) => l());
}

export function onNemNodeSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
