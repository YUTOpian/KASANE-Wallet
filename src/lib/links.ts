// Official links and testnet faucets, per chain / network. Shown on the Links screen and in the guide wizard.
import type { ChainKey } from './chain';
import type { SymbolNetwork } from './symbol/constants';
import { NETWORKS } from './symbol/constants';
import { getNetworkConfig } from './symbol/network';
import { NEM_NETWORKS } from './nem/constants';

export interface LinkItem {
  /** i18n key under `guide.link_*`. */
  labelKey: string;
  url: string;
}

export const COMMUNITY_DISCORD_URL = 'https://discord.com/invite/NMA9YQ55td';

export function officialLinks(chain: ChainKey, network: SymbolNetwork): LinkItem[] {
  if (chain === 'nem') {
    return [
      { labelKey: 'guide.link_site', url: 'https://nem.io' },
      { labelKey: 'guide.link_docs', url: 'https://docs.nemtest.net/ja/' },
      { labelKey: 'guide.link_nodes_nem', url: 'https://nemnodes.org/nodes/' },
      { labelKey: 'guide.link_nemscan', url: 'https://nemscan.io' },
      // On testnet the explorer is NEMSCAN itself (already listed above), so don't list it twice.
      ...(network === 'testnet' ? [] : [{ labelKey: 'guide.link_explorer', url: NEM_NETWORKS[network === 'mijin' ? 'mainnet' : network].explorer }]),
      { labelKey: 'guide.link_discord', url: COMMUNITY_DISCORD_URL },
    ];
  }
  if (network === 'mijin') {
    // mijin v2 (Catapult) is a private-chain product: no public node list, faucet or explorer (an explorer the person entered is shown).
    const explorer = getNetworkConfig('mijin').explorer;
    return [
      { labelKey: 'guide.link_mijin_site', url: 'https://mijin.io/' },
      { labelKey: 'guide.link_mijin_guide', url: 'https://tech-bureau-jp.github.io/mijin-guide/' },
      ...(explorer ? [{ labelKey: 'guide.link_explorer', url: explorer }] : []),
    ];
  }
  return [
    { labelKey: 'guide.link_site', url: 'https://docs.symbol.dev' },
    { labelKey: 'guide.link_docs', url: 'https://docs.symboltest.net/ja/' },
    { labelKey: 'guide.link_community', url: 'https://symbol-community.com/ja/' },
    { labelKey: 'guide.link_nodes_symbol', url: 'https://symbolnodes.org/nodes/' },
    { labelKey: 'guide.link_explorer', url: NETWORKS[network].explorer },
    { labelKey: 'guide.link_discord', url: COMMUNITY_DISCORD_URL },
  ];
}

/** Where to get test coins. Null on mainnet (there is no faucet for real coins). */
export function faucetLink(chain: ChainKey, network: SymbolNetwork): LinkItem | null {
  if (network !== 'testnet') return null;
  return chain === 'nem'
    ? { labelKey: 'guide.faucet_nem', url: 'https://testnet.nem.tools' }
    : { labelKey: 'guide.faucet_symbol', url: 'https://testnet.symbol.tools/' };
}
