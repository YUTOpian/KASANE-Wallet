import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import { useTranslation } from 'react-i18next';
import PasswordDialog from './PasswordDialog';
import { WalletsHelper } from '../lib/storage';
import type { Wallet } from '../lib/storage';
import { useAppStore } from '../store/appStore';
import { formatAtomic } from '../lib/symbol/amount';
import { LedgerError } from '../lib/ledger/framing';
import { ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink } from '../lib/ledger/session';
import { SymbolSendError } from '../lib/symbol/api';
import { executeTestnetReturn, planTestnetReturn } from '../lib/testnetReturn';
import type { TestnetReturnPlan } from '../lib/testnetReturn';

// 設定 > 「テストXYMを返還」「テストXEMを返還」。テストネットのときだけ開く。
// 返還先・残高・手数料・返還額を見せ、ボタン1つ（全額返還する）→ パスワード（Ledger はデバイス）で、
// 残高から手数料を引いた全額を1回の送金で返す。
export default function TestnetReturnDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const symbol = chain === 'nem' ? 'XEM' : 'XYM';
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [plan, setPlan] = useState<TestnetReturnPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ hash: string; amount: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setPlan(null);
    try {
      const active = await WalletsHelper.getActive();
      setWallet(active);
      if (!active || active.watchOnly) throw new Error('no_signer');
      setPlan(await planTestnetReturn(chain, active.address));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setError('');
    void load();
  }, [open, load]);

  const run = async (privateKey: string, ledgerIndex?: number) => {
    if (!wallet) return;
    setSending(true);
    setError('');
    try {
      const result = await executeTestnetReturn(chain, wallet.address, { privateKey, ledgerIndex, publicKey: wallet.publicKey });
      setDone({ hash: result.hash, amount: formatAtomic(result.plan.amount, result.plan.divisibility) });
      setPlan(null);
    } catch (e) {
      if (e instanceof LedgerError) {
        if (e.kind !== 'no_device') setError(t(ledgerErrorKey(e), { chain: chain === 'nem' ? 'NEM' : 'Symbol' }));
      } else if (e instanceof Error && e.message === 'nothing_to_return') {
        setError(t('settings.testnet_return_none', { symbol }));
      } else {
        const code = e instanceof SymbolSendError && e.code ? `${e.code}: ` : '';
        setError(t('settings.testnet_return_failed', { detail: `${code}${e instanceof Error ? e.message : String(e)}` }));
      }
    } finally {
      setSending(false);
    }
  };

  const onPassword = async (password: string) => {
    if (!wallet) return;
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) {
      setError(t('wallet.invalid_key'));
      return;
    }
    await run(privateKey);
  };

  // Ledger: the device can only be picked right after the button press, so connect here, then sign.
  const onLedger = async () => {
    if (!wallet || wallet.accountIndex === null) return;
    const link = preferredLedgerLink();
    if (link === null) {
      setError(t('ledger.error_unsupported_browser'));
      return;
    }
    try {
      await ensureLedgerConnected(link);
    } catch (e) {
      if (!(e instanceof LedgerError && e.kind === 'no_device')) setError(t(ledgerErrorKey(e), { chain: chain === 'nem' ? 'NEM' : 'Symbol' }));
      return;
    }
    await run('', wallet.accountIndex);
  };

  const onReturnClick = () => {
    if (wallet?.ledger) void onLedger();
    else setShowPassword(true);
  };

  const fmt = (v: bigint) => `${formatAtomic(v, plan?.divisibility ?? 6)} ${symbol}`;
  const canReturn = plan !== null && plan.amount > 0n && !sending;
  const row = (label: string, value: string, big = false) => (
    <Box sx={{ py: 1 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem' }}>{label}</Typography>
      <Typography sx={{ fontSize: big ? '1.5rem' : '0.95rem', fontWeight: big ? 'bold' : 'normal', wordBreak: 'break-all', lineHeight: 1.5 }}>{value}</Typography>
    </Box>
  );

  return (
    <>
      <Dialog open={open} onClose={() => !sending && onClose()} fullWidth maxWidth="xs">
        <DialogTitle>{t(chain === 'nem' ? 'settings.testnet_return_xem_title' : 'settings.testnet_return_xym_title')}</DialogTitle>
        <DialogContent>
          {done ? (
            <Alert severity="success" sx={{ mt: 0.5 }}>
              <Typography sx={{ fontWeight: 600 }}>{t('settings.testnet_return_done', { amount: `${done.amount} ${symbol}` })}</Typography>
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}>{done.hash}</Typography>
            </Alert>
          ) : (
            <>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('settings.testnet_return_message', { symbol })}</Typography>
              {loading && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}><CircularProgress size={18} /><Typography variant="body2">{t('settings.testnet_return_loading')}</Typography></Box>}
              {loadError && <Alert severity="error" sx={{ my: 1 }}>{t('settings.testnet_return_load_failed', { detail: loadError })}</Alert>}
              {plan && (
                <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 0.5 }}>
                  {row(t('settings.testnet_return_to'), plan.recipientPretty)}
                  {row(t('settings.testnet_return_balance'), fmt(plan.balance))}
                  {row(t('settings.testnet_return_fee'), fmt(plan.fee))}
                  {row(t('settings.testnet_return_amount'), fmt(plan.amount), true)}
                </Box>
              )}
              {plan && plan.amount <= 0n && <Alert severity="info" sx={{ mt: 1.5 }}>{t('settings.testnet_return_none', { symbol })}</Alert>}
              {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
              {sending && <Typography variant="body2" sx={{ mt: 1.5 }}>{wallet?.ledger ? t('ledger.confirm_on_device') : t('send.sending')}</Typography>}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
          {!done && (
            <Button
              variant="contained"
              size="large"
              fullWidth
              disabled={!canReturn}
              onClick={onReturnClick}
              startIcon={sending ? <CircularProgress size={18} /> : wallet?.ledger ? <UsbOutlinedIcon /> : <LockOutlinedIcon />}
              sx={{ py: 1.25 }}
            >
              {t('settings.testnet_return_button')}
            </Button>
          )}
          <Button onClick={onClose} disabled={sending} sx={{ ml: '0 !important' }}>{done ? t('common.close') : t('common.cancel')}</Button>
        </DialogActions>
      </Dialog>
      <PasswordDialog
        open={showPassword}
        mode="check"
        popup
        onClose={() => setShowPassword(false)}
        onPass={(password) => { setShowPassword(false); void onPassword(password); }}
      />
    </>
  );
}
