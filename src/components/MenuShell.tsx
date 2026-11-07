import { Outlet, useLocation } from 'react-router-dom';
import { Box, useMediaQuery } from '@mui/material';
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import NavigationDrawer from './NavigationDrawer';
import LiveUpdates from './LiveUpdates';
import NemNamespaceExpiryNotice from './NemNamespaceExpiryNotice';
import SymbolNamespaceExpiryNotice from './SymbolNamespaceExpiryNotice';
import OfflineIssueHost from './OfflineIssueHost';
import { useMenuStore } from '../store/menuStore';
import { hasNoMenuPath } from '../theme/designScope';
import { Environment } from '../lib/environment';

// From this viewport width up the page is shrunk next to the expanded menu; below it the
// expanded menu floats OVER the page instead (see the doc comment on MenuShell).
const WIDE_QUERY = '(min-width: 900px)';
// Expanded sidebar: 280px, but never more than ~78% of a narrow phone screen.
const MENU_WIDTH = 'min(280px, 78vw)';
// Collapsed sidebar: a narrow icon rail that is always visible and always takes its own space.
const RAIL_WIDTH = '72px';
// モバイル表示（iOS / Android）の下のナビゲーションの高さ（ホームバーなどの安全領域は別に足す）。
const BOTTOM_NAV_HEIGHT = '60px';

// Sign-in / onboarding / profile-selection screens have no menu at all (the list lives in theme/designScope.ts).

/**
 * Layout wrapped around every route. A full-height sidebar sits on the left edge with no dimming
 * backdrop. It is always visible as a narrow icon rail; its hamburger button widens it into the
 * labelled menu and collapses it back. Nothing else opens or closes it.
 * The page is NEVER pushed off-screen or clipped - it is always laid out at the full width of
 * the space that is actually available:
 *  - Menu hidden (no sidebar on this route): the page uses the whole width.
 *  - Collapsed: the page uses the space right of the icon rail.
 *  - Expanded, wide screens (>= 900px): the page shrinks to the space right of the menu.
 *  - Expanded, narrow screens (phones): the labelled menu floats over the page, which keeps the
 *    full width it has next to the rail (shrinking it to the ~100px left of a 280px menu would
 *    be unusable, and pushing it aside is what used to cut off its right-hand part).
 *  - モバイル表示（iOS / Android からのアクセス。画面の幅ではなく端末で決める）: 左のレールは出さず、ページは全幅。
 *    下にナビゲーション（ホーム・アカウント・サービス・設定・メニュー）が付き、「メニュー」で全項目が左から重なって開く。
 */
export default function MenuShell() {
  const expanded = useMenuStore((s) => s.open);
  const toggle = useMenuStore((s) => s.toggle);
  const { pathname } = useLocation();
  const isWide = useMediaQuery(WIDE_QUERY);
  const hasMenu = !hasNoMenuPath(pathname);
  // iOS / Android: 端末で決める（アクセス中は変わらない）。
  const mobile = Environment.isMobile();
  // The page's left padding animates only while the menu is toggled between rail and full width. Going to or from a
  // screen without a menu (login / logout, onboarding) must not slide the page: that render skips the transition.
  const hadMenu = useRef(hasMenu);
  const animatePadding = hadMenu.current && hasMenu;
  useEffect(() => { hadMenu.current = hasMenu; }, [hasMenu]);
  // 下のナビゲーションの高さを <html> にも置く（ダイアログなど、シェルの外に出る固定表示が、ナビゲーションに重ならないように使う）。
  const bottomNav = hasMenu && mobile ? `calc(${BOTTOM_NAV_HEIGHT} + env(safe-area-inset-bottom, 0px))` : '0px';
  useEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', bottomNav);
    return () => { document.documentElement.style.removeProperty('--bottom-nav-height'); };
  }, [bottomNav]);

  const vars = {
    '--menu-width': MENU_WIDTH,
    '--rail-width': RAIL_WIDTH,
    // Left edge of the usable area, for full-width fixed bars.
    // (Narrow screens: the expanded menu overlays the page, so only the rail is reserved.)
    '--menu-left': !hasMenu || mobile ? '0px' : expanded && isWide ? MENU_WIDTH : RAIL_WIDTH,
    // 下のナビゲーションの高さ（モバイルでメニューのある画面だけ）。ページはこの分だけ上に空ける。
    '--bottom-nav-height': bottomNav,
  } as CSSProperties;

  return (
    <Box style={vars} sx={{ overflowX: 'clip', flexGrow: 1, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {hasMenu && <NavigationDrawer expanded={expanded} onToggle={toggle} mobile={mobile} />}
      {/* Live updates from the node (Symbol): only on screens with the menu, i.e. while a wallet is in use. */}
      {hasMenu && <LiveUpdates />}
      {/* NEM: a warning when a root namespace expires within a month (as in the official wallet). */}
      {hasMenu && <NemNamespaceExpiryNotice />}
      {/* Symbol: the same warning for a root namespace that expires within a month. */}
      {hasMenu && <SymbolNamespaceExpiryNotice />}
      {/* オフラインのため送らずにQRコードにしたトランザクション: どの画面からでも、ここで確認画面が開く。 */}
      <OfflineIssueHost />
      <Box
        sx={{
          // #root is always the full window width, so the page just reserves the sidebar's width.
          // モバイルは、左右の切り欠き（横向きのときのノッチ）の安全領域だけ空ける。下は、下のナビゲーションの高さの分。
          paddingLeft: mobile ? 'env(safe-area-inset-left, 0px)' : 'var(--menu-left)',
          paddingRight: mobile ? 'env(safe-area-inset-right, 0px)' : undefined,
          paddingBottom: 'var(--bottom-nav-height, 0px)',
          boxSizing: 'border-box', width: '100%', minWidth: 0,
          transition: animatePadding && !mobile ? 'padding-left 0.25s ease' : 'none',
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
