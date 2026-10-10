import { alpha, createTheme } from '@mui/material/styles';
import type { ChainKey } from '../lib/chain';
import type { ThemeMode } from '../store/appStore';

// KASANE design for every screen of the app.
// Taken from the KASANE logo: a muted mauve-grey stage, the coral -> pink -> lavender -> aqua -> mint
// gradient of the hexagon, and the pale yellow-green of the thin geometric wordmark.
//
// The chain changes the *tint* of that design, never its character:
//   Symbol = the warm half of the gradient (coral -> pink -> lavender) on a mauve stage,
//   NEM    = the cool half of the gradient (lavender -> aqua -> mint) on a teal-grey stage.
export const KASANE = {
  coral: '#FA7268',
  pink: '#E58AAE',
  lavender: '#B79BD0',
  aqua: '#7ED1C0',
  mint: '#55E2A0',
  lime: '#EAF4A6', // wordmark
  limeSoft: 'rgba(234,244,166,0.68)',
  limeLine: 'rgba(234,244,166,0.30)',
  ink: '#262129', // text on the gradient
  bg: '#2B262D',
  bgGlow: '#554C58',
  paper: '#3A343D',
} as const;

// The full logo gradient (used by the logo itself, which never changes with the chain).
export const KASANE_GRADIENT_V = `linear-gradient(180deg, ${KASANE.coral} 0%, ${KASANE.pink} 36%, ${KASANE.lavender} 58%, ${KASANE.aqua} 80%, ${KASANE.mint} 100%)`;
export const KASANE_GRADIENT_H = `linear-gradient(90deg, ${KASANE.coral} 0%, ${KASANE.pink} 34%, ${KASANE.lavender} 62%, ${KASANE.mint} 100%)`;
export const KASANE_STAGE_BG = `radial-gradient(ellipse at 50% 22%, ${KASANE.bgGlow} 0%, ${KASANE.bg} 70%)`;

export interface KasaneMenuTokens {
  panel: string;
  text: string;
  icon: string;
  line: string;
  hover: string;
  shadow: string;
  activeGradient: string;
  activeShadow: string;
  avatarBg: string;
}

// Everything chain / mode dependent that is not a plain MUI palette entry. Read it with
// `useTheme().kasane` (or `(t) => t.kasane...` inside sx).
// 'base' = the neutral KASANE look of the first-run screens (no Symbol / NEM tint).
export type DesignKey = ChainKey | 'base';

export interface KasaneTokens {
  chain: DesignKey;
  bg: string; // page background colour (also the browser's theme-color)
  stageBg: string; // page / stage background (radial glow)
  gradient: string; // horizontal chain gradient: buttons, pills, bar underline
  gradientV: string; // vertical chain gradient
  hero: string; // the balance card (deeper KASANE gradient so white text stays readable)
  heroText: string; // text on the balance card
  ink: string; // text on top of any gradient
  heroTextSoft: string; // secondary text on the balance card
  wordmark: string; // colour of the KASANE wordmark / thin titles
  accent: string; // chain accent (selected borders, glows)
  line: string; // hairlines
  cardShadow: string;
  cardShadowHover: string;
  menu: KasaneMenuTokens;
}

declare module '@mui/material/styles' {
  interface Theme {
    kasane: KasaneTokens;
  }
  interface ThemeOptions {
    kasane?: KasaneTokens;
  }
  interface Palette {
    textSlightGray: string;
    textGray: string;
    textDarkGray: string;
    textLightGray: string;
    nemBlue: string;
    nemOrange: string;
    nemGreen: string;
  }
  interface PaletteOptions {
    textSlightGray?: string;
    textGray?: string;
    textDarkGray?: string;
    textLightGray?: string;
    nemBlue?: string;
    nemOrange?: string;
    nemGreen?: string;
  }
}

const FONT = '"Avenir Next", "Century Gothic", "Futura", "Hiragino Sans", "Yu Gothic", "Segoe UI", system-ui, sans-serif';

interface ChainLook {
  gradientStops: string; // CSS colour stops of the button / pill gradient, left -> right
  stops: [string, string, string]; // main colours of that gradient
  heroStops: [string, string, string]; // deeper version of the stops for the balance card
  accent: { dark: string; light: string };
  dark: { bg: string; glow: string; paper: string; menuTop: string };
  light: { bg: string; glow: string; menuBottom: string };
}

