// Links the person adds to the link collection themselves (new tools and sites keep appearing).
// Each link is placed on NEM only, Symbol only, or both; stored only in this browser (store/customLinksStore.ts).
import type { ChainKey } from './chain';

/** Where a link is shown: one chain, or both. */
export type LinkScope = ChainKey | 'both';

export const LINK_SCOPES: LinkScope[] = ['both', 'symbol', 'nem'];

export interface CustomLink {
  id: string;
  title: string;
  url: string;
  scope: LinkScope;
}

export const isLinkScope = (v: unknown): v is LinkScope => v === 'symbol' || v === 'nem' || v === 'both';

/** True when the link is placed on the given chain. */
export const linkShownOn = (link: CustomLink, chain: ChainKey): boolean => link.scope === 'both' || link.scope === chain;

export const CUSTOM_LINK_LIMITS = { max: 50, title: 60, url: 500 } as const;

/**
 * Cleans what was typed into the URL box. A missing scheme gets "https://" ("nemscan.io" works); only
 * http(s) addresses are accepted - never "javascript:" or similar. Returns null when it is not a usable address.
 */
export function normalizeLinkUrl(input: string): string | null {
  let text = input.trim();
  if (text === '' || text.length > CUSTOM_LINK_LIMITS.url || /\s/.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // "javascript:alert(1)" and "data:..." have a scheme without "//": refuse them instead of making them look like a host.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]*:\d+(\/|$)/.test(text)) return null;
    text = `https://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A real address has a dot ("example.com"), or is localhost / an IPv6 address.
  if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[')) return null;
  return url.toString();
}

/** The name shown when none is typed: the site's host name. */
export function defaultLinkTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function newLinkId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
