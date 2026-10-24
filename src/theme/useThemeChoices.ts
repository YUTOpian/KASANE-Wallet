import { useTranslation } from 'react-i18next';
import { selectActiveCustomTheme, useAppStore } from '../store/appStore';
import type { ThemeMode } from '../store/appStore';

// The themes a person can pick from (設定 > テーマ, the start screen, the profile screen): the four built-in ones,
// then every saved カスタムテーマ by name. A choice is a plain string: 'dark' | 'light' | 'business' | 'blossom' | 'custom:<id>'.
const BUILTIN: ThemeMode[] = ['dark', 'light', 'business', 'blossom'];

export function useThemeChoices(): { code: string; label: string }[] {
  const { t } = useTranslation();
  const customThemes = useAppStore((s) => s.customThemes);
  return [
    ...BUILTIN.map((code) => ({ code: code as string, label: t(`settings.theme_${code}`) })),
    ...customThemes.map((theme) => ({ code: `custom:${theme.id}`, label: theme.name || t('settings.theme_custom') })),
  ];
}

/** The choice that is in use now. */
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
