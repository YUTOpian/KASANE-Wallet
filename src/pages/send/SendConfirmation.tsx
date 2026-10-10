import { useEffect, useState } from 'react';
import { Box, Typography, Button, Divider } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppToolBar from '../../components/AppToolBar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { getMosaicInfos, quoteFee, sendTransfer, SymbolSendError } from '../../lib/symbol/api';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { chainMeta } from '../../lib/chain';
import { activeNetworkLabel, currencyDivisibility, currencySymbol, nativeAssetId, prettyChainAddress } from '../../lib/chainApi';
import { sendNemTransfer } from '../../lib/nem/api';
import { nemTransferFee } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

// Maps the node's transaction-status codes (and local failures) to a message key + params.
function classifySendError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance' || code === 'FAILURE_INSUFFICIENT_BALANCE') return { kind: 'insufficient_balance', detail };
  if (code === 'recipient_public_key_missing') return { kind: 'no_public_key', detail };
  if (code === 'Failure_Mosaic_Non_Transferable') return { kind: 'non_transferable', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline' || code.startsWith('FAILURE_TIMESTAMP') || code.startsWith('FAILURE_DEADLINE')) return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network' || code === 'FAILURE_WRONG_NETWORK') return { kind: 'wrong_network', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

export default function SendConfirmation() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const backPath = useAppStore((s) => s.backPathFromSendConfirmation);
  const sendAmount = useAppStore((s) => s.sendAmount);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const sendEncrypt = useAppStore((s) => s.sendEncrypt);
  const sendExtraMosaics = useAppStore((s) => s.sendExtraMosaics);
  const receiverAddress = useAppStore((s) => s.receiverAddress);
  useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const isNem = chain === 'nem';
  // Symbol only: the message goes encrypted for the recipient.
  const encrypt = !isNem && sendEncrypt && !!sendMessage;
  // Symbol: more mosaics sent together with the main one.
  const extras = isNem ? [] : sendExtraMosaics;
  const sendMosaicId = useAppStore((s) => s.sendMosaicId);
  const feeSpeed = useAppStore((s) => s.sendFeeSpeed);
  const setLastTxHash = useAppStore((s) => s.setLastTxHash);

  const CURRENCY_SYMBOL = currencySymbol();
  const CURRENCY_DIVISIBILITY = currencyDivisibility();
  const nativeId = nativeAssetId();
  // NEM sends only XEM for now, whatever the draft says.
  const mosaicId = isNem ? nativeId : (sendMosaicId || nativeId).toUpperCase();
  const [currencyLabel, setCurrencyLabel] = useState(mosaicId === nativeId ? CURRENCY_SYMBOL : mosaicId);
  const [divisibility, setDivisibility] = useState(mosaicId === nativeId ? CURRENCY_DIVISIBILITY : 0);

  const [showSendCaution, setShowSendCaution] = useState(true);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  // 'loading' while the quote is in flight, null once it settles with no result.
  const [estimatedFee, setEstimatedFee] = useState<string | null | 'loading'>('loading');

  // Symbol and divisibility of the extra mosaics (for the summary).
  const [extraInfos, setExtraInfos] = useState<Record<string, { symbol: string; divisibility: number }>>({});
  useEffect(() => {
    if (isNem || sendExtraMosaics.length === 0) return;
    let cancelled = false;
    const ids = sendExtraMosaics.map((l) => l.id.toUpperCase());
    getMosaicInfos(ids)
      .then((infos) => {
        if (cancelled) return;
        setExtraInfos(Object.fromEntries(ids.map((id) => [id, { symbol: infos[id]?.symbol ?? id, divisibility: infos[id]?.divisibility ?? 0 }])));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [isNem, sendExtraMosaics]);

  useEffect(() => {
    if (isNem) return; // XEM: symbol and divisibility are known
    let cancelled = false;
    (async () => {
      const info = (await getMosaicInfos([mosaicId]))[mosaicId];
      if (info && !cancelled) {
        setCurrencyLabel(info.symbol);
        setDivisibility(info.divisibility);
      }
    })();
    return () => { cancelled = true; };
  }, [mosaicId, isNem]);

  useEffect(() => {
    if (isNem) {
      // NEM: the fee is a formula of the amount and the message.
      const amount = parseDecimal(sendAmount, CURRENCY_DIVISIBILITY) ?? 0n;
      setEstimatedFee(formatAtomic(nemTransferFee(amount, sendMessage || undefined), CURRENCY_DIVISIBILITY));
      return;
    }
    let cancelled = false;
    setEstimatedFee('loading');
    quoteFee(1 + extras.length, sendMessage, feeSpeed, encrypt)
      .then((q) => { if (!cancelled) setEstimatedFee(formatAtomic(q.fee, CURRENCY_DIVISIBILITY)); })
      .catch(() => { if (!cancelled) setEstimatedFee(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMessage, feeSpeed, isNem, sendAmount, encrypt, extras.length]);

  const onPassed = async (pin: string) => {
    const amountAtomic = parseDecimal(sendAmount, divisibility);
    if (amountAtomic === null || amountAtomic <= 0n) {
      setErrorMessage(t('send.invalid_amount'));
      return;
    }

    setSending(true);
    try {
      const activeWallet = await WalletsHelper.getActive();
      if (!activeWallet) {
        return;
      }
      // The extra mosaics, each with its own divisibility (looked up now rather than trusting the summary's cache).
      const extraIds = extras.map((l) => l.id.toUpperCase());
      const extraInfosNow = extraIds.length > 0 ? await getMosaicInfos(extraIds) : {};
      const extraMosaics: { id: string; amount: bigint }[] = [];
      for (let i = 0; i < extras.length; i += 1) {
        const atomic = parseDecimal(extras[i].amount, extraInfosNow[extraIds[i]]?.divisibility ?? 0);
        if (atomic === null || atomic <= 0n) {
          setErrorMessage(t('send.invalid_amount'));
          return;
        }
        extraMosaics.push({ id: extraIds[i], amount: atomic });
      }
      const privateKey = await WalletsHelper.decryptKey(activeWallet.id, pin);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const { hash } = isNem
        ? await sendNemTransfer({
            privateKey,
            publicKey: activeWallet.publicKey,
            recipient: receiverAddress,
            amount: amountAtomic,
            message: sendMessage || undefined,
          })
        : await sendTransfer({
            privateKey,
            publicKey: activeWallet.publicKey,
            recipient: receiverAddress,
            mosaics: [{ id: mosaicId, amount: amountAtomic }, ...extraMosaics],
            message: sendMessage,
            encrypt,
            feeSpeed,
          });
      setLastTxHash(hash);
      navigate('/send/complete');
    } catch (error) {
      setSendError(classifySendError(error));
    } finally {
      setSending(false);
    }
  };

  const sendErrorTitle = sendError ? t(`send.error_${sendError.kind}_title`) : '';
  const sendErrorTexts = sendError
    ? (t(`send.error_${sendError.kind}_message`, { returnObjects: true, symbol: currencyLabel, detail: sendError.detail }) as string[])
    : [];

  // One row of the summary card: small teal label, comfortable value underneath.
  const amountLines = [
    `${sendAmount} ${currencyLabel}`,
    ...extras.map((l) => `${l.amount} ${extraInfos[l.id.toUpperCase()]?.symbol ?? l.id}`),
  ];
  const rows: { label: string; value: string; big?: boolean; breakAll?: boolean; multiline?: boolean }[] = [
    { label: t('common.amount'), value: amountLines.join('\n'), big: extras.length === 0, breakAll: true, multiline: extras.length > 0 },
    { label: t('send.network'), value: `${chainMeta(chain).name} ${activeNetworkLabel()}` },
    { label: t('common.destination'), value: prettyChainAddress(receiverAddress), breakAll: true },
    ...(sendMessage ? [{ label: encrypt ? `${t('common.message')}（${t('send.encrypted_tag')}）` : t('common.message'), value: sendMessage, breakAll: true }] : []),
    {
      label: isNem ? t('send.fee_label') : `${t('send.fee_label')}（${t(`send.fee_speed_${feeSpeed}`)}）`,
      value: estimatedFee === 'loading'
        ? t('send.fee_estimating')
        : estimatedFee != null
          ? `${estimatedFee} ${CURRENCY_SYMBOL}`
          : t('send.fee_estimate_unavailable'),
      breakAll: true,
    },
  ];

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppToolBar back={backPath || '/top'} title={t('send.confirmation_title')} />
      {/* Summary: one roomy card (generous padding, a divider between rows) centred in a
          comfortable reading width instead of bare text hugging the screen edge. */}
      <Box sx={{ flexGrow: 1, width: '100%', maxWidth: 560, mx: 'auto', px: 3, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
        <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
          {rows.map((row, i) => (
            <Box key={row.label}>
              {i > 0 && <Divider />}
              <Box sx={{ py: 2.5 }}>
                <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.75 }}>{row.label}</Typography>
                <Typography sx={{ fontSize: row.big ? '1.6rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: row.breakAll ? 'break-all' : 'normal', whiteSpace: row.multiline ? 'pre-line' : 'normal' }}>
                  {row.value}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <MessageDialog
        open={showSendCaution}
        title={t('send.confirmation_title')}
        texts={t('send.confirmation_dialog_message', { returnObjects: true }) as string[]}
        onClose={() => setShowSendCaution(false)}
      />

      {/* Action area: full width, with the call to action as a proper large button. */}
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
        <Box sx={{ maxWidth: 560, mx: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
          <Typography>{sending ? t('send.sending') : t('send.confirmation_ready')}</Typography>
          <Button
            variant="contained"
            color="primary"
            size="large"
            fullWidth
            disabled={sending}
            onClick={() => setShowPinDialog(true)}
            startIcon={<LockOutlinedIcon />}
            sx={{ py: 1.5 }}
          >
            {t('send.confirmation_password')}
          </Button>
        </Box>
      </Box>

      <PasswordDialog open={showPinDialog} mode="check" onClose={() => setShowPinDialog(false)} onPass={onPassed} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog
        open={sendError != null}
        title={sendErrorTitle}
        texts={sendErrorTexts}
        onClose={() => setSendError(null)}
      />
    </Box>
  );
}
