import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, TextField } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemXemBalance } from '../../lib/nem/api';
import { fetchNemMultisigInfo, sendNemMultisigWrapped } from '../../lib/nem/multisigApi';
import type { NemMultisigInfo } from '../../lib/nem/multisigApi';
import { isValidNemAddress, normalizeNemAddress } from '../../lib/nem/crypto';
import { NEM_CURRENCY_DIVISIBILITY } from '../../lib/nem/constants';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { NEM_MAX_MESSAGE_BYTES } from '../../lib/nem/constants';
import { NEM_MULTISIG_WRAPPER_FEE, nemMessageByteLength, nemTransferFee } from '../../lib/nem/tx';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { useAppStore } from '../../store/appStore';
import { NemConfirmScreen, NemDoneScreen, nemAddressPrefix } from './multisigParts';
import type { NemConfirmRow } from './multisigParts';
import { nemXem } from './parts';

type Step = 'form' | 'confirm' | 'done';

// NEM 「マルチシグから送金」: an XEM transfer in the name of a multisig account this wallet
// cosigns for. This wallet signs the wrapper (and pays 0.15 XEM); the account pays the transfer fee.
export default function NemMultisigSend() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState((params.get('account') ?? '').toUpperCase());
  const [info, setInfo] = useState<NemMultisigInfo | null>(null);
  const [accountBalance, setAccountBalance] = useState<bigint | null>(null);
  const [ownBalance, setOwnBalance] = useState<bigint | null>(null);

  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const [resultHash, setResultHash] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        const own = await fetchNemMultisigInfo(wallet.address);
        const bal = await fetchNemXemBalance(wallet.address).catch(() => null);
        if (cancelled) return;
        const list = own.multisigOf.map((a) => a.address);
        setAccounts(list);
        setAccount((cur) => (list.includes(cur) ? cur : (list[0] ?? '')));
        setOwnBalance(bal);
      } catch (e) {
        console.error('Failed to load multisig accounts', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setInfo(null);
    setAccountBalance(null);
    Promise.all([fetchNemMultisigInfo(account), fetchNemXemBalance(account)])
      .then(([i, b]) => { if (!cancelled) { setInfo(i); setAccountBalance(b); } })
      .catch((e) => console.error('Failed to load account', e));
    return () => { cancelled = true; };
  }, [account, network]);

  const amount = parseDecimal(amountText, NEM_CURRENCY_DIVISIBILITY);
  const recipientOk = recipient.trim() !== '' && isValidNemAddress(recipient, netCfg.networkByte);
  const recipientError = recipient.trim() !== '' && !recipientOk;
  const messageTooLong = nemMessageByteLength(message) > NEM_MAX_MESSAGE_BYTES;
  const innerFee = amount !== null && amount > 0n ? nemTransferFee(amount, message || undefined) : nemTransferFee(0n, message || undefined);
  const needAccount = (amount ?? 0n) + innerFee;
  const amountError = amountText === '' ? '' : amount === null || amount <= 0n ? 'err_amount' : accountBalance !== null && needAccount > accountBalance ? 'err_amount_over' : '';
  const ownShort = ownBalance !== null && ownBalance < NEM_MULTISIG_WRAPPER_FEE;
  const required = info ? (info.minCosignatories === 0 ? info.cosignatories.length : info.minCosignatories) : 0;
  const canContinue = !!info?.publicKey && recipientOk && amount !== null && amount > 0n && amountError === '' && !messageTooLong;

  const rows = useMemo<NemConfirmRow[]>(() => [
    { label: t('multisig.from_account'), value: account, big: true },
    { label: t('multisig.recipient_label'), value: normalizeNemAddress(recipient), big: true },
    { label: t('multisig.network_label'), value: `NEM ${netCfg.label}` },
    { label: t('multisig.amount_row'), value: `${amountText} XEM`, big: true },
    ...(message ? [{ label: t('multisig.message_row'), value: message }] : []),
    { label: t('multisig.approval_row'), value: `${required} / ${info?.cosignatories.length ?? ''}` },
    { label: t('nemmultisig.inner_fee_row'), value: nemXem(innerFee) },
    { label: t('nemmultisig.wrapper_fee_row'), value: nemXem(NEM_MULTISIG_WRAPPER_FEE) },
  ], [t, account, recipient, netCfg.label, amountText, message, required, info, innerFee]);

  const onSend = async (password: string) => {
    const wallet = await WalletsHelper.getActive();
    if (!wallet || !info?.publicKey || amount === null) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    const sent = await sendNemMultisigWrapped(privateKey, wallet.publicKey, info.publicKey, {
      kind: 'transfer',
      recipient: normalizeNemAddress(recipient),
      amount,
      message: message || undefined,
    });
    setResultHash(sent.hash);
    setStep('done');
  };

  if (step === 'done') {
    const lines = t(required > 1 ? 'nemmultisig.done_transfer_waiting' : 'nemmultisig.done_transfer', { returnObjects: true }) as string[];
    return <NemDoneScreen hash={resultHash} lines={lines} />;
  }
  if (step === 'confirm') return <NemConfirmScreen rows={rows} onBack={() => setStep('form')} onPassword={onSend} />;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemmultisig.send_note')}</Alert>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {!loading && accounts.length === 0 && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.no_account')}</Alert>}
        {accounts.length > 0 && (
          <>
            <TextField select label={t('multisig.from_account')} value={account} onChange={(e) => setAccount(e.target.value)} fullWidth sx={{ mb: 2 }}>
              {accounts.map((a) => <MenuItem key={a} value={a} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>{a}</MenuItem>)}
            </TextField>
            {info && !info.publicKey && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.err_no_public_key')}</Alert>}
            <TextField
              label={t('multisig.recipient_label')}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              error={recipientError}
              helperText={recipientError ? t('multisig.err_address_invalid') : t('nemmultisig.address_hint', { prefix: nemAddressPrefix() })}
              fullWidth
              slotProps={{ htmlInput: { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('nemmultisig.amount_label')}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              error={amountError !== ''}
              helperText={amountError ? t(`multisig.${amountError}`) : accountBalance !== null ? t('multisig.available', { amount: `${formatAtomic(accountBalance, NEM_CURRENCY_DIVISIBILITY)} XEM` }) : ''}
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('multisig.message_label')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              error={messageTooLong}
              helperText={messageTooLong ? t('multisig.err_message_long') : `${nemMessageByteLength(message)} / ${NEM_MAX_MESSAGE_BYTES}`}
              fullWidth
              multiline
              minRows={2}
            />
            <Box sx={{ mt: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
              <Box sx={{ fontWeight: 'bold', mb: 1 }}>{t('multisig.cost_title')}</Box>
              <Box sx={{ fontSize: '0.875rem' }}>{t('nemmultisig.inner_fee_row')}: {nemXem(innerFee)}</Box>
              <Box sx={{ fontSize: '0.875rem' }}>{t('nemmultisig.wrapper_fee_row')}: {nemXem(NEM_MULTISIG_WRAPPER_FEE)}</Box>
              {ownShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('nemmultisig.xem_short_warning')}</Alert>}
            </Box>
          </>
        )}
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>{t('multisig.go_confirm')}</Button>
      </Box>
    </Box>
  );
}
