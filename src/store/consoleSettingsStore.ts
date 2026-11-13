// コンソールの設定。このブラウザにだけ保存する（localStorage）。どこにも送らない。
// コンソールのコードからは見えない（コードに渡る変数ではなく、アプリ側の設定なので、コードは書き換えられない）。
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_CONSOLE_LANG, isConsoleLang } from '../lib/console/tsStrip';
import type { ConsoleLang } from '../lib/console/tsStrip';

/** 通信の保護。すべて true（保護する）が初期値。開発者が必要なときだけ、項目ごとにオフにできる。 */
export interface NetworkProtections {
  /** true: URL に埋め込んだユーザー名・パスワード（https://user:pass@host/）を拒否する。 */
  blockUrlCredentials: boolean;
  /** true: fetch に Cookie（認証情報）を付けない。false: コードの指定（credentials）に従う。 */
  omitCookies: boolean;
  /** true: fetch に参照元（Referer）を付けない。false: コードの指定（referrerPolicy）に従う。 */
  hideReferrer: boolean;
}

export type ProtectionKey = keyof NetworkProtections;
export const PROTECTION_KEYS: readonly ProtectionKey[] = ['blockUrlCredentials', 'omitCookies', 'hideReferrer'];

interface ConsoleSettingsState extends NetworkProtections {
  /**
   * true（初期値）: fetch / WebSocket で、このPC・同じLAN・localhost への通信を止める（いま使っているノードは除く）。リダイレクトも追わない。
   * false: 制限なし（http / https / ws / wss の通信なら、どこへでも送れる）。
   */
  limitNetwork: boolean;
  /** 実行する言語。'js'（初期値）: そのまま動かす。'ts': 型を取り除いてから動かす（型のチェックはしない）。 */
  lang: ConsoleLang;
  setLang: (v: ConsoleLang) => void;
  setLimitNetwork: (v: boolean) => void;
  setProtection: (key: ProtectionKey, v: boolean) => void;
}

export const useConsoleSettingsStore = create<ConsoleSettingsState>()(
  persist(
    (set) => ({
      limitNetwork: true,
      lang: DEFAULT_CONSOLE_LANG,
      setLang: (v) => set({ lang: v }),
      blockUrlCredentials: true,
      omitCookies: true,
      hideReferrer: true,
      setLimitNetwork: (v) => set({ limitNetwork: v }),
      setProtection: (key, v) => set({ [key]: v } as Partial<NetworkProtections>),
    }),
    {
      name: 'kasane-console-settings',
      storage: createJSONStorage(() => localStorage),
      // v1: limitNetwork のみ。v2: 通信の保護3項目を追加（保存が無い項目は「保護する」）。v3: 実行する言語 lang を追加（保存が無ければ js）
      version: 3,
      // 古い版の保存はそのまま通す（項目の足りない分は、下の merge が既定値で埋める。migrate が無いと、版が違う保存は捨てられてしまう）
      migrate: (persisted) => persisted as Partial<ConsoleSettingsState>,
      // 壊れた値・知らない値は、安全な側（制限あり・保護する）に戻す。明示的に false のときだけオフ。
      merge: (persisted, current) => {
        const p = persisted as Partial<ConsoleSettingsState> | null;
        return {
          ...current,
          limitNetwork: p?.limitNetwork === false ? false : true,
          lang: isConsoleLang(p?.lang) ? p.lang : DEFAULT_CONSOLE_LANG,
          blockUrlCredentials: p?.blockUrlCredentials === false ? false : true,
          omitCookies: p?.omitCookies === false ? false : true,
          hideReferrer: p?.hideReferrer === false ? false : true,
        };
      },
      partialize: (s) => ({
        limitNetwork: s.limitNetwork,
        lang: s.lang,
        blockUrlCredentials: s.blockUrlCredentials,
        omitCookies: s.omitCookies,
        hideReferrer: s.hideReferrer,
      }),
    },
  ),
);

/** 画面の外（コンソールの実行環境）から、いまの設定を読む。 */
export const isNetworkLimited = (): boolean => useConsoleSettingsStore.getState().limitNetwork;

/** 画面の外（コンソールの実行環境）から、いまの通信の保護を読む。呼ぶたびに読むので、実行中に切り替えても効く。 */
export const getNetworkProtections = (): NetworkProtections => {
  const s = useConsoleSettingsStore.getState();
  return { blockUrlCredentials: s.blockUrlCredentials, omitCookies: s.omitCookies, hideReferrer: s.hideReferrer };
};
