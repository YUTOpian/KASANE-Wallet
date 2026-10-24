import './lib/frameGuard'
import { StrictMode, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App.tsx'
import { useKasaneTheme } from './theme/useKasaneTheme'
import { alpha } from '@mui/material/styles'
import { resolveDesign } from './theme/designScope'
import { router } from './router'
import { Storage } from './lib/storage'
import { useAppStore } from './store/appStore'
import './i18n'
import { installDiagnostics } from './lib/diagnostics'

// localForage's driver (IndexedDB → WebSQL → localStorage fallback) must be configured
// before any Storage/WalletsHelper read happens. Previously this call didn't exist
// anywhere, so a browser/profile where IndexedDB throws at open time (a completely fresh
// browser profile, some privacy modes, file:// origins) never fell back to WebSQL/
// localStorage — the wallet-detection read in router.tsx's RootRedirect would reject
// silently, leaving RootRedirect stuck and never reaching /welcome.
installDiagnostics();
Storage.setup();

// The Zustand store rehydrates the persisted network / custom node synchronously; make sure the
// module-level copies used by plain (non-React) code agree with it before the first screen renders.
{
  const { network, customNodes, setNetwork, setCustomNode } = useAppStore.getState();
  setNetwork(network);
  setCustomNode('mainnet', customNodes.mainnet);
  setCustomNode('testnet', customNodes.testnet);
  setCustomNode('mijin', customNodes.mijin ?? '');
}

// Builds the KASANE MUI theme from the dark / white choice in 設定 > テーマ and the selected chain
// (Symbol / NEM) and the network (mijin v2 has its own look), all persisted in the app store,
// and mirrors it onto <html> so index.css, the browser's colour-scheme (scrollbars, form
// controls) and the mobile browser chrome (theme-color) follow it too.
function ThemedApp() {
  const storedMode = useAppStore((s) => s.themeMode);
  const storedChain = useAppStore((s) => s.chain);
  const storedNetwork = useAppStore((s) => s.network);
  // The design is fixed per group of screens (see theme/designScope.ts), so it depends on the route too.
  const pathname = useSyncExternalStore(
    (onChange) => router.subscribe(onChange),
    () => router.state.location.pathname,
  );
  const { mode, chain } = resolveDesign(pathname, storedMode, storedChain, storedNetwork);
  const theme = useKasaneTheme(mode, chain);
  useEffect(() => {
    const root = document.documentElement;
    const custom = mode === 'custom';
    // カスタムテーマ is the dark or white look underneath, so index.css's data-theme follows the base brightness.
    root.dataset.theme = custom ? theme.palette.mode : mode;
    root.dataset.chain = chain;
    root.style.colorScheme = (custom ? theme.palette.mode === 'dark' : mode === 'dark') ? 'dark' : 'light'; // ビジネス is a light scheme
    // The plain-HTML colours of index.css (headings, <code>) follow the person's colours too.
    const vars: Record<string, string | null> = custom
      ? {
          '--bg': theme.kasane.bg,
          '--text': theme.palette.text.secondary,
          '--text-h': theme.palette.text.primary,
          '--border': theme.kasane.line,
          '--code-bg': alpha(theme.kasane.accent, 0.14),
          '--accent': theme.kasane.accent,
          '--accent-bg': alpha(theme.kasane.accent, 0.1),
          '--accent-border': alpha(theme.kasane.accent, 0.5),
        }
      : { '--bg': null, '--text': null, '--text-h': null, '--border': null, '--code-bg': null, '--accent': null, '--accent-bg': null, '--accent-border': null };
    for (const [name, value] of Object.entries(vars)) {
      if (value === null) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.kasane.bg);
  }, [mode, chain, theme]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemedApp />
  </StrictMode>,
)
