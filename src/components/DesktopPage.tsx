import type { ReactNode } from 'react';
import { Alert, Box, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { FlatSectionsContext, FormRow } from '../pages/multisig/parts';

// 画面の外枠と、縦に積むカード、ラベルを左に置く入力欄（DNS・署名付きメッセージ・アポスティーユで共通）。
// NEMonster の画面と同じ作り: 幅いっぱいに使い、太字のタイトル、青い説明バー、カードを縦に並べる。

interface DesktopPageProps {
  title: ReactNode;
  /** The explanation under the title, in a blue bar. */
  about?: ReactNode;
  /** The tab bar, when the page has one. */
  tabs?: ReactNode;
  children: ReactNode;
}

/** The frame of a page: bold title, a blue explanation bar, tabs, then the content (full width). */
export default function DesktopPage({ title, about, tabs, children }: DesktopPageProps) {
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="h6" component="h1" sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
        {about && <Alert severity="info" sx={{ mb: 2 }}>{about}</Alert>}
        {tabs}
        <FlatSectionsContext.Provider value>{children}</FlatSectionsContext.Provider>
      </Box>
    </Box>
  );
}

/** Blocks one under another, full width. With `columns`, two blocks side by side on a wide screen (one column on a phone). */
export function TwoColumns({ children, sx, columns = false }: { children: ReactNode; ratio?: [number, number]; sx?: SxProps<Theme>; columns?: boolean }) {
  if (!columns) return <Box sx={{ display: 'block', ...sx }}>{children}</Box>;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, columnGap: { md: 4 }, alignItems: 'start', ...sx }}>
      {children}
    </Box>
  );
}

/** One input: the label on the left, the field next to it, the note on the right (stacked on a phone). */
export function FormStack({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return <FormRow label={label} hint={hint} top>{children}</FormRow>;
}

/** What a result card shows before there is anything to show. */
export function EmptyPanel({ children, minHeight = 96 }: { children: ReactNode; minHeight?: number }) {
  return (
    <Box sx={{ bgcolor: 'action.hover', borderRadius: 1.5, px: 3, py: 3, minHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', boxSizing: 'border-box' }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8 }}>{children}</Typography>
    </Box>
  );
}
