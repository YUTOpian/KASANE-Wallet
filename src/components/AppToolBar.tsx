import type { ReactNode } from 'react';
import { AppBar, Toolbar, IconButton, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNavigate } from 'react-router-dom';
import { Environment } from '../lib/environment';

interface AppToolBarProps {
  title: string;
  back?: string;
  // Optional right-aligned content (e.g. a save/checkmark IconButton on a form screen).
  actions?: ReactNode;
  // Optional override for the back button's action - e.g. to run cleanup (discarding an
  // unsaved draft) before navigating away. When omitted, falls back to the normal
  // back/navigate(-1) behavior below.
  onBack?: () => void;
  // Hides the back arrow entirely - for screens (SWAP, トークン) that are also reachable
  // from the bottom nav, where a redundant back arrow at the top just adds noise.
  showBack?: boolean;
  // Optional override for the back arrow's color (a CSS color, e.g. a hex string) - for
  // screens that want a colour other than the KASANE bar's own. Omit to keep the default look.
  backColor?: string;
}

/**
 * Ported from src/components/parts/ToolBar.vue. In the iOS home-screen "standalone" PWA
 * mode there's no native back gesture/button, so we navigate to the given `back` path
 * explicitly instead of relying on browser history (same behavior as the Vue version).
 */
export default function AppToolBar({ title, back, actions, onBack, showBack = true, backColor }: AppToolBarProps) {
  const navigate = useNavigate();

  const backTo = () => {
    if (onBack) {
      onBack();
    } else if (Environment.isIos() && Environment.isInStandaloneMode() && back) {
      navigate(back);
    } else {
      navigate(-1);
    }
  };

  return (
    <AppBar position="sticky" color="default" elevation={1}>
      <Toolbar>
        {showBack && (
          <IconButton onClick={backTo} edge="start" aria-label="back" sx={backColor ? { color: backColor } : undefined}>
            <ArrowBackIcon color="inherit" />
          </IconButton>
        )}
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{title}</Typography>
        {actions}
      </Toolbar>
    </AppBar>
  );
}
