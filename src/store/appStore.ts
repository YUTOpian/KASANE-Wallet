import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import i18n from '../i18n';
import { setNetwork, setCustomNodeUrl } from '../lib/symbol/network';
import type { SymbolNetwork } from '../lib/symbol/constants';
import { setChain as setModuleChain } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { setNemCustomNodeUrl } from '../lib/nem/network';
import type { TransactionWrapper } from '../lib/transactionWrapper';
import type { FeeSpeed } from '../lib/symbol/api';

/** One more mosaic of the transfer being composed: its id (16 hex chars) and the amount typed for it. */
export interface SendExtraMosaic {
  id: string;
  amount: string;
}

export type AppLanguage = 'ja' | 'en';

// Which section of Home is expanded (null = all collapsed). Kept in the store so coming back to
// Home from the address book picker / the send confirmation screen shows the same section.
export type HomePanel = 'receive' | 'send' | 'history' | 'harvest' | null;

// Colour scheme of the whole app. 'dark' (the KASANE stage, the default) or 'light'.
export type ThemeMode = 'dark' | 'light';

interface AppState {
  // Recipient of the transfer being composed (a normalized Symbol address, or '').
  receiverAddress: string;
  backPathFromWalletSelect: string;
  backPathFromSendConfirmation: string;
  transaction: TransactionWrapper | null;
  // Cache of TransactionList's last successful fetch so navigating away and back shows the
  // previous result instantly. Not persisted.
  transactionListCache: { grouped: Record<string, TransactionWrapper[]>} | null;
  // Symbol network the whole app talks to. Addresses differ per network ("N..." / "T...").
  network: SymbolNetwork;
  // Which blockchain the app works with: Symbol or NEM (picked from the logo in the side menu).
  chain: ChainKey;
  // Optional hand-entered REST node per network ('' = pick one automatically).
  customNodes: Record<SymbolNetwork, string>;
  // The same for NEM (NIS1) nodes.
  nemCustomNodes: Record<SymbolNetwork, string>;
  language: AppLanguage;
  themeMode: ThemeMode;
  // The mosaic the current send flow transfers (16 hex chars); '' = the network's XYM.
  sendMosaicId: string;
  // Amount of that mosaic as a plain decimal string ('' = nothing entered).
  sendAmount: string;
  // Optional plain-text message attached to the transfer.
  sendMessage: string;
  // Further mosaics sent together with the main one (Symbol only); amounts are decimal text.
  sendExtraMosaics: SendExtraMosaic[];
  // Encrypt that message for the recipient (Symbol only; needs the recipient's public key on chain).
  sendEncrypt: boolean;
  // Transaction hash of the most recently announced send, shown/linked on SendComplete.
  // Fee level chosen for the transfer being composed.
  sendFeeSpeed: FeeSpeed;
  lastTxHash: string;
  homePanel: HomePanel;
  // Live updates from the node (Symbol): bumped when something happened so open screens reload.
  liveTick: number;
  // Show a notification / play a sound for new transactions (both on by default).
  liveNotifications: boolean;
  liveSound: boolean;

