import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import PlaceholderPage from './pages/PlaceholderPage';
import PasswordExposureGuard from './components/PasswordExposureGuard';
import MenuShell from './components/MenuShell';
import { WalletsHelper } from './lib/storage';
import { useAppStore } from './store/appStore';

// Every real screen is loaded via React.lazy() so the initial JS bundle only contains the
// app shell (router, theme, i18n bootstrap) — each route's code is fetched on first visit
// instead of all being bundled into one ~1.4MB file up front.
const WalletCreationName = lazy(() => import('./pages/wallet/WalletCreationName'));
const WalletCreationMnemonic = lazy(() => import('./pages/wallet/WalletCreationMnemonic'));
const WalletCreationNew = lazy(() => import('./pages/wallet/WalletCreationNew'));
const WalletCreationEnd = lazy(() => import('./pages/wallet/WalletCreationEnd'));
const WalletLoginImport = lazy(() => import('./pages/wallet/WalletLoginImport'));
const WalletLoginName = lazy(() => import('./pages/wallet/WalletLoginName'));
const WalletLoginEnd = lazy(() => import('./pages/wallet/WalletLoginEnd'));
const WalletNew = lazy(() => import('./pages/wallet/WalletNew'));
const WalletSelect = lazy(() => import('./pages/wallet/WalletSelect'));
const WalletSwitch = lazy(() => import('./pages/wallet/WalletSwitch'));
const Welcome = lazy(() => import('./pages/Welcome'));
const Top = lazy(() => import('./pages/top/Top'));
const SendConfirmation = lazy(() => import('./pages/send/SendConfirmation'));
const SendComplete = lazy(() => import('./pages/send/SendComplete'));
const TransactionDetail = lazy(() => import('./pages/transaction/TransactionDetail'));
const SymbolTransactionDetail = lazy(() => import('./pages/transaction/SymbolTransactionDetail'));
const WalletSettings = lazy(() => import('./pages/wallet/WalletSettings'));
const WalletBackupCaution = lazy(() => import('./pages/wallet/WalletBackupCaution'));
const WalletBackup = lazy(() => import('./pages/wallet/WalletBackup'));
const SettingsTop = lazy(() => import('./pages/settings/SettingsTop'));
const About = lazy(() => import('./pages/about/About'));
const WalletPasswordRequired = lazy(() => import('./pages/wallet/WalletPasswordRequired'));
const MosaicList = lazy(() => import('./pages/mosaic/MosaicList'));
const MosaicCreate = lazy(() => import('./pages/mosaic/MosaicCreate'));
const NamespaceList = lazy(() => import('./pages/namespace/NamespaceList'));
const NamespaceRegister = lazy(() => import('./pages/namespace/NamespaceRegister'));
const NemMosaicList = lazy(() => import('./pages/nem/NemMosaicList'));
const NemMosaicCreate = lazy(() => import('./pages/nem/NemMosaicCreate'));
const NemNamespaceList = lazy(() => import('./pages/nem/NemNamespaceList'));
const NemNamespaceRegister = lazy(() => import('./pages/nem/NemNamespaceRegister'));
const NemMultisigTop = lazy(() => import('./pages/nem/NemMultisigTop'));
const NemMultisigConvert = lazy(() => import('./pages/nem/NemMultisigConvert'));
const NemMultisigSend = lazy(() => import('./pages/nem/NemMultisigSend'));
const NemHarvest = lazy(() => import('./pages/nem/NemHarvest'));
const NemMonster = lazy(() => import('./pages/nem/NemMonster'));
const NemVotingList = lazy(() => import('./pages/nem/NemVotingList'));
const NemVotingDetail = lazy(() => import('./pages/nem/NemVotingDetail'));
const NemVotingCreate = lazy(() => import('./pages/nem/NemVotingCreate'));
const MetadataPage = lazy(() => import('./pages/metadata/MetadataPage'));
const MultisigTop = lazy(() => import('./pages/multisig/MultisigTop'));
const MultisigConvert = lazy(() => import('./pages/multisig/MultisigConvert'));
const MultisigSend = lazy(() => import('./pages/multisig/MultisigSend'));
const AggregatePage = lazy(() => import('./pages/aggregate/AggregatePage'));
const HarvestSettings = lazy(() => import('./pages/harvest/HarvestSettings'));
const SupernodePage = lazy(() => import('./pages/supernode/SupernodePage'));

function RouteFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <CircularProgress color="primary" />
    </Box>
  );
}

// Wraps a lazily-loaded page in its own Suspense boundary so navigating to one route
// shows a spinner only for that route, not a blank screen for the whole app.
function withSuspense(element: ReactElement): ReactElement {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

// Every route (other than the root redirect) is wrapped in PasswordExposureGuard, which
// transparently redirects to /wallet/password-required instead of rendering the requested
// page whenever the active wallet still has no real password behind it - see that component
// for why this can still happen (pre-fix installations) even though normal usage no
// longer produces the state. Outside the Suspense boundary so the guard's own check
// (a couple of storage reads) resolves before the destination page's lazy chunk even
// starts loading.
// Metadata is a Symbol feature: on NEM it goes Home. (Harvesting exists on both chains, with different screens.)
function SymbolOnly({ children }: { children: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'symbol' ? children : <Navigate to="/top" replace />;
}

// Namespaces and mosaics exist on both chains with different screens (NIS1 vs Symbol).
function ByChain({ symbol, nem }: { symbol: ReactElement; nem: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'nem' ? nem : symbol;
}

// The SuperNode Program and NEMonster are NEM (NIS1) features: on Symbol they go Home.
function NemOnly({ children }: { children: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'nem' ? children : <Navigate to="/top" replace />;
}

// The transaction history is a section of Home now: old links to /transaction/list (bookmarks, the
// iOS home-screen app's saved screen) land on Home with that section open.
function ToHomeHistory() {
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  useEffect(() => { setHomePanel('history'); }, [setHomePanel]);
  return <Navigate to="/top" replace />;
}

function withGuard(element: ReactElement): ReactElement {
  return <PasswordExposureGuard>{element}</PasswordExposureGuard>;
}

// 起動時の振り分け:
// - アクティブなウォレットがあれば /top（ホーム）へ。
// - それ以外（ウォレットが1件も無い/あるが選択中のものが無い）は常に /welcome（ウェルカム画面）へ。
//   ウォレットを持っていても一度もアクティブにしていない状態でいきなり /wallet/select
//   に飛ばすと welcome 画面を経由しないままになってしまうため、/wallet/select への
//   遷移は welcome 画面の GET STARTED ボタン経由（ウォレット登録済みならそのまま
//   一覧が表示される）のみとする。
function RootRedirect() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Any chain's active account counts (the selected chain may not be set up for the profile yet).
        const activeWallet = await WalletsHelper.getActiveAny();
        setTarget(activeWallet ? '/top' : '/welcome');
      } catch (e) {
        // ストレージの読み込みに失敗した場合（初期化がまだ済んでいない、ドライバが
        // 使えない等）でもここで固まらないように、安全側の /welcome にフォールバックする。
        console.error('Failed to determine active wallet', e);
        setTarget('/welcome');
      }
    })();
  }, []);

  if (target === null) {
    return <RouteFallback />;
  }
  return <Navigate to={target} replace />;
}

