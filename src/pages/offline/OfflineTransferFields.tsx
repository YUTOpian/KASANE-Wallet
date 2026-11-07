import type { ReactNode } from 'react';
import { Alert, Box, Button, IconButton, InputAdornment, MenuItem, Select, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import type { Wallet } from '../../lib/storage';
import { ValueBox } from '../multisig/parts';
import { accountLabel } from './signingAccounts';

// The input part of the offline transfer screens (Symbol: OfflineSignPage, NEM: OfflineNemTransfer), laid out like the
// 「送る」 form on Home (pages/top/SendForm.tsx): a bold heading over each field, white fields, the mosaic on the left and its
// amount on the right (one column on a phone), the message with its byte count, and the fee in a framed box.
// Nothing here talks to a node, so (unlike Home) the mosaic picker has no "available balance" line.

const BOX_HEIGHT = 64;
const PAPER_SX = { '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } } as const;
const PAIR_SX = { display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, columnGap: 2, rowGap: 1, alignItems: 'start' } as const;

export function Heading({ children, mt }: { children: ReactNode; mt?: number }) {
  return <Typography sx={{ fontWeight: 'bold', mt, mb: 1 }}>{children}</Typography>;
}

/** The fee, laid out like Home's fee field: a bold heading and the value in a field-shaped box. */
export function FeeBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Heading>{label}</Heading>
      <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, px: 1.75, py: 1.75 }}>{children}</Box>
    </Box>
  );
}

export interface MosaicChoice { id: string; symbol: string; divisibility: number }
export interface MosaicRow { id: string; amount: string }
export interface ParsedMosaicRow { amount: bigint | null }

interface Props {
  // sender
  accounts: Wallet[];
  signerId: string;
  onSignerChange: (id: string) => void;
  senderNone: string;
  /** The heading over the sender (default: 送信元). */
  senderLabel?: string;
  address: string;
  // recipient
  recipient: string;
  onRecipientChange: (v: string) => void;
  recipientOk: boolean;
  // mosaics
  options: MosaicChoice[];
  rows: MosaicRow[];
  parsedRows: ParsedMosaicRow[];
  onRow: (i: number, patch: Partial<MosaicRow>) => void;
  onRemoveRow: (i: number) => void;
  onAddRow: () => void;
  canAddRow: boolean;
  maxRows: number;
  duplicate: boolean;
  noCachedNote: string;
  hasCached: boolean;
  // message
  message: string;
  onMessageChange: (v: string) => void;
  messageBytes: number;
  maxMessageBytes: number;
  messageOk: boolean;
  messageHint: string;
}

