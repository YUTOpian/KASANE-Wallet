import type { ReactNode } from 'react';
import { Box, IconButton, ThemeProvider, Typography, useMediaQuery } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useLocation, useNavigate } from 'react-router-dom';
import { Environment } from '../../lib/environment';
import type { ChainKey } from '../../lib/chain';
import { useAppStore } from '../../store/appStore';
import { useKasaneTheme } from '../../theme/useKasaneTheme';
import { useEffectiveTheme } from '../../theme/useThemeChoices';
import { resolveDesign } from '../../theme/designScope';
import { KasaneMark } from './KasaneLogo';

interface KasaneStageProps {
  title?: string;
  children: ReactNode;
  // Back arrow: `back` is where the iOS home-screen app goes (it has no browser back), like AppToolBar.
  showBack?: boolean;
  back?: string;
  onBack?: () => void;
  maxWidth?: number;
  // Top right corner (e.g. a button).
  topRight?: ReactNode;
  // Tints the stage for this chain instead of the app's current one (in-wallet screens only).
  // The welcome -> create / import -> recovery phrase screens ignore it: their design is fixed
  // (theme/designScope.ts).
  chain?: ChainKey;
  // デスクトップ幅（900px以上）で、中身を角丸のパネル（カード）に載せる。入力フォームの画面用。
  // スマホでは今までどおり、背景にそのまま並べる。
  panel?: boolean;
}

// デスクトップ（ウィンドウ幅900px以上）の目安。MenuShellのWIDE_QUERYと同じ値。
const DESKTOP_QUERY = '(min-width: 900px)';

// デスクトップでは、各画面が指定した幅（スマホ向けの狭い値）を広げて使う。広がりすぎないよう上限を付ける。
function desktopWidth(maxWidth: number): number {
  return Math.min(1280, Math.round(maxWidth * (maxWidth >= 760 ? 1.4 : 1.3)));
}

// Shared frame of the screens that have no side menu (welcome -> profile -> recovery phrase -> done,
// sign-in, backup, password): the KASANE stage background, the small hexagon mark, the page title
// in thin letters. Colours come from the fixed design of the screen group (theme/designScope.ts).
export default function KasaneStage({ title, children, showBack = true, back, onBack, maxWidth = 520, chain, topRight, panel = false }: KasaneStageProps) {
  const navigate = useNavigate();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const appChain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { pathname } = useLocation();
  const effective = useEffectiveTheme(pathname);
  const design = resolveDesign(pathname, effective.mode, chain ?? appChain, network);
  const theme = useKasaneTheme(design.mode, design.chain, effective.customId);
  const goBack = () => {
    if (onBack) onBack();
    else if (Environment.isIos() && Environment.isInStandaloneMode() && back) navigate(back);
    else navigate(-1);
  };
  // パネルは自分の内側の余白ぶん（左右約160px）を食うので、そのぶん広く取る。
  const contentWidth = !desktop ? maxWidth : panel ? maxWidth + 220 : desktopWidth(maxWidth);
  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          position: 'relative', minHeight: '100svh', width: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: (t) => t.kasane.stageBg, color: 'text.primary', pb: desktop ? 10 : 6,
        }}
      >
        {showBack && (
          <IconButton
            onClick={goBack}
            aria-label="back"
            size={desktop ? 'large' : 'medium'}
            sx={{ position: 'absolute', top: desktop ? 24 : 10, left: desktop ? 28 : 10, color: (t) => t.kasane.wordmark }}
          >
            <ArrowBackIcon />
          </IconButton>
        )}
        {topRight && <Box sx={{ position: 'absolute', top: desktop ? 28 : 10, right: desktop ? 32 : 10 }}>{topRight}</Box>}
        <Box sx={{ mt: desktop ? 7 : 3.5, mb: desktop ? 2 : 1 }}><KasaneMark size={desktop ? 92 : 64} /></Box>
        {title && (
          <Typography
            component="h1"
            sx={{
              fontSize: desktop ? 30 : 21, fontWeight: 300, letterSpacing: desktop ? 2.5 : 1.5, textWrap: 'balance', lineHeight: 1.5,
              color: (t) => t.kasane.wordmark, textAlign: 'center', px: 7, mb: desktop ? 2 : 1, maxWidth: '100%', boxSizing: 'border-box',
            }}
          >
            {title}
          </Typography>
        )}
        <Box sx={{ width: '100%', maxWidth: contentWidth, px: desktop ? 4 : 2, boxSizing: 'border-box', flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
          {panel && desktop ? (
            <Box
              sx={{
                mt: 2, px: 6, py: 5, boxSizing: 'border-box', borderRadius: '28px',
                bgcolor: 'background.paper', border: 1, borderColor: (t) => t.kasane.line, boxShadow: (t) => t.kasane.cardShadow,
              }}
            >
              {children}
            </Box>
          ) : children}
        </Box>
      </Box>
    </ThemeProvider>
  );
}
