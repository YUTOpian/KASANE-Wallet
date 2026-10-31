import { alpha, createTheme } from '@mui/material/styles';
import type { ChainKey } from '../lib/chain';
import type { ThemeMode } from '../store/appStore';
import { resolveCustomValues } from './customTheme';
import type { CustomImages, CustomThemeData, CustomValues, LookValues } from './customTheme';

// KASANE design for every screen of the app.
// Taken from the KASANE logo: a muted mauve-grey stage, the coral -> pink -> lavender -> aqua -> mint
// gradient of the hexagon, and the pale yellow-green of the thin geometric wordmark.
//
// ビジネス (the third theme next to dark / white): a calm, flat look made for work - no gradients (solid colours),
// small corner radii, thin-bordered white cards on a cool grey page, a navy side menu and balance card,
// tabular figures and compact fields. The chain only changes its accent colour.
//
// さくら (blossom, the fourth theme): made for women - a cute, pastel look: a cream-pink stage sprinkled with tiny flowers, hearts
// and sparkles, a bright pastel pink -> lilac gradient, extra-round corners, pink hairlines, soft pink glows, a rounded font,
// a rose -> orchid balance card and a blush side menu.
// Like ビジネス it keeps its own character, but the chain still tints it (Symbol rose / NEM mint / mijin sky blue).
//
// The chain changes the *tint* of that design, never its character:
//   Symbol = the warm half of the gradient (coral -> pink -> lavender) on a mauve stage,
//   NEM    = the cool half of the gradient (lavender -> aqua -> mint) on a teal-grey stage,
//   mijin  = (mijin v2, a Symbol-chain network) a sky-blue / teal tint taken from the mijin site's blue,
//            on a blue-grey stage; dark / light follows the setting like Symbol and NEM.
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
  activeText?: string; // text / icon colour of the open page's entry (defaults to `onGradient`)
}

// Everything chain / mode dependent that is not a plain MUI palette entry. Read it with
// `useTheme().kasane` (or `(t) => t.kasane...` inside sx).
// 'base' = the neutral KASANE look of the first-run screens (no Symbol / NEM tint).
export type DesignKey = ChainKey | 'base' | 'mijin';

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
  heroTextShadow: string; // text shadow on the balance card
  heroChipBg: string; // small chips on the balance card
  wordmark: string; // colour of the KASANE wordmark / thin titles
  accent: string; // chain accent (selected borders, glows)
  line: string; // hairlines
  cardShadow: string;
  cardShadowHover: string;
  menu: KasaneMenuTokens;
  onGradient: string; // text / icons on top of `gradient` (buttons, selected toggles, the active menu entry)
  cardRadius: number; // corner radius of cards and tiles
  images: CustomImages; // images of the カスタムテーマ (logo, side menu icons; the background and the balance card image are already in stageBg / hero)
  look: LookValues; // the values above as the plain colours the カスタムテーマ template is made of
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
    ribbonBlue: string;
  }
  interface PaletteOptions {
    textSlightGray?: string;
    textGray?: string;
    textDarkGray?: string;
    textLightGray?: string;
    nemBlue?: string;
    nemOrange?: string;
    nemGreen?: string;
    ribbonBlue?: string;
  }
}

const FONT = '"Avenir Next", "Century Gothic", "Futura", "Hiragino Sans", "Yu Gothic", "PingFang SC", "Microsoft YaHei", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif';

const FONT_BLOSSOM = '"Hiragino Maru Gothic ProN", "Zen Maru Gothic", "Quicksand", "Avenir Next", "Hiragino Sans", "Yu Gothic", "PingFang SC", "Microsoft YaHei", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif';

