import type { SymbolNetwork } from '../symbol/constants';

// NEM (NIS1) networks. The network byte is the same value as on Symbol (0x68 / 0x98), but the
// address is 40 characters ("N..." / "T...") and the node API (NIS1) is a different one.
export interface NemNetworkConfig {
  key: SymbolNetwork;
  label: string;
  networkByte: number; // 0x68 / 0x98
  networkId: number; // as reported by NIS1 /node/info: 104 / -104
  fallbackNodes: string[];
  explorer: string;
}

// Only HTTPS nodes are used: a web page served over HTTPS cannot call plain-HTTP nodes (mixed
// content), and a wallet should not talk to a node over an unencrypted connection anyway.
export const NEM_NETWORKS: Record<SymbolNetwork, NemNetworkConfig> = {
  mainnet: {
    key: 'mainnet',
    label: 'Mainnet',
    networkByte: 0x68,
    networkId: 104,
    // HTTPS (port 7891) nodes taken from the public node list at https://nemnodes.org/nodes/
    // (checked 2026-10-08). Nodes come and go, so at run time the same page is read again
    // (see NEM_NODE_LIST_PAGE_URL) and these are only the starting point.
    fallbackNodes: [
      'https://awaodori.kasanetalk.net:7891',
      'https://eisa.kasanetalk.net:7891',
      'https://gion.kasanetalk.net:7891',
      'https://hanabi.kasanetalk.net:7891',
      'https://kanda.kasanetalk.net:7891',
      'https://sanja.kasanetalk.net:7891',
      'https://tanabata.kasanetalk.net:7891',
      'https://tenjin.kasanetalk.net:7891',
      'https://yamakasa.kasanetalk.net:7891',
      'https://yosakoi.kasanetalk.net:7891',
      'https://arasio.tsvr.net:7891',
      'https://mosio.tsvr.net:7891',
      'https://norisio.tsvr.net:7891',
      'https://sioramen.tsvr.net:7891',
      'https://sioyakisoba.tsvr.net:7891',
      'https://siomusubi.tsvr.net:7891',
      'https://tenpisio.tsvr.net:7891',
      'https://umasio.tsvr.net:7891',
      'https://ususio.tsvr.net:7891',
      'https://wasabisio.tsvr.net:7891',
      'https://yakisio.tsvr.net:7891',
      'https://yukisio.tsvr.net:7891',
      'https://siobeef.tsvr.net:7891',
      'https://nem01.symbol-node.com:7891',
      'https://nem01a.symbol-node.com:7891',
      'https://nem02.symbol-node.com:7891',
      'https://nem03.symbol-node.com:7891',
      'https://nem04.symbol-node.com:7891',
      'https://nem05.symbol-node.com:7891',
      'https://nem06.symbol-node.com:7891',
      'https://nem07.symbol-node.com:7891',
      'https://nem08.symbol-node.com:7891',
      'https://nem09.symbol-node.com:7891',
      'https://nem10.symbol-node.com:7891',
      'https://nem01.neluta.win:7891',
      'https://nem02.neluta.win:7891',
      'https://nem03.neluta.win:7891',
      'https://nem04.neluta.win:7891',
      'https://nem06.neluta.win:7891',
      'https://nem07.neluta.win:7891',
      'https://nem08.neluta.win:7891',
      'https://rn.nemnesia.com:7891',
      'https://super-nem.love:7891',
      'https://luna2.dusanjp.com:7891',
      'https://1n.dusanjp.com:7891',
      'https://2n.dusanjp.com:7891',
      'https://sika.dusanjp.com:7891',
      'https://sakia.nis1.harvestasya.com:7891',
      'https://symbol.from.nagoya:7891',
      'https://symbolism.from.nagoya:7891',
    ],
    explorer: 'https://explorer.nemtool.com',
  },
  testnet: {
    key: 'testnet',
    label: 'Testnet',
    networkByte: 0x98,
    networkId: -104,
    // The public NEM testnet nodes only speak plain HTTP, so there is nothing to pick
    // automatically: enter an HTTPS testnet node under Settings.
    fallbackNodes: [],
    explorer: 'https://testnet-explorer.nemtool.com',
  },
};

// Public list of live NIS1 nodes (HTML page; each HTTPS node is linked as https://host:7891/chain/height).
export const NEM_NODE_LIST_PAGE_URL = 'https://nemnodes.org/nodes/';

// Official list of active supernodes (JSON); used, when reachable, to find more HTTPS nodes.
export const NEM_SUPERNODE_LIST_URL = 'https://supernodes.nem.io/nodes';

export const NEM_CURRENCY_SYMBOL = 'XEM';
export const NEM_CURRENCY_DIVISIBILITY = 6;
// The id this app uses for XEM in asset lists ("namespace:name" of the NEM mosaic).
export const NEM_NATIVE_ID = 'nem:xem';

// NIS1 timestamps count seconds from 2015-03-29 00:06:25 UTC.
export const NEM_EPOCH_SECONDS = 1427587585;

export const NEM_TX_TYPE_TRANSFER = 0x101; // 257
export const NEM_TX_TYPE_MULTISIG = 0x1004; // 4100
export const NEM_TX_TYPE_IMPORTANCE_TRANSFER = 0x801; // 2049 (delegated harvesting: activate / deactivate a remote account)

// Harvesting needs at least 10,000 vested XEM (micro-XEM).
export const NEM_MIN_HARVEST_VESTED = 10_000_000_000n;

// A NEM plain message holds up to 1024 bytes.
export const NEM_MAX_MESSAGE_BYTES = 1024;
