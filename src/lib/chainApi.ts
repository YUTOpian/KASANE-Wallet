// Everything the screens need that differs between Symbol and NEM, behind one set of functions that
// follow the chain currently selected (lib/chain.ts). Symbol-only features (mosaic creation,
// namespaces, metadata, harvesting) keep calling lib/symbol/api directly.
import { chainMeta, getChain } from './chain';
import { SYMBOL_ICON, NEM_ICON, MIJIN_ICON } from './chainIcons';
import { getNetwork, getNetworkConfig } from './symbol/network';
import { explorerAccountUrl, explorerTxUrl, fetchBalances } from './symbol/api';
import type { MosaicBalance } from './symbol/api';
import { isValidAddress, normalizeAddress, prettyAddress } from './symbol/crypto';
import { buildAccountInfoQr, buildAddressQr } from './symbol/qr';
import { fetchNemBalances, nemExplorerAccountUrl, nemExplorerTxUrl } from './nem/api';
import { isValidNemAddress, normalizeNemAddress, prettyNemAddress } from './nem/crypto';
import { buildNemAddressQr } from './nem/qr';
import { getNemNetworkConfig } from './nem/network';
import { NEM_NATIVE_ID } from './nem/constants';

const nem = () => getChain() === 'nem';

export function currencySymbol(): string {
  return chainMeta().currencySymbol;
}

export function currencyDivisibility(): number {
  return chainMeta().currencyDivisibility;
}

/** Id of the native currency in asset lists (Symbol: the XYM mosaic id, NEM: "nem:xem"). */
export function nativeAssetId(): string {
  return nem() ? NEM_NATIVE_ID : getNetworkConfig().currencyMosaicId;
}

export function nativeIcon(): string {
  if (nem()) return NEM_ICON;
  return getNetwork() === 'mijin' ? MIJIN_ICON : SYMBOL_ICON;
}

/** 0x68 mainnet / 0x98 testnet (the same on both chains). */
export function activeNetworkByte(): number {
  return nem() ? getNemNetworkConfig().networkByte : getNetworkConfig().networkByte;
}

export function activeNetworkLabel(): string {
  return nem() ? getNemNetworkConfig().label : getNetworkConfig().label;
}

export function fetchChainBalances(address: string): Promise<MosaicBalance[]> {
  return nem() ? fetchNemBalances(address) : fetchBalances(address);
}

export function normalizeChainAddress(address: string): string {
  return nem() ? normalizeNemAddress(address) : normalizeAddress(address);
}

export function prettyChainAddress(address: string): string {
  return nem() ? prettyNemAddress(address) : prettyAddress(address);
}

/** Well-formed address of the active chain (and, when given, of that network byte). */
export function isValidChainAddress(address: string, networkByte?: number): boolean {
  return nem() ? isValidNemAddress(address, networkByte) : isValidAddress(address, networkByte);
}

export function chainAddressQr(address: string, name = '', publicKey = ''): string {
  if (nem()) return buildNemAddressQr(address, name);
  // Symbol: account-info QR (name + public key); falls back to the address QR when no public key is known.
  return /^[0-9a-fA-F]{64}$/.test(publicKey) ? buildAccountInfoQr(publicKey, name) : buildAddressQr(address, name);
}

export function chainExplorerTxUrl(hash: string): string {
  return nem() ? nemExplorerTxUrl(hash) : explorerTxUrl(hash);
}

export function chainExplorerAccountUrl(address: string): string {
  return nem() ? nemExplorerAccountUrl(address) : explorerAccountUrl(address);
}

