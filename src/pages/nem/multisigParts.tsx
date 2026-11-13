import { useState } from 'react';
import { Box, Button, Divider, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { SymbolSendError } from '../../lib/symbol/api';

export interface NemConfirmRow { label: string; value: string; big?: boolean }

/** Address prefix of the current network: N (mainnet) or T (testnet). */
export const nemAddressPrefix = () => (getNemNetworkConfig().networkByte === 0x68 ? 'N' : 'T');

export function classifyNemMultisigError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  const c = code.toUpperCase();
  if (c.includes('INSUFFICIENT_BALANCE')) return { kind: 'insufficient_balance', detail };
  if (c.includes('DEADLINE') || c.includes('TIMESTAMP')) return { kind: 'deadline', detail };
  if (c.includes('WRONG_NETWORK')) return { kind: 'wrong_network', detail };
  if (c.includes('NOT_A_COSIGNER')) return { kind: 'not_cosigner', detail };
  if (c.includes('MULTISIG')) return { kind: 'prohibited', detail: code };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

/** The confirm step: a summary, then password -> send. `onPassword` throws on failure. */
export function NemConfirmScreen({ rows, onBack, onPassword }: { rows: NemConfirmRow[]; onBack: () => void; onPassword: (password: string) => Promise<void> }) {
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
      else setSendError(classifyNemMultisigError(e));
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
                <Typography sx={{ fontSize: row.big ? '1.1rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{row.value}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
      <MessageDialog open={showCaution} title={t('multisig.confirm_title')} texts={t('nemmultisig.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
          <Typography variant="body2" align="center">{sending ? t('nemmultisig.sending') : t('multisig.confirm_ready')}</Typography>
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
        title={sendError ? t(`nemmultisig.error_${sendError.kind}_title`) : ''}
        texts={sendError ? (t(`nemmultisig.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : []}
        onClose={() => setSendError(null)}
      />
    </Box>
  );
}

