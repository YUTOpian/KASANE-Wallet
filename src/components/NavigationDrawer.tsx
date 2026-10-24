import type { ReactNode } from 'react';
import { useState } from 'react';
import { List, ListItemButton, ListItemIcon, ListItemText, Box, Divider, Typography, Avatar, IconButton, ButtonBase, Tooltip, Menu, MenuItem, useTheme } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import MenuIcon from '@mui/icons-material/Menu';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { activeNetworkLabel } from '../lib/chainApi';
import ErrorSnackbar from './ErrorSnackbar';
import { CHAIN_LOGOS, chainLogo } from '../lib/chainIcons';
import { CHAINS, CHAIN_ORDER } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import type { SymbolNetwork } from '../lib/symbol/constants';
import { KasaneWordmark } from './kasane/KasaneLogo';
import { AccountNavIcon, AggregateNavIcon, HarvestNavIcon, MosaicNavIcon, MultisigNavIcon, NamespaceNavIcon } from './NavIcons';
import type { ImageKey } from '../theme/customTheme';
import { WalletsHelper } from '../lib/storage';
import { useNoKey, useWatchOnly } from '../hooks/useWatchOnly';

// ネットワーク切り替えメニューの大きさ（一定）: 幅と、1行の高さ。
const CHAIN_MENU_WIDTH = 252;
const CHAIN_MENU_ROW_HEIGHT = 40;

// Width of the collapsed icon rail; the header cells below use it so icons keep their x position.
const RAIL_WIDTH_PX = 72;

// Labels (menu names, wordmark, network name) stay mounted in both states and are clipped by the nav while it is narrow;
// they fade with the same 0.25s as the nav's width, a little later when opening so the wipe leads and the text follows.
const labelFadeSx = (expanded: boolean) => ({
  opacity: expanded ? 1 : 0,
  transition: `opacity ${expanded ? '0.18s ease 0.07s' : '0.12s ease'}`,
});

interface NavigationDrawerProps {
  // true = full menu with labels; false = narrow icon rail (the "closed" state).
  expanded: boolean;
  onToggle: () => void;
}

