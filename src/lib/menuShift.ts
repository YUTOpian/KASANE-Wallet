/**
 * Screen-fixed elements (bottom nav, wallet notch, address-book bars, the add FAB) are not
 * positioned by the content wrapper's padding, because `position: fixed` ignores it. MenuShell
 * publishes CSS variables for them:
 *
 *  - --menu-left:   x of the page's left edge (0px with no menu, the icon-rail width when
 *                   collapsed or on phones, the full menu width when expanded on wide screens).
 *                   Full-width fixed bars start at this x so they stay inside the page.
 *  - --menu-offset: always 0px now - the page is never pushed aside, it is only ever shrunk.
 *
 * Use `menuShiftSx` for elements anchored to the right edge (e.g. a FAB) and `menuBarSx` for
 * full-width bars that set `left: 0` / `right: 0` (put it after those keys).
 */
export const menuShiftSx = {
  transform: 'translateX(var(--menu-offset, 0px))',
  transition: 'transform 0.25s ease, left 0.25s ease',
} as const;

export const menuBarSx = {
  ...menuShiftSx,
  left: 'var(--menu-left, 0px)',
} as const;
