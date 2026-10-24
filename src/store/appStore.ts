import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import i18n from '../i18n';
import type { AppLanguage } from '../i18n/languages';
import { resolveNode } from '../lib/symbol/api';
import { setNetwork, setCustomNodeUrl, setSavedNodes, setAutoSwitch, setMijinParams } from '../lib/symbol/network';
import type { MijinParams } from '../lib/symbol/network';
import type { PublicNetwork, SymbolNetwork } from '../lib/symbol/constants';
import { setChain as setModuleChain } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { setNemCustomNodeUrl } from '../lib/nem/network';
import type { TransactionWrapper } from '../lib/transactionWrapper';
import { FEE_SPEED_FALLBACK, isFeeSpeed, setDefaultFeeSpeed as setModuleDefaultFeeSpeed } from '../lib/symbol/feeSpeed';
import type { FeeSpeed } from '../lib/symbol/feeSpeed';
import { MAX_CUSTOM_THEMES, newThemeId, sanitizeCustomTheme, sanitizeSavedThemes } from '../theme/customTheme';
import type { CustomThemeData, SavedCustomTheme } from '../theme/customTheme';

/** One more mosaic of the transfer being composed: its id (16 hex chars) and the amount typed for it. */
export interface SendExtraMosaic {
  id: string;
  amount: string;
}

export type { AppLanguage };

// Which section of Home is expanded (null = all collapsed). Kept in the store so coming back to
// Home from the address book picker / the send confirmation screen shows the same section.
export type HomePanel = 'mosaics' | 'invoice' | 'send' | 'apostille' | 'history' | 'network' | null;

// Colour scheme of the whole app. 'dark' (the KASANE stage, the default), 'light' (white), 'business'
// (a flat, calm look made for work; see theme/kasaneTheme.ts), 'blossom' or 'custom' (the person's own CSS, see theme/customTheme.ts).
export type ThemeMode = 'dark' | 'light' | 'business' | 'blossom' | 'custom';

interface AppState {
  // Recipient of the transfer being composed (a normalized Symbol address, or '').
  receiverAddress: string;
  transaction: TransactionWrapper | null;
  // Symbol network the whole app talks to. Addresses differ per network ("N..." / "T...").
  network: SymbolNetwork;
  // Which blockchain the app works with: Symbol or NEM (picked from the logo in the side menu).
  chain: ChainKey;
  // Optional hand-entered REST node per network ('' = pick one automatically).
  customNodes: Record<SymbolNetwork, string>;
  // Symbol: the registered nodes per network (設定 > ノード管理). customNodes above is the one picked.
  symbolNodeLists: Record<SymbolNetwork, string[]>;
  // Symbol: switch to another node by itself when the picked one stops answering.
  autoSwitchNode: boolean;
  // The same for NEM (NIS1) nodes.
  nemCustomNodes: Record<PublicNetwork, string>;
  // mijin v2 (Catapult): what was read from the person's node (null = not set up yet). Symbol chain only.
  mijinParams: MijinParams | null;
  language: AppLanguage;
  themeMode: ThemeMode;
  // カスタムテーマ: up to 10 themes read from the person's uploaded CSS (checked and normalised), and the one that 'custom' shows.
  customThemes: SavedCustomTheme[];
  customThemeId: string | null;
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
  // Fee level chosen for the transfer being composed (null = not picked: the default below).
  sendFeeSpeed: FeeSpeed | null;
  // 手数料の既定値 (設定): the fee level used when nothing else is picked - the preselected level of
  // every fee picker and the level of transactions that offer no choice. Symbol only.
  defaultFeeSpeed: FeeSpeed;
  homePanel: HomePanel;
  // Live updates from the node (Symbol): bumped when something happened so open screens reload.
  liveTick: number;
  // Play the sounds for new transactions (the one for a new transaction and the one for a confirmed one together; on by default).
  liveSound: boolean;
  // Symbol: also list the transactions of the multisig accounts this wallet cosigns in 履歴 (off by default).
  showMultisigHistory: boolean;
  // Symbol: may signature requests (cosign) from addresses that are not in the address book be signed? true = yes, with a warning (as before).
  allowUnknownSigners: boolean;