const LOOK: Record<DesignKey, ChainLook> = {
  // Neutral: the whole logo gradient (coral -> pink -> lavender -> aqua -> mint) on the logo's own
  // mauve-grey stage. Used by welcome -> profile -> create / import -> recovery phrase -> done.
  base: {
    gradientStops: `${KASANE.coral} 0%, ${KASANE.pink} 30%, ${KASANE.lavender} 56%, ${KASANE.aqua} 80%, ${KASANE.mint} 100%`,
    stops: [KASANE.coral, KASANE.lavender, KASANE.mint],
    heroStops: ['#C24A47', '#7A5AA0', '#1B7F55'],
    accent: { dark: KASANE.lavender, light: '#7C5FA3' },
    dark: { bg: '#2B262D', glow: '#554C58', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEE6F0', menuBottom: '#F1E8F0' },
  },
  symbol: {
    gradientStops: `${KASANE.coral} 0%, ${KASANE.pink} 52%, ${KASANE.lavender} 100%`,
    stops: [KASANE.coral, KASANE.pink, KASANE.lavender],
    heroStops: ['#C24A47', '#B04A78', '#7A5AA0'],
    accent: { dark: KASANE.pink, light: '#B8517F' },
    dark: { bg: '#2B262D', glow: '#5A4A64', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEDFEA', menuBottom: '#F1E4EE' },
  },
  nem: {
    gradientStops: `${KASANE.lavender} 0%, ${KASANE.aqua} 52%, ${KASANE.mint} 100%`,
    stops: [KASANE.lavender, KASANE.aqua, KASANE.mint],
    heroStops: ['#7A5AA0', '#238570', '#1B7F55'],
    accent: { dark: KASANE.aqua, light: '#23917C' },
    dark: { bg: '#232A29', glow: '#3C5A55', paper: '#2F3A38', menuTop: '#2D4340' },
    light: { bg: '#F0F7F5', glow: '#D8EDE7', menuBottom: '#E2F1ED' },
  },
};

export function createKasaneTheme(mode: ThemeMode, chain: DesignKey = 'symbol') {
  const look = LOOK[chain];
  const dark = mode === 'dark';
  const surface = dark ? look.dark : look.light;
  const bg = surface.bg;
  const paper = dark ? look.dark.paper : '#FFFFFF';
  const accent = dark ? look.accent.dark : look.accent.light;
  const ink = KASANE.ink;
  const line = dark ? KASANE.limeLine : 'rgba(43,38,45,0.14)';
  const gradient = `linear-gradient(90deg, ${look.gradientStops})`;
  const gradientV = `linear-gradient(180deg, ${look.gradientStops})`;

  // Primary is the pale lime of the wordmark on the dark stage (the look of the first-run screens);
  // on the light stage lime would vanish, so it becomes the deep chain accent.
  const primary = dark
    ? { main: KASANE.lime, light: '#F4FAC8', dark: '#C9D87F', contrastText: ink }
    : { main: accent, light: alpha(accent, 0.8), dark: accent, contrastText: '#FFFFFF' };
  const text = dark
    ? { primary: '#F1F6CF', secondary: KASANE.limeSoft, disabled: 'rgba(234,244,166,0.4)' }
    : { primary: ink, secondary: 'rgba(43,38,45,0.68)', disabled: 'rgba(43,38,45,0.4)' };
  const grey = dark
    ? { 50: '#322D35', 100: 'rgba(234,244,166,0.08)', 200: 'rgba(234,244,166,0.14)', 300: '#4A444E', 400: '#615A66', 500: '#8E8693', 600: '#7A7280', 700: '#A39BA8', 800: '#C4BDC8', 900: '#E2DDE5' }
    : { 50: '#FAF7F9', 100: '#F1EBEF', 200: '#E6DDE3', 300: '#D3C8D0', 400: '#B8AAB5', 500: '#8E8693', 600: '#756D7B', 700: '#5C5562', 800: '#433D49', 900: '#2B262D' };

  const kasane: KasaneTokens = {
    chain,
    bg,
    stageBg: `radial-gradient(ellipse at 50% 22%, ${surface.glow} 0%, ${bg} 70%)`,
    gradient,
    gradientV,
    hero: `linear-gradient(135deg, ${look.heroStops[0]} 0%, ${look.heroStops[1]} 55%, ${look.heroStops[2]} 100%)`,
    heroText: '#FFFFFF',
    ink,
    heroTextSoft: 'rgba(255,255,255,0.86)',
    wordmark: dark ? KASANE.lime : '#4A4150',
    accent,
    line,
    cardShadow: dark ? '0 6px 24px rgba(0,0,0,0.28)' : `0 6px 22px ${alpha(accent, 0.14)}`,
    cardShadowHover: dark ? `0 8px 28px ${alpha(accent, 0.28)}` : `0 8px 28px ${alpha(accent, 0.26)}`,
    menu: dark
      ? {
          panel: `linear-gradient(180deg, ${look.dark.menuTop} 0%, ${bg} 100%)`,
          text: '#F1F6CF',
          icon: 'rgba(234,244,166,0.62)',
          line: 'rgba(234,244,166,0.16)',
          hover: 'rgba(234,244,166,0.07)',
          shadow: '2px 0 18px rgba(0,0,0,0.45)',
          activeGradient: gradient,
          activeShadow: `0 6px 18px ${alpha(accent, 0.35)}`,
          avatarBg: alpha(accent, 0.18),
        }
      : {
          panel: `linear-gradient(180deg, #FFFFFF 0%, ${look.light.menuBottom} 100%)`,
          text: ink,
          icon: 'rgba(43,38,45,0.6)',
          line: 'rgba(43,38,45,0.10)',
          hover: 'rgba(43,38,45,0.05)',
          shadow: '2px 0 14px rgba(43,38,45,0.10)',
          activeGradient: gradient,
          activeShadow: `0 6px 16px ${alpha(accent, 0.30)}`,
          avatarBg: alpha(accent, 0.14),
        },
  };

  const fieldBg = dark ? 'rgba(234,244,166,0.04)' : 'rgba(43,38,45,0.03)';
  const fieldLine = dark ? KASANE.limeLine : 'rgba(43,38,45,0.26)';
  const fieldHover = dark ? 'rgba(234,244,166,0.6)' : 'rgba(43,38,45,0.55)';

  return createTheme({
    kasane,
    palette: {
      mode,
      primary,
      secondary: { main: dark ? accent : KASANE.lavender },
      error: { main: dark ? '#FF8F86' : '#D6453D' },
      info: { main: dark ? KASANE.lavender : '#7C5FA3' },
      success: { main: dark ? KASANE.mint : '#23915F' },
      warning: { main: dark ? '#F6C177' : '#B9770E' },
      background: { default: bg, paper },
      text,
      divider: line,
      grey,
      textSlightGray: text.secondary,
      textGray: dark ? 'rgba(234,244,166,0.78)' : 'rgba(43,38,45,0.78)',
      textDarkGray: dark ? '#F1F6CF' : ink,
      textLightGray: text.disabled,
      // Names kept from the earlier theme so existing screens keep working; the hues are now the
      // KASANE gradient's coral / mint / lavender.
      nemOrange: dark ? KASANE.coral : '#D9534A',
      nemGreen: dark ? KASANE.mint : '#23915F',
      nemBlue: dark ? KASANE.lavender : '#7C5FA3',
    },
    shape: { borderRadius: 16 },
    typography: {
      fontFamily: FONT,
      h6: { fontWeight: 300, letterSpacing: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { background: kasane.stageBg, backgroundColor: bg, backgroundAttachment: 'fixed', minHeight: '100svh' },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          elevation1: { boxShadow: kasane.cardShadow },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            border: `1px solid ${line}`,
            borderRadius: 20,
            backgroundColor: dark ? alpha(paper, 0.82) : paper,
            boxShadow: kasane.cardShadow,
          },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          colorDefault: {
            // A translucent stage-coloured bar with the chain gradient as a thin underline.
            backgroundColor: alpha(bg, dark ? 0.86 : 0.9),
            backgroundImage: 'none',
            backdropFilter: 'blur(12px)',
            color: text.primary,
            boxShadow: 'none',
            borderBottom: `1px solid ${line}`,
            '&::after': { content: '""', position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: gradient, opacity: 0.9 },
            '& .MuiSvgIcon-colorPrimary, & .MuiIconButton-colorPrimary': { color: primary.main },
            '& .MuiButton-textPrimary': { color: primary.main },
            '& .MuiIconButton-root:not(.Mui-disabled)': { color: primary.main },
          },
        },
      },
      MuiDialog: {
        styleOverrides: { paper: { border: `1px solid ${line}`, borderRadius: 24, backgroundColor: paper } },
      },
      MuiMenu: { styleOverrides: { paper: { border: `1px solid ${line}`, borderRadius: 16 } } },
      MuiTooltip: {
        styleOverrides: { tooltip: { backgroundColor: dark ? '#4A4150' : '#3A343D', color: '#F1F6CF', borderRadius: 10 } },
      },
      MuiButton: {
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 600, letterSpacing: 1.5, borderRadius: 999 },
        },
        variants: [
          {
            props: { variant: 'contained', color: 'primary' },
            style: {
              background: gradient,
              color: ink,
              boxShadow: `0 8px 26px ${alpha(accent, 0.28)}`,
              '&:hover': { background: gradient, filter: 'brightness(1.08)', boxShadow: `0 10px 32px ${alpha(accent, 0.4)}` },
              '&.Mui-disabled': {
                background: dark ? 'rgba(234,244,166,0.10)' : 'rgba(43,38,45,0.08)',
                color: dark ? 'rgba(234,244,166,0.35)' : 'rgba(43,38,45,0.35)',
                boxShadow: 'none',
              },
            },
          },
          { props: { variant: 'outlined', color: 'primary' }, style: { borderColor: dark ? KASANE.limeLine : alpha(accent, 0.55) } },
        ],
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 14,
            backgroundColor: fieldBg,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: fieldLine },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: fieldHover },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            '&.Mui-selected': { backgroundColor: alpha(accent, 0.16) },
            '&.Mui-selected:hover': { backgroundColor: alpha(accent, 0.24) },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            '&.Mui-selected, &.Mui-selected:hover': { background: gradient, color: ink },
          },
        },
      },
      MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3, background: gradient } } },
      MuiLinearProgress: { styleOverrides: { bar: { background: gradient } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 999 } } },
      MuiCheckbox: { defaultProps: { color: 'primary' } },
      MuiBottomNavigation: { styleOverrides: { root: { borderTop: `1px solid ${line}` } } },
    },
  });
}
