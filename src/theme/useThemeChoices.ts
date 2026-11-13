import { useTranslation } from 'react-i18next';
import { selectActiveCustomTheme, useAppStore } from '../store/appStore';
import type { ThemeMode } from '../store/appStore';
import { isOnboardingPath } from './designScope';

// The themes a person can pick from (設定 > テーマ, the start screen, the profile screen): the four built-in ones,
// then every saved カスタムテーマ by name. A choice is a plain string: 'dark' | 'light' | 'business' | 'blossom' | 'custom:<id>'.
//
// テーマの設定は2か所ある:
//   ・共通のテーマ（themeMode / customThemeId）… スタート画面・プロファイル選択画面など、プロファイルを開く前の画面。
//     プロファイルが自分のテーマを持っていなければ、プロファイルの中もこれに合わせる。
//   ・プロファイルのテーマ（profileThemes）… そのプロファイルを開いている間だけ使う。
const BUILTIN: ThemeMode[] = ['dark', 'light', 'business', 'blossom'];

export function useThemeChoices(): { code: string; label: string }[] {
  const { t } = useTranslation();
  const customThemes = useAppStore((s) => s.customThemes);
  return [
    ...BUILTIN.map((code) => ({ code: code as string, label: t(`settings.theme_${code}`) })),
    ...customThemes.map((theme) => ({ code: `custom:${theme.id}`, label: theme.name || t('settings.theme_custom') })),
  ];
}

/** The common choice (start screen / profile select, and every profile without its own). */
export function useThemeChoice(): string {
  const themeMode = useAppStore((s) => s.themeMode);
  const active = useAppStore(selectActiveCustomTheme);
  if (themeMode === 'custom') return active ? `custom:${active.id}` : 'dark';
  return themeMode;
}

export function applyThemeChoice(code: string): void {
  const { setThemeMode, selectCustomTheme } = useAppStore.getState();
  if (code.startsWith('custom:')) selectCustomTheme(code.slice('custom:'.length));
  else setThemeMode(code as ThemeMode);
}

/** The choice the open profile made for itself. '' = it follows the common one (or no profile is open). */
export function useProfileThemeChoice(): string {
  const key = useAppStore((s) => s.activeProfileKey);
  const choices = useAppStore((s) => s.profileThemes);
  const customThemes = useAppStore((s) => s.customThemes);
  const choice = key ? choices[key] : undefined;
  if (!choice) return '';
  if (choice.startsWith('custom:') && !customThemes.some((t) => `custom:${t.id}` === choice)) return '';
  return choice;
}

/** Sets the open profile's own theme. '' = follow the common one again. */
export function applyProfileThemeChoice(code: string): void {
  const { activeProfileKey, setProfileTheme } = useAppStore.getState();
  if (!activeProfileKey) return;
  setProfileTheme(activeProfileKey, code === '' ? null : code);
}

/** The theme a screen shows: the profile's own while a profile is open, the common one everywhere else. */
export function useEffectiveTheme(pathname: string): { mode: ThemeMode; customId: string | null } {
  const themeMode = useAppStore((s) => s.themeMode);
  const customThemeId = useAppStore((s) => s.customThemeId);
  const profileChoice = useProfileThemeChoice();
  // The start-screen group (welcome, profile select, new / import, profile settings, ...) always shows the common theme.
  if (isOnboardingPath(pathname) || profileChoice === '') return { mode: themeMode, customId: customThemeId };
  if (profileChoice.startsWith('custom:')) return { mode: 'custom', customId: profileChoice.slice('custom:'.length) };
  return { mode: profileChoice as ThemeMode, customId: customThemeId };
}
