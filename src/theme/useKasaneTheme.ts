import { useMemo } from 'react';
import { selectActiveCustomTheme, useAppStore } from '../store/appStore';
import type { ThemeMode } from '../store/appStore';
import { createKasaneTheme } from './kasaneTheme';
import type { DesignKey } from './kasaneTheme';
import { sanitizeCustomTheme } from './customTheme';

// The MUI theme of a design. Reads the カスタムテーマ in use from the store, so every place that builds a theme
// (the app root, the start-screen stage) shows 'custom' the same way.
export function useKasaneTheme(mode: ThemeMode, chain: DesignKey) {
  const custom = useAppStore(selectActiveCustomTheme);
  return useMemo(
    () => createKasaneTheme(mode, chain, mode === 'custom' ? sanitizeCustomTheme(custom) : null),
    [mode, chain, custom],
  );
}
