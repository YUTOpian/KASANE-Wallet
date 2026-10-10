import { Box, Divider, Typography } from '@mui/material';
import { SymbolSendError } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL } from '../../lib/nem/constants';

export const nemXem = (micro: bigint) => `${formatAtomic(micro, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;

/** Maps NIS1's rejection text (e.g. FAILURE_INSUFFICIENT_BALANCE) to a message key + detail. */
export function classifyNemError(error: unknown, conflictHint: 'NAMESPACE' | 'MOSAIC' | 'NONE'): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  const c = code.toUpperCase();
  if (c.includes('INSUFFICIENT_BALANCE')) return { kind: 'insufficient_balance', detail };
  if (c.includes('DEADLINE') || c.includes('TIMESTAMP')) return { kind: 'deadline', detail };
  if (c.includes('WRONG_NETWORK')) return { kind: 'wrong_network', detail };
  if (c.includes('EXPIRED')) return { kind: 'expired', detail };
  if (c.includes(conflictHint) && (c.includes('CONFLICT') || c.includes('EXISTS') || c.includes('RESERVED') || c.includes('INVALID_NAME') || c.includes('OWNER'))) {
    return { kind: 'conflict', detail };
  }
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

/** The review card shown before the password is asked. */
export function ConfirmRows({ rows }: { rows: { label: string; value: string; big?: boolean }[] }) {
  return (
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
      {rows.map((row, i) => (
        <Box key={row.label}>
          {i > 0 && <Divider />}
          <Box sx={{ py: 2 }}>
            <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
            <Typography sx={{ fontSize: row.big ? '1.4rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
              {row.value}
            </Typography>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** The cost box of a form. */
export function CostBox({ title, rows, hint, warning }: { title: string; rows: { label: string; value: string; bold?: boolean }[]; hint: string; warning?: string }) {
  return (
    <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
      {rows.map((r) => (
        <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
      ))}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{hint}</Typography>
      {warning && <Typography variant="body2" sx={{ mt: 1.5, color: 'warning.main', fontWeight: 'bold' }}>{warning}</Typography>}
    </Box>
  );
}
