import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, TextField } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { WalletsHelper } from '../../lib/storage';
import { fetchBalances } from '../../lib/symbol/api';
import type { MosaicBalance } from '../../lib/symbol/api';
import { fetchAccountPublicKey, fetchMultisigInfo, quoteMultisigCost, submitMultisig } from '../../lib/symbol/multisigApi';
import type { MultisigCost, MultisigInfo } from '../../lib/symbol/multisigApi';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { MAX_MESSAGE_BYTES, messageByteLength, multisigTransferAggregateSize } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { ConfirmScreen, CostBox, DoneScreen, addressPrefix, addressProblem } from './parts';
import type { ConfirmRow } from './parts';

type Step = 'form' | 'confirm' | 'done';

// 「マルチシグから送金」: a transfer in the name of a multisig account this wallet cosigns for.
// With minApproval 1 it is a complete aggregate; otherwise it is bonded and waits for signatures.
export default function MultisigSend() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState((params.get('account') ?? '').toUpperCase());
  const [info, setInfo] = useState<MultisigInfo | null>(null);
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [balances, setBalances] = useState<MosaicBalance[]>([]);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [recipient, setRecipient] = useState('');
  const [mosaicId, setMosaicId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');

  const [cost, setCost] = useState<MultisigCost | null>(null);
  const [resultHash, setResultHash] = useState('');
  const [bondedResult, setBondedResult] = useState(true);

  // The multisig accounts this wallet cosigns for, and the wallet's own XYM (it pays fees / lock).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        const own = await fetchMultisigInfo(wallet.address);
        const own_balances = await fetchBalances(wallet.address).catch(() => null);
        if (cancelled) return;
        setAccounts(own.multisigOf);
        setAccount((cur) => (own.multisigOf.includes(cur) ? cur : (own.multisigOf[0] ?? '')));
        const xym = own_balances?.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        setXymBalance(own_balances ? (xym?.amount ?? 0n) : null);
      } catch (e) {
        console.error('Failed to load multisig accounts', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // Thresholds, public key and holdings of the selected account.
  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setInfo(null);
    setBalances([]);
    Promise.all([fetchMultisigInfo(account), fetchAccountPublicKey(account), fetchBalances(account)])
      .then(([i, key, b]) => {
        if (cancelled) return;
        setInfo(i);
        setAccountKey(key);
        const usable = b.filter((m) => m.amount > 0n && m.transferable);
        setBalances(usable);
        setMosaicId((cur) => (usable.some((m) => m.id === cur) ? cur : (usable[0]?.id ?? '')));
      })
      .catch((e) => console.error('Failed to load account', e));
    return () => { cancelled = true; };
  }, [account, network]);

  const mosaic = balances.find((m) => m.id === mosaicId);
  const amount = mosaic ? parseDecimal(amountText, mosaic.divisibility) : null;
  const recipientProblem = recipient.trim() === '' ? null : addressProblem(recipient);
  const amountError = amountText === '' ? '' : amount === null || amount <= 0n ? 'err_amount' : mosaic && amount > mosaic.amount ? 'err_amount_over' : '';
  const messageTooLong = messageByteLength(message) > MAX_MESSAGE_BYTES;
  const bonded = (info?.minApproval ?? 2) > 1;
  const cosignatureCount = Math.max((info?.minApproval ?? 1) - 1, 1);
  const canContinue = !!info && accountKey !== null && !!mosaic && recipient.trim() !== '' && recipientProblem === null
    && amount !== null && amount > 0n && amountError === '' && !messageTooLong;

  const baseSize = multisigTransferAggregateSize(1, message || undefined);
  useEffect(() => {
    if (!info) return undefined;
    let cancelled = false;
    setCost(null);
    quoteMultisigCost(baseSize, cosignatureCount, bonded)
      .then((c) => { if (!cancelled) setCost(c); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [baseSize, cosignatureCount, bonded, info, network]);
  const balanceShort = cost !== null && xymBalance !== null && xymBalance < cost.totalNeeded;

  const rows = useMemo<ConfirmRow[]>(() => [
    { label: t('multisig.from_account'), value: account, big: true },
    { label: t('multisig.recipient_label'), value: normalizeAddress(recipient), big: true },
    { label: t('multisig.network_label'), value: `Symbol ${netCfg.label}` },
    { label: t('multisig.amount_row'), value: `${amountText} ${mosaic?.symbol ?? ''}`, big: true },
    ...(message ? [{ label: t('multisig.message_row'), value: message }] : []),
    { label: t('multisig.approval_row'), value: `${info?.minApproval ?? ''} / ${info?.cosignatories.length ?? ''}` },
  ], [t, account, recipient, netCfg.label, amountText, mosaic, message, info]);

  const onSend = async (password: string) => {
    const wallet = await WalletsHelper.getActive();
    if (!wallet || accountKey === null || !mosaic || amount === null) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    const sent = await submitMultisig({
      privateKey,
      publicKey: wallet.publicKey,
      inner: { kind: 'transfer', accountPublicKey: accountKey, recipient, mosaics: [{ id: mosaic.id, amount }], message: message || undefined },
      bonded,
      cosignatureCount,
    });
    setResultHash(sent.hash);
    setBondedResult(sent.bonded);
    setStep('done');
  };

  if (step === 'done') return <DoneScreen hash={resultHash} bonded={bondedResult} />;
  if (step === 'confirm') return <ConfirmScreen rows={rows} onBack={() => setStep('form')} onPassword={onSend} />;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('multisig.send_note')}</Alert>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {!loading && accounts.length === 0 && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.no_account')}</Alert>}
        {accounts.length > 0 && (
          <>
            <TextField select label={t('multisig.from_account')} value={account} onChange={(e) => setAccount(e.target.value)} fullWidth sx={{ mb: 2 }}>
              {accounts.map((a) => <MenuItem key={a} value={a} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>{a}</MenuItem>)}
            </TextField>
            {info && accountKey === null && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.err_no_public_key')}</Alert>}
            <TextField
              label={t('multisig.recipient_label')}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              error={recipientProblem !== null}
              helperText={recipientProblem ? t(`multisig.${recipientProblem}`) : t('multisig.address_hint', { prefix: addressPrefix() })}
              fullWidth
              slotProps={{ htmlInput: { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } }}
              sx={{ mb: 2 }}
            />
            <TextField select label={t('multisig.mosaic_label')} value={mosaicId} onChange={(e) => { setMosaicId(e.target.value); setAmountText(''); }} fullWidth sx={{ mb: 2 }}>
              {balances.map((m) => <MenuItem key={m.id} value={m.id}>{m.symbol}</MenuItem>)}
            </TextField>
            <TextField
              label={t('multisig.amount_label')}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              error={amountError !== ''}
              helperText={amountError ? t(`multisig.${amountError}`) : mosaic ? t('multisig.available', { amount: `${formatAtomic(mosaic.amount, mosaic.divisibility)} ${mosaic.symbol}` }) : ''}
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('multisig.message_label')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              error={messageTooLong}
              helperText={messageTooLong ? t('multisig.err_message_long') : `${messageByteLength(message)} / ${MAX_MESSAGE_BYTES}`}
              fullWidth
              multiline
              minRows={2}
            />
            <CostBox cost={cost} hasBalanceShort={balanceShort} />
          </>
        )}
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>
          {t('multisig.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}