// Route list ported 1:1 from the Vue app's src/router/index.ts. Every path exists from
// day one; most still point at PlaceholderPage so in-app navigation/back-buttons don't
// 404 while screens are ported one at a time — replace an entry's element with the real
// component as each screen gets built.
const routeDefs: { path: string; name: string; element?: ReactElement }[] = [
  { path: '/welcome', name: 'Welcome', element: <Welcome /> },
  { path: '/top', name: 'Top', element: <Top /> },
  { path: '/transaction/list', name: 'TransactionList', element: <ToHomeHistory /> },
  { path: '/transaction/view', name: 'TransactionView', element: <SymbolOnly><SymbolTransactionDetail /></SymbolOnly> },
  { path: '/transaction/detail', name: 'TransactionDetail', element: <TransactionDetail /> },
  { path: '/wallet/select', name: 'WalletSelect', element: <WalletSelect /> },
  { path: '/wallet/new', name: 'WalletNew', element: <WalletNew /> },
  { path: '/wallet/switch', name: 'WalletSwitch', element: <WalletSwitch /> },
  { path: '/wallet/creation/name', name: 'WalletCreationName', element: <WalletCreationName /> },
  { path: '/wallet/creation/mnemonic', name: 'WalletCreationMnemonic', element: <WalletCreationMnemonic /> },
  { path: '/wallet/creation/new', name: 'WalletCreationNew', element: <WalletCreationNew /> },
  { path: '/wallet/creation/end', name: 'WalletCreationEnd', element: <WalletCreationEnd /> },
  { path: '/wallet/login/import', name: 'WalletLoginImport', element: <WalletLoginImport /> },
  { path: '/wallet/login/name', name: 'WalletLoginName', element: <WalletLoginName /> },
  { path: '/wallet/login/end', name: 'WalletLoginEnd', element: <WalletLoginEnd /> },
  { path: '/wallet/settings', name: 'WalletSettings', element: <WalletSettings /> },
  { path: '/wallet/backup_caution', name: 'WalletBackupCaution', element: <WalletBackupCaution /> },
  { path: '/wallet/backup', name: 'WalletBackup', element: <WalletBackup /> },
  { path: '/wallet/password-required', name: 'WalletPasswordRequired', element: <WalletPasswordRequired /> },
  { path: '/send/confirmation', name: 'SendConfirmation', element: <SendConfirmation /> },
  { path: '/send/complete', name: 'SendComplete', element: <SendComplete /> },
  { path: '/about', name: 'About', element: <About /> },
  { path: '/settings/top', name: 'SettingsTop', element: <SettingsTop /> },
  { path: '/mosaic', name: 'MosaicList', element: <ByChain symbol={<MosaicList />} nem={<NemMosaicList />} /> },
  { path: '/mosaic/create', name: 'MosaicCreate', element: <ByChain symbol={<MosaicCreate />} nem={<NemMosaicCreate />} /> },
  { path: '/namespace', name: 'NamespaceList', element: <ByChain symbol={<NamespaceList />} nem={<NemNamespaceList />} /> },
  { path: '/namespace/register', name: 'NamespaceRegister', element: <ByChain symbol={<NamespaceRegister />} nem={<NemNamespaceRegister />} /> },
  { path: '/metadata', name: 'MetadataPage', element: <SymbolOnly><MetadataPage /></SymbolOnly> },
  { path: '/multisig', name: 'MultisigTop', element: <ByChain symbol={<MultisigTop />} nem={<NemMultisigTop />} /> },
  { path: '/multisig/convert', name: 'MultisigConvert', element: <ByChain symbol={<MultisigConvert />} nem={<NemMultisigConvert />} /> },
  { path: '/multisig/send', name: 'MultisigSend', element: <ByChain symbol={<MultisigSend />} nem={<NemMultisigSend />} /> },
  { path: '/aggregate', name: 'AggregatePage', element: <SymbolOnly><AggregatePage /></SymbolOnly> },
  { path: '/harvest', name: 'HarvestSettings', element: <ByChain symbol={<HarvestSettings />} nem={<NemHarvest />} /> },
  { path: '/supernode', name: 'SupernodePage', element: <NemOnly><SupernodePage /></NemOnly> },
  { path: '/nemonster', name: 'NemMonster', element: <NemOnly><NemMonster /></NemOnly> },
  { path: '/voting', name: 'NemVotingList', element: <NemOnly><NemVotingList /></NemOnly> },
  { path: '/voting/create', name: 'NemVotingCreate', element: <NemOnly><NemVotingCreate /></NemOnly> },
  { path: '/voting/poll/:address', name: 'NemVotingDetail', element: <NemOnly><NemVotingDetail /></NemOnly> },
];

// HashRouter (not BrowserRouter) so this works both when opened directly as a local
// file (file://index.html) and when hosted on GitHub Pages: routing state lives entirely
// in the URL fragment (#/top, #/wallet/select, ...), so no server-side rewrite rules are
// needed for a route to be requested directly or refreshed — the server (or filesystem)
// only ever sees a request for index.html itself.
export const router = createHashRouter([
  {
    // Layout route: the side menu + page-pushing wrapper around every screen.
    element: <MenuShell />,
    children: [
      { path: '/', element: <RootRedirect /> },
      ...routeDefs.map(({ path, name, element }) => ({
        path,
        element: withGuard(withSuspense(element ?? <PlaceholderPage name={name} />)),
      })),
    ],
  },
]);
