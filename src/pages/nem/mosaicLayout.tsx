import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

// NanoWallet-style building blocks for the NEM mosaic screens: two columns on a wide screen (one on a phone),
// a titled section with a line under it, and rows with the label on the left and the field on the right.

export function MosaicColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, columnGap: 6, rowGap: 1, alignItems: 'start' }}>
      <Box sx={{ minWidth: 0 }}>{left}</Box>
      <Box sx={{ minWidth: 0 }}>{right}</Box>
    </Box>
  );
}

export function SectionHead({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <Typography component="h3" sx={{ fontSize: '1.1rem', color: 'text.secondary', pb: 0.75, mb: 2, mt: first ? 0 : 4, borderBottom: 2, borderColor: 'primary.main' }}>
      {children}
    </Typography>
  );
}

export function FormRow({ label, children, top = false }: { label: ReactNode; children: ReactNode; top?: boolean }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(110px, 180px) minmax(0, 1fr)' }, columnGap: 2, rowGap: 0.5, alignItems: top ? 'start' : 'center', mb: 2 }}>
      <Typography component="div" sx={{ fontWeight: 'bold', fontSize: '0.95rem', pt: top ? 0.5 : 0 }}>{label}</Typography>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

/** A value that can't be edited (grey box, like NanoWallet's read-only fields). */
export function ReadOnlyValue({ value, unit, mono = false, bold = false }: { value: string; unit?: string; mono?: boolean; bold?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider', px: 1.5, py: 0.9, minHeight: 36, boxSizing: 'border-box' }}>
      <Typography sx={{ fontSize: mono ? '0.85rem' : '0.95rem', fontFamily: mono ? 'monospace' : undefined, fontWeight: bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{value}</Typography>
      {unit && <Typography sx={{ fontSize: '0.8rem', fontWeight: 'bold', whiteSpace: 'nowrap', color: 'text.secondary' }}>{unit}</Typography>}
    </Box>
  );
}

/** "1234" + divisibility 2 → "1,234.00" (the whole supply as it will be shown with its decimals). */
export function supplyWithDecimals(whole: string, divisibility: number): string {
  const digits = whole === '' ? '0' : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return divisibility > 0 ? `${grouped}.${'0'.repeat(divisibility)}` : grouped;
}

/** NEM address in the usual hyphenated form. */
export function hyphenateNemAddress(address: string): string {
  return address.replace(/-/g, '').replace(/(.{6})(?=.)/g, '$1-');
}

/** micro-XEM with all 6 decimals ("0.150000"), the way NanoWallet shows fees. */
export function xemFixed(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${frac}`;
}

/** An amount in the smallest unit shown with all its decimals ("5" with divisibility 6 → "0.000005"). */
export function fixedAtomic(atomic: bigint, divisibility: number): string {
  if (divisibility <= 0) return atomic.toString();
  const base = 10n ** BigInt(divisibility);
  return `${(atomic / base).toString()}.${(atomic % base).toString().padStart(divisibility, '0')}`;
}
