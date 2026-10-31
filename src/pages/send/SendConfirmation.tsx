import { useEffect, useState } from 'react';
import { Alert, Box, Typography, Button, Divider } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppToolBar from '../../components/AppToolBar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { SssError, sssErrorKey } from '../../lib/sss';
import { LedgerError } from '../../lib/ledger/framing';
import { ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink } from '../../lib/ledger/session';
import type { Wallet } from '../../lib/storage';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import QrTextDialog from '../../components/QrTextDialog';
import SaveContactDialog from '../../components/SaveContactDialog';
import { useTrust } from '../../hooks/useAddressBook';
import { useAddressBookStore } from '../../store/addressBookStore';
import { displayName, entryKey } from '../../lib/addressBook';
import { checkSignerTrust } from '../../lib/signerTrust';
import { parseWatchAddress } from '../../lib/watchAddress';
import { WalletsHelper } from '../../lib/storage';
import { getMosaicInfos, quoteFee, sendTransfer, signTransferForExport, SymbolSendError } from '../../lib/symbol/api';
import { buildKasaneQr } from '../../lib/symbol/kasaneQr';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { chainMeta } from '../../lib/chain';
import { activeNetworkByte, activeNetworkLabel, currencyDivisibility, currencySymbol, nativeAssetId, prettyChainAddress } from '../../lib/chainApi';
import { fetchNemMosaicInfos, sendNemTransfer } from '../../lib/nem/api';
import type { NemMosaicInfo } from '../../lib/nem/api';
import { nemSendFee } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import QrCode2OutlinedIcon from '@mui/icons-material/QrCode2Outlined';

