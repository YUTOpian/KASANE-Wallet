import type { ChainKey } from '../lib/chain';
import type { DesignKey } from './kasaneTheme';
import type { ThemeMode } from '../store/appStore';

// Which KASANE design a screen gets. The design is FIXED per group of screens:
//
//   1. welcome -> profile -> new / import -> recovery phrase -> done, and profile settings / backup / password
//        always the neutral KASANE look: dark stage, the whole logo gradient, no Symbol / NEM tint.
//        It never follows the saved chain, the dark / light setting, or the Symbol / NEM tile
//        picked on the create / import screens.
//   2. Symbol screens  -> always the Symbol tint
//   3. NEM screens     -> always the NEM tint
//        (the chain selected in the side menu decides which of the two groups you are in;
//         the dark / light choice in 設定 > テーマ applies to these two groups only)
const ONBOARDING_PREFIXES = [
  '/welcome', '/wallet/select', '/wallet/new', '/wallet/creation', '/wallet/login',
  // profile settings and what follows from it (backup, password prompt): same look as the start screen
  '/wallet/settings', '/wallet/backup_caution', '/wallet/backup', '/wallet/password-required',
];

export const ONBOARDING_DESIGN: DesignKey = 'base';
export const ONBOARDING_MODE: ThemeMode = 'dark';

export function isOnboardingPath(pathname: string): boolean {
  return ONBOARDING_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function resolveDesign(pathname: string, mode: ThemeMode, chain: ChainKey): { mode: ThemeMode; chain: DesignKey } {
  return isOnboardingPath(pathname) ? { mode: ONBOARDING_MODE, chain: ONBOARDING_DESIGN } : { mode, chain };
}
