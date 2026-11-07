import { create } from 'zustand';
import type { AggregateItem } from '../lib/symbol/aggregate';

// The aggregate being put together (not persisted: it is only a draft). Mosaic and namespace ids depend on the
// owner's address, so the draft is dropped when the wallet or the network changes (see `bind`).
interface AggregateState {
  ownerKey: string;
  items: AggregateItem[];
  /** Starts a fresh draft when the stored one belongs to a different wallet / network than `key`. */
  bind: (key: string) => void;
  add: (item: AggregateItem) => void;
  remove: (uids: string[]) => void;
  clear: () => void;
}

export const useAggregateStore = create<AggregateState>((set) => ({
  ownerKey: '',
  items: [],
  bind: (key) => set((s) => (s.ownerKey === key ? s : { ownerKey: key, items: [] })),
  add: (item) => set((s) => ({ items: [...s.items, item] })),
  remove: (uids) => set((s) => ({ items: s.items.filter((i) => !uids.includes(i.uid)) })),
  clear: () => set({ items: [] }),
}));
