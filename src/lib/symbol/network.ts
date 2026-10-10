import { NETWORKS } from './constants';
import type { NetworkConfig, SymbolNetwork } from './constants';

// Module-level copies of the persisted settings (see store/appStore.ts, which keeps them in
// sync) so plain functions - storage, the REST client - can read them without importing React.
let currentNetwork: SymbolNetwork = 'mainnet';
const customNodes: Record<SymbolNetwork, string> = { mainnet: '', testnet: '' };
const listeners = new Set<() => void>();

export function getNetwork(): SymbolNetwork {
  return currentNetwork;
}

export function setNetwork(network: SymbolNetwork) {
  if (network === currentNetwork) return;
  currentNetwork = network;
  listeners.forEach((l) => l());
}

export function getNetworkConfig(network: SymbolNetwork = currentNetwork): NetworkConfig {
  return NETWORKS[network];
}

export function getCustomNode(network: SymbolNetwork = currentNetwork): string {
  return customNodes[network];
}

export function setCustomNodeUrl(network: SymbolNetwork, url: string) {
  customNodes[network] = url.trim().replace(/\/+$/, '');
  listeners.forEach((l) => l());
}

/** Called whenever the network or a custom node changes (the REST client drops its node cache). */
export function onNetworkSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
