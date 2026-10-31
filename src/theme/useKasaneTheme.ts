import { useMemo } from 'react';
import { selectActiveCustomTheme, useAppStore } from '../store/appStore';
import type { ThemeMode } from '../store/appStore';
import { createKasaneTheme } from './kasaneTheme';
import type { DesignKey } from './kasaneTheme';
import { sanitizeCustomTheme } from './customTheme';

// The MUI theme of a design. Reads the カスタムテーマ in use from the store, so every place that builds a theme
// (the app root, the start-screen stage) shows 'custom' the same way.
// customId: the カスタムテーマ to show when `mode` is 'custom' (a profile can use another one than the common theme).
// Without it (or when it is gone) the common one is used.
export function useKasaneTheme(mode: ThemeMode, chain: DesignKey, customId?: string | null) {
  const common = useAppStore(selectActiveCustomTheme);
  const own = useAppStore((s) => (customId ? s.customThemes.find((t) => t.id === customId) ?? null : null));
  const custom = own ?? common;
  return useMemo(
    () => createKasaneTheme(mode, chain, mode === 'custom' ? sanitizeCustomTheme(custom) : null),
    [mode, chain, custom],
  );
}