  setReceiverAddress: (address: string) => void;
  clearReceiverAddress: () => void;
  setTransaction: (transaction: TransactionWrapper) => void;
  setNetwork: (network: SymbolNetwork) => void;
  setCustomNode: (network: SymbolNetwork, url: string) => void;
  setNemCustomNode: (network: PublicNetwork, url: string) => void;
  setMijinParams: (params: MijinParams | null) => void;
  addSymbolNode: (network: SymbolNetwork, url: string) => void;
  removeSymbolNode: (network: SymbolNetwork, url: string) => void;
  setAutoSwitchNode: (on: boolean) => void;
  setChain: (chain: ChainKey) => void;
  setLanguage: (language: AppLanguage) => void;
  setThemeMode: (mode: ThemeMode) => void;
  // Saves a custom theme: a new one (no id; null comes back when 10 are already saved) or a replacement of the one with `id`.
  // Returns the id it was saved under. The saved theme becomes the one 'custom' shows (it does not switch the theme mode).
  saveCustomTheme: (theme: CustomThemeData, id?: string) => string | null;
  // Makes this saved theme the one in use: the theme mode becomes 'custom'.
  selectCustomTheme: (id: string) => void;
  renameCustomTheme: (id: string, name: string) => void;
  // Deletes a saved theme. If it was the one shown, the next saved theme is shown instead; with none left, 'custom' goes back to dark.
  removeCustomTheme: (id: string) => void;
  setSendMosaicId: (id: string) => void;
  setSendAmount: (amount: string) => void;
  setSendMessage: (message: string) => void;
  setSendEncrypt: (encrypt: boolean) => void;
  setSendExtraMosaics: (lines: SendExtraMosaic[]) => void;
  setSendFeeSpeed: (speed: FeeSpeed) => void;
  setDefaultFeeSpeed: (speed: FeeSpeed) => void;
  clearSendDraft: () => void;
  setHomePanel: (panel: HomePanel) => void;
  bumpLiveTick: () => void;
  setLiveSound: (on: boolean) => void;
  setShowMultisigHistory: (on: boolean) => void;
  setAllowUnknownSigners: (on: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      receiverAddress: '',
      transaction: null,
      network: 'mainnet',
      chain: 'symbol',
      customNodes: { mainnet: '', testnet: '', mijin: '' },
      nemCustomNodes: { mainnet: '', testnet: '' },
      mijinParams: null,
      symbolNodeLists: { mainnet: [], testnet: [], mijin: [] },
      autoSwitchNode: true,
      language: 'ja',
      themeMode: 'dark', // KASANE is a dark design; people who already picked a mode keep it
      customThemes: [],
      customThemeId: null,
      sendMosaicId: '',
      sendAmount: '',
      sendMessage: '',
      sendEncrypt: false,
      sendExtraMosaics: [],
      sendFeeSpeed: null,
      defaultFeeSpeed: FEE_SPEED_FALLBACK,
      homePanel: 'history',
      liveTick: 0,
      liveSound: true,
      showMultisigHistory: false,
      allowUnknownSigners: true,

      setReceiverAddress: (address) => set({ receiverAddress: address }),
      clearReceiverAddress: () => set({ receiverAddress: '' }),
      setTransaction: (transaction) => set({ transaction }),
      setNetwork: (network) => {
        // mijin v2 exists on the Symbol chain only: leave NEM when switching to it.
        const leaveNem = network === 'mijin' && get().chain === 'nem';
        if (leaveNem) setModuleChain('symbol');
        setNetwork(network);
        // Pick this network's node right away, so the first screen after the switch does not wait for it.
        if (network !== 'mijin' && (leaveNem || get().chain === 'symbol')) void resolveNode().catch(() => undefined);
        // Cached lists belong to the previous network.
        set({ network, ...(leaveNem ? { chain: 'symbol' as const, homePanel: 'history' as const } : {}), receiverAddress: '', sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendMosaicId: '' });
      },
      setCustomNode: (network, url) => {
        setCustomNodeUrl(network, url);
        set((state) => ({ customNodes: { ...state.customNodes, [network]: url.trim().replace(/\/+$/, '') } }));
      },
      addSymbolNode: (network, url) => {
        const clean = url.trim().replace(/\/+$/, '');
        if (!clean) return;
        set((state) => {
          const list = state.symbolNodeLists[network] ?? [];
          if (list.includes(clean)) return state;
          const next = { ...state.symbolNodeLists, [network]: [...list, clean] };
          setSavedNodes(network, next[network]);
          return { symbolNodeLists: next };
        });
      },
      removeSymbolNode: (network, url) => {
        set((state) => {
          const next = { ...state.symbolNodeLists, [network]: (state.symbolNodeLists[network] ?? []).filter((u) => u !== url) };
          setSavedNodes(network, next[network]);
          return { symbolNodeLists: next };
        });
        // Removing the node in use goes back to the automatic choice.
        if (get().customNodes[network] === url) get().setCustomNode(network, '');
      },
      setAutoSwitchNode: (on) => {
        setAutoSwitch(on);
        set({ autoSwitchNode: on });
      },
      setNemCustomNode: (network, url) => {
        setNemCustomNodeUrl(network, url);
        set((state) => ({ nemCustomNodes: { ...state.nemCustomNodes, [network]: url.trim().replace(/\/+$/, '') } }));
      },
      setMijinParams: (params) => {
        setMijinParams(params);
        // Cached lists / the transfer being composed belong to the previous parameters.
        set({ mijinParams: params, receiverAddress: '', sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendMosaicId: '' });
      },
      setChain: (chain) => {
        if (chain === 'nem' && get().network === 'mijin') return; // NEM has no mijin v2
        setModuleChain(chain);
        // Everything of the transfer being composed and the cached history belong to one chain.
        set({ chain, receiverAddress: '', sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendMosaicId: '', sendFeeSpeed: null, homePanel: 'history' });
      },
      setLanguage: (language) => {
        i18n.changeLanguage(language);
        set({ language });
      },
      setThemeMode: (themeMode) => set({ themeMode }),
      saveCustomTheme: (theme, id) => {
        const state = get();
        const existing = id ? state.customThemes.find((t) => t.id === id) : undefined;
        if (!existing && state.customThemes.length >= MAX_CUSTOM_THEMES) return null;
        const saved: SavedCustomTheme = { ...theme, id: existing ? existing.id : newThemeId() };
        set({
          customThemes: existing ? state.customThemes.map((t) => (t.id === saved.id ? saved : t)) : [...state.customThemes, saved],
          customThemeId: saved.id,
        });
        return saved.id;
      },
      selectCustomTheme: (id) => set((state) => (state.customThemes.some((t) => t.id === id) ? { customThemeId: id, themeMode: 'custom' } : {})),
      renameCustomTheme: (id, name) => set((state) => ({ customThemes: state.customThemes.map((t) => (t.id === id ? { ...t, name: name.trim().slice(0, 40) } : t)) })),
      removeCustomTheme: (id) => set((state) => {
        const customThemes = state.customThemes.filter((t) => t.id !== id);
        const customThemeId = state.customThemeId === id ? (customThemes[0]?.id ?? null) : state.customThemeId;
        return { customThemes, customThemeId, themeMode: state.themeMode === 'custom' && customThemes.length === 0 ? 'dark' : state.themeMode };
      }),
      setSendMosaicId: (id) => set({ sendMosaicId: id }),
      setSendAmount: (amount) => set({ sendAmount: amount }),
      setSendMessage: (message) => set({ sendMessage: message }),
      setSendEncrypt: (encrypt) => set({ sendEncrypt: encrypt }),
      setSendExtraMosaics: (lines) => set({ sendExtraMosaics: lines }),
      setSendFeeSpeed: (speed) => set({ sendFeeSpeed: speed }),
      setDefaultFeeSpeed: (speed) => {
        if (!isFeeSpeed(speed)) return;
        setModuleDefaultFeeSpeed(speed);
        set({ defaultFeeSpeed: speed });
      },
      clearSendDraft: () => set({ sendAmount: '', sendMessage: '', sendEncrypt: false, sendExtraMosaics: [], sendFeeSpeed: null }),
      setHomePanel: (panel) => set({ homePanel: panel }),
      bumpLiveTick: () => set((state) => ({ liveTick: state.liveTick + 1 })),
      setLiveSound: (liveSound) => set({ liveSound }),
      setShowMultisigHistory: (showMultisigHistory) => set({ showMultisigHistory }),
      setAllowUnknownSigners: (allowUnknownSigners) => set({ allowUnknownSigners }),
    }),
    {
      name: 'vintage-symbol-wallet-app-store',
      // v2: the default theme became dark (KASANE). Saved v1 data still holds the old default
      // ('light'), so move it to dark once; the choice in 設定 > テーマ is kept from then on.
      // v3: the 'mijin' network (mijin v2 / Catapult) was added next to mainnet / testnet.
      version: 3,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) state.themeMode = 'dark';
        if (version < 3) {
          state.customNodes = { mijin: '', ...(state.customNodes as object) };
          state.symbolNodeLists = { mijin: [], ...(state.symbolNodeLists as object) };
          state.mijinParams = null;
        }
        return state as never;
      },
      // Whatever is in localStorage (older builds, hand edits, partial data) is normalised here, so a missing
      // or malformed node list can never reach the screens (it used to crash 設定 with "a is not iterable").
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        const lists = (saved.symbolNodeLists ?? {}) as Partial<Record<SymbolNetwork, unknown>>;
        const toList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : []);
        // The saved カスタムテーマ are checked again (a hand-edited or damaged value is dropped); without one, 'custom' falls back to dark.
        // Builds before v208 kept a single `customTheme`: it becomes the first of the list.
        const legacy = sanitizeCustomTheme((saved as { customTheme?: unknown }).customTheme);
        const customThemes = sanitizeSavedThemes(saved.customThemes ?? (legacy ? [legacy] : []));
        const customThemeId = customThemes.some((t) => t.id === saved.customThemeId) ? (saved.customThemeId as string) : (customThemes[0]?.id ?? null);
        return {
          ...current,
          ...saved,
          customThemes,
          customThemeId,
          themeMode: saved.themeMode === 'custom' && customThemes.length === 0 ? 'dark' : (saved.themeMode ?? current.themeMode),
          symbolNodeLists: {
            mainnet: toList(lists.mainnet),
            testnet: toList(lists.testnet),
            mijin: toList(lists.mijin),
          },
        } as AppState;
      },
      storage: createJSONStorage(() => localStorage),
      // Everything transient (the transfer being composed, caches) resets on reload.
      partialize: (state) => ({
        network: state.network,
        chain: state.chain,
        customNodes: state.customNodes,
        nemCustomNodes: state.nemCustomNodes,
        mijinParams: state.mijinParams,
        symbolNodeLists: state.symbolNodeLists,
        autoSwitchNode: state.autoSwitchNode,
        language: state.language,
        themeMode: state.themeMode,
        customThemes: state.customThemes,
        customThemeId: state.customThemeId,
        liveSound: state.liveSound,
        showMultisigHistory: state.showMultisigHistory,
        allowUnknownSigners: state.allowUnknownSigners,
        defaultFeeSpeed: state.defaultFeeSpeed,
      }),
      // chains/network modules keep module-level copies (plain functions can't read the store),
      // so push the persisted values into them once rehydrated.
      onRehydrateStorage: () => (state) => {
        // mijin v2's parameters first: the network below may be mijin and its config is read from them.
        setMijinParams(state?.mijinParams ?? null);
        if (state?.network) setNetwork(state.network);
        if (state?.chain) setModuleChain(state.chain);
        if (state?.nemCustomNodes) {
          setNemCustomNodeUrl('mainnet', state.nemCustomNodes.mainnet ?? '');
          setNemCustomNodeUrl('testnet', state.nemCustomNodes.testnet ?? '');
        }
        if (state?.customNodes) {
          setCustomNodeUrl('mainnet', state.customNodes.mainnet ?? '');
          setCustomNodeUrl('testnet', state.customNodes.testnet ?? '');
          setCustomNodeUrl('mijin', state.customNodes.mijin ?? '');
        }
        if (state?.symbolNodeLists) {
          setSavedNodes('mainnet', state.symbolNodeLists.mainnet ?? []);
          setSavedNodes('testnet', state.symbolNodeLists.testnet ?? []);
          setSavedNodes('mijin', state.symbolNodeLists.mijin ?? []);
        }
        if (typeof state?.autoSwitchNode === 'boolean') setAutoSwitch(state.autoSwitchNode);
        if (state?.language) i18n.changeLanguage(state.language);
        if (state && isFeeSpeed(state.defaultFeeSpeed)) setModuleDefaultFeeSpeed(state.defaultFeeSpeed);
      },
    }
  )
);

/** 'custom' が見せるテーマ：選んであるもの、なければ先頭。保存がなければ null。 */
export const selectActiveCustomTheme = (state: Pick<AppState, 'customThemes' | 'customThemeId'>): SavedCustomTheme | null =>
  state.customThemes.find((t) => t.id === state.customThemeId) ?? state.customThemes[0] ?? null;
