// Everything the screens need that differs between Symbol and NEM, behind one set of functions that
// follow the chain currently selected (lib/chain.ts). Symbol-only features (mosaic creation,
// namespaces, metadata, harvesting) keep calling lib/symbol/api directly.
import { chainMeta, getChain } from './chain';
import { SYMBOL_ICON, NEM_ICON } from './chainIcons';
import { getNetworkConfig } from './symbol/network';
import { explorerAccountUrl, explorerTxUrl, fetchBalances, fetchTransfers } from './symbol/api';
import type { MosaicBalance, SymbolTransfer } from './symbol/api';
import { addressFromPublicKey, isValidAddress, normalizeAddress, prettyAddress } from './symbol/crypto';
import { buildAddressQr } from './symbol/qr';
import { fetchNemBalances, fetchNemTransfers, nemExplorerAccountUrl, nemExplorerTxUrl } from './nem/api';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress, prettyNemAddress } from './nem/crypto';
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
  return nem() ? NEM_ICON : SYMBOL_ICON;
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

export function fetchChainTransfers(address: string, count: number, includeUnconfirmed = true): Promise<SymbolTransfer[]> {
  return nem() ? fetchNemTransfers(address, count, includeUnconfirmed) : fetchTransfers(address, count, includeUnconfirmed);
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

export function chainAddressFromPublicKey(publicKey: string, networkByte: number): string {
  return nem() ? nemAddressFromPublicKey(publicKey, networkByte) : addressFromPublicKey(publicKey, networkByte);
}

export function chainAddressQr(address: string, name = ''): string {
  return nem() ? buildNemAddressQr(address, name) : buildAddressQr(address, name);
}

export function chainExplorerTxUrl(hash: string): string {
  return nem() ? nemExplorerTxUrl(hash) : explorerTxUrl(hash);
}

export function chainExplorerAccountUrl(address: string): string {
  return nem() ? nemExplorerAccountUrl(address) : explorerAccountUrl(address);
}