export default function OfflineTransferFields(p: Props) {
  const { t } = useTranslation();
  const symbolOf = (id: string) => p.options.find((o) => o.id === id)?.symbol ?? id;
  const usedElsewhere = (i: number) => new Set(p.rows.filter((_, j) => j !== i).map((r) => r.id));

  return (
    <Box sx={{ textAlign: 'left' }}>
      {/* Sender: the offline screens sign with any account of the device, so it is chosen here. */}
      <Heading>{p.senderLabel ?? t('offline.sender')}</Heading>
      <TextField
        select
        fullWidth
        value={p.signerId}
        onChange={(e) => p.onSignerChange(e.target.value)}
        error={p.accounts.length === 0}
        helperText={p.accounts.length === 0 ? p.senderNone : ''}
        slotProps={{ htmlInput: { 'aria-label': p.senderLabel ?? t('offline.sender') } }}
        sx={PAPER_SX}
      >
        {p.accounts.map((w) => <MenuItem key={w.id} value={w.id}>{accountLabel(w, t('wallet.account_imported'))}</MenuItem>)}
      </TextField>
      {p.address !== '' && <Box sx={{ mt: 0.75 }}><ValueBox>{p.address}</ValueBox></Box>}

      {/* Recipient. */}
      <Heading mt={3}>{t('send.destination')}</Heading>
      <TextField
        label={t('send.input_address')}
        value={p.recipient}
        onChange={(e) => p.onRecipientChange(e.target.value)}
        fullWidth
        error={p.recipient !== '' && !p.recipientOk}
        helperText={p.recipient !== '' && !p.recipientOk ? t('offline.recipient_invalid') : t('offline.recipient_hint')}
        slotProps={{ formHelperText: { sx: { wordBreak: 'break-all' } }, htmlInput: { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
        sx={PAPER_SX}
      />

      {/* The mosaic on the left, its amount on the right (one column on a phone); more mosaics under it. */}
      {p.rows.map((r, i) => {
        const parsed = p.parsedRows[i];
        const choice = p.options.find((o) => o.id === r.id);
        const symbol = symbolOf(r.id);
        const amountBad = r.amount !== '' && (parsed.amount === null || parsed.amount <= 0n);
        const choices = p.options.filter((o) => o.id === r.id || !usedElsewhere(i).has(o.id));
        return (
          <Box key={i} sx={{ mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
              <Typography sx={{ fontWeight: 'bold', flexGrow: 1 }}>{i === 0 ? t('send.select_mosaic_title') : t('send.mosaic_n', { n: i + 1 })}</Typography>
              {p.rows.length > 1 && (
                <IconButton size="small" onClick={() => p.onRemoveRow(i)} aria-label={t('offline.remove_mosaic')}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={PAIR_SX}>
              <Box sx={{ minWidth: 0 }}>
                <Select
                  value={choice ? r.id : ''}
                  displayEmpty
                  fullWidth
                  onChange={(e) => p.onRow(i, { id: e.target.value as string, amount: '' })}
                  inputProps={{ 'aria-label': t('offline.mosaic') }}
                  renderValue={() => (
                    <Box sx={{ minWidth: 0 }}>
                      <Typography noWrap sx={{ fontWeight: 'bold' }}>{symbol}</Typography>
                      {symbol !== r.id && <Typography noWrap sx={{ color: 'text.secondary', fontSize: 13 }}>ID: {r.id}</Typography>}
                    </Box>
                  )}
                  sx={{ bgcolor: 'background.paper', height: BOX_HEIGHT, '& .MuiSelect-select': { py: 1.25 } }}
                >
                  {choices.map((o) => (
                    <MenuItem key={o.id} value={o.id}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontWeight: 'bold' }}>{o.symbol}</Typography>
                        {o.symbol !== o.id && <Typography noWrap sx={{ color: 'text.disabled', fontSize: 10 }}>ID: {o.id}</Typography>}
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
                {i === 0 && <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.75 }}>{t('offline.mosaic_hint')}</Typography>}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <TextField
                  value={r.amount}
                  onChange={(e) => p.onRow(i, { amount: e.target.value.replace(/,/g, '.').replace(/[^0-9.]/g, '') })}
                  placeholder={t('send.amount_placeholder')}
                  fullWidth
                  error={amountBad}
                  helperText={amountBad ? t('offline.amount_invalid') : t('offline.amount_hint', { n: choice?.divisibility ?? 0 })}
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper', height: BOX_HEIGHT } }}
                  slotProps={{
                    htmlInput: { inputMode: 'decimal', autoComplete: 'off', 'aria-label': t('common.amount'), style: { fontSize: '1.4rem' } },
                    input: { endAdornment: <InputAdornment position="end"><Typography sx={{ fontWeight: 'bold' }}>{symbol}</Typography></InputAdornment> },
                  }}
                />
              </Box>
            </Box>
          </Box>
        );
      })}
      {p.duplicate && <Alert severity="error" sx={{ mt: 1.5 }}>{t('offline.duplicate_mosaic')}</Alert>}
      {!p.hasCached && <Alert severity="info" sx={{ mt: 1.5 }}>{p.noCachedNote}</Alert>}
      <Box sx={{ mt: 1.5 }}>
        <Button size="small" startIcon={<AddIcon />} disabled={!p.canAddRow} onClick={p.onAddRow}>{t('send.add_mosaic')}</Button>
        {p.rows.length >= p.maxRows && (
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('send.mosaic_limit', { count: p.maxRows })}</Typography>
        )}
      </Box>

      {/* Optional message (plain: encrypting needs the recipient's public key from the chain). */}
      <Heading mt={3}>{t('send.message_optional')}</Heading>
      <TextField
        value={p.message}
        onChange={(e) => p.onMessageChange(e.target.value)}
        placeholder={t('common.message_input')}
        fullWidth
        multiline
        minRows={2}
        error={!p.messageOk}
        helperText={`${p.messageBytes} / ${p.maxMessageBytes} bytes`}
        sx={PAPER_SX}
      />
      <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.5 }}>{p.messageHint}</Typography>
    </Box>
  );
}
