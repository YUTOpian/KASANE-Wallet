// 'mijin' is mijin v2 (Catapult): a private-chain product whose parameters (generation hash, epoch,
// currency mosaic, nodes) differ per deployment, so they are not fixed here - the person enters a node
// and KASANE reads them from it (see lib/symbol/mijin.ts). Symbol chain only; NEM has no mijin v2.
export type SymbolNetwork = 'mainnet' | 'testnet' | 'mijin';
export type PublicNetwork = Exclude<SymbolNetwork, 'mijin'>;

export const SYMBOL_NETWORKS: SymbolNetwork[] = ['mainnet', 'testnet', 'mijin'];
export const MIJIN_NETWORK_BYTE = 0x60; // mijin (0x90 = mijin-test, also accepted: the node says which one it is)
export const MIJIN_TEST_NETWORK_BYTE = 0x90;

export interface NetworkConfig {
  key: SymbolNetwork;
  label: string;
  networkByte: number; // 0x68 / 0x98 (mijin v2: 0x60 / 0x90)
  generationHash: string;
  epochAdjustment: number; // seconds since unix epoch of the nemesis block
  currencyMosaicId: string; // XYM mosaic id on this network
  statisticsService: string; // public node directory
  fallbackNodes: string[];
  explorer: string;
}

// XYM is also reachable through the namespace alias `symbol.xym`, which REST responses use
// for unresolved mosaics. The alias id is the same on both networks.
export const XYM_NAMESPACE_ID = 'E74B99BA41F4AFEE';

export const NETWORKS: Record<SymbolNetwork, NetworkConfig> = {
  mainnet: {
    key: 'mainnet',
    label: 'Mainnet',
    networkByte: 0x68,
    generationHash: '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6',
    epochAdjustment: 1615853185,
    currencyMosaicId: '6BED913FA20223F8',
    statisticsService: 'https://symbol.services',
    fallbackNodes: [
      'https://symbolnode.blockchain-authn.app:3001',
      'https://symbol-mikun.net:3001',
      'https://sym-main-01.opening-line.jp:3001',
    ],
    explorer: 'https://symbol.fyi',
  },
  testnet: {
    key: 'testnet',
    label: 'Testnet',
    networkByte: 0x98,
    generationHash: '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4',
    epochAdjustment: 1667250467,
    currencyMosaicId: '72C0212E67A08BCE',
    statisticsService: 'https://testnet.symbol.services',
    fallbackNodes: [
      'https://sym-test-01.opening-line.jp:3001',
      'https://001-sai-dual.symboltest.net:3001',
    ],
    explorer: 'https://testnet.symbol.fyi',
  },
  // Defaults of an unconfigured mijin v2 network. generationHash '' = not connected yet; the real values
  // are read from the person's node and layered on top by getNetworkConfig('mijin').
  mijin: {
    key: 'mijin',
    label: 'mijin',
    networkByte: MIJIN_NETWORK_BYTE,
    generationHash: '',
    epochAdjustment: 0,
    currencyMosaicId: '',
    statisticsService: '',
    fallbackNodes: [],
    explorer: '',
  },
};

export const CURRENCY_SYMBOL = 'XYM';
export const CURRENCY_DIVISIBILITY = 6;

export const TX_TYPE_TRANSFER = 0x4154;
export const TX_TYPE_AGGREGATE_COMPLETE = 0x4141;
export const TX_TYPE_AGGREGATE_BONDED = 0x4241;

// Fallback for the one-off mosaic rental fee (500 XYM) when the node's /network/fees/rental is unreachable.
export const DEFAULT_MOSAIC_RENTAL_FEE = 500_000_000n;