  setReceiverAddress: (address: string) => void;
  clearReceiverAddress: () => void;
  setBackPathFromWalletSelect: (path: string) => void;
  setBackPathFromSendConfirmation: (path: string) => void;
  setTransaction: (transaction: TransactionWrapper) => void;
  setTransactionListCache: (cache: { grouped: Record<string, TransactionWrapper[]>}) => void;
  setNetwork: (network: SymbolNetwork) => void;
  setCustomNode: (network: SymbolNetwork, url: string) => void;
  setNemCustomNode: (network: SymbolNetwork, url: string) => void;
  setChain: (chain: ChainKey) => void;
  setLanguage: (language: AppLanguage) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setSendMosaicId: (id: string) => void;
  setSendAmount: (amount: string) => void;
  setSendMessage: (message: string) => void;
  setSendEncrypt: (encrypt: boolean) => void;
  setSendExtraMosaics: (lines: SendExtraMosaic[]) => void;
  setSendFeeSpeed: (speed: FeeSpeed) => void;
  clearSendDraft: () => void;
  setLastTxHash: (hash: string) => void;
  setHomePanel: (panel: HomePanel) => void;
  bumpLiveTick: () => void;
  setLiveNotifications: (on: boolean) => void;
  setLiveSound: (on: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      receiverAddress: '',
      backPathFromWalletSelect: '',
      backPathFromSendConfirmation: '',
      transaction: null,
      transactionListCache: null,
      network: 'mainnet',
      chain: 'symbol',
      customNodes: { mainnet: '', testnet: '' },
      nemCustomNodes: { mainnet: '', testnet: '' },
      language: 'ja',
      themeMode: 'dark', // KASANE is a dark design; people who already picked a mode keep it
      sendMosaicId: '',
      sendAmount: '',
      sendMessage: '',
      sendEncrypt: false,
      sendExtraMosaics: [],
      sendFeeSpeed: 'standard',
      lastTxHash: '',
      homePanel: 'history',
      liveTick: 0,
      liveNotifications: true,
      liveSound: true,

      setReceiverAddress: (address) => set({ receiverAddress: address }),
      clearReceiverAddress: () => set({ receiverAddress: '' }),
          setBackPathFromWalletSelect: (path) => set({ backPathFromWalletSelect: path }),
      setBackPathFromSendConfirmation: (path) => set({ backPathFromSendConfirmation: path }),
      setTransaction: (transaction) => set({ transaction }),
      setTransactionListCache: (cache) => set({ transactionListCache: cache }),
      setNetwork: (network) => {
        setNetwork(network);
        // Cached lists belong to the previous network.
        set({ network, transactionListCache: null, receiverAddress: '', sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendMosaicId: '' });
      },
      setCustomNode: (network, url) => {
        setCustomNodeUrl(network, url);
        set((state) => ({ customNodes: { ...state.customNodes, [network]: url.trim().replace(/\/+$/, '') } }));
      },
      setNemCustomNode: (network, url) => {
        setNemCustomNodeUrl(network, url);
        set((state) => ({ nemCustomNodes: { ...state.nemCustomNodes, [network]: url.trim().replace(/\/+$/, '') } }));
      },
      setChain: (chain) => {
        setModuleChain(chain);
        // Everything of the transfer being composed and the cached history belong to one chain.
        set({ chain, transactionListCache: null, receiverAddress: '', sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendMosaicId: '', sendFeeSpeed: 'standard', homePanel: 'history' });
      },
      setLanguage: (language) => {
        i18n.changeLanguage(language);
        set({ language });
      },
      setThemeMode: (themeMode) => set({ themeMode }),
      setSendMosaicId: (id) => set({ sendMosaicId: id }),
      setSendAmount: (amount) => set({ sendAmount: amount }),
      setSendMessage: (message) => set({ sendMessage: message }),
      setSendEncrypt: (encrypt) => set({ sendEncrypt: encrypt }),
      setSendExtraMosaics: (lines) => set({ sendExtraMosaics: lines }),
      setSendFeeSpeed: (speed) => set({ sendFeeSpeed: speed }),
      clearSendDraft: () => set({ sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendFeeSpeed: 'standard' }),
      setLastTxHash: (hash) => set({ lastTxHash: hash }),
      setHomePanel: (panel) => set({ homePanel: panel }),
      bumpLiveTick: () => set((state) => ({ liveTick: state.liveTick + 1 })),
      setLiveNotifications: (liveNotifications) => set({ liveNotifications }),
      setLiveSound: (liveSound) => set({ liveSound }),
    }),
    {
      name: 'vintage-symbol-wallet-app-store',
      // v2: the default theme became dark (KASANE). Saved v1 data still holds the old default
      // ('light'), so move it to dark once; the choice in 設定 > テーマ is kept from then on.
      version: 2,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) state.themeMode = 'dark';
        return state as never;
      },
      storage: createJSONStorage(() => localStorage),
      // Everything transient (the transfer being composed, caches) resets on reload.
      partialize: (state) => ({
        network: state.network,
        chain: state.chain,
        customNodes: state.customNodes,
        nemCustomNodes: state.nemCustomNodes,
        language: state.language,
        themeMode: state.themeMode,
        liveNotifications: state.liveNotifications,
        liveSound: state.liveSound,
      }),
      // chains/network modules keep module-level copies (plain functions can't read the store),
      // so push the persisted values into them once rehydrated.
      onRehydrateStorage: () => (state) => {
        if (state?.network) setNetwork(state.network);
        if (state?.chain) setModuleChain(state.chain);
        if (state?.nemCustomNodes) {
          setNemCustomNodeUrl('mainnet', state.nemCustomNodes.mainnet ?? '');
          setNemCustomNodeUrl('testnet', state.nemCustomNodes.testnet ?? '');
        }
        if (state?.customNodes) {
          setCustomNodeUrl('mainnet', state.customNodes.mainnet ?? '');
          setCustomNodeUrl('testnet', state.customNodes.testnet ?? '');
        }
        if (state?.language) i18n.changeLanguage(state.language);
      },
    }
  )
);
