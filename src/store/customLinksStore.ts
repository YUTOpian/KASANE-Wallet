// The person's own links, each placed on NEM only, Symbol only, or both. Saved in this browser only (localStorage), never sent anywhere.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ChainKey } from '../lib/chain';
import { CUSTOM_LINK_LIMITS, defaultLinkTitle, isLinkScope, linkShownOn, newLinkId, normalizeLinkUrl } from '../lib/customLinks';
import type { CustomLink, LinkScope } from '../lib/customLinks';

export type CustomLinkError = 'url' | 'limit';

interface CustomLinksState {
  links: CustomLink[];
  /** Adds a link; the address is cleaned (see normalizeLinkUrl). Returns an error name, or null when saved. */
  addLink: (scope: LinkScope, title: string, url: string) => CustomLinkError | null;
  updateLink: (id: string, scope: LinkScope, title: string, url: string) => CustomLinkError | null;
  removeLink: (id: string) => void;
}

const clean = (title: string, url: string): { title: string; url: string } | null => {
  const normalized = normalizeLinkUrl(url);
  if (normalized === null) return null;
  return { title: title.trim().slice(0, CUSTOM_LINK_LIMITS.title) || defaultLinkTitle(normalized), url: normalized };
};

const CHAIN_KEYS: ChainKey[] = ['symbol', 'nem'];

/** The limit is per chain: a link placed on both counts toward both. */
const overLimit = (links: CustomLink[], scope: LinkScope, ignoreId?: string): boolean => {
  const chains = scope === 'both' ? CHAIN_KEYS : [scope];
  return chains.some((c) => links.filter((l) => l.id !== ignoreId && linkShownOn(l, c)).length >= CUSTOM_LINK_LIMITS.max);
};

const wellFormed = (l: unknown): l is CustomLink => {
  const x = l as Partial<CustomLink> | null;
  return !!x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.url === 'string' && isLinkScope(x.scope) && normalizeLinkUrl(x.url) !== null;
};

export const useCustomLinksStore = create<CustomLinksState>()(
  persist(
    (set, get) => ({
      links: [],
      addLink: (scope, title, url) => {
        const item = clean(title, url);
        if (!item) return 'url';
        if (overLimit(get().links, scope)) return 'limit';
        set({ links: [...get().links, { ...item, id: newLinkId(), scope }] });
        return null;
      },
      updateLink: (id, scope, title, url) => {
        const item = clean(title, url);
        if (!item) return 'url';
        if (overLimit(get().links, scope, id)) return 'limit';
        set({ links: get().links.map((l) => (l.id === id ? { ...item, id, scope } : l)) });
        return null;
      },
      removeLink: (id) => set({ links: get().links.filter((l) => l.id !== id) }),
    }),
    {
      name: 'kasane-custom-links',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ links: state.links }),
      // v1 kept one list per chain ({ symbol: [...], nem: [...] }): each old link becomes a link placed on that chain only.
      migrate: (persisted) => {
        const saved = (persisted as { links?: unknown } | undefined)?.links;
        if (Array.isArray(saved)) return { links: saved };
        const old = (saved ?? {}) as Partial<Record<ChainKey, unknown>>;
        const links: unknown[] = [];
        for (const chain of CHAIN_KEYS) {
          const list = old[chain];
          if (Array.isArray(list)) links.push(...list.map((l) => ({ ...(l as object), scope: chain })));
        }
        return { links };
      },
      // A hand-edited or damaged saved value must not break the screen: keep only well-formed links.
      merge: (persisted, current) => {
        const saved = (persisted as { links?: unknown } | undefined)?.links;
        return { ...current, links: Array.isArray(saved) ? saved.filter(wellFormed) : [] };
      },
    },
  ),
);
