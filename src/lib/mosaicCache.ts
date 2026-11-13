import localForage from 'localforage';

// 「オフライン署名」のモザイク選択用に、オンラインのときに確認したモザイク（そのアカウントが持っていたもの）を
// 端末に覚えておく。オフラインの端末にはノードへの問い合わせができないので、モザイクIDを手で入力させる
// 代わりに、ここに覚えたものから選んでもらう。ネットワーク通貨（XYM）は覚える必要がない（常に選べる）。

export interface KnownMosaic {
  id: string; // 16-digit hex mosaic id
  symbol: string; // namespace name, or the id when none is registered
  name: string | null;
  divisibility: number;
}

// The wallet's own database is configured in lib/storage.ts; this one is separate so a problem here can never touch the wallets.
const store = localForage.createInstance({ name: 'KasaneKnownMosaics', storeName: 'known_mosaics' });

// Symbol addresses already differ per network (the network byte is part of them), but the network is part of the key anyway.
const keyOf = (network: string, address: string) => `${network}:${address.replace(/-/g, '').toUpperCase()}`;

export async function saveKnownMosaics(network: string, address: string, list: KnownMosaic[]): Promise<void> {
  try {
    await store.setItem(keyOf(network, address), list);
  } catch (e) {
    // Remembering is a convenience: never let it break the screen that asked for the balance.
    console.warn('Failed to remember the mosaics', e);
  }
}

export async function loadKnownMosaics(network: string, address: string): Promise<KnownMosaic[]> {
  try {
    const list = await store.getItem<KnownMosaic[]>(keyOf(network, address));
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m && /^[0-9A-F]{16}$/.test(m.id) && Number.isInteger(m.divisibility) && m.divisibility >= 0 && m.divisibility <= 6);
  } catch (e) {
    console.warn('Failed to read the remembered mosaics', e);
    return [];
  }
}

// --- NEM ---------------------------------------------------------------------------------------------------------
// NEM (NIS1) mosaics are named "namespace:name" and are priced from their supply and divisibility, so both are kept (the
// offline screen has no node to ask). Kept in the same database as the Symbol ones, under a key of its own.

export interface KnownNemMosaic {
  id: string; // "namespace:name" (lower case)
  divisibility: number;
  supply: string; // whole units, as a decimal string (a bigint cannot be stored)
}

const nemKeyOf = (network: string, address: string) => `nem:${network}:${address.replace(/-/g, '').toUpperCase()}`;

export async function saveKnownNemMosaics(network: string, address: string, list: KnownNemMosaic[]): Promise<void> {
  try {
    await store.setItem(nemKeyOf(network, address), list);
  } catch (e) {
    console.warn('Failed to remember the NEM mosaics', e);
  }
}

export async function loadKnownNemMosaics(network: string, address: string): Promise<KnownNemMosaic[]> {
  try {
    const list = await store.getItem<KnownNemMosaic[]>(nemKeyOf(network, address));
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m && typeof m.id === 'string' && /^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(m.id)
      && Number.isInteger(m.divisibility) && m.divisibility >= 0 && m.divisibility <= 6
      && typeof m.supply === 'string' && /^\d+$/.test(m.supply));
  } catch (e) {
    console.warn('Failed to read the remembered NEM mosaics', e);
    return [];
  }
}