// Ported from src/components/parts/NavigationDrawer.vue. A full-height sidebar fixed to the left
// edge, always visible as a narrow icon rail and widened to a labelled menu by its hamburger
// button (see MenuShell, which makes room for it next to the page). It is never closed
// automatically: navigating, tapping an entry or pressing Escape leave it as it is - only the
// hamburger toggles it.
export default function NavigationDrawer({ expanded, onToggle }: NavigationDrawerProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const setChain = useAppStore((s) => s.setChain);
  const setNetwork = useAppStore((s) => s.setNetwork);
  // 閲覧用プロファイル（アドレスだけ）では、署名が要る機能はメニューに出さない。
  const watchOnly = useNoKey();
  // 閲覧用プロファイルは、アドレスのチェーン・ネットワークで固定。ロゴの切り替えメニュー（ネットワーク選択）は開かない。
  const viewOnly = useWatchOnly();
  const theme = useTheme();
  // Panel colours follow the chain (Symbol: warm KASANE, NEM: cool KASANE) and the light / dark scheme.
  const M = theme.kasane.menu;
  // Text / icons of the active entry sit on the gradient (or, in ビジネス, frosted) pill.
  const INK = M.activeText ?? theme.kasane.onGradient;
  const ACTIVE_BG = M.activeGradient;
  const [chainMenuAnchor, setChainMenuAnchor] = useState<HTMLElement | null>(null);
  // 「もっと見る」: Symbol / NEM のテストネットと mijin を出す。
  const [moreOpen, setMoreOpen] = useState(false);
  const TEXT = M.text;
  const ICON = M.icon;
  const LINE = M.line;
  const [errorMessage, setErrorMessage] = useState('');
  // The header shows which chain and network the wallet is on (Symbol / NEM, Mainnet / Testnet).
  const network = useAppStore((st) => st.network);
  // mijin is shown as just "mijin" (not "Symbol mijin").
  const networkName = chain === 'symbol' && network === 'mijin' ? activeNetworkLabel() : `${CHAINS[chain].name} ${activeNetworkLabel()}`;

  const iconSx = { color: 'inherit', fontSize: 28 };
  // カスタムテーマで、サイドメニューのアイコンを画像に替えていれば、その画像を（32px の枠に収めて）使う。
  const navImages = theme.kasane.images;
  const navIcon = (key: ImageKey, fallback: ReactNode): ReactNode =>
    navImages[key] ? <Box component="img" src={navImages[key]} alt="" sx={{ display: 'block', width: 30, height: 30, objectFit: 'contain' }} /> : fallback;
  const items: ({ title: string; icon: ReactNode; active: boolean; action: () => void } | null)[] = [
    // 受け取る / 送る / 取引履歴 live on Home (the history is a section of Home), so Home also counts as active on those screens and on a transaction's detail.
    { title: t('home.nav_home'), icon: navIcon('navHome', <HomeOutlinedIcon sx={iconSx} />), active: pathname === '/top' || pathname.startsWith('/send') || pathname.startsWith('/transaction'), action: () => navigate('/top', { replace: true }) },
    // Order: Home, then アカウント, then モザイク, then ネームスペース, then マルチシグ, then ハーベスト, then アグリゲート (Symbol only).
    // メタデータとアカウント制限はメニューに出さない：メタデータは各画面（アカウント・モザイク・ネームスペース）で設定でき、アカウント制限は「アカウント」画面の中にある。
    { title: t('wallet.switch'), icon: navIcon('navAccount', <AccountNavIcon />), active: pathname.startsWith('/account') || pathname.startsWith('/addressbook') || pathname.startsWith('/wallet'), action: () => navigate('/account') },
    // アドレス帳（連絡先・ホワイトリスト/ブラックリスト）は「アカウント」画面のタブ（?tab=addressbook）。
    // Aggregate is a Symbol feature, so NEM mode leaves it out.
    // Mosaics and namespaces are on both chains.
    { title: t('home.nav_mosaic'), icon: navIcon('navMosaic', <MosaicNavIcon />), active: pathname.startsWith('/mosaic'), action: () => navigate('/mosaic') },
    { title: t('home.nav_namespace'), icon: navIcon('navNamespace', <NamespaceNavIcon />), active: pathname.startsWith('/namespace'), action: () => navigate('/namespace') },
    ...(!watchOnly ? [
      { title: t('home.nav_multisig'), icon: navIcon('navMultisig', <MultisigNavIcon />), active: pathname.startsWith('/multisig'), action: () => navigate('/multisig') },
    ] : []),
    // Harvest (Symbol: delegated harvesting; NEM: delegated harvesting via a remote account) sits below
    // the main navigation items, just above the Links / Settings group.
    // mijin has no harvesting entry.
    ...(!watchOnly && !(chain === 'symbol' && network === 'mijin') ? [
      { title: t('home.nav_harvest'), icon: navIcon('navHarvest', <HarvestNavIcon />), active: pathname.startsWith('/harvest'), action: () => navigate('/harvest') },
    ] : []),
    // Aggregate is a Symbol feature (NEM mode leaves it out); it follows Harvest.
    ...(chain === 'symbol' && !watchOnly ? [
      { title: t('home.nav_aggregate'), icon: navIcon('navAggregate', <AggregateNavIcon />), active: pathname.startsWith('/aggregate'), action: () => navigate('/aggregate') },
    ] : []),
    // The SuperNode Program, NEMonster and Voting are NEM features: one 「サービス」 entry, whose screen shows them as tiles.
    // Symbol has NEMonster there too (not on mijin).
    ...(!watchOnly && !(chain === 'symbol' && network === 'mijin') ? [
      { title: t('home.nav_service'), icon: navIcon('navService', <AppsOutlinedIcon sx={iconSx} />), active: ['/service', '/supernode', '/nemonster', '/apostille', '/signed-message', '/dns', '/voting', '/optin', '/post-optin'].some((p) => pathname.startsWith(p)), action: () => navigate('/service') },
    ] : []),
    null,
    { title: t('links.title'), icon: navIcon('navLinks', <InfoOutlinedIcon sx={iconSx} />), active: pathname.startsWith('/links'), action: () => navigate('/links') },
    { title: t('common.settings'), icon: navIcon('navSettings', <SettingsOutlinedIcon sx={iconSx} />), active: pathname.startsWith('/settings'), action: () => navigate('/settings/top') },
  ];

  // The logo of the selected chain, with the little up/down badge that tells it can be switched (not shown for a view-only profile).
  const avatarVisual = (size: number) => (
    <Box sx={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <Avatar sx={{ width: size, height: size, bgcolor: M.avatarBg, flexShrink: 0 }}>
        <Box component="img" src={chainLogo(chain, network)} sx={{ width: '75%' }} />
      </Avatar>
      {!viewOnly && <UnfoldMoreIcon sx={{ position: 'absolute', right: -6, bottom: -4, fontSize: 16, color: TEXT, bgcolor: M.hover, borderRadius: '50%' }} />}
    </Box>
  );

  // The choices of the network picker: Symbol and NEM (mainnet) are always shown; the testnets and mijin sit behind 「もっと見る」.
  type NetworkChoice = { chain: ChainKey; network: SymbolNetwork };
  // 並び順は、選んでいるチェーンが先頭: Symbol → Symbol メイン, NEM メイン, Symbol テスト, NEM テスト, mijin。
  // NEM → NEM メイン, Symbol メイン, NEM テスト, Symbol テスト, mijin。
  const ORDERED_CHAINS: ChainKey[] = [chain, ...CHAIN_ORDER.filter((key) => key !== chain)];
  const MAIN_CHOICES: NetworkChoice[] = ORDERED_CHAINS.map((key) => ({ chain: key, network: 'mainnet' }));
  const MORE_CHOICES: NetworkChoice[] = [
    ...ORDERED_CHAINS.map((key): NetworkChoice => ({ chain: key, network: 'testnet' })),
    { chain: 'symbol', network: 'mijin' },
  ];
  const isSelectedChoice = (c: NetworkChoice) => c.chain === chain && c.network === network;
  const choiceName = (c: NetworkChoice) =>
    c.network === 'mijin' ? t('settings.network_mijin') : `${CHAINS[c.chain].name} ${t(c.network === 'testnet' ? 'settings.network_testnet' : 'settings.network_mainnet')}`;
  const choiceLogo = (c: NetworkChoice) => (c.chain === 'symbol' ? chainLogo('symbol', c.network) : CHAIN_LOGOS[c.chain]);
  const openChainMenu = (el: HTMLElement) => {
    if (viewOnly) return;
    setMoreOpen(MORE_CHOICES.some(isSelectedChoice)); // open with the current network visible
    setChainMenuAnchor(el);
  };

  const onSelectChain = async (choice: NetworkChoice) => {
    const next = choice.chain;
    setChainMenuAnchor(null);
    if (choice.network === network && next === chain) return;
    // Same as 設定 > ネットワーク: moving to mijin leaves NEM (it has no mijin), and the network is shared by the app.
    if (choice.network !== network) setNetwork(choice.network);
    if (next === chain) return; // e.g. Symbol mainnet <-> testnet: stay on this screen
    setChain(next); // also updates the module-level chain the storage / API helpers read
    // A chain without a wallet yet goes to the wallet screen to create / import one.
    // 閲覧用プロファイルは、そのチェーンのアドレスが無くても Home へ（Home でアドレスを追加できる）。
    const active = await WalletsHelper.getActive();
    const viewOnly = active === null && await WalletsHelper.isActiveWatchOnly();
    navigate(active || viewOnly ? '/top' : '/wallet/select', { replace: true });
  };

  return (
    <>
      <Box
        component="nav"
        aria-label="menu"
        sx={{
          position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 1200,
          width: expanded ? 'var(--menu-width, 280px)' : 'var(--rail-width, 72px)',
          transition: 'width 0.25s ease',
          background: M.panel, color: TEXT, overflowY: 'auto', overflowX: 'hidden',
          // Keep the rail scrollable on short windows, but without a fat scrollbar covering the icons.
          scrollbarWidth: 'none', msOverflowStyle: 'none', '&::-webkit-scrollbar': { display: 'none' },
          borderRight: `1px solid ${LINE}`, boxShadow: M.shadow,
        }}
      >
        {/* One header layout for both states, and the SAME elements in both: nothing is swapped or
            mounted/unmounted when the menu is toggled, so the width animation only wipes the
            labels in and out (the nav clips them). The hamburger and the avatar sit on the rail's
            centre line (RAIL_WIDTH_PX / 2) and never move, and the header has the same height in both
            states. The texts are laid out at their final (expanded) width and never re-wrap while the
            nav is narrower, which is what used to make the header jump during the animation. */}
        <Box
          sx={{
            borderBottom: `1px solid ${LINE}`, pt: 1, pb: 1.5,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Box sx={{ width: RAIL_WIDTH_PX, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <IconButton
                onClick={onToggle}
                aria-label={expanded ? 'collapse menu' : 'expand menu'}
                aria-expanded={expanded}
                sx={{ color: TEXT }}
              >
                <MenuIcon />
              </IconButton>
            </Box>
            <Box aria-hidden={!expanded} sx={{ flexShrink: 0, pointerEvents: 'none', ...labelFadeSx(expanded) }}>
              <KasaneWordmark width={104} color={TEXT} />
            </Box>
          </Box>
          {/* The whole row (logo + "Symbol Mainnet") is one button that opens the picker. In the rail only the logo
              is visible (the rest is clipped by the nav) and the tooltip names the network. */}
          <Tooltip title={expanded ? '' : viewOnly ? networkName : `${networkName} - ${t('chain.switch')}`} placement="right">
            <ButtonBase
              onClick={(e) => openChainMenu(e.currentTarget)}
              aria-label={viewOnly ? networkName : t('chain.switch')}
              aria-haspopup={viewOnly ? undefined : 'menu'}
              disableRipple={viewOnly}
              sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start', textAlign: 'left',
                // The cell below is 64px wide, so starting 4px from the edge puts the avatar on the rail's centre line (36px).
                // The width does not follow the nav while it animates (the nav clips it).
                flexShrink: 0, ml: '4px', mt: 1, py: 0.5, pr: 1, borderRadius: '16px', cursor: viewOnly ? 'default' : 'pointer',
                width: `calc(var(--menu-width, 280px) - 8px)`,
                '&:hover': { bgcolor: expanded && !viewOnly ? M.hover : 'transparent' },
                '&.Mui-focusVisible': { bgcolor: expanded && !viewOnly ? M.hover : 'transparent' },
              }}
            >
              <Box sx={{ width: RAIL_WIDTH_PX - 8, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                {avatarVisual(40)}
              </Box>
              <Typography
                sx={{
                  fontSize: 'large', color: TEXT, wordBreak: 'break-all', flex: 'none', ...labelFadeSx(expanded),
                  // = the button's width - the avatar cell (64px) - its right padding (8px)
                  width: `calc(var(--menu-width, 280px) - 8px - ${RAIL_WIDTH_PX - 8}px - 8px)`,
                }}
              >
                {networkName}
              </Typography>
            </ButtonBase>
          </Tooltip>
        </Box>

        <Menu
          anchorEl={chainMenuAnchor}
          open={chainMenuAnchor !== null}
          onClose={() => setChainMenuAnchor(null)}
          // The menu is a fixed element above the page, so it must sit above the side panel.
          // 大きさは状態ごとに一定: 幅は常に同じで、高さは行数ぶん（Symbol・NEMの2つだけのときは、その2行＋「もっと見る」の大きさ。
          // 「もっと見る」で全項目を出したときは、全項目＋「閉じる」の大きさ）。余白は足さない。
          slotProps={{
            root: { sx: { zIndex: 1300 } },
            paper: { sx: { width: `min(${CHAIN_MENU_WIDTH}px, calc(100vw - 32px))` } },
          }}
        >
          {[...MAIN_CHOICES, ...(moreOpen ? MORE_CHOICES : [])].map((c) => (
            <MenuItem key={`${c.chain}-${c.network}`} selected={isSelectedChoice(c)} onClick={() => void onSelectChain(c)} sx={{ gap: 1.5, height: CHAIN_MENU_ROW_HEIGHT, minHeight: CHAIN_MENU_ROW_HEIGHT }}>
              <Avatar src={choiceLogo(c)} sx={{ width: 28, height: 28, bgcolor: 'transparent' }} />
              <Typography sx={{ flexGrow: 1 }}>{choiceName(c)}</Typography>
              {isSelectedChoice(c) && <CheckIcon fontSize="small" />}
            </MenuItem>
          ))}
          <MenuItem onClick={() => setMoreOpen((v) => !v)} sx={{ gap: 1.5, height: CHAIN_MENU_ROW_HEIGHT, minHeight: CHAIN_MENU_ROW_HEIGHT, color: 'text.secondary' }}>
            <Box sx={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {moreOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </Box>
            <Typography sx={{ flexGrow: 1 }}>{t(moreOpen ? 'chain.less' : 'chain.more')}</Typography>
          </MenuItem>
        </Menu>

        <List sx={{ px: 1.5, py: 1.5 }}>
          {items.map((item, i) =>
            item === null ? (
              <Divider key={i} sx={{ my: 1, borderColor: LINE }} />
            ) : (
              <Tooltip key={item.title} title={expanded ? '' : item.title} placement="right">
                <ListItemButton
                  onClick={item.action}
                  selected={item.active}
                  sx={{
                    // The open page is filled with the menu's colour gradient. px keeps the 32px icon centred in the collapsed rail.
                    borderRadius: '14px', mb: 0.5, py: 1.5, px: '8px', overflow: 'hidden', flexShrink: 0, color: item.active ? INK : ICON,
                    '&.Mui-selected, &.Mui-selected:hover': { background: ACTIVE_BG, boxShadow: M.activeShadow },
                    // On the gradient the accent strokes (magenta) nearly vanish, so the open page's icon is drawn
                    // entirely in the dark ink colour with a slightly heavier line.
                    '&.Mui-selected': { '--nav-accent': INK },
                    '&.Mui-selected svg g': { strokeWidth: 1.9 },
                    '&:hover': { bgcolor: M.hover },
                  }}
                >
                  {/* Same x position as the icon in the collapsed rail, so widening the menu only
                     reveals the labels instead of moving the icons. The label stays mounted (never display: none)
                     and is clipped by the button while the rail is narrow, so it is wiped in/out with the width. */}
                  <ListItemIcon sx={{ color: 'inherit', minWidth: 32, width: 32, height: 32, flexShrink: 0, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.title}
                    sx={{ ml: 3, whiteSpace: 'nowrap', ...labelFadeSx(expanded) }}
                    slotProps={{ primary: { sx: { color: item.active ? INK : TEXT, fontWeight: item.active ? 600 : 400, fontSize: '1.05rem' } } }}
                  />
                </ListItemButton>
              </Tooltip>
            )
          )}
        </List>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </>
  );
}
