import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import BackButton from './components/BackButton';
import { createHashRouter, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import PlaceholderPage from './pages/PlaceholderPage';
import PasswordExposureGuard from './components/PasswordExposureGuard';
import LoginPasswordGate from './components/LoginPasswordGate';
import MenuShell from './components/MenuShell';
import { WalletsHelper } from './lib/storage';
import { useAppStore } from './store/appStore';
import { useLedgerProfile, useWatchOnly } from './hooks/useWatchOnly';

// Every real screen is loaded via React.lazy() so the initial JS bundle only contains the
// app shell (router, theme, i18n bootstrap) — each route's code is fetched on first visit
// instead of all being bundled into one ~1.4MB file up front.
const WalletCreationName = lazy(() => import('./pages/wallet/WalletCreationName'));
const WalletCreationMnemonic = lazy(() => import('./pages/wallet/WalletCreationMnemonic'));
const WalletCreationNew = lazy(() => import('./pages/wallet/WalletCreationNew'));
const WalletCreationEnd = lazy(() => import('./pages/wallet/WalletCreationEnd'));
const WalletLoginImport = lazy(() => import('./pages/wallet/WalletLoginImport'));
const WalletCreationAccounts = lazy(() => import('./pages/wallet/WalletCreationAccounts'));
const WalletLoginAccounts = lazy(() => import('./pages/wallet/WalletLoginAccounts'));
const WalletLoginName = lazy(() => import('./pages/wallet/WalletLoginName'));
const WalletLoginEnd = lazy(() => import('./pages/wallet/WalletLoginEnd'));
const WalletNew = lazy(() => import('./pages/wallet/WalletNew'));
const WalletWatchNew = lazy(() => import('./pages/wallet/WalletWatchNew'));
const WalletLedgerNew = lazy(() => import('./pages/wallet/WalletLedgerNew'));
const WalletSelect = lazy(() => import('./pages/wallet/WalletSelect'));
const AccountPage = lazy(() => import('./pages/account/AccountPage'));
const Welcome = lazy(() => import('./pages/Welcome'));
const Top = lazy(() => import('./pages/top/Top'));
const SendConfirmation = lazy(() => import('./pages/send/SendConfirmation'));
const TransactionDetail = lazy(() => import('./pages/transaction/TransactionDetail'));
const SymbolTransactionDetail = lazy(() => import('./pages/transaction/SymbolTransactionDetail'));
const WalletSettings = lazy(() => import('./pages/wallet/WalletSettings'));
const WalletBackupCaution = lazy(() => import('./pages/wallet/WalletBackupCaution'));
const WalletBackup = lazy(() => import('./pages/wallet/WalletBackup'));
const SettingsTop = lazy(() => import('./pages/settings/SettingsTop'));
const Links = lazy(() => import('./pages/links/Links'));
const DiagnosticsPage = lazy(() => import('./pages/settings/DiagnosticsPage'));
const WalletPasswordRequired = lazy(() => import('./pages/wallet/WalletPasswordRequired'));
const MosaicList = lazy(() => import('./pages/mosaic/MosaicList'));
const NamespaceList = lazy(() => import('./pages/namespace/NamespaceList'));
const NemMosaicList = lazy(() => import('./pages/nem/NemMosaicList'));
const NemNamespaceList = lazy(() => import('./pages/nem/NemNamespaceList'));
const NemMultisigTop = lazy(() => import('./pages/nem/NemMultisigTop'));
const NemMultisigConvert = lazy(() => import('./pages/nem/NemMultisigConvert'));
const NemMultisigSend = lazy(() => import('./pages/nem/NemMultisigSend'));
const NemHarvest = lazy(() => import('./pages/nem/NemHarvest'));
const NemMultisigHarvest = lazy(() => import('./pages/nem/NemMultisigHarvest'));
const ServiceHub = lazy(() => import('./pages/service/ServiceHub'));
const OptinPage = lazy(() => import('./pages/optin/OptinPage'));
const PostOptinPage = lazy(() => import('./pages/optin/PostOptinPage'));
const ApostillePage = lazy(() => import('./pages/apostille/ApostillePage'));
const NemMonster = lazy(() => import('./pages/nem/NemMonster'));
const NemSignedMessage = lazy(() => import('./pages/nem/NemSignedMessage'));
const SymbolSignedMessage = lazy(() => import('./pages/signmsg/SymbolSignedMessage'));
const NemDns = lazy(() => import('./pages/nem/NemDns'));
const SymbolDns = lazy(() => import('./pages/dns/SymbolDns'));
const NemVotingList = lazy(() => import('./pages/nem/NemVotingList'));
const NemVotingDetail = lazy(() => import('./pages/nem/NemVotingDetail'));
const NemVotingCreate = lazy(() => import('./pages/nem/NemVotingCreate'));
const SymbolVotingList = lazy(() => import('./pages/voting/SymbolVotingList'));
const SymbolVotingDetail = lazy(() => import('./pages/voting/SymbolVotingDetail'));
const SymbolVotingCreate = lazy(() => import('./pages/voting/SymbolVotingCreate'));
const MultisigTop = lazy(() => import('./pages/multisig/MultisigTop'));
const MultisigConvert = lazy(() => import('./pages/multisig/MultisigConvert'));
const MultisigSend = lazy(() => import('./pages/multisig/MultisigSend'));
const MultisigTreePage = lazy(() => import('./pages/multisig/MultisigTreePage'));
const AggregatePage = lazy(() => import('./pages/aggregate/AggregatePage'));
const SignQrPage = lazy(() => import('./pages/signqr/SignQrPage'));
const OfflineSignPage = lazy(() => import('./pages/offline/OfflineSignPage'));
const OfflineCosignPage = lazy(() => import('./pages/offline/OfflineCosignPage'));
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
// Symbol-only screens: on NEM they go Home. (Harvesting exists on both chains, with different screens.)
function SymbolOnly({ children }: { children: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'symbol' ? children : <Navigate to="/top" replace />;
}

// NEM 「モザイク定義の編集」: the mosaic list with the edit form open for ?id=namespace:name (Symbol mosaics can't be re-defined).
function NemMosaicEditRoute() {
  const [params] = useSearchParams();
  return <NemMosaicList initialEditId={params.get('id')} />;
}

// Namespaces and mosaics exist on both chains with different screens (NIS1 vs Symbol).
function ByChain({ symbol, nem }: { symbol: ReactElement; nem: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'nem' ? nem : symbol;
}

// A service's screen gets a 「戻る」 to the 「サービス」 tiles above it.
function ServiceFrame({ children }: { children: ReactElement }) {
  const navigate = useNavigate();
  return (
    <>
      <BackButton onBack={() => navigate('/service')} back="/service" />
      {children}
    </>
  );
}

// The SuperNode Program is a NEM (NIS1) feature; signed messages and Voting have Symbol screens too: on Symbol they go Home (NEMonster, Apostille and DNS exist on both chains).
function NemOnly({ children }: { children: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  return chain === 'nem' ? children : <Navigate to="/top" replace />;
}

// mijin has no harvesting: a direct visit to the harvest screen goes Home.
function NotMijin({ children }: { children: ReactElement }) {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  return chain === 'symbol' && network === 'mijin' ? <Navigate to="/top" replace /> : children;
}

// 閲覧用プロファイル（アドレスだけ）では使えない画面：署名・送信・作成・設定など、秘密鍵が要るもの。
// メニューにも出さないが、アドレスを直接開かれても Home に戻す。
// Ledger のプロファイルは、秘密鍵をパスワードで開いて署名する画面は使えない。`ledgerOk` を付けた画面
// （Ledger で署名できるもの）だけ開く。それ以外は Home に戻す（メニューにも出さない）。
function KeyRequired({ children, ledgerOk = false }: { children: ReactElement; ledgerOk?: boolean }) {
  const watchOnly = useWatchOnly();
  const ledger = useLedgerProfile();
  return watchOnly || (ledger && !ledgerOk) ? <Navigate to="/top" replace /> : children;
}

// The transaction history is a section of Home now: old links to /transaction/list (bookmarks, the
// iOS home-screen app's saved screen) land on Home with that section open.
// The address book lives on the アカウント screen now: the old /addressbook (and its ?pick=1) opens that tab.
function AddressBookRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={params.get('pick') === '1' ? '/account?tab=addressbook&pick=1' : '/account?tab=addressbook'} replace />;
}

function ToHomeHistory() {
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  useEffect(() => { setHomePanel('history'); }, [setHomePanel]);
  return <Navigate to="/top" replace />;
}

function withGuard(element: ReactElement): ReactElement {
  return <PasswordExposureGuard><LoginPasswordGate>{element}</LoginPasswordGate></PasswordExposureGuard>;
}

// 起動時の振り分け:
// - アプリを開いたとき（ページを読み込んだ最初の1回）は、ウォレットが登録済みでも、必ず /welcome（ウェルカム画面）から始める。
//   ブラウザに前のプロファイルが残っていても、いきなりホームやNEMの設定画面などから始まらないようにする。
//   ウェルカム画面の GET STARTED からプロファイル選択（/wallet/select）へ進む。
// - そのあとアプリの中で「/」に戻ったときは、アクティブなウォレットがあれば /top（ホーム）、なければ /welcome。
let launchPending = true;

function RootRedirect() {
  // 開発時の StrictMode が effect や初期化を2回動かしても結果が変わらないよう、最初の1回かどうかはここで決めて持っておく。
  const [isLaunch] = useState(() => launchPending);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (isLaunch) {
      setTarget('/welcome');
      return;
    }
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
  }, [isLaunch]);

  if (target === null) {
    return <RouteFallback />;
  }
  launchPending = false; // 最初の振り分けは済んだ。次に「/」へ来たときはウォレットの有無で決める。
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
  { path: '/wallet/watch', name: 'WalletWatchNew', element: <WalletWatchNew /> },
  { path: '/wallet/ledger', name: 'WalletLedgerNew', element: <WalletLedgerNew /> },
  { path: '/account', name: 'AccountPage', element: <AccountPage /> },
  // Old name of the screen (bookmarks, the iOS home-screen app's saved screen).
  { path: '/wallet/switch', name: 'WalletSwitch', element: <Navigate to="/account" replace /> },
  { path: '/wallet/creation/name', name: 'WalletCreationName', element: <WalletCreationName /> },
  { path: '/wallet/creation/mnemonic', name: 'WalletCreationMnemonic', element: <WalletCreationMnemonic /> },
  { path: '/wallet/creation/accounts', name: 'WalletCreationAccounts', element: <WalletCreationAccounts /> },
  { path: '/wallet/creation/new', name: 'WalletCreationNew', element: <WalletCreationNew /> },
  { path: '/wallet/creation/end', name: 'WalletCreationEnd', element: <WalletCreationEnd /> },
  { path: '/wallet/login/import', name: 'WalletLoginImport', element: <WalletLoginImport /> },
  { path: '/wallet/login/accounts', name: 'WalletLoginAccounts', element: <WalletLoginAccounts /> },
  { path: '/wallet/login/name', name: 'WalletLoginName', element: <WalletLoginName /> },
  { path: '/wallet/login/end', name: 'WalletLoginEnd', element: <WalletLoginEnd /> },
  { path: '/wallet/settings', name: 'WalletSettings', element: <WalletSettings /> },
  { path: '/wallet/backup_caution', name: 'WalletBackupCaution', element: <KeyRequired><WalletBackupCaution /></KeyRequired> },
  { path: '/wallet/backup', name: 'WalletBackup', element: <KeyRequired><WalletBackup /></KeyRequired> },
  { path: '/wallet/password-required', name: 'WalletPasswordRequired', element: <WalletPasswordRequired /> },
  { path: '/send/confirmation', name: 'SendConfirmation', element: <KeyRequired ledgerOk><SendConfirmation /></KeyRequired> },
  { path: '/links', name: 'Links', element: <Links /> },
  // 旧アドレス（/about）で開いたときは、リンク集へ。
  { path: '/about', name: 'AboutOld', element: <Navigate to="/links" replace /> },
  { path: '/settings/top', name: 'SettingsTop', element: <SettingsTop /> },
  { path: '/settings/diagnostics', name: 'Diagnostics', element: <DiagnosticsPage /> },
  // QRコードのインポート（署名・連署のQR、アドレス・請求書のQR）: Symbol only, and not for view-only / Ledger profiles (they cannot sign).
  // It is a popup on 設定 now; the old address just opens 設定.
  { path: '/settings/import-qr', name: 'ImportQr', element: <Navigate to="/settings/top" replace /> },
  // アドレス帳は「アカウント」画面のタブになった。古いアドレス（ブックマーク、iOSのホーム画面アプリの保存画面）は、そのタブを開く（?pick=1 は送金先の選択）。
  { path: '/addressbook', name: 'AddressBook', element: <AddressBookRedirect /> },
  { path: '/mosaic', name: 'MosaicList', element: <ByChain symbol={<MosaicList />} nem={<NemMosaicList />} /> },
  // The same screen as /mosaic with the 作成 tab open (only its lower part is the form), on both chains.
  { path: '/mosaic/create', name: 'MosaicCreate', element: <KeyRequired><ByChain symbol={<MosaicList initialTab="create" />} nem={<NemMosaicList initialTab="create" />} /></KeyRequired> },
  // 供給量の変更: the same screen as /mosaic with the 供給量の変更 tab open, on both chains.
  { path: '/mosaic/supply', name: 'MosaicSupply', element: <KeyRequired><ByChain symbol={<Navigate to="/mosaic" replace />} nem={<Navigate to="/mosaic" replace />} /></KeyRequired> },
  // 定義の編集（NEM のみ）: 自分が作ったモザイクの説明・設定・徴収を、同じ名前で定義を送り直して変える。Symbol は一覧へ戻る。
  { path: '/mosaic/edit', name: 'MosaicEdit', element: <KeyRequired><ByChain symbol={<Navigate to="/mosaic" replace />} nem={<NemMosaicEditRoute />} /></KeyRequired> },
  { path: '/namespace', name: 'NamespaceList', element: <ByChain symbol={<NamespaceList />} nem={<NemNamespaceList />} /> },
  // エイリアスのリンク / 解除（Symbol のみ）: the same screen as /namespace with the エイリアス tab open. NEM goes back to the list.
  { path: '/namespace/alias', name: 'NamespaceAlias', element: <KeyRequired><ByChain symbol={<Navigate to="/namespace" replace />} nem={<Navigate to="/namespace" replace />} /></KeyRequired> },
  // ネームスペースの更新（NEM のみ）: /namespace の「ネームスペースの更新」タブを開く。Symbol は一覧へ戻る。
  { path: '/namespace/renew', name: 'NamespaceRenew', element: <KeyRequired><ByChain symbol={<Navigate to="/namespace" replace />} nem={<Navigate to="/namespace" replace />} /></KeyRequired> },
  { path: '/namespace/register', name: 'NamespaceRegister', element: <KeyRequired><ByChain symbol={<NamespaceList initialTab="create_root" />} nem={<NemNamespaceList initialTab="create_root" />} /></KeyRequired> },
  // アカウント制限（アドレス / モザイク / オペレーション）：Symbol のみ。現在の設定は閲覧用プロファイルでも見られる（変更は画面側で隠す）。
  { path: '/multisig', name: 'MultisigTop', element: <KeyRequired><ByChain symbol={<MultisigTop />} nem={<NemMultisigTop />} /></KeyRequired> },
  { path: '/multisig/convert', name: 'MultisigConvert', element: <KeyRequired><ByChain symbol={<MultisigConvert />} nem={<NemMultisigConvert />} /></KeyRequired> },
  // マルチシグツリー（Symbolのみ。見るだけなので閲覧用プロファイルでも開ける）
  { path: '/multisig/tree', name: 'MultisigTree', element: <SymbolOnly><MultisigTreePage /></SymbolOnly> },
  // 委任ハーベスト of a multisig account (NEM only): a cosigner activates its remote account and starts harvesting.
  { path: '/multisig/harvest', name: 'NemMultisigHarvest', element: <KeyRequired><NemOnly><NemMultisigHarvest /></NemOnly></KeyRequired> },
  { path: '/multisig/send', name: 'MultisigSend', element: <KeyRequired><ByChain symbol={<MultisigSend />} nem={<NemMultisigSend />} /></KeyRequired> },
  { path: '/aggregate', name: 'AggregatePage', element: <KeyRequired><SymbolOnly><AggregatePage /></SymbolOnly></KeyRequired> },
  { path: '/signqr', name: 'SignQr', element: <KeyRequired><SymbolOnly><SignQrPage /></SymbolOnly></KeyRequired> },
  // オフライントランザクション: opened from the profile-selection screen, so it does not depend on the selected
  // chain or on the active profile (the screen has its own chain switch and account picker).
  { path: '/offline', name: 'OfflineHub', element: <Navigate to="/offline/sign" replace /> },
  { path: '/offline/sign', name: 'OfflineSign', element: <OfflineSignPage /> },
  { path: '/offline/cosign', name: 'OfflineCosign', element: <OfflineCosignPage /> },
  // Old address of the screen (it used to be an item of the Symbol menu).
  { path: '/offline-sign', name: 'OfflineSignOld', element: <Navigate to="/offline/sign" replace /> },
  { path: '/harvest', name: 'HarvestSettings', element: <KeyRequired><NotMijin><ByChain symbol={<HarvestSettings />} nem={<NemHarvest />} /></NotMijin></KeyRequired> },
  // 「サービス」: NEM has the SuperNode Program, Apostille, DNS, NEMonster, Voting ...; Symbol has Apostille, DNS and NEMonster.
  { path: '/service', name: 'ServiceHub', element: <KeyRequired><NotMijin><ServiceHub /></NotMijin></KeyRequired> },
  // Symbol 事前オプトインの体験（デモ）。全画面で自前の「閉じる」を持つので ServiceFrame は付けない。
  { path: '/optin', name: 'OptinPage', element: <KeyRequired><NemOnly><OptinPage /></NemOnly></KeyRequired> },
  { path: '/post-optin', name: 'PostOptinPage', element: <KeyRequired><NemOnly><PostOptinPage /></NemOnly></KeyRequired> },
  { path: '/supernode', name: 'SupernodePage', element: <KeyRequired><NemOnly><ServiceFrame><SupernodePage /></ServiceFrame></NemOnly></KeyRequired> },
  { path: '/apostille', name: 'ApostillePage', element: <KeyRequired><ServiceFrame><ApostillePage /></ServiceFrame></KeyRequired> },
  { path: '/dns', name: 'Dns', element: <KeyRequired><NotMijin><ServiceFrame><ByChain symbol={<SymbolDns />} nem={<NemDns />} /></ServiceFrame></NotMijin></KeyRequired> },
  { path: '/signed-message', name: 'SignedMessage', element: <KeyRequired><NotMijin><ServiceFrame><ByChain symbol={<SymbolSignedMessage />} nem={<NemSignedMessage />} /></ServiceFrame></NotMijin></KeyRequired> },
  { path: '/nemonster', name: 'NemMonster', element: <KeyRequired><NotMijin><ServiceFrame><NemMonster /></ServiceFrame></NotMijin></KeyRequired> },
  { path: '/voting', name: 'NemVotingList', element: <KeyRequired><NotMijin><ServiceFrame><ByChain symbol={<SymbolVotingList />} nem={<NemVotingList />} /></ServiceFrame></NotMijin></KeyRequired> },
  { path: '/voting/create', name: 'NemVotingCreate', element: <KeyRequired><NotMijin><ByChain symbol={<SymbolVotingCreate />} nem={<NemVotingCreate />} /></NotMijin></KeyRequired> },
  { path: '/voting/poll/:address', name: 'NemVotingDetail', element: <KeyRequired><NotMijin><ByChain symbol={<SymbolVotingDetail />} nem={<NemVotingDetail />} /></NotMijin></KeyRequired> },
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
