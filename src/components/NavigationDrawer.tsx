import type { ReactNode } from 'react';
import { useState } from 'react';
import { List, ListItemButton, ListItemIcon, ListItemText, Box, Divider, Typography, Avatar, IconButton, ButtonBase, Tooltip, Menu, MenuItem, useTheme } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import MenuIcon from '@mui/icons-material/Menu';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined';
import TokenOutlinedIcon from '@mui/icons-material/TokenOutlined';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PetsOutlinedIcon from '@mui/icons-material/PetsOutlined';
import HowToVoteOutlinedIcon from '@mui/icons-material/HowToVoteOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { activeNetworkLabel } from '../lib/chainApi';
import ErrorSnackbar from './ErrorSnackbar';
import { CHAIN_LOGOS } from '../lib/chainIcons';
import { CHAINS, CHAIN_ORDER } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { KasaneWordmark } from './kasane/KasaneLogo';
import { WalletsHelper } from '../lib/storage';

// Width of the collapsed icon rail; the header cells below use it so icons keep their x position.
const RAIL_WIDTH_PX = 72;

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
  const theme = useTheme();
  // Panel colours follow the chain (Symbol: warm KASANE, NEM: cool KASANE) and the light / dark scheme.
  const M = theme.kasane.menu;
  const INK = theme.kasane.ink;
  const ACTIVE_BG = M.activeGradient;
  const [chainMenuAnchor, setChainMenuAnchor] = useState<HTMLElement | null>(null);
  const TEXT = M.text;
  const ICON = M.icon;
  const LINE = M.line;
  const [errorMessage, setErrorMessage] = useState('');
  // The header shows which chain and network the wallet is on (Symbol / NEM, Mainnet / Testnet).
  useAppStore((st) => st.network);
  const networkName = `${CHAINS[chain].name} ${activeNetworkLabel()}`;

  const iconSx = { color: 'inherit' };
  const items: ({ title: string; icon: ReactNode; active: boolean; action: () => void } | null)[] = [
    // 受け取る / 送る / 取引履歴 live on Home (the history is a section of Home), so Home also counts as active on those screens and on a transaction's detail.
    { title: 'Home', icon: <HomeOutlinedIcon sx={iconSx} />, active: pathname === '/top' || pathname.startsWith('/send') || pathname.startsWith('/transaction'), action: () => navigate('/top', { replace: true }) },
    // Order: Home, then ウォレット切替, then モザイク, then ネームスペース, then メタデータ, then マルチシグ, then アグリゲート, then ハーベスト (NEM: スーパーノードプログラム).
    { title: t('wallet.switch'), icon: <AccountBalanceWalletOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/wallet'), action: () => navigate('/wallet/switch') },
    // Metadata / aggregate are Symbol features, so NEM mode leaves them out.
    // Mosaics and namespaces are on both chains.
    { title: t('home.nav_mosaic'), icon: <TokenOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/mosaic'), action: () => navigate('/mosaic') },
    { title: t('home.nav_namespace'), icon: <LabelOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/namespace'), action: () => navigate('/namespace') },
    ...(chain === 'symbol' ? [
      { title: t('home.nav_metadata'), icon: <DataObjectOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/metadata'), action: () => navigate('/metadata') },
    ] : []),
    { title: t('home.nav_multisig'), icon: <GroupsOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/multisig'), action: () => navigate('/multisig') },
    ...(chain === 'symbol' ? [
      { title: t('home.nav_aggregate'), icon: <LayersOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/aggregate'), action: () => navigate('/aggregate') },
    ] : []),
    // Harvest (Symbol: delegated harvesting; NEM: delegated harvesting via a remote account) sits below
    // the main navigation items, just above the About / Settings group.
    { title: t('home.nav_harvest'), icon: <AgricultureOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/harvest'), action: () => navigate('/harvest') },
    // The SuperNode Program and NEMonster are NEM features; they follow Harvest on that chain.
    ...(chain === 'nem' ? [
      { title: t('home.nav_supernode'), icon: <DnsOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/supernode'), action: () => navigate('/supernode') },
      // NEMonster (a small collecting game on NIS1) follows the SuperNode Program.
      { title: t('home.nav_nemonster'), icon: <PetsOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/nemonster'), action: () => navigate('/nemonster') },
      // Voting (polls in the format of the official NEM Wallet) follows NEMonster.
      { title: t('home.nav_voting'), icon: <HowToVoteOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/voting'), action: () => navigate('/voting') },
    ] : []),
    null,
    { title: 'About', icon: <InfoOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/about'), action: () => navigate('/about') },
    { title: t('common.settings'), icon: <SettingsOutlinedIcon sx={iconSx} />, active: pathname.startsWith('/settings'), action: () => navigate('/settings/top') },
  ];

  // The logo of the selected chain, with the little up/down badge that tells it can be switched.
  const avatarVisual = (size: number) => (
    <Box sx={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <Avatar sx={{ width: size, height: size, bgcolor: M.avatarBg, flexShrink: 0 }}>
        <Box component="img" src={CHAIN_LOGOS[chain]} sx={{ width: '75%' }} />
      </Avatar>
      <UnfoldMoreIcon sx={{ position: 'absolute', right: -6, bottom: -4, fontSize: 16, color: TEXT, bgcolor: M.hover, borderRadius: '50%' }} />
    </Box>
  );

  // Collapsed rail: only the logo fits, so the logo itself is the button.
  const avatarButton = (size: number) => (
    <Tooltip title={`${networkName} - ${t('chain.switch')}`} placement="right">
      <IconButton
        onClick={(e) => setChainMenuAnchor(e.currentTarget)}
        aria-label={t('chain.switch')}
        aria-haspopup="menu"
        sx={{ p: 0 }}
      >
        {avatarVisual(size)}
      </IconButton>
    </Tooltip>
  );

  const onSelectChain = async (next: ChainKey) => {
    setChainMenuAnchor(null);
    if (next === chain) return;
    setChain(next); // also updates the module-level chain the storage / API helpers read
    // A chain without a wallet yet goes to the wallet screen to create / import one.
    const active = await WalletsHelper.getActive();
    navigate(active ? '/top' : '/wallet/select', { replace: true });
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
        {/* One header layout for both states, so the hamburger and the avatar never move:
            each sits in a cell exactly as wide as the collapsed rail (RAIL_WIDTH_PX), centred,
            and the rows are top-aligned. Expanding only adds the name next to the avatar. */}
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
            {expanded && <KasaneWordmark width={104} color={TEXT} />}
          </Box>
          {expanded ? (
            // Expanded menu: the whole row (logo + "Symbol Mainnet") is one button that opens the picker.
            <ButtonBase
              onClick={(e) => setChainMenuAnchor(e.currentTarget)}
              aria-label={t('chain.switch')}
              aria-haspopup="menu"
              sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start', textAlign: 'left',
                width: 'calc(100% - 16px)', mt: 1, mx: '8px', py: 0.5, pr: 1, borderRadius: '16px',
                '&:hover': { bgcolor: M.hover },
                '&.Mui-focusVisible': { bgcolor: M.hover },
              }}
            >
              <Box sx={{ width: RAIL_WIDTH_PX - 8, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                {avatarVisual(40)}
              </Box>
              <Typography sx={{ fontSize: 'large', color: TEXT, wordBreak: 'break-all', flexGrow: 1, minWidth: 0 }}>{networkName}</Typography>
            </ButtonBase>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'flex-start', mt: 1 }}>
              <Box sx={{ width: RAIL_WIDTH_PX, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                {avatarButton(40)}
              </Box>
            </Box>
          )}
        </Box>

        <Menu
          anchorEl={chainMenuAnchor}
          open={chainMenuAnchor !== null}
          onClose={() => setChainMenuAnchor(null)}
          // The menu is a fixed element above the page, so it must sit above the side panel.
          slotProps={{ root: { sx: { zIndex: 1300 } } }}
        >
          {CHAIN_ORDER.map((key) => (
            <MenuItem key={key} selected={key === chain} onClick={() => void onSelectChain(key)} sx={{ gap: 1.5, minWidth: 180 }}>
              <Avatar src={CHAIN_LOGOS[key]} sx={{ width: 28, height: 28, bgcolor: 'transparent' }} />
              <Typography sx={{ flexGrow: 1 }}>{CHAINS[key].name}</Typography>
              {key === chain && <CheckIcon fontSize="small" />}
            </MenuItem>
          ))}
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
                    borderRadius: '14px', mb: 0.5, py: 1.25, px: '12px', overflow: 'hidden', flexShrink: 0, color: item.active ? INK : ICON,
                    '&.Mui-selected, &.Mui-selected:hover': { background: ACTIVE_BG, boxShadow: M.activeShadow },
                    '&:hover': { bgcolor: M.hover },
                  }}
                >
                  {/* Same x position as the icon in the collapsed rail, so widening the menu only
                     reveals the labels instead of moving the icons. */}
                  <ListItemIcon sx={{ color: 'inherit', minWidth: 24, width: 24, flexShrink: 0 }}>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.title}
                    sx={{ ml: 2, whiteSpace: 'nowrap', display: expanded ? 'block' : 'none' }}
                    slotProps={{ primary: { sx: { color: item.active ? INK : TEXT, fontWeight: item.active ? 600 : 400 } } }}
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
