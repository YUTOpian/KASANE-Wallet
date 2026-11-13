import iconSymbol from '../assets/icon_chain_symbol.png';
import iconNem from '../assets/icon_chain_nem.png';
import logoSymbol from '../assets/logo_symbol.png';
import logoNem from '../assets/logo_nem.png';
import iconMijin from '../assets/icon_chain_mijin.png';
import logoMijin from '../assets/logo_mijin.png';
import type { ChainKey } from './chain';
import type { SymbolNetwork } from './symbol/constants';

// Round-ish chain icon used for the native currency (XYM / XEM) and the address book.
export const SYMBOL_ICON: string = iconSymbol;
export const NEM_ICON: string = iconNem;

// Full logo shown in the side menu header.
export const CHAIN_LOGOS: Record<ChainKey, string> = { symbol: logoSymbol, nem: logoNem };

// mijin v2 (Catapult) runs on the Symbol chain with its own mark: the icon of its currency and the side-menu logo.
export const MIJIN_ICON: string = iconMijin;
export const MIJIN_LOGO: string = logoMijin;

/** Logo for the side menu / empty states: the chain's own, or mijin's while the network is mijin v2. */
export function chainLogo(chain: ChainKey, network: SymbolNetwork): string {
  return chain === 'symbol' && network === 'mijin' ? MIJIN_LOGO : CHAIN_LOGOS[chain];
}
