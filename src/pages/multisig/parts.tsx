import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Divider, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SymbolSendError, explorerTxUrl } from '../../lib/symbol/api';
import type { MultisigCost } from '../../lib/symbol/multisigApi';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { decodeAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';

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
      <PasswordDialog open={showPassword} mode="check" onClose={() => setShowPassword(false)} onPass={onPass} />
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

export function DoneScreen({ hash, bonded, extra }: { hash: string; bonded: boolean; extra?: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lines = t(bonded ? 'multisig.done_bonded' : 'multisig.done_complete', { returnObjects: true }) as string[];
  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box sx={{ width: '100%', px: { xs: 3, md: 5 }, py: 4, boxSizing: 'border-box', textAlign: 'center' }}>
        <Typography sx={{ fontSize: 'x-large', color: 'primary.main', mb: 3 }}>
          {lines.map((line, i) => <span key={i}>{line}<br /></span>)}
        </Typography>
        {extra}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/multisig', { replace: true })}>{t('multisig.to_list')}</Button>
          <Button href={explorerTxUrl(hash)} target="_blank" rel="noopener" variant="contained" fullWidth>
            {t('multisig.view_explorer')}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