// さくら / ビジネス colours per design. Both themes keep their own character (soft & round / flat & compact),
// but the chain still tints them like the dark / white themes: Symbol = warm rose, NEM = fresh mint, mijin = sky blue,
// 'base' (first-run screens) = the neutral rose-lilac.
interface BlossomLook {
  bg: string; glow: string; menuBottom: string; accent: string; ink: string; inkRgb: string; wordmark: string;
  gradientStops: string; hero: string;
  petal: string; // colour of the little flowers / hearts / sparkles on the stage
  menuActive: string; // fill of the open page's entry in the side menu (white text on it)
}
const BLOSSOM: Record<DesignKey, BlossomLook> = {
  base: {
    bg: '#FFF5F8', glow: '#FFE0EA', menuBottom: '#FFE9F0', accent: '#C94F80', ink: '#4A2536', inkRgb: '74,37,54', wordmark: '#9B3F6A',
    gradientStops: '#FFA3BF 0%, #FFB7CF 45%, #E2B8F6 100%',
    hero: 'linear-gradient(135deg, #FFD6E4 0%, #FFC4DB 50%, #EBCDFA 100%)',
    petal: '#F58FB0',
    menuActive: 'linear-gradient(135deg, #F78DB4 0%, #E5619B 100%)',
  },
  symbol: {
    bg: '#FFF4F3', glow: '#FFDCD9', menuBottom: '#FFE6E2', accent: '#D0506E', ink: '#4D2530', inkRgb: '77,37,48', wordmark: '#A23F5C',
    gradientStops: '#FFB09C 0%, #FFA3BE 50%, #E3B8F0 100%',
    hero: 'linear-gradient(135deg, #FFD9CF 0%, #FFC6D6 50%, #EACDF7 100%)',
    petal: '#F79A8E',
    menuActive: 'linear-gradient(135deg, #FF8F8A 0%, #E9638F 100%)',
  },
  nem: {
    bg: '#F2FAF6', glow: '#D9F2E6', menuBottom: '#E0F4EA', accent: '#2E9E7F', ink: '#1F3A33', inkRgb: '31,58,51', wordmark: '#2A6E5C',
    gradientStops: '#A8EBD0 0%, #A5E0EA 50%, #D9C6F6 100%',
    hero: 'linear-gradient(135deg, #CFF5E4 0%, #C6EAF0 50%, #E3D6FA 100%)',
    petal: '#7FD1B0',
    menuActive: 'linear-gradient(135deg, #46C4A0 0%, #2E9E8F 100%)',
  },
  mijin: {
    bg: '#F1F7FC', glow: '#D8EAF8', menuBottom: '#E0EEF9', accent: '#2F7FB8', ink: '#1E3445', inkRgb: '30,52,69', wordmark: '#245C86',
    gradientStops: '#A5D8FA 0%, #A3CCF5 50%, #C9CDF8 100%',
    hero: 'linear-gradient(135deg, #CFE8FB 0%, #C6DBF8 50%, #D9DCFA 100%)',
    petal: '#8CC4EE',
    menuActive: 'linear-gradient(135deg, #5AAEE8 0%, #3A82C4 100%)',
  },
};

