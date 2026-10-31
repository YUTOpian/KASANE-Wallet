import { useState } from 'react';
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from 'react';
import { Alert, Box, Button, Chip, Divider, TextField, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextDialog from '../../components/QrTextDialog';
import { KASANE_QR_MAX_LENGTH, buildKasaneQr } from '../../lib/symbol/kasaneQr';
import { SymbolSendError } from '../../lib/symbol/api';
import type { MultisigCost, PartialItem } from '../../lib/symbol/multisigApi';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { decodeAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { operationKey } from '../../lib/symbol/restrictions';
import { treeRows } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import type { RestrictionKind } from '../../lib/symbol/restrictions';

export const xymText = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;

/** Address prefix of the current network: N (mainnet) or T (testnet). */
export const addressPrefix = () => (getNetworkConfig().networkByte === 0x68 ? 'N' : 'T');

/** null when fine, else the i18n key suffix of the problem. */
export function addressProblem(text: string): 'err_address_invalid' | 'err_address_network' | null {
  const a = normalizeAddress(text);
  if (decodeAddress(a) === null) return 'err_address_invalid';
  return a.startsWith(addressPrefix()) ? null : 'err_address_network';
}

export function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'Failure_Multisig_Operation_Prohibited_By_Account') return { kind: 'prohibited', detail: code };
  if (code === 'lock_timeout') return { kind: 'lock_timeout', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

export function CostBox({ cost, hasBalanceShort }: { cost: MultisigCost | null; hasBalanceShort: boolean }) {
  const { t } = useTranslation();
  const val = (v: bigint | undefined) => (v === undefined ? t('multisig.cost_unavailable') : xymText(v));
  const rows: [string, bigint | undefined][] = [[t('multisig.tx_fee'), cost?.aggregateFee.fee]];
  if (cost?.bonded) {
    rows.push([t('multisig.lock_fee'), cost.lockFee], [t('multisig.lock_amount'), cost.lockAmount]);
  }
  rows.push([t('multisig.total_needed'), cost?.totalNeeded]);
  return (
    <Box sx={{ mt: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('multisig.cost_title')}</Typography>
      {rows.map(([label, v], i) => (
        <Typography key={label} variant="body2" sx={{ fontWeight: i === rows.length - 1 ? 'bold' : 'normal', wordBreak: 'break-all' }}>
          {label}: {val(v)}
        </Typography>
      ))}
      {cost && (
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>
          {cost.bonded ? t('multisig.bonded_hint', { amount: xymText(cost.lockAmount) }) : t('multisig.complete_hint')}
        </Typography>
      )}
      {hasBalanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('multisig.xym_short_warning')}</Alert>}
    </Box>
  );
}

export interface ConfirmRow { label: string; value: string; big?: boolean }

/** The confirm step shared by the multisig forms: a summary, then password -> send. */
export function ConfirmScreen({ rows, onBack, onPassword }: {
  rows: ConfirmRow[];
  onBack: () => void;
  // Gets the password; throws on failure (the error is classified and shown).
  onPassword: (password: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [showCaution, setShowCaution] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  const onPass = async (password: string) => {
    setSending(true);
    try {
      await onPassword(password);
    } catch (e) {
      if (e instanceof Error && e.message === 'invalid_password') setErrorMessage(t('wallet.invalid_key'));
      else setSendError(classifyError(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
        <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
          {rows.map((row, i) => (
            <Box key={`${row.label}-${i}`}>
              {i > 0 && <Divider />}
              <Box sx={{ py: 2 }}>
                <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                <Typography sx={{ fontSize: row.big ? '1.1rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                  {row.value}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
      <MessageDialog open={showCaution} title={t('multisig.confirm_title')} texts={t('multisig.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
          <Typography variant="body2" align="center">{sending ? t('multisig.sending') : t('multisig.confirm_ready')}</Typography>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPassword(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
            {t('multisig.confirm_password')}
          </Button>
        </Box>
      </Box>
      <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={onPass} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog
        open={sendError != null}
        variant="error"
        title={sendError ? t(`multisig.error_${sendError.kind}_title`) : ''}
        texts={sendError ? (t(`multisig.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : []}
        onClose={() => setSendError(null)}
      />
    </Box>
  );
}

/**
 * 「連署QR」: a bonded aggregate as a QR code for the other cosigners to scan and sign. It carries the signed
 * aggregate when that fits in a QR code (so it can be read without the node), else just the hash.
 */
export function CosignQrButton({ hash, payload }: { hash: string; payload?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const full = buildKasaneQr({ kind: 'cosign_request', hash, payload });
  const text = full.length <= KASANE_QR_MAX_LENGTH ? full : buildKasaneQr({ kind: 'cosign_request', hash });
  return (
    <>
      <Button variant="outlined" color="primary" fullWidth onClick={() => setOpen(true)} sx={{ mb: 1 }}>{t('signqr.cosign_qr_button')}</Button>
      <QrTextDialog open={open} title={t('signqr.cosign_qr_title')} hint={t('signqr.cosign_qr_hint')} text={text}
        file={payload ? { text: full, name: `kasane-cosign-request-${hash.slice(0, 8).toLowerCase()}.json` } : undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

export function ItemView({ item }: { item: PartialItem }) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (item.kind === 'transfer') {
    lines.push(`${t('multisig.item_to')}: ${item.recipient}`);
    lines.push(item.mosaics.map((m) => `${m.amount} ${m.symbol}`).join(', '));
    if (item.encrypted) lines.push(t('multisig.item_encrypted'));
    else if (item.message) lines.push(`${t('multisig.item_message')}: ${item.message}`);
  } else if (item.kind === 'multisig') {
    if (item.additions.length) lines.push(`${t('multisig.item_add')}:\n${item.additions.join('\n')}`);
    if (item.deletions.length) lines.push(`${t('multisig.item_remove')}:\n${item.deletions.join('\n')}`);
    lines.push(t('multisig.item_thresholds', { approval: signed(item.minApprovalDelta), removal: signed(item.minRemovalDelta) }));
  } else if (item.kind === 'metadata') {
    lines.push(`${t('multisig.item_metadata_target')}: ${t(`metadata.type_${item.targetType}`)}${item.targetId ? ` (${item.targetId})` : ''}`);
    lines.push(`${t('multisig.item_metadata_owner')}: ${item.targetAddress}`);
    lines.push(`${t('metadata.key_label')}: ${item.key}`);
    if (item.value) lines.push(`${t('metadata.value_label')}: ${item.value.text ?? `0x${item.value.hex}`}`);
    else lines.push(`${t('multisig.item_metadata_change')}: 0x${item.changeHex} (${signed(item.valueSizeDelta)} bytes)`);
  } else if (item.kind === 'restriction') {
    const rule = item.rule.kind === 'address'
      ? `${t('restriction.kind_address')} (${t(`restriction.dir_${item.rule.direction}`)})`
      : t(`restriction.kind_${item.rule.kind}`);
    lines.push(`${rule} - ${t(`restriction.mode_${item.mode}`)}`);
    const valueText = (kind: RestrictionKind, v: string) => {
      const key = kind === 'operation' ? operationKey(v) : null;
      return key ? `${t(`restriction.ops.${key}`)} (${v})` : v;
    };
    if (item.additions.length) lines.push(`${t('multisig.item_restriction_add')}:\n${item.additions.map((v) => valueText(item.rule.kind, v)).join('\n')}`);
    if (item.deletions.length) lines.push(`${t('multisig.item_restriction_remove')}:\n${item.deletions.map((v) => valueText(item.rule.kind, v)).join('\n')}`);
  }
  const title = item.kind === 'transfer' ? t('multisig.item_transfer', { account: item.account })
    : item.kind === 'multisig' ? t('multisig.item_multisig', { account: item.account })
      : item.kind === 'restriction' ? t('multisig.item_restriction', { account: item.account })
        : item.kind === 'metadata' ? t('multisig.item_metadata', { account: item.account })
          : t('multisig.item_other', { account: item.account });
  return (
    <Box sx={{ mb: 1 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', ...mono }}>{title}</Typography>
      {lines.map((l, i) => <Typography key={i} variant="body2" sx={{ whiteSpace: 'pre-wrap', ...mono }}>{l}</Typography>)}
    </Box>
  );
}
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

// --- form layout (label on the left, field in the middle, hint on the right) ---------------------------------
/** A white panel with an optional title: one block of a multisig screen. */
export function SectionCard({ title, children, sx }: { title?: string; children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: { xs: 2, md: 4 }, py: { xs: 2, md: 3 }, mb: 2, ...sx }}>
      {title && <Typography sx={{ fontWeight: 'bold', fontSize: '1.15rem', color: 'primary.main', mb: 1 }}>{title}</Typography>}
      {children}
    </Box>
  );
}

/** One row of a form: the label on the left, the field next to it and an optional hint on the right (stacked on a phone). */
export function FormRow({ label, hint, children, top = false }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; top?: boolean }) {
  return (
    <Box sx={{
      display: 'grid',
      // the hint column only exists when there is a hint, so a row without one gives its whole width to the field
      gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: hint ? '180px minmax(0, 1fr) minmax(0, 240px)' : '180px minmax(0, 1fr)' },
      columnGap: 3,
      rowGap: 0.75,
      alignItems: top ? 'start' : 'center',
      py: 1.25,
    }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', pt: top ? { md: 1 } : 0 }}>{label}</Typography>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
      {hint && <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic', lineHeight: 1.5 }}>{hint}</Typography>}
    </Box>
  );
}

interface FieldProps {
  value: string | number;
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  ariaLabel: string;
  select?: boolean;
  error?: boolean;
  helperText?: ReactNode;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
  minRows?: number;
  htmlInput?: InputHTMLAttributes<HTMLInputElement>;
  /** Shown inside the field at its right end (a unit such as XYM). */
  endAdornment?: ReactNode;
  children?: ReactNode;
}

/** A grey, borderless input (the label is the FormRow's, so the field itself carries only an aria-label). */
export function Field({ ariaLabel, htmlInput, endAdornment, children, ...rest }: FieldProps) {
  return (
    <TextField
      {...rest}
      variant="filled"
      hiddenLabel
      size="small"
      fullWidth
      slotProps={{ input: { disableUnderline: true, sx: { borderRadius: 1.5 }, endAdornment }, htmlInput: { 'aria-label': ariaLabel, ...htmlInput } }}
    >
      {children}
    </TextField>
  );
}

/** A read-only value in a grey box (an address). */
export function ValueBox({ children }: { children: ReactNode }) {
  return <Box sx={{ bgcolor: 'action.hover', borderRadius: 1.5, px: 1.5, py: 1, fontSize: 13, ...mono }}>{children}</Box>;
}

/**
 * マルチレベルマルチシグ: the cosigners of `root`, indented by depth. A cosigner that is a multisig account carries its own
 * threshold, and its cosigners are listed under it (it is approved by their signatures).
 */
export function CosignerTree({ graph, root }: { graph: MultisigGraph; root: string }) {
  const { t } = useTranslation();
  return (
    <Box>
      {treeRows(graph, root).map((r, i) => (
        <Box key={`${r.address}-${i}`} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, py: 0.25, pl: r.depth * 2.5, borderLeft: r.depth > 0 ? 2 : 0, borderColor: 'divider', ml: r.depth > 0 ? 1 : 0 }}>
          <Typography variant="body2" sx={{ minWidth: 0, ...mono }}>{r.address}</Typography>
          {r.multisig && <Chip size="small" variant="outlined" color="primary" label={t('multisig.multilevel_chip', { approval: r.minApproval, count: r.cosignerCount })} />}
          {r.repeated && <Chip size="small" variant="outlined" label={t('multisig.tree_repeated')} />}
        </Box>
      ))}
    </Box>
  );
}
