import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Box, IconButton, ThemeProvider, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useLocation, useNavigate } from 'react-router-dom';
import { Environment } from '../../lib/environment';
import type { ChainKey } from '../../lib/chain';
import { useAppStore } from '../../store/appStore';
import { createKasaneTheme } from '../../theme/kasaneTheme';
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
  // Tints the stage for this chain instead of the app's current one (in-wallet screens only).
  // The welcome -> create / import -> recovery phrase screens ignore it: their design is fixed
  // (theme/designScope.ts).
  chain?: ChainKey;
}

// Shared frame of the screens that have no side menu (welcome -> profile -> recovery phrase -> done,
// sign-in, backup, password): the KASANE stage background, the small hexagon mark, the page title
// in thin letters. Colours come from the fixed design of the screen group (theme/designScope.ts).
export default function KasaneStage({ title, children, showBack = true, back, onBack, maxWidth = 520, chain }: KasaneStageProps) {
  const navigate = useNavigate();
  const mode = useAppStore((s) => s.themeMode);
  const appChain = useAppStore((s) => s.chain);
  const { pathname } = useLocation();
  const design = resolveDesign(pathname, mode, chain ?? appChain);
  const theme = useMemo(() => createKasaneTheme(design.mode, design.chain), [design.mode, design.chain]);
  const goBack = () => {
    if (onBack) onBack();
    else if (Environment.isIos() && Environment.isInStandaloneMode() && back) navigate(back);
    else navigate(-1);
  };
  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          position: 'relative', minHeight: '100svh', width: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: (t) => t.kasane.stageBg, color: 'text.primary', pb: 6,
        }}
      >
        {showBack && (
          <IconButton onClick={goBack} aria-label="back" sx={{ position: 'absolute', top: 10, left: 10, color: (t) => t.kasane.wordmark }}>
            <ArrowBackIcon />
          </IconButton>
        )}
        <Box sx={{ mt: 3.5, mb: 1 }}><KasaneMark size={64} /></Box>
        {title && (
          <Typography component="h1" sx={{ fontSize: 21, fontWeight: 300, letterSpacing: 1.5, textWrap: 'balance', lineHeight: 1.5, color: (t) => t.kasane.wordmark, textAlign: 'center', px: 7, mb: 1 }}>
            {title}
          </Typography>
        )}
        <Box sx={{ width: '100%', maxWidth, px: 2, boxSizing: 'border-box', flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
          {children}
        </Box>
      </Box>
    </ThemeProvider>
  );
}