// A tile of tiny flowers, hearts and sparkles in the chain's pastel colour, as a CSS background layer (used by さくら).
function petalPattern(color: string, opacity = 0.30): string {
  const flower = [0, 72, 144, 216, 288].map((deg) => `<ellipse cx='0' cy='-7' rx='4.5' ry='7' transform='rotate(${deg})'/>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>`
    + `<g fill='${color}' fill-opacity='${opacity}'>`
    + `<g transform='translate(32 34)'>${flower}</g>`
    + `<path transform='translate(114 78) scale(0.95)' d='M0 -3C-6 -9 -12 -1 0 8C12 -1 6 -9 0 -3Z'/>`
    + `<path transform='translate(64 124)' d='M0 -8L2 -2L8 0L2 2L0 8L-2 2L-8 0L-2 -2Z'/>`
    + `<path transform='translate(136 20) scale(0.6)' d='M0 -8L2 -2L8 0L2 2L0 8L-2 2L-8 0L-2 -2Z'/>`
    + `<circle cx='92' cy='30' r='2.2'/><circle cx='20' cy='96' r='2'/><circle cx='140' cy='132' r='2.4'/>`
    + `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 160px 160px repeat`;
}

interface BusinessLook { bg: string; accent: string; panel: string; panel2: string }
const BUSINESS: Record<DesignKey, BusinessLook> = {
  base: { bg: '#EFEEF5', accent: '#5B4A8A', panel: '#262240', panel2: '#3A3260' },
  symbol: { bg: '#F3EEF2', accent: '#8A3A68', panel: '#3A1E33', panel2: '#57294A' },
  nem: { bg: '#EDF3F1', accent: '#1F7A68', panel: '#16332D', panel2: '#1F4A41' },
  mijin: { bg: '#EDF2F6', accent: '#006699', panel: '#12304A', panel2: '#1B4666' },
};

const FONT_BUSINESS = '"Inter", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "Noto Sans JP", "Segoe UI", Roboto, system-ui, sans-serif';

interface ChainLook {
  gradientStops: string; // CSS colour stops of the button / pill gradient, left -> right
  stops: [string, string, string]; // main colours of that gradient
  heroStops: [string, string, string]; // deeper version of the stops for the balance card
  accent: { dark: string; light: string };
  business: string; // accent of the ビジネス theme
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
    business: '#5B4A8A',
    dark: { bg: '#2B262D', glow: '#554C58', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEE6F0', menuBottom: '#F1E8F0' },
  },
  symbol: {
    gradientStops: `${KASANE.coral} 0%, ${KASANE.pink} 52%, ${KASANE.lavender} 100%`,
    stops: [KASANE.coral, KASANE.pink, KASANE.lavender],
    heroStops: ['#C24A47', '#B04A78', '#7A5AA0'],
    accent: { dark: KASANE.pink, light: '#B8517F' },
    business: '#8A3A68',
    dark: { bg: '#2B262D', glow: '#5A4A64', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEDFEA', menuBottom: '#F1E4EE' },
  },
  mijin: {
    gradientStops: '#7FD3DC 0%, #4FA5CC 52%, #7096D6 100%',
    stops: ['#7FD3DC', '#4FA5CC', '#7096D6'],
    heroStops: ['#2F8AA8', '#1D6E98', '#3A5FA5'],
    accent: { dark: '#6FBBD9', light: '#006699' },
    business: '#006699',
    dark: { bg: '#222A31', glow: '#3B5769', paper: '#2D3841', menuTop: '#2A4455' },
    light: { bg: '#F0F6FA', glow: '#D6E8F3', menuBottom: '#E0EDF6' },
  },
  nem: {
    gradientStops: `${KASANE.lavender} 0%, ${KASANE.aqua} 52%, ${KASANE.mint} 100%`,
    stops: [KASANE.lavender, KASANE.aqua, KASANE.mint],
    heroStops: ['#7A5AA0', '#238570', '#1B7F55'],
    accent: { dark: KASANE.aqua, light: '#23917C' },
    business: '#1F7A68',
    dark: { bg: '#232A29', glow: '#3C5A55', paper: '#2F3A38', menuTop: '#2D4340' },
    light: { bg: '#F0F7F5', glow: '#D8EDE7', menuBottom: '#E2F1ED' },
  },
};

// The three main colours of a CSS gradient written as `#hex 0%, #hex 50%, ...` (first, middle, last).
function stopColors(stops: string): [string, string, string] {
  const colors = stops.match(/#[0-9A-Fa-f]{6}/g) ?? [];
  return [colors[0], colors[Math.floor((colors.length - 1) / 2)], colors[colors.length - 1]] as [string, string, string];
}

// requestedMode 'custom' = the dark or white look (whichever the person's CSS says, `--kasane-mode`) with their values laid over it.
// Every value read from `custom` has been checked and normalised by theme/customTheme.ts (colours, numbers, a plain font list).
export function createKasaneTheme(requestedMode: ThemeMode, chain: DesignKey = 'symbol', custom?: CustomThemeData | null) {
  const cv: CustomValues = requestedMode === 'custom' && custom ? resolveCustomValues(custom, chain) : {};
  const baseMode: Exclude<ThemeMode, 'custom'> = requestedMode === 'custom' ? (cv.mode ?? 'dark') : requestedMode;
  const look = LOOK[chain];
  const business = baseMode === 'business';
  const blossom = baseMode === 'blossom';
  const bl = BLOSSOM[chain];
  const biz = BUSINESS[chain];
  // ビジネス and さくら are light schemes as far as MUI is concerned.
  const mode: 'dark' | 'light' = baseMode === 'dark' ? 'dark' : 'light';
  const dark = mode === 'dark';
  // RGB of the dark text colour (used for the translucent greys below).
  const inkRgb = business ? '27,36,51' : blossom ? bl.inkRgb : '43,38,45';
  let gradientStops = business ? `${biz.accent} 0%, ${biz.accent} 100%` : blossom ? bl.gradientStops : look.gradientStops;
  let stops3: [string, string, string] = business ? [biz.accent, biz.accent, biz.accent] : blossom ? stopColors(bl.gradientStops) : [...look.stops];
  if (cv.gradientStart || cv.gradientMid || cv.gradientEnd) {
    stops3 = [cv.gradientStart ?? stops3[0], cv.gradientMid ?? stops3[1], cv.gradientEnd ?? stops3[2]];
    gradientStops = `${stops3[0]} 0%, ${stops3[1]} 52%, ${stops3[2]} 100%`;
  }
  const surface = dark ? look.dark : look.light;
  const bg = cv.bg ?? (business ? biz.bg : blossom ? bl.bg : surface.bg);
  const glow = cv.glow ?? (blossom ? bl.glow : surface.glow);
  const paper = cv.paper ?? (dark ? look.dark.paper : '#FFFFFF');
  const accent = cv.accent ?? (business ? biz.accent : blossom ? bl.accent : dark ? look.accent.dark : look.accent.light);
  const ink = business ? '#1B2433' : blossom ? bl.ink : KASANE.ink;
  const onGradient = cv.onGradient ?? (business ? '#FFFFFF' : blossom ? bl.ink : KASANE.ink);
  const line = cv.line ?? (dark ? KASANE.limeLine : business ? 'rgba(27,36,51,0.12)' : blossom ? alpha(accent, 0.28) : `rgba(${inkRgb},0.14)`);
  const gradient = `linear-gradient(90deg, ${gradientStops})`;
  const gradientV = `linear-gradient(180deg, ${gradientStops})`;

  // Primary is the pale lime of the wordmark on the dark stage (the look of the first-run screens);
  // on the light stage lime would vanish, so it becomes the deep chain accent.
  const primary = dark
    ? (cv.primary
      ? { main: cv.primary, light: alpha(cv.primary, 0.8), dark: cv.primary, contrastText: onGradient }
      : { main: KASANE.lime, light: '#F4FAC8', dark: '#C9D87F', contrastText: onGradient })
    : { main: cv.primary ?? accent, light: alpha(cv.primary ?? accent, 0.8), dark: cv.primary ?? accent, contrastText: '#FFFFFF' };
  const textBase = dark
    ? { primary: '#F1F6CF', secondary: KASANE.limeSoft, disabled: 'rgba(234,244,166,0.4)' }
    : { primary: ink, secondary: `rgba(${inkRgb},0.68)`, disabled: `rgba(${inkRgb},0.4)` };
  const text = {
    primary: cv.text ?? textBase.primary,
    secondary: cv.textSoft ?? (cv.text ? alpha(cv.text, 0.68) : textBase.secondary),
    disabled: cv.text ? alpha(cv.text, 0.4) : textBase.disabled,
  };
  const grey = dark
    ? { 50: '#322D35', 100: 'rgba(234,244,166,0.08)', 200: 'rgba(234,244,166,0.14)', 300: '#4A444E', 400: '#615A66', 500: '#8E8693', 600: '#7A7280', 700: '#A39BA8', 800: '#C4BDC8', 900: '#E2DDE5' }
    : business
      ? { 50: '#F8FAFC', 100: '#F1F5F9', 200: '#E2E8F0', 300: '#CBD5E1', 400: '#94A3B8', 500: '#64748B', 600: '#526071', 700: '#3F4C5E', 800: '#2A364A', 900: '#1B2433' }
      : blossom
        ? { 50: '#FFF9FB', 100: '#FBEEF3', 200: '#F4DEE7', 300: '#E7C9D6', 400: '#CDA7B9', 500: '#9E7F8F', 600: '#846675', 700: '#684F5D', 800: '#4F3A47', 900: '#3A2630' }
        : { 50: '#FAF7F9', 100: '#F1EBEF', 200: '#E6DDE3', 300: '#D3C8D0', 400: '#B8AAB5', 500: '#8E8693', 600: '#756D7B', 700: '#5C5562', 800: '#433D49', 900: '#2B262D' };

  // The balance card's three colours (top left -> bottom right) and the side menu's top / bottom colours.
  let heroStops3: [string, string, string] = business ? [biz.panel, biz.panel2, biz.panel2] : blossom ? stopColors(bl.hero) : [...look.heroStops];
  const heroCustom = Boolean(cv.heroStart || cv.heroMid || cv.heroEnd);
  if (heroCustom) heroStops3 = [cv.heroStart ?? heroStops3[0], cv.heroMid ?? heroStops3[1], cv.heroEnd ?? heroStops3[2]];
  const menuTop0 = business ? biz.panel : dark ? look.dark.menuTop : '#FFFFFF';
  const menuBottom0 = business ? biz.panel : dark ? bg : blossom ? bl.menuBottom : look.light.menuBottom;
  const menuText0 = business ? '#E8EDF5' : dark ? '#F1F6CF' : ink;
  const menuText = cv.menuText ?? menuText0;
  const menuCustom = Boolean(cv.menuTop || cv.menuBottom || cv.menuText);
  const heroText = cv.heroText ?? (blossom ? bl.ink : '#FFFFFF');
  // カスタムテーマ images (data:image/... strings that theme/customTheme.ts has already checked).
  const images: CustomImages = requestedMode === 'custom' && custom?.images ? custom.images : {};
  const backgroundDim = cv.backgroundDim ?? 0.35;
  const heroDim = cv.heroDim ?? 0.3;
  const heroImageLayer = images.hero ? `linear-gradient(rgba(0,0,0,${heroDim}), rgba(0,0,0,${heroDim})), url("${images.hero}") center / cover no-repeat, ` : '';
  const cardRadius = cv.radius ?? (business ? 8 : blossom ? 28 : 20);
  const shapeRadius = cv.radius !== undefined ? Math.round(cv.radius * 0.8) : business ? 8 : blossom ? 24 : 16;
  const buttonRadius = cv.buttonRadius ?? (business ? 6 : 999);
  const fontFamily = cv.font ?? (business ? FONT_BUSINESS : blossom ? FONT_BLOSSOM : FONT);
  const errorMain = cv.error ?? (dark ? '#FF8F86' : business ? '#B42318' : '#D6453D');
  const infoMain = cv.info ?? (dark ? KASANE.lavender : business ? '#1D4ED8' : '#7C5FA3');
  const successMain = cv.success ?? (dark ? KASANE.mint : business ? '#15803D' : '#23915F');
  const warningMain = cv.warning ?? (dark ? '#F6C177' : business ? '#B45309' : '#B9770E');
  const wordmark = cv.wordmark ?? (business ? '#1E293B' : dark ? KASANE.lime : blossom ? bl.wordmark : '#4A4150');

  const kasane: KasaneTokens = {
    chain,
    bg,
    stageBg: images.background ? `linear-gradient(${alpha(bg, backgroundDim)}, ${alpha(bg, backgroundDim)}), url("${images.background}") center / cover no-repeat` : business ? bg : blossom ? `${petalPattern(bl.petal)}, radial-gradient(ellipse at 50% 22%, ${glow} 0%, ${bg} 70%)` : `radial-gradient(ellipse at 50% 22%, ${glow} 0%, ${bg} 70%)`,
    gradient,
    gradientV,
    hero: heroImageLayer + (heroCustom
      ? `linear-gradient(135deg, ${heroStops3[0]} 0%, ${heroStops3[1]} 55%, ${heroStops3[2]} 100%)`
      : business
      ? `linear-gradient(135deg, ${biz.panel} 0%, ${biz.panel2} 100%)`
      : blossom
      ? `${petalPattern('#FFFFFF', 0.7)}, ${bl.hero}`
      : `linear-gradient(135deg, ${look.heroStops[0]} 0%, ${look.heroStops[1]} 55%, ${look.heroStops[2]} 100%)`),
    heroText,
    ink: cv.onGradient ?? ink,
    heroTextSoft: cv.heroText ? alpha(cv.heroText, 0.86) : blossom ? alpha(bl.ink, 0.72) : 'rgba(255,255,255,0.86)',
    // A soft pastel card with dark text: no dark shadow, just a faint white glow.
    heroTextShadow: blossom ? '0 1px 0 rgba(255,255,255,0.7)' : '0 1px 3px rgba(0,0,0,0.28)',
    heroChipBg: blossom ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.22)',
    wordmark,
    accent,
    line,
    cardShadow: business ? '0 1px 3px rgba(16,24,40,0.08)' : dark ? '0 6px 24px rgba(0,0,0,0.28)' : blossom ? `0 8px 24px ${alpha(accent, 0.20)}, 0 2px 6px ${alpha(accent, 0.10)}` : `0 6px 22px ${alpha(accent, 0.14)}`,
    cardShadowHover: business ? '0 4px 14px rgba(16,24,40,0.14)' : dark ? `0 8px 28px ${alpha(accent, 0.28)}` : `0 8px 28px ${alpha(accent, blossom ? 0.34 : 0.26)}`,
    onGradient,
    cardRadius,
    images,
    look: undefined as unknown as LookValues, // filled in below, once the theme's palette is known
    menu: business
      ? {
          // A dark side menu tinted by the chain; the open page is a frosted white bar (no gradient).
          panel: biz.panel,
          text: '#E8EDF5',
          icon: 'rgba(232,237,245,0.70)',
          line: 'rgba(255,255,255,0.12)',
          hover: 'rgba(255,255,255,0.07)',
          shadow: '2px 0 8px rgba(16,24,40,0.18)',
          activeGradient: 'rgba(255,255,255,0.16)',
          activeShadow: 'none',
          avatarBg: 'rgba(255,255,255,0.12)',
        }
      : dark
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
          panel: `linear-gradient(180deg, #FFFFFF 0%, ${blossom ? bl.menuBottom : look.light.menuBottom} 100%)`,
          text: ink,
          icon: `rgba(${inkRgb},0.6)`,
          line: blossom ? alpha(accent, 0.18) : `rgba(${inkRgb},0.10)`,
          hover: blossom ? alpha(accent, 0.08) : `rgba(${inkRgb},0.05)`,
          shadow: '2px 0 14px rgba(43,38,45,0.10)',
          // さくら: the open page is a candy-coloured rounded pill with white text and a soft glow.
          activeGradient: blossom ? bl.menuActive : gradient,
          activeShadow: blossom ? `0 6px 16px ${alpha(accent, 0.38)}` : `0 6px 16px ${alpha(accent, 0.30)}`,
          avatarBg: alpha(accent, 0.14),
          ...(blossom ? { activeText: '#FFFFFF' } : {}),
        },
  };

  // カスタムテーマ: the side menu's own colours (any of the three; the others keep the standard of the base brightness).
  const menuTop = cv.menuTop ?? menuTop0;
  const menuBottom = cv.menuBottom ?? menuBottom0;
  if (menuCustom) {
    kasane.menu = {
      ...kasane.menu,
      panel: `linear-gradient(180deg, ${menuTop} 0%, ${menuBottom} 100%)`,
      text: menuText,
      icon: alpha(menuText, 0.62),
      line: alpha(menuText, 0.16),
      hover: alpha(menuText, 0.07),
    };
  }

  // The plain values the カスタムテーマ template is made of (what the design is right now).
  kasane.look = {
    mode: dark ? 'dark' : 'light',
    bg, glow, paper,
    text: text.primary,
    textSoft: text.secondary,
    accent,
    primary: primary.main,
    wordmark,
    gradientStart: stops3[0], gradientMid: stops3[1], gradientEnd: stops3[2],
    onGradient,
    heroStart: heroStops3[0], heroMid: heroStops3[1], heroEnd: heroStops3[2],
    heroText,
    menuTop, menuBottom, menuText,
    line,
    error: errorMain, success: successMain, warning: warningMain, info: infoMain,
    radius: cardRadius,
    buttonRadius,
    font: fontFamily,
    backgroundDim,
    heroDim,
  };

  const fieldBg = dark ? 'rgba(234,244,166,0.04)' : `rgba(${inkRgb},0.03)`;
  const fieldLine = dark ? KASANE.limeLine : `rgba(${inkRgb},0.26)`;
  const fieldHover = dark ? 'rgba(234,244,166,0.6)' : `rgba(${inkRgb},0.55)`;

  return createTheme({
    kasane,
    palette: {
      mode,
      primary,
      secondary: { main: dark ? accent : KASANE.lavender },
      error: { main: errorMain },
      info: { main: infoMain },
      success: { main: successMain },
      warning: { main: warningMain },
      background: { default: bg, paper },
      text,
      divider: line,
      grey,
      textSlightGray: text.secondary,
      textGray: cv.text ? alpha(cv.text, 0.78) : dark ? 'rgba(234,244,166,0.78)' : `rgba(${inkRgb},0.78)`,
      textDarkGray: text.primary,
      textLightGray: text.disabled,
      // Names kept from the earlier theme so existing screens keep working; the hues are now the
      // KASANE gradient's coral / mint / lavender.
      nemOrange: dark ? KASANE.coral : business ? '#B45309' : '#D9534A',
      nemGreen: dark ? KASANE.mint : business ? '#15803D' : '#23915F',
      nemBlue: dark ? KASANE.lavender : business ? '#1D4ED8' : '#7C5FA3',
      // A true blue (nemBlue is the gradient's lavender, i.e. purple): the インボイス ribbon on Home.
      ribbonBlue: dark ? '#7DB7F5' : business ? '#1E40AF' : '#2F6DB5',
    },
    shape: { borderRadius: shapeRadius },
    typography: {
      fontFamily,
      h6: business ? { fontWeight: 600, letterSpacing: 0 } : blossom ? { fontWeight: 500, letterSpacing: 1 } : { fontWeight: 300, letterSpacing: 1.5 },
    },
    components: {
      // 「コピーしました」「送信しました」などの通知は、すべて画面の右上に出す（右上は他に何も置いていないため）。
      MuiSnackbar: {
        defaultProps: { anchorOrigin: { vertical: 'top', horizontal: 'right' } },
        styleOverrides: {
          root: { top: 'calc(16px + env(safe-area-inset-top, 0px))', right: 16, left: 'auto', maxWidth: 'calc(100vw - 32px)' },
        },
      },
      MuiCssBaseline: {
        styleOverrides: {
          body: { background: kasane.stageBg, backgroundColor: bg, backgroundAttachment: 'fixed', minHeight: '100svh', ...(business ? { fontVariantNumeric: 'tabular-nums' } : {}) },
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
            borderRadius: kasane.cardRadius,
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
            backgroundColor: business ? '#FFFFFF' : alpha(bg, dark ? 0.86 : 0.9),
            backgroundImage: 'none',
            backdropFilter: business ? 'none' : 'blur(12px)',
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
        styleOverrides: { paper: { border: `1px solid ${line}`, borderRadius: cv.radius !== undefined ? cv.radius + 4 : business ? 10 : 24, backgroundColor: paper } },
      },
      MuiMenu: { styleOverrides: { paper: { border: `1px solid ${line}`, borderRadius: business ? 8 : 16 } } },
      MuiTooltip: {
        styleOverrides: { tooltip: { backgroundColor: dark ? '#4A4150' : business ? '#1E293B' : '#3A343D', color: '#F1F6CF', borderRadius: business ? 6 : 10 } },
      },
      MuiButton: {
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 600, letterSpacing: business ? 0.2 : 1.5, borderRadius: buttonRadius },
        },
        variants: [
          {
            props: { variant: 'contained', color: 'primary' },
            style: {
              background: gradient,
              color: onGradient,
              boxShadow: business ? 'none' : `0 8px 26px ${alpha(accent, 0.28)}`,
              '&:hover': { background: gradient, filter: business ? 'brightness(0.92)' : 'brightness(1.08)', boxShadow: business ? 'none' : `0 10px 32px ${alpha(accent, 0.4)}` },
              '&.Mui-disabled': {
                background: dark ? 'rgba(234,244,166,0.10)' : `rgba(${inkRgb},0.08)`,
                color: dark ? 'rgba(234,244,166,0.35)' : `rgba(${inkRgb},0.35)`,
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
            borderRadius: business ? 6 : 14,
            backgroundColor: business ? '#FFFFFF' : fieldBg,
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
            '&.Mui-selected, &.Mui-selected:hover': { background: gradient, color: onGradient },
          },
        },
      },
      MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3, background: gradient } } },
      MuiLinearProgress: { styleOverrides: { bar: { background: gradient } } },
      MuiChip: { styleOverrides: { root: { borderRadius: buttonRadius } } },
      // ビジネス: compact fields and tables.
      ...(business ? { MuiTextField: { defaultProps: { size: 'small' as const } }, MuiTable: { defaultProps: { size: 'small' as const } } } : {}),
      MuiCheckbox: { defaultProps: { color: 'primary' } },
      MuiBottomNavigation: { styleOverrides: { root: { borderTop: `1px solid ${line}` } } },
    },
  });
}
