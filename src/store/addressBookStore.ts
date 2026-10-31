// アドレス帳の状態と保存。連絡先はプロファイルとは別に、この端末のブラウザ（IndexedDB など、ウォレットと同じ場所）に
// 保存する。ネットワークには送らない。プロファイルを切り替えても同じアドレス帳を使う。
import { create } from 'zustand';
import localForage from 'localforage';
import { parseWatchAddress } from '../lib/watchAddress';
import {
  LIMITS, findEntry, keyOf, mergeImported, newId, normalizeList, parseBackup, serializeBackup, validateContact,
} from '../lib/addressBook';
import type { AddressBookEntry, ContactError, ContactInput, ContactList, ImportMode, MergeResult, ParsedBackup } from '../lib/addressBook';
import type { ChainKey } from '../lib/chain';
import type { AddressNetwork } from '../lib/addressBook';

const STORAGE_KEY = 'ADDRESS_BOOK';

interface StoredDoc {
  version: 1;
  entries: AddressBookEntry[];
  /** ブロックしたアドレスの取引を履歴から隠す。 */
  hideBlocked: boolean;
  /** 「保存しますか」を今後出さないアドレス（entryKey）。 */
  dismissed: string[];
}

export type SaveResult = { ok: true; entry: AddressBookEntry } | { ok: false; error: ContactError };

interface AddressBookState {
  entries: AddressBookEntry[];
  hideBlocked: boolean;
  dismissed: string[];
  loaded: boolean;

  load: () => Promise<void>;
  addContact: (input: ContactInput) => Promise<SaveResult>;
  updateContact: (id: string, input: ContactInput) => Promise<SaveResult>;
  removeContact: (id: string) => Promise<void>;
  /** アドレス帳に無いアドレスでも、リストだけ指定して登録する（ブロック・信頼する相手に追加）。 */
  setList: (address: string, list: ContactList, name?: string) => Promise<SaveResult>;
  setHideBlocked: (hide: boolean) => Promise<void>;
  dismissSavePrompt: (chain: ChainKey, network: AddressNetwork, address: string) => Promise<void>;
  exportJson: () => string;
  /** インポートの下見（保存はしない）。 */
  readBackup: (text: string) => ParsedBackup;
  applyBackup: (incoming: AddressBookEntry[], mode: ImportMode) => Promise<MergeResult>;
}

let loading: Promise<void> | null = null;

export const useAddressBookStore = create<AddressBookState>()((set, get) => {
  const persist = async (patch: Partial<Pick<AddressBookState, 'entries' | 'hideBlocked' | 'dismissed'>>) => {
    set(patch);
    const { entries, hideBlocked, dismissed } = get();
    const doc: StoredDoc = { version: 1, entries, hideBlocked, dismissed };
    try {
      await localForage.setItem(STORAGE_KEY, doc);
    } catch (e) {
      console.error('Failed to save the address book', e);
    }
  };

  const save = async (id: string | null, input: ContactInput): Promise<SaveResult> => {
    const { entries } = get();
    const result = validateContact(input, entries, parseWatchAddress, id ?? undefined);
    if (!result.ok) return result;
    if (id === null && entries.length >= LIMITS.entries) return { ok: false, error: 'limit' };
    const now = Date.now();
    const old = id !== null ? entries.find((e) => e.id === id) : undefined;
    const entry: AddressBookEntry = { ...result.fields, id: old?.id ?? newId(), createdAt: old?.createdAt ?? now, updatedAt: now };
    await persist({ entries: old ? entries.map((e) => (e.id === old.id ? entry : e)) : [...entries, entry] });
    return { ok: true, entry };
  };

  return {
    entries: [],
    hideBlocked: true,
    dismissed: [],
    loaded: false,

    load: () => {
      if (get().loaded) return Promise.resolve();
      loading ??= (async () => {
        try {
          const raw = (await localForage.getItem(STORAGE_KEY)) as Partial<StoredDoc> | null;
          set({
            // 以前の「通常」（none）の連絡先は、ホワイトリストにそろえる。
            entries: Array.isArray(raw?.entries) ? raw.entries.map((e) => ({ ...e, list: normalizeList(e.list) })) : [],
            hideBlocked: raw?.hideBlocked !== false,
            dismissed: Array.isArray(raw?.dismissed) ? raw.dismissed : [],
            loaded: true,
          });
        } catch (e) {
          console.error('Failed to load the address book', e);
          set({ loaded: true });
        } finally {
          loading = null;
        }
      })();
      return loading;
    },

    addContact: (input) => save(null, input),
    updateContact: (id, input) => save(id, input),

    removeContact: async (id) => {
      await persist({ entries: get().entries.filter((e) => e.id !== id) });
    },

    setList: async (address, list, name = '') => {
      const parsed = parseWatchAddress(address.trim());
      if (!parsed) return { ok: false, error: 'invalid_address' };
      const existing = findEntry(get().entries, parsed.chain, parsed.network, parsed.address);
      if (existing) return save(existing.id, { name: existing.name, address: existing.address, email: existing.email, phone: existing.phone, memo: existing.memo, list });
      return save(null, { name, address: parsed.address, list });
    },

    setHideBlocked: async (hideBlocked) => { await persist({ hideBlocked }); },

    dismissSavePrompt: async (chain, network, address) => {
      const key = keyOf({ chain, network, address });
      if (get().dismissed.includes(key)) return;
      await persist({ dismissed: [...get().dismissed, key].slice(-LIMITS.entries) });
    },

    exportJson: () => serializeBackup(get().entries),
    readBackup: (text) => parseBackup(text, parseWatchAddress),
    applyBackup: async (incoming, mode) => {
      const result = mergeImported(get().entries, incoming, mode);
      await persist({ entries: result.entries });
      return result;
    },
  };
});
