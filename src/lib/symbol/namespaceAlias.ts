// Pure rules for linking / unlinking a namespace alias from its own screen (no network, no SDK), shared by the
// form and the tests. A namespace can be linked while it is not expired and has no alias yet; it can be unlinked
// while it has one. An address alias can point at the owner's own address only, a mosaic alias at a mosaic the
// owner created (the signer must own both sides).
import type { AliasAction, AliasTarget } from './tx';

export interface AliasNamespace {
  expired: boolean;
  aliasType: 'none' | 'mosaic' | 'address';
  alias: string; // mosaic id (hex) / address (base32); '' without an alias
}

export interface AliasMosaic {
  createdByMe: boolean;
  expired: boolean;
}

/** What can be done with this namespace now: 'link', 'unlink', or null (expired). */
export function aliasActionFor(ns: AliasNamespace): AliasAction | null {
  if (ns.expired) return null;
  return ns.aliasType === 'none' || ns.alias === '' ? 'link' : 'unlink';
}

/** Mosaics that can be the target of a mosaic alias. */
export const isAliasableMosaic = (m: AliasMosaic): boolean => m.createdByMe && !m.expired;

/** The target an unlink must name: exactly what is linked now (null when nothing is linked). */
export function currentAliasTarget(ns: AliasNamespace): AliasTarget | null {
  if (ns.alias === '') return null;
  if (ns.aliasType === 'mosaic') return { type: 'mosaic', mosaicId: ns.alias };
  if (ns.aliasType === 'address') return { type: 'address', address: ns.alias };
  return null;
}
