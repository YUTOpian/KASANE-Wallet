import iconSymbol from '../assets/icon_chain_symbol.png';
import iconNem from '../assets/icon_chain_nem.png';
import logoSymbol from '../assets/logo_symbol.png';
import logoNem from '../assets/logo_nem.png';
import type { ChainKey } from './chain';

// Round-ish chain icon used for the native currency (XYM / XEM) and the address book.
export const SYMBOL_ICON: string = iconSymbol;
export const NEM_ICON: string = iconNem;

export const CHAIN_ICONS: Record<ChainKey, string> = { symbol: iconSymbol, nem: iconNem };

// Full logo shown in the side menu header.
export const CHAIN_LOGOS: Record<ChainKey, string> = { symbol: logoSymbol, nem: logoNem };