// Maps the node's transaction-status codes (and local failures) to a message key + params.
function classifySendError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance' || code === 'FAILURE_INSUFFICIENT_BALANCE') return { kind: 'insufficient_balance', detail };
  if (code === 'recipient_public_key_missing') return { kind: 'no_public_key', detail };
  if (code === 'Failure_Mosaic_Non_Transferable' || code === 'FAILURE_MOSAIC_NOT_TRANSFERABLE') return { kind: 'non_transferable', detail };
  // NIS1: any "... INSUFFICIENT_BALANCE" (XEM or a mosaic) means the account does not hold enough.
  if (code.includes('INSUFFICIENT_BALANCE')) return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline' || code.startsWith('FAILURE_TIMESTAMP') || code.startsWith('FAILURE_DEADLINE')) return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network' || code === 'FAILURE_WRONG_NETWORK') return { kind: 'wrong_network', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

/** 送金できた相手を「保存しますか」と聞くべきか：アドレス帳にも自分のアカウントにも無く、「今後聞かない」にもしていない。 */
async function shouldOfferToSave(address: string): Promise<boolean> {
  try {
    const parsed = parseWatchAddress(address);
    if (!parsed) return false;
    if ((await checkSignerTrust(address)) !== 'unknown') return false;
    return !useAddressBookStore.getState().dismissed.includes(entryKey(parsed.chain, parsed.network, parsed.address));
  } catch (e) {
    console.warn('Failed to check the address book', e);
    return false;
  }
}

export default function SendConfirmation() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const sendAmount = useAppStore((s) => s.sendAmount);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const sendEncrypt = useAppStore((s) => s.sendEncrypt);
  const sendExtraMosaics = useAppStore((s) => s.sendExtraMosaics);
  const receiverAddress = useAppStore((s) => s.receiverAddress);
  useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const isNem = chain === 'nem';
  // The message goes encrypted for the recipient (Symbol and NEM).
  const encrypt = sendEncrypt && !!sendMessage;
  // More mosaics sent together with the main one (Symbol and NEM).
  const extras = sendExtraMosaics;
  const sendMosaicId = useAppStore((s) => s.sendMosaicId);
  const feeSpeed = useAppStore((s) => s.sendFeeSpeed ?? s.defaultFeeSpeed);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);

  const CURRENCY_SYMBOL = currencySymbol();
  const CURRENCY_DIVISIBILITY = currencyDivisibility();
  const nativeId = nativeAssetId();
  // Symbol ids are upper-case hex; NEM ids are lower-case "namespace:name".
  const mosaicId = isNem ? (sendMosaicId || nativeId).toLowerCase() : (sendMosaicId || nativeId).toUpperCase();
  const [currencyLabel, setCurrencyLabel] = useState(mosaicId === nativeId ? CURRENCY_SYMBOL : mosaicId);
  const [divisibility, setDivisibility] = useState(mosaicId === nativeId ? CURRENCY_DIVISIBILITY : 0);

  const [showSendCaution, setShowSendCaution] = useState(true);
  const [showPinDialog, setShowPinDialog] = useState(false);
  // Ledger のアカウントなら、パスワードの代わりにデバイスで署名する。
  const [ledgerWallet, setLedgerWallet] = useState<Wallet | null>(null);
  // SSS Extension のアカウントなら、パスワードの代わりに拡張で署名する。
  const [sssWallet, setSssWallet] = useState<Wallet | null>(null);
  useEffect(() => {
    let cancelled = false;
    WalletsHelper.getActive().then((w) => {
      if (cancelled) return;
      setLedgerWallet(w?.ledger ? w : null);
      setSssWallet(w?.sss ? w : null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [chain]);
  // Symbol: sign and show the signed transaction as a QR code instead of sending it.
  const [exportMode, setExportMode] = useState(false);
  const [exported, setExported] = useState<{ text: string; deadlineMs: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  // 'loading' while the quote is in flight, null once it settles with no result.
  const [estimatedFee, setEstimatedFee] = useState<string | null | 'loading'>('loading');

  // アドレス帳：送り先が連絡先なら名前も見せ、ブラックリストの相手なら警告する。
  const { trust: destTrust, entry: destContact } = useTrust(receiverAddress);
  // 送金できたあと、アドレス帳に無い相手なら「保存しますか」を出す。出している間は Home に戻らない。
  const [savePromptAddress, setSavePromptAddress] = useState<string | null>(null);

  // Symbol and divisibility of the extra mosaics (for the summary).
  const [extraInfos, setExtraInfos] = useState<Record<string, { symbol: string; divisibility: number }>>({});
  // NEM: definitions (divisibility, supply) of every mosaic of the transfer; null while they are read.
  const [nemInfos, setNemInfos] = useState<Record<string, NemMosaicInfo> | null>(null);
  const nemIdsKey = isNem ? [mosaicId, ...extras.map((l) => l.id.toLowerCase())].join(',') : '';
  useEffect(() => {
    if (!isNem) return;
    let cancelled = false;
    setNemInfos(null);
    const ids = nemIdsKey.split(',');
    fetchNemMosaicInfos(ids)
      .then((infos) => {
        if (cancelled) return;
        setNemInfos(infos);
        const main = infos[ids[0]];
        if (main) {
          setCurrencyLabel(ids[0] === nativeId ? CURRENCY_SYMBOL : ids[0]);
          setDivisibility(main.divisibility);
        }
        setExtraInfos(Object.fromEntries(ids.slice(1).map((id) => [id.toUpperCase(), { symbol: id, divisibility: infos[id]?.divisibility ?? 0 }])));
      })
      .catch(() => { if (!cancelled) setNemInfos({}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNem, nemIdsKey]);

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
      // NEM: the fee is a formula of the amounts (a mosaic by its supply and divisibility) and the message.
      if (nemInfos === null) { setEstimatedFee('loading'); return; }
      try {
        const atLeastOne = (n: bigint | null) => (n !== null ? n : 1n);
        const lines = [
          { id: mosaicId, quantity: atLeastOne(parseDecimal(sendAmount, nemInfos[mosaicId]?.divisibility ?? 0)) },
          ...extras.map((l) => ({ id: l.id.toLowerCase(), quantity: atLeastOne(parseDecimal(l.amount, nemInfos[l.id.toLowerCase()]?.divisibility ?? 0)) })),
        ];
        const feeInfos = Object.fromEntries(Object.values(nemInfos).map((i) => [i.id, { supply: i.supply, divisibility: i.divisibility }]));
        setEstimatedFee(formatAtomic(nemSendFee(activeNetworkByte(), lines, feeInfos, sendMessage || undefined, encrypt), CURRENCY_DIVISIBILITY));
      } catch {
        setEstimatedFee(null);
      }
      return;
    }
    let cancelled = false;
    setEstimatedFee('loading');
    quoteFee(1 + extras.length, sendMessage, feeSpeed, encrypt)
      .then((q) => { if (!cancelled) setEstimatedFee(formatAtomic(q.fee, CURRENCY_DIVISIBILITY)); })
      .catch(() => { if (!cancelled) setEstimatedFee(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMessage, feeSpeed, isNem, sendAmount, encrypt, extras.length, nemInfos, mosaicId]);

  // 送金のあとの片付けと Home への移動。
  const finishSend = () => {
    clearReceiverAddress();
    clearSendDraft();
    useAppStore.getState().setHomePanel('history');
    navigate('/top', { replace: true });
  };

  const onPassed = async (pin: string, exportNow: boolean = exportMode) => {
    // NEM: read each mosaic's definition now (never trust a divisibility that was not read from the chain).
    const nemNow = isNem ? await fetchNemMosaicInfos([mosaicId, ...extras.map((l) => l.id.toLowerCase())]) : {};
    const mainDivisibility = isNem ? nemNow[mosaicId]?.divisibility : divisibility;
    if (mainDivisibility === undefined) {
      setErrorMessage(t('send.nem_mosaic_unreadable'));
      return;
    }
    const amountAtomic = parseDecimal(sendAmount, mainDivisibility);
    if (amountAtomic === null) {
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
      const extraIds = extras.map((l) => (isNem ? l.id.toLowerCase() : l.id.toUpperCase()));
      const extraInfosNow: Record<string, { divisibility: number } | undefined> = isNem ? nemNow : extraIds.length > 0 ? await getMosaicInfos(extraIds) : {};
      if (isNem && [mosaicId, ...extraIds].some((id) => nemNow[id] === undefined)) {
        setErrorMessage(t('send.nem_mosaic_unreadable'));
        return;
      }
      const extraMosaics: { id: string; amount: bigint }[] = [];
      for (let i = 0; i < extras.length; i += 1) {
        const atomic = parseDecimal(extras[i].amount, extraInfosNow[extraIds[i]]?.divisibility ?? 0);
        if (atomic === null) {
          setErrorMessage(t('send.invalid_amount'));
          return;
        }
        extraMosaics.push({ id: extraIds[i], amount: atomic });
      }
      // Ledger：鍵はデバイスの中。ここでは持たず、署名のときにデバイスへ頼む。
      const ledgerIndex = activeWallet.ledger && activeWallet.accountIndex !== null ? activeWallet.accountIndex : undefined;
      if (activeWallet.ledger && ledgerIndex === undefined) {
        setErrorMessage(t('ledger.error_unknown'));
        return;
      }
      // SSS Extension：鍵は拡張の中。ここでは持たず、署名のときに拡張へ頼む。
      const viaSss = activeWallet.sss;
      const privateKey = ledgerIndex !== undefined || viaSss ? '' : await WalletsHelper.decryptKey(activeWallet.id, pin);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      if (isNem) {
        await sendNemTransfer({
          privateKey,
          ledgerIndex,
          publicKey: activeWallet.publicKey,
          recipient: receiverAddress,
          amount: amountAtomic,
          mosaics: [{ id: mosaicId, quantity: amountAtomic }, ...extraMosaics.map((m) => ({ id: m.id, quantity: m.amount }))],
          message: sendMessage || undefined,
          encrypt,
        });
      } else if (exportNow) {
        // Signed here, announced by whoever scans the QR code: nothing is sent and the draft stays as it is.
        const signed = await signTransferForExport({
          privateKey,
          ledgerIndex,
          sss: viaSss,
          publicKey: activeWallet.publicKey,
          recipient: receiverAddress,
          mosaics: [{ id: mosaicId, amount: amountAtomic }, ...extraMosaics],
          message: sendMessage,
          encrypt,
          feeSpeed,
        });
        setExported({ text: buildKasaneQr({ kind: 'signed', payload: signed.payload, hash: signed.hash }), deadlineMs: signed.deadlineMs });
        return;
      } else {
        await sendTransfer({
          privateKey,
          ledgerIndex,
          sss: viaSss,
          publicKey: activeWallet.publicKey,
          recipient: receiverAddress,
          mosaics: [{ id: mosaicId, amount: amountAtomic }, ...extraMosaics],
          message: sendMessage,
          encrypt,
          feeSpeed,
        });
      }
      // Sent. There is no separate "complete" screen: forget the recipient and amount so the next
      // send starts empty, and go back to Home, where the history section shows the new transfer.
      // その前に、アドレス帳に無い相手なら「保存しますか」を聞く（聞いている間は、この画面のまま）。
      if (await shouldOfferToSave(receiverAddress)) {
        setSavePromptAddress(receiverAddress);
        return;
      }
      finishSend();
    } catch (error) {
      if (error instanceof LedgerError) {
        // Ledger 側の理由（拒否・ロック中・アプリが開いていない・切断など）は、短いメッセージで知らせる。
        if (error.kind !== 'no_device') setErrorMessage(t(ledgerErrorKey(error), { chain: isNem ? 'NEM' : 'Symbol' }));
      } else if (error instanceof SssError) {
        // SSS Extension 側の理由（拒否・アカウント違い・ネットワーク違いなど）は、短いメッセージで知らせる。
        setErrorMessage(t(sssErrorKey(error)));
      } else {
        setSendError(classifySendError(error));
      }
    } finally {
      setSending(false);
    }
  };

  // Ledger：デバイスの選択はボタンを押した直後にしかできないので、ここ（押した直後）で接続してから署名に進む。
  const startLedger = async (exportFlag: boolean) => {
    setExportMode(exportFlag);
    const link = preferredLedgerLink();
    if (link === null) {
      setErrorMessage(t('ledger.error_unsupported_browser'));
      return;
    }
    try {
      await ensureLedgerConnected(link);
    } catch (e) {
      if (!(e instanceof LedgerError && e.kind === 'no_device')) setErrorMessage(t(ledgerErrorKey(e), { chain: isNem ? 'NEM' : 'Symbol' }));
      return;
    }
    await onPassed('', exportFlag);
  };
  // 暗号化メッセージは送り手の秘密鍵が要るので、Ledger では送れない（黙って平文にはしない）。
  const ledgerEncryptBlocked = ledgerWallet !== null && encrypt;
  const sssEncryptBlocked = sssWallet !== null && encrypt;
  const encryptBlocked = ledgerEncryptBlocked || sssEncryptBlocked;

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
    {
      label: t('common.destination'),
      value: destContact ? `${displayName(destContact)}\n${prettyChainAddress(receiverAddress)}` : prettyChainAddress(receiverAddress),
      breakAll: true,
      multiline: destContact !== null,
    },
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
      <AppToolBar back="/top" title={t('send.confirmation_title')} />
      {/* Summary: one roomy card (generous padding, a divider between rows) centred in a
          comfortable reading width instead of bare text hugging the screen edge. */}
      <Box sx={{ flexGrow: 1, width: '100%', maxWidth: 560, mx: 'auto', px: 3, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
        {destTrust === 'black' && (
          <Alert severity="error" sx={{ mb: 2 }}>{t('addressbook.recipient_blacklisted', { name: destContact ? displayName(destContact) : '' })}</Alert>
        )}
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
          {encryptBlocked && <Alert severity="warning" sx={{ width: '100%' }}>{t(sssEncryptBlocked ? 'sss.no_encrypt' : 'ledger.no_encrypt')}</Alert>}
          <Typography>{sending ? (ledgerWallet ? t('ledger.confirm_on_device') : sssWallet ? t('sss.confirm_in_extension') : t('send.sending')) : t('send.confirmation_ready')}</Typography>
          <Button
            variant="contained"
            color="primary"
            size="large"
            fullWidth
            disabled={sending || encryptBlocked}
            onClick={() => { if (ledgerWallet) { void startLedger(false); } else if (sssWallet) { setExportMode(false); void onPassed('', false); } else { setExportMode(false); setShowPinDialog(true); } }}
            startIcon={ledgerWallet ? <UsbOutlinedIcon /> : sssWallet ? <ExtensionOutlinedIcon /> : <LockOutlinedIcon />}
            sx={{ py: 1.5 }}
          >
            {ledgerWallet ? t('ledger.sign_button') : sssWallet ? t('sss.sign_button') : t('send.confirmation_password')}
          </Button>
          {/* Symbol only: sign now, let someone else (another device) announce it. */}
          {!isNem && (
            <Button
              variant="outlined"
              color="primary"
              fullWidth
              disabled={sending || encryptBlocked}
              onClick={() => { if (ledgerWallet) { void startLedger(true); } else if (sssWallet) { setExportMode(true); void onPassed('', true); } else { setExportMode(true); setShowPinDialog(true); } }}
              startIcon={<QrCode2OutlinedIcon />}
            >
              {t('signqr.export_button')}
            </Button>
          )}
        </Box>
      </Box>

      <PasswordDialog open={showPinDialog} mode="check" popup onClose={() => setShowPinDialog(false)} onPass={onPassed} />
      <QrTextDialog
        open={exported !== null}
        title={t('signqr.export_title')}
        hint={t('signqr.export_hint')}
        text={exported?.text ?? ''}
        note={exported ? t('signqr.export_note', { time: new Date(exported.deadlineMs).toLocaleString() }) : undefined}
        onClose={() => setExported(null)}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <SaveContactDialog
        open={savePromptAddress !== null}
        address={savePromptAddress ?? ''}
        onClose={() => { setSavePromptAddress(null); finishSend(); }}
      />
      <MessageDialog
        open={sendError != null}
        title={sendErrorTitle}
        texts={sendErrorTexts}
        onClose={() => setSendError(null)}
      />
    </Box>
  );
}
