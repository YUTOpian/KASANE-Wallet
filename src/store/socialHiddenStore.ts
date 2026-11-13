// S.M.D（ソーシャルメタデータの一覧）で、見たくない登録を「非表示」にした印。この端末のブラウザ（localStorage）にだけ保存し、
// どこにも送らない。ブロックチェーンの登録そのものは消えない（自分の一覧に出さないだけ）。
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SocialHiddenState {
  /** 非表示にした登録のアドレス。 */
  hidden: string[];
  hide: (address: string) => void;
  unhide: (address: string) => void;
}

export const useSocialHiddenStore = create<SocialHiddenState>()(
  persist(
    (set, get) => ({
      hidden: [],
      hide: (address) => { if (!get().hidden.includes(address)) set({ hidden: [...get().hidden, address] }); },
      unhide: (address) => set({ hidden: get().hidden.filter((a) => a !== address) }),
    }),
    {
      name: 'kasane-social-hidden',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ hidden: state.hidden }),
      // 手で書き換えられた・壊れた保存値で画面が壊れないよう、文字列だけを残す。
      merge: (persisted, current) => {
        const saved = (persisted as { hidden?: unknown } | undefined)?.hidden;
        return { ...current, hidden: Array.isArray(saved) ? saved.filter((a): a is string => typeof a === 'string') : [] };
      },
    },
  ),
);
