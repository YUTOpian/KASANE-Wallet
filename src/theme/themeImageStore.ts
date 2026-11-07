import localForage from 'localforage';
import { sanitizeImages } from './customTheme';
import type { CustomImages } from './customTheme';

// カスタムテーマの画像（data:URI）は、localStorage（5MB ほど）ではなく IndexedDB に置く。テーマの id が鍵。
// ウォレット本体のデータベース（lib/storage.ts）とは別にして、ここで何かあってもウォレットには触れないようにする。
const store = localForage.createInstance({ name: 'KasaneThemeImages', storeName: 'theme_images' });

/** 画像を置く。画像が無ければ消す。置けたら true（IndexedDB が使えないときは false: 呼ぶ側が localStorage に残す）。 */
export async function saveThemeImages(id: string, images: CustomImages | undefined): Promise<boolean> {
  try {
    if (images && Object.keys(images).length > 0) await store.setItem(id, images);
    else await store.removeItem(id);
    return true;
  } catch (e) {
    console.warn('Failed to save the theme images', e);
    return false;
  }
}

/** 置いてある画像を読む（読み直して検証する）。無ければ null、読めなければ undefined。 */
export async function loadThemeImages(id: string): Promise<CustomImages | null | undefined> {
  try {
    const raw = await store.getItem<unknown>(id);
    if (raw === null || raw === undefined) return null;
    const images = sanitizeImages(raw);
    return Object.keys(images).length > 0 ? images : null;
  } catch (e) {
    console.warn('Failed to load the theme images', e);
    return undefined;
  }
}

export async function removeThemeImages(id: string): Promise<void> {
  try { await store.removeItem(id); } catch (e) { console.warn('Failed to remove the theme images', e); }
}

/** 消したテーマの画像が残らないように、いまあるテーマの id 以外を消す。 */
export async function pruneThemeImages(keepIds: readonly string[]): Promise<void> {
  try {
    const keep = new Set(keepIds);
    for (const key of await store.keys()) if (!keep.has(key)) await store.removeItem(key);
  } catch (e) {
    console.warn('Failed to clean the theme images', e);
  }
}
