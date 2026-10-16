import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

/** One figure of a statistics panel: a small label above the value. */
export function StatTile({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1, minWidth: 0 }}>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '1.15rem', color: 'primary.main', wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' }}>{children}</Typography>
      {hint && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{hint}</Typography>}
    </Box>
  );
}

/** The tiles of a panel, as a grid that wraps on a narrow screen. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, mb: 2 }}>{children}</Box>;
}
