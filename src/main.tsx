import { StrictMode, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App.tsx'
import { createKasaneTheme } from './theme/kasaneTheme'
import { resolveDesign } from './theme/designScope'
import { router } from './router'
import { Storage } from './lib/storage'
import { useAppStore } from './store/appStore'
import './i18n'

// localForage's driver (IndexedDB → WebSQL → localStorage fallback) must be configured
// before any Storage/WalletsHelper read happens. Previously this call didn't exist
// anywhere, so a browser/profile where IndexedDB throws at open time (a completely fresh
// browser profile, some privacy modes, file:// origins) never fell back to WebSQL/
// localStorage — the wallet-detection read in router.tsx's RootRedirect would reject
// silently, leaving RootRedirect stuck and never reaching /welcome.
Storage.setup();

// The Zustand store rehydrates the persisted network / custom node synchronously; make sure the
// module-level copies used by plain (non-React) code agree with it before the first screen renders.
{
  const { network, customNodes, setNetwork, setCustomNode } = useAppStore.getState();
  setNetwork(network);
  setCustomNode('mainnet', customNodes.mainnet);
  setCustomNode('testnet', customNodes.testnet);
}

// Builds the KASANE MUI theme from the dark / white choice in 設定 > テーマ and the selected chain
// (Symbol / NEM), both persisted in the app store,
// and mirrors it onto <html> so index.css, the browser's colour-scheme (scrollbars, form
// controls) and the mobile browser chrome (theme-color) follow it too.
function ThemedApp() {
  const storedMode = useAppStore((s) => s.themeMode);
  const storedChain = useAppStore((s) => s.chain);
  // The design is fixed per group of screens (see theme/designScope.ts), so it depends on the route too.
  const pathname = useSyncExternalStore(
    (onChange) => router.subscribe(onChange),
    () => router.state.location.pathname,
  );
  const { mode, chain } = resolveDesign(pathname, storedMode, storedChain);
  const theme = useMemo(() => createKasaneTheme(mode, chain), [mode, chain]);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.chain = chain;
    document.documentElement.style.colorScheme = mode;
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
