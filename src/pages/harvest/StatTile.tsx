import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

/** One figure of a statistics panel: a small label above the value, both centred. */
export function StatTile({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1, minWidth: 0, textAlign: 'center' }}>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '1.15rem', color: 'primary.main', wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' }}>{children}</Typography>
      {hint && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{hint}</Typography>}
    </Box>
  );
}

/** The tiles of a panel, as a grid that wraps on a narrow screen. */
export function StatGrid({ children, columns }: { children: ReactNode; columns?: number }) {
  // With `columns` the tiles sit in that many columns (2 on a phone); without it they wrap by width.
  const template = columns === undefined ? 'repeat(auto-fit, minmax(150px, 1fr))' : { xs: 'repeat(2, minmax(0, 1fr))', sm: `repeat(${columns}, minmax(0, 1fr))` };
  return <Box sx={{ display: 'grid', gridTemplateColumns: template, gap: 1.5, mb: 2 }}>{children}</Box>;
}
