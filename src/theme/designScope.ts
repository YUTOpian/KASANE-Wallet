import type { ChainKey } from '../lib/chain';
import type { DesignKey } from './kasaneTheme';
import type { ThemeMode } from '../store/appStore';
import type { SymbolNetwork } from '../lib/symbol/constants';

// Which KASANE design a screen gets. The design is FIXED per group of screens:
//
//   1. welcome -> profile -> new / import -> recovery phrase -> done, and profile settings / backup / password
//        always the neutral KASANE look: the whole logo gradient, no Symbol / NEM tint.
//        It never follows the saved chain or the Symbol / NEM tile picked on the create / import screens.
//        The dark / white / business setting DOES apply (it can be changed on the title and profile-select screens).
//   2. Symbol screens  -> always the Symbol tint
//   3. NEM screens     -> always the NEM tint
//   4. Symbol screens while the network is mijin v2 -> the mijin tint (sky blue / teal on a blue-grey stage);
//        same KASANE design as Symbol / NEM, and the dark / light setting applies.
//        (the chain selected in the side menu decides which of the two groups you are in;
//         the dark / light choice in 設定 > テーマ applies to these two groups only)
export const ONBOARDING_PREFIXES = [
  '/welcome', '/wallet/select', '/wallet/new', '/wallet/creation', '/wallet/login',
  // 新規プロファイルの作成画面（Ledger / 閲覧用）：スタート画面と同じ見た目で、メニューなし
  '/wallet/ledger', '/wallet/watch',
  // profile settings and what follows from it (backup, password prompt): same look as the start screen
  // 署名・連署QR（プロファイル選択の右上「オフライントランザクション」から開く。メニューなし）
  '/signqr',
  // オフライントランザクション（プロファイル選択の右上から開く）：入口の画面と、オフライン署名
  '/offline',
  '/wallet/settings', '/wallet/backup_caution', '/wallet/backup', '/wallet/password-required',
];

export const ONBOARDING_DESIGN: DesignKey = 'base';

export function isOnboardingPath(pathname: string): boolean {
  return ONBOARDING_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Screens with no side menu: every screen of the start-screen group above (view-only profile creation included).
// (One list, so a new start-screen-group screen can never show the menu or a different look by mistake.)
export function hasNoMenuPath(pathname: string): boolean {
  return pathname === '/' || ONBOARDING_PREFIXES.some((p) => pathname.startsWith(p));
}

export const MIJIN_DESIGN: DesignKey = 'mijin';

// `network` is the Symbol network the app is on; only the Symbol chain can be on mijin (NEM has no mijin v2).
export function resolveDesign(pathname: string, mode: ThemeMode, chain: ChainKey, network?: SymbolNetwork): { mode: ThemeMode; chain: DesignKey } {
  if (isOnboardingPath(pathname)) return { mode, chain: ONBOARDING_DESIGN };
  if (chain === 'symbol' && network === 'mijin') return { mode, chain: MIJIN_DESIGN };
  return { mode, chain };
}
