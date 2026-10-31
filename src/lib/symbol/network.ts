import { NETWORKS } from './constants';
import type { NetworkConfig, SymbolNetwork } from './constants';
import { isAllowedNodeUrl } from '../nodePolicy';

// Module-level copies of the persisted settings (see store/appStore.ts, which keeps them in
// sync) so plain functions - storage, the REST client - can read them without importing React.
let currentNetwork: SymbolNetwork = 'mainnet';
const customNodes: Record<SymbolNetwork, string> = { mainnet: '', testnet: '', mijin: '' };
// 登録済みノードの一覧 (the node list of 設定 > ノード) and the 利用不可時の自動切替 switch.
const savedNodes: Record<SymbolNetwork, string[]> = { mainnet: [], testnet: [], mijin: [] };
let autoSwitch = true;
const listeners = new Set<() => void>();

export function getNetwork(): SymbolNetwork {
  return currentNetwork;
}

export function setNetwork(network: SymbolNetwork) {
  if (network === currentNetwork) return;
  currentNetwork = network;
  listeners.forEach((l) => l());
}

// What KASANE learned from the person's mijin v2 node (null = not set up yet).
export interface MijinParams {
  networkByte: number;
  generationHash: string;
  epochAdjustment: number;
  currencyMosaicId: string;
  explorer: string; // optional block explorer base URL ('' = none)
}
let mijinParams: MijinParams | null = null;
let mijinConfig: NetworkConfig = NETWORKS.mijin;

export function getMijinParams(): MijinParams | null {
  return mijinParams;
}

export function setMijinParams(params: MijinParams | null) {
  mijinParams = params;
  mijinConfig = params ? { ...NETWORKS.mijin, ...params } : NETWORKS.mijin;
  listeners.forEach((l) => l());
}

/** False for a mijin v2 network that has no node / parameters yet (nothing can be signed or sent). */
export function isNetworkConfigured(network: SymbolNetwork = currentNetwork): boolean {
  return getNetworkConfig(network).generationHash !== '';
}

export function getNetworkConfig(network: SymbolNetwork = currentNetwork): NetworkConfig {
  return network === 'mijin' ? mijinConfig : NETWORKS[network];
}

/**
 * The node the person picked ('' = automatic). A stored http:// node on the open internet (saved before that was
 * refused) reads as '' here, so every request path treats it as "not picked" - see lib/nodePolicy.ts.
 */
export function getCustomNode(network: SymbolNetwork = currentNetwork): string {
  const url = customNodes[network];
  return url !== '' && isAllowedNodeUrl(url) ? url : '';
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

export function getSavedNodes(network: SymbolNetwork = currentNetwork): string[] {
  return savedNodes[network].filter(isAllowedNodeUrl);
}

/** Kept apart from setCustomNodeUrl: editing the list does not change which node is in use. */
export function setSavedNodes(network: SymbolNetwork, urls: string[]) {
  savedNodes[network] = Array.from(new Set(urls.map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)));
}

export function getAutoSwitch(): boolean {
  return autoSwitch;
}

export function setAutoSwitch(on: boolean) {
  autoSwitch = on;
  listeners.forEach((l) => l());
}
