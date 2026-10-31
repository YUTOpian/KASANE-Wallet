import { useEffect, useRef, useState } from 'react';
import { Alert, AppBar, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton, InputAdornment, MenuItem, Select, Switch, TextField, Toolbar, Typography } from '@mui/material';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import LinkIcon from '@mui/icons-material/Link';
import ContactsOutlinedIcon from '@mui/icons-material/ContactsOutlined';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { useTrust } from '../../hooks/useAddressBook';
import { displayName } from '../../lib/addressBook';
import QrImageButton from '../../components/QrImageButton';
import Scan from './Scan';
import RecipientInfoCard from './RecipientInfoCard';
import TransactionUriCard from './TransactionUriCard';
import { applyScannedText, networkOfAddress, scanFailureMessage } from '../../lib/applyScanned';
import NetworkMismatchDialog from '../../components/NetworkMismatchDialog';
import type { SymbolNetwork } from '../../lib/symbol/constants';
import { WalletsHelper } from '../../lib/storage';
import { isSelectedAsset, loadSendAssets } from '../../lib/sendAssets';
import type { AssetOption } from '../../lib/sendAssets';
import { FEE_SPEEDS, fetchRecipientInfo, fetchTransfersWith, quoteFees, resolveRecipientInput } from '../../lib/symbol/api';
import { fetchNemRecipientInfo, fetchNemTransfersWith } from '../../lib/nem/recipient';
import type { FeeSpeed, RecipientInfo, RecipientResolution, SymbolTransfer } from '../../lib/symbol/api';
import { classifyRecipientInput } from '../../lib/symbol/recipientInput';
import type { RecipientInput } from '../../lib/symbol/recipientInput';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { MAX_ENCRYPTED_MESSAGE_BYTES, MAX_MESSAGE_BYTES, messageByteLength } from '../../lib/symbol/tx';
import { nemSendFee } from '../../lib/nem/tx';
import type { NemMosaicAmount, NemMosaicFeeInfo } from '../../lib/nem/tx';
import { chainMeta } from '../../lib/chain';
import { NEM_MAX_MESSAGE_BYTES } from '../../lib/nem/constants';
import { NEM_MAX_ENCRYPTED_MESSAGE_BYTES } from '../../lib/nem/message';
import { activeNetworkByte, activeNetworkLabel, currencyDivisibility, currencySymbol, isValidChainAddress, nativeAssetId, normalizeChainAddress, prettyChainAddress } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';

// Keep only what a decimal amount can contain: digits and a single '.', limited to `decimals`
// places. A comma (some keyboards) is accepted as the decimal point.
function sanitizeAmount(raw: string, decimals: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = s.split('.');
  if (frac !== undefined) s = `${whole}.${frac.slice(0, decimals)}`;
  return s;
}

// Most mosaics one transfer can carry from this form (the screen gets long, and so does the transaction).
const MAX_MOSAICS_PER_SEND = 10;

interface AssetSelectProps {
  selected: AssetOption | null;
  fallbackSymbol: string;
  options: AssetOption[];
  loading: boolean;
  disabled: boolean;
  onChange: (id: string) => void;
}

// The mosaic picker: the chosen mosaic with its balance, and the list of mosaics to choose from.
function AssetSelect({ selected, fallbackSymbol, options, loading, disabled, onChange }: AssetSelectProps) {
  const { t } = useTranslation();
  const symbol = selected?.symbol ?? fallbackSymbol;
  const available = selected?.balance ?? '0';
  return (
    <Select
      value={selected?.id ?? ''}
      displayEmpty
      fullWidth
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as string)}
      renderValue={() => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap sx={{ fontWeight: 'bold' }}>{symbol}</Typography>
            <Typography noWrap sx={{ color: 'text.secondary', fontSize: 13 }}>
              {t('send.available_balance')}: {loading ? t('common.loading') : `${available} ${symbol}`}
            </Typography>
          </Box>
        </Box>
      )}
      sx={{ bgcolor: 'background.paper', borderRadius: 3, '& .MuiSelect-select': { py: 1.25 } }}
    >
      {options.map((option) => (
        <MenuItem key={option.id} value={option.id} sx={{ gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap sx={{ fontWeight: 'bold' }}>{option.symbol}</Typography>
            <Typography noWrap sx={{ color: 'text.secondary', fontSize: 12 }}>
              {Number(option.balance).toLocaleString(undefined, { maximumFractionDigits: option.divisibility })} {option.symbol}
            </Typography>
            {option.symbol !== option.id && (
              <Typography noWrap sx={{ color: 'text.disabled', fontSize: 10 }}>ID: {option.id}</Typography>
            )}
          </Box>
        </MenuItem>
      ))}
    </Select>
  );
}

// 「送る」: Home の送信リボンを押すと下に展開される入力画面。送るモザイクの選択、送信先アドレス、
// 金額、任意のメッセージ、手数料の表示までをこの1画面で行う。進むと /send/confirmation へ。
export default function SendForm() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const isNem = chain === 'nem';
  // Symbol: XYM / 6 decimals / 1023-byte messages; NEM: XEM / 6 decimals / 1024-byte messages.
  const CURRENCY_SYMBOL = currencySymbol();
  const CURRENCY_DIVISIBILITY = currencyDivisibility();

  const receiverAddress = useAppStore((s) => s.receiverAddress);
  const setReceiverAddress = useAppStore((s) => s.setReceiverAddress);
  const sendAmount = useAppStore((s) => s.sendAmount);
  const setSendAmount = useAppStore((s) => s.setSendAmount);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const setSendMessage = useAppStore((s) => s.setSendMessage);
  const sendEncrypt = useAppStore((s) => s.sendEncrypt);
  const sendExtraMosaics = useAppStore((s) => s.sendExtraMosaics);
  const setSendExtraMosaics = useAppStore((s) => s.setSendExtraMosaics);
  const setSendEncrypt = useAppStore((s) => s.setSendEncrypt);
  const sendMosaicId = useAppStore((s) => s.sendMosaicId);
  const setSendMosaicId = useAppStore((s) => s.setSendMosaicId);
  const feeSpeed = useAppStore((s) => s.sendFeeSpeed ?? s.defaultFeeSpeed);
  const setFeeSpeed = useAppStore((s) => s.setSendFeeSpeed);

  // Seeded from the store so coming back from the confirmation screen, the address book or a
  // scanned QR shows what was entered before.
  const [address, setAddress] = useState(receiverAddress);
  const [amountText, setAmountText] = useState(sendAmount);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [scanOpen, setScanOpen] = useState(false);
  // 「URIから読み込む」: a pasted address / payment URI / transaction URI.
  const [uriOpen, setUriOpen] = useState(false);
  const [uriText, setUriText] = useState('');
  const [uriError, setUriError] = useState('');
  const [uriBusy, setUriBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // 警告モーダル: a scanned code / typed address that belongs to the other network.
  const [mismatch, setMismatch] = useState<{ other: SymbolNetwork | null } | null>(null);
  const mismatchShownFor = useRef('');
  // Fee in XYM at each speed: 'loading' while quoted, null when it could not be worked out.
  const [fees, setFees] = useState<Record<FeeSpeed, string> | null | 'loading'>('loading');
  const fee = fees === 'loading' || fees === null ? fees : fees[feeSpeed];
  // What the chain knows about the typed recipient: 'loading' while fetched, null when it could not be read.
  const [recipient, setRecipient] = useState<RecipientInfo | null | 'loading'>(null);
  // Past transfers between this wallet and the typed address: 'loading' while fetched, null when it could not be read.
  const [history, setHistory] = useState<SymbolTransfer[] | null | 'loading'>(null);
  // Set when the typed address belongs to one of this device's own wallets (the active one or another account).
  const [ownMatch, setOwnMatch] = useState<{ active: boolean; name: string } | null>(null);

  // Holdings of the active wallet (balance of the chosen mosaic, divisibility).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAssets(true);
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const list = await loadSendAssets(wallet.address);
        if (!cancelled) setAssets(list);
      } catch (e) {
        console.error('Failed to load balances', e);
      } finally {
        if (!cancelled) setLoadingAssets(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  const selected = assets.find((o) => isSelectedAsset(o, sendMosaicId)) ?? null;
  const isNative = selected ? selected.id === nativeAssetId() : (sendMosaicId === '' || sendMosaicId === nativeAssetId());
  const symbol = selected?.symbol ?? (isNative ? CURRENCY_SYMBOL : sendMosaicId);
  const decimals = selected?.divisibility ?? (isNative ? CURRENCY_DIVISIBILITY : 0);
  const availableAtomic = selected?.amount ?? 0n;
  const xymAtomic = assets[0]?.amount ?? 0n;

  // Further mosaics sent together with the main one (Symbol and NEM). Each line has its own balance and divisibility.
  const extras = sendExtraMosaics;
  const extraLines = extras.map((line) => {
    const asset = assets.find((o) => o.id.toUpperCase() === line.id.toUpperCase()) ?? null;
    const lineDecimals = asset?.divisibility ?? 0;
    const atomic = parseDecimal(line.amount, lineDecimals);
    const lineAvailable = asset?.amount ?? 0n;
    return { line, asset, decimals: lineDecimals, symbol: asset?.symbol ?? line.id, atomic, over: atomic !== null && atomic > lineAvailable };
  });
  const extrasOk = extraLines.every((l) => l.asset !== null && l.atomic !== null && !l.over);
  const mainId = (selected?.id ?? (sendMosaicId || nativeAssetId())).toUpperCase();
  const usedIds = new Set([mainId, ...extras.map((l) => l.id.toUpperCase())]);
  const unusedHeld = assets.filter((o) => o.amount > 0n && !usedIds.has(o.id.toUpperCase()));
  const canAddMosaic = !loadingAssets && unusedHeld.length > 0 && extras.length + 1 < MAX_MOSAICS_PER_SEND;
  const addExtra = () => {
    const next = unusedHeld[0];
    if (next) setSendExtraMosaics([...extras, { id: isNem ? next.id : next.id.toUpperCase(), amount: '' }]);
  };
  const updateExtra = (index: number, patch: { id?: string; amount?: string }) => {
    setSendExtraMosaics(extras.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };
  const removeExtra = (index: number) => setSendExtraMosaics(extras.filter((_, i) => i !== index));

  // Symbol: the field also takes a namespace alias ("nem.group") or a 64-hex public key. Those are looked
  // up and turned into the address they stand for, which is shown under the field and is what gets sent.
  const typedAddress = normalizeChainAddress(address);
  const typedAddressValid = isValidChainAddress(typedAddress, activeNetworkByte());
  const recipientInput: RecipientInput = !isNem && !typedAddressValid ? classifyRecipientInput(address) : { kind: 'other' };
  const lookupKey = recipientInput.kind === 'alias' ? `a:${recipientInput.name}` : recipientInput.kind === 'publicKey' ? `k:${recipientInput.publicKey}` : '';
  // 'loading' while looked up; the lookup it belongs to is kept so a stale answer is never used for other text.
  const [resolution, setResolution] = useState<{ key: string; result: RecipientResolution | 'loading' | 'failed' } | null>(null);
  const resolved = lookupKey !== '' && resolution?.key === lookupKey ? resolution.result : null;
  const resolvedAddress = resolved !== null && resolved !== 'loading' && resolved !== 'failed' && resolved.ok ? resolved.address : '';

  const normalizedAddress = typedAddressValid ? typedAddress : resolvedAddress;
  const addressValid = normalizedAddress !== '' && isValidChainAddress(normalizedAddress, activeNetworkByte());
  // アドレス帳での扱い：連絡先なら名前を出し、ブラックリストの相手なら送る前に警告する。
  const { trust: recipientTrust, entry: recipientContact } = useTrust(addressValid ? normalizedAddress : '');
  const lookupPending = lookupKey !== '' && (resolved === null || resolved === 'loading');
  let addressError = '';
  if (lookupKey !== '' && resolved !== null && resolved !== 'loading') {
    // The alias / key was understood but could not be used.
    addressError = resolved === 'failed' ? t('send.alias_lookup_failed') : resolved.ok ? '' : t(`send.alias_${resolved.reason}`);
  } else if (lookupKey === '' && address.trim().length > 0 && !addressValid) {
    addressError = t(isValidChainAddress(typedAddress) ? 'send.wrong_network_address' : 'common.invalid_address', { chain: chainMeta().name, network: activeNetworkLabel() });
  }
  // A complete address of the other network: tell the person in a modal (once per address), not just under the field.
  const typedWrongNetwork = lookupKey === '' && !addressValid && address.trim().length > 0 && isValidChainAddress(typedAddress);
  useEffect(() => {
    if (!typedWrongNetwork) { mismatchShownFor.current = ''; return; }
    if (mismatchShownFor.current === typedAddress) return;
    mismatchShownFor.current = typedAddress;
    setMismatch({ other: networkOfAddress(typedAddress) });
  }, [typedWrongNetwork, typedAddress]);
  const resolvedNote = resolved !== null && resolved !== 'loading' && resolved !== 'failed' && resolved.ok
    ? t(resolved.via === 'alias' ? 'send.alias_resolved' : 'send.publickey_resolved', { address: prettyChainAddress(resolved.address) })
    : lookupPending ? t('send.alias_resolving') : '';

  useEffect(() => {
    if (lookupKey === '') {
      setResolution(null);
      return;
    }
    let cancelled = false;
    setResolution({ key: lookupKey, result: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const result = await resolveRecipientInput(recipientInput, activeNetworkByte());
        if (!cancelled) setResolution({ key: lookupKey, result });
      } catch (e) {
        console.error('Failed to resolve recipient', e);
        if (!cancelled) setResolution({ key: lookupKey, result: 'failed' });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, network]);

  // Is the typed address one of my own wallets? Checked against every wallet on this device, so sending to
  // another account of the same profile is flagged as well as sending to the active wallet itself.
  useEffect(() => {
    if (!addressValid) {
      setOwnMatch(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [active, all] = await Promise.all([WalletsHelper.getActive(), WalletsHelper.gets()]);
        const hit = all.find((w) => w.chain === chain && normalizeChainAddress(w.address) === normalizedAddress);
        if (cancelled) return;
        if (!hit) { setOwnMatch(null); return; }
        const name = hit.accountName || (hit.accountIndex !== null ? t('wallet.account_index', { index: hit.accountIndex }) : hit.name);
        setOwnMatch({ active: active?.id === hit.id, name });
      } catch (e) {
        console.error('Failed to check own wallets', e);
        if (!cancelled) setOwnMatch(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressValid, normalizedAddress, network]);

  // Recipient info: looked up (debounced) as soon as the typed address is a valid one for this network.
  // (NEM reads the same facts from NIS1: balance, mosaics, namespaces, latest transfers.)
  useEffect(() => {
    if (!addressValid) {
      setRecipient(null);
      return;
    }
    let cancelled = false;
    setRecipient('loading');
    const timer = setTimeout(async () => {
      try {
        const info = isNem ? await fetchNemRecipientInfo(normalizedAddress) : await fetchRecipientInfo(normalizedAddress);
        if (!cancelled) setRecipient(info);
      } catch (e) {
        console.error('Failed to load recipient info', e);
        if (!cancelled) setRecipient(null);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [addressValid, normalizedAddress, network]);

  // Past dealings with the typed address ("have I seen / sent to this address before?"). Runs once the
  // recipient lookup has settled so the counterparty's public key (needed to find what it sent us) is known.
  const recipientKey = recipient !== null && recipient !== 'loading' ? recipient.publicKey : null;
  const recipientSettled = recipient !== 'loading';
  useEffect(() => {
    if (!addressValid) {
      setHistory(null);
      return;
    }
    if (!recipientSettled) return;
    let cancelled = false;
    setHistory('loading');
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) { if (!cancelled) setHistory(null); return; }
        const list = isNem
          ? await fetchNemTransfersWith(wallet.address, normalizedAddress)
          : await fetchTransfersWith(wallet.address, wallet.publicKey, normalizedAddress, recipientKey);
        if (!cancelled) setHistory(list);
      } catch (e) {
        console.error('Failed to load history with recipient', e);
        if (!cancelled) setHistory(null);
      }
    })();
    return () => { cancelled = true; };
  }, [addressValid, recipientSettled, recipientKey, normalizedAddress, network]);

  const amountAtomic = parseDecimal(amountText, decimals);
  const overBalance = amountAtomic !== null && amountAtomic > availableAtomic;
  // Encrypting needs the recipient's public key on chain (an account has one after its first outgoing
  // transaction). Without it the switch is off and cannot be turned on.
  const canEncrypt = recipientKey !== null;
  const encryptActive = canEncrypt && sendEncrypt;
  // Symbol: XYM / 6 decimals / 1023-byte messages (995 once encrypted); NEM: XEM / 6 decimals / 1024-byte messages.
  const maxMessageBytes = isNem ? (encryptActive ? NEM_MAX_ENCRYPTED_MESSAGE_BYTES : NEM_MAX_MESSAGE_BYTES) : encryptActive ? MAX_ENCRYPTED_MESSAGE_BYTES : MAX_MESSAGE_BYTES;
  const messageBytes = messageByteLength(sendMessage);
  const messageTooLong = messageBytes > maxMessageBytes;
  // While the recipient's public key is still being looked up, an encrypted send has to wait: going on
  // now would send the message in the clear.
  const waitingForKey = sendEncrypt && recipient === 'loading';
  const canGo = addressValid && amountAtomic !== null && !overBalance && !loadingAssets && !messageTooLong && !waitingForKey && extrasOk;

  // Fee. Symbol: re-quoted (debounced) whenever the message changes; it depends only on the
  // transaction size. NEM: a fixed formula of the amount sent and the message length.
  useEffect(() => {
    if (isNem) {
      // A formula of the amounts and the message; a mosaic is priced by its supply and divisibility.
      if (loadingAssets) { setFees('loading'); return; }
      try {
        const atLeastOne = (n: bigint | null) => (n !== null ? n : 1n);
        const lines: NemMosaicAmount[] = [
          { id: mainId.toLowerCase(), quantity: atLeastOne(amountAtomic) },
          ...extraLines.map((l) => ({ id: l.line.id.toLowerCase(), quantity: atLeastOne(l.atomic) })),
        ];
        const infos: Record<string, NemMosaicFeeInfo> = {};
        for (const o of assets) if (o.supply !== undefined) infos[o.id.toLowerCase()] = { supply: o.supply, divisibility: o.divisibility };
        const fee = formatAtomic(nemSendFee(activeNetworkByte(), lines, infos, messageTooLong || !sendMessage ? undefined : sendMessage, encryptActive), CURRENCY_DIVISIBILITY);
        setFees(Object.fromEntries(FEE_SPEEDS.map((speed) => [speed, fee])) as Record<FeeSpeed, string>);
      } catch {
        setFees(null);
      }
      return;
    }
    let cancelled = false;
    setFees('loading');
    const timer = setTimeout(async () => {
      try {
        const q = await quoteFees(1 + extras.length, messageTooLong ? undefined : sendMessage, encryptActive);
        if (!cancelled) {
          setFees(Object.fromEntries(FEE_SPEEDS.map((speed) => [speed, formatAtomic(q[speed].fee, CURRENCY_DIVISIBILITY)])) as Record<FeeSpeed, string>);
        }
      } catch {
        if (!cancelled) setFees(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMessage, messageTooLong, encryptActive, extras, network, chain, amountText, assets, loadingAssets, sendMosaicId]);

  // The fee is paid in XYM: sending XYM takes it out of the same balance as the amount.
  const feeAtomic = fee !== null && fee !== 'loading' ? (parseDecimal(fee, CURRENCY_DIVISIBILITY) ?? 0n) : 0n;
  // XYM spent by the transfer itself (the main mosaic and any extra line that is XYM) plus the fee.
  const nativeUpper = nativeAssetId().toUpperCase();
  const nativeSpend = (isNative && amountAtomic !== null ? amountAtomic : 0n)
    + extraLines.reduce((n, l) => n + (l.asset?.id.toUpperCase() === nativeUpper && l.atomic !== null ? l.atomic : 0n), 0n);
  const anyOver = overBalance || extraLines.some((l) => l.over);
  const nativeShort = fee !== 'loading' && !loadingAssets && !anyOver && (nativeSpend > 0n || !isNative) && nativeSpend + feeAtomic > xymAtomic;

  // Holdings offered in the selector: XYM (always), every mosaic actually held and the one chosen
  // (e.g. via a scanned QR) even if it is not held.
  const options = assets.filter((o, i) => (i === 0 || o.amount > 0n || isSelectedAsset(o, sendMosaicId)) && !extras.some((l) => l.id.toUpperCase() === o.id.toUpperCase()));

  const onChangeMosaic = (id: string) => {
    setSendMosaicId(id);
    // Another mosaic can have another divisibility, so a new mosaic starts with an empty amount.
    setAmountText('');
    setSendAmount('');
  };

  const onChangeAmount = (raw: string) => {
    const next = sanitizeAmount(raw, decimals);
    setAmountText(next);
    setSendAmount(next);
  };

  // Called by the scanner after it has put the scanned recipient / amount / mosaic in the store.
  const onScanned = () => {
    setScanOpen(false);
    const s = useAppStore.getState();
    setAddress(s.receiverAddress);
    setAmountText(s.sendAmount);
  };

  // A QR image chosen from the files: handled exactly like a scanned code.
  const onImageDecoded = async (text: string) => {
    const result = await applyScannedText(text);
    if (!result.ok) {
      if (result.reason === 'wrong_network') setMismatch({ other: result.scannedNetwork ?? null });
      else setErrorMessage(scanFailureMessage(result.reason, t));
    } else onScanned();
  };

  const closeUriDialog = () => {
    setUriOpen(false);
    setUriText('');
    setUriError('');
  };

  const onLoadUri = async () => {
    setUriBusy(true);
    setUriError('');
    try {
      const result = await applyScannedText(uriText);
      if (!result.ok) {
        if (result.reason === 'wrong_network') {
          closeUriDialog();
          setMismatch({ other: result.scannedNetwork ?? null });
        } else {
          setUriError(scanFailureMessage(result.reason, t));
        }
        return;
      }
      // Same as a successful scan: the store has the new values, so show them in the form.
      closeUriDialog();
      onScanned();
    } finally {
      setUriBusy(false);
    }
  };

  const onClickedOk = async () => {
    if (!(await WalletsHelper.getActive())) {
      setErrorMessage(t('wallet.not_select_message'));
      return;
    }
    if (!addressValid) {
      setErrorMessage(t('common.invalid_address'));
      return;
    }
    setReceiverAddress(normalizedAddress);
    setSendAmount(amountText);
    setSendEncrypt(encryptActive); // what the form shows is what is sent
    navigate('/send/confirmation');
  };

  const feeText = (speed: FeeSpeed) => fees === 'loading'
    ? t('send.fee_estimating')
    : fees != null
      ? `${fees[speed]} ${CURRENCY_SYMBOL}`
      : t('send.fee_estimate_unavailable');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {/* The mosaic to send, chosen right here. */}
        <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('send.select_mosaic_title')}</Typography>
        <AssetSelect
          selected={selected}
          fallbackSymbol={symbol}
          options={options}
          loading={loadingAssets}
          disabled={loadingAssets && assets.length === 0}
          onChange={onChangeMosaic}
        />

        {/* Recipient. */}
        <Typography sx={{ fontWeight: 'bold', mt: 3, mb: 1 }}>{t('send.destination')}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <TextField
            id="address"
            label={t('send.input_address')}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setReceiverAddress(e.target.value); }}
            fullWidth
            error={addressError !== ''}
            helperText={addressError || resolvedNote || (!isNem ? t('send.input_address_hint') : undefined)}
            slotProps={{ formHelperText: { sx: { wordBreak: 'break-all' } }, htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
          />
          <IconButton onClick={() => navigate('/account?tab=addressbook&pick=1')} aria-label={t('addressbook.pick_title')} color="primary" sx={{ mt: 0.75 }}>
            <ContactsOutlinedIcon />
          </IconButton>
          <IconButton onClick={() => setScanOpen(true)} aria-label={t('home.scan')} color="primary" sx={{ mt: 0.75 }}>
            <QrCodeScannerIcon />
          </IconButton>
          <QrImageButton iconOnly onDecoded={(text) => { void onImageDecoded(text); }} onNotFound={() => setErrorMessage(t('signqr.image_not_found'))} sx={{ mt: 0.75 }} />
        </Box>

        {!isNem && (
          <Button variant="outlined" size="small" startIcon={<LinkIcon />} sx={{ mt: 1 }} onClick={() => setUriOpen(true)}>{t('home.import_uri_ribbon')}</Button>
        )}

        {addressValid && recipientContact && recipientTrust !== 'black' && (
          <Typography variant="body2" sx={{ mt: 0.5, color: 'success.main' }}>
            {t(recipientTrust === 'white' ? 'addressbook.recipient_whitelisted' : 'addressbook.recipient_contact', { name: displayName(recipientContact) })}
          </Typography>
        )}
        {addressValid && recipientTrust === 'black' && (
          <Alert severity="error" sx={{ mt: 1 }}>{t('addressbook.recipient_blacklisted', { name: recipientContact ? displayName(recipientContact) : '' })}</Alert>
        )}

        {/* What the chain knows about the recipient (shown once the address is valid). */}
        {addressValid && <RecipientInfoCard address={normalizedAddress} recipient={recipient} history={history} ownMatch={ownMatch} />}

        {/* Amount, typed straight into the field. */}
        <Typography sx={{ fontWeight: 'bold', mt: 3, mb: 1 }}>{t('common.amount')}</Typography>
        <TextField
          value={amountText}
          onChange={(e) => onChangeAmount(e.target.value)}
          placeholder={t('send.amount_placeholder')}
          fullWidth
          error={overBalance}
          sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
          slotProps={{
            htmlInput: { inputMode: 'decimal', autoComplete: 'off', 'aria-label': t('common.amount'), style: { fontSize: '1.4rem' } },
            input: { endAdornment: <InputAdornment position="end"><Typography sx={{ fontWeight: 'bold' }}>{symbol}</Typography></InputAdornment> },
          }}
        />
        {overBalance && (
          <Typography sx={{ color: 'error.main', fontSize: 12, mt: 0.75 }}>{t('chain.insufficient_balance_error')}</Typography>
        )}

        {/* More mosaics in the same transfer. */}
        {extraLines.map((l, i) => (
          <Box key={l.line.id} sx={{ mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
              <Typography sx={{ fontWeight: 'bold', flexGrow: 1 }}>{t('send.mosaic_n', { n: i + 2 })}</Typography>
              <IconButton size="small" onClick={() => removeExtra(i)} aria-label={t('send.remove_mosaic')}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Box>
            <AssetSelect
              selected={l.asset}
              fallbackSymbol={l.line.id}
              options={assets.filter((o) => {
                const id = o.id.toUpperCase();
                return id === l.line.id.toUpperCase() || (o.amount > 0n && !usedIds.has(id));
              })}
              loading={loadingAssets}
              disabled={loadingAssets && assets.length === 0}
              onChange={(id) => updateExtra(i, { id: isNem ? id : id.toUpperCase(), amount: '' })}
            />
            <TextField
              value={l.line.amount}
              onChange={(e) => updateExtra(i, { amount: sanitizeAmount(e.target.value, l.decimals) })}
              placeholder={t('send.amount_placeholder')}
              fullWidth
              error={l.over}
              sx={{ mt: 1, '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
              slotProps={{
                htmlInput: { inputMode: 'decimal', autoComplete: 'off', 'aria-label': t('common.amount'), style: { fontSize: '1.4rem' } },
                input: { endAdornment: <InputAdornment position="end"><Typography sx={{ fontWeight: 'bold' }}>{l.symbol}</Typography></InputAdornment> },
              }}
            />
            {l.over && (
              <Typography sx={{ color: 'error.main', fontSize: 12, mt: 0.75 }}>{t('chain.insufficient_balance_error')}</Typography>
            )}
          </Box>
        ))}
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" startIcon={<AddIcon />} disabled={!canAddMosaic} onClick={addExtra}>{t('send.add_mosaic')}</Button>
          {extras.length + 1 >= MAX_MOSAICS_PER_SEND && (
            <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('send.mosaic_limit', { count: MAX_MOSAICS_PER_SEND })}</Typography>
          )}
        </Box>
        {/* NEM: a mosaic with a levy costs the sender an extra amount on every transfer. */}
        {isNem && (selected?.hasLevy || extraLines.some((l) => l.asset?.hasLevy)) && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>{t('send.nem_levy_note')}</Alert>
        )}

        {/* Optional message. */}
        <Typography sx={{ fontWeight: 'bold', mt: 3, mb: 1 }}>{t('send.message_optional')}</Typography>
        <TextField
          value={sendMessage}
          onChange={(e) => setSendMessage(e.target.value)}
          placeholder={t('common.message_input')}
          fullWidth
          multiline
          minRows={2}
          error={messageTooLong}
          helperText={`${messageBytes} / ${maxMessageBytes} bytes`}
          sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
        />
        {/* Encrypt the message for the recipient (Symbol and NEM). */}
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Switch checked={encryptActive} disabled={!canEncrypt} onChange={(e) => setSendEncrypt(e.target.checked)} />}
            label={t('send.encrypt_message')}
          />
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
            {addressValid && recipientSettled && !canEncrypt ? t('send.encrypt_unavailable') : t('send.encrypt_hint')}
          </Typography>
        </Box>

        {/* Transaction fee. */}
        <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{t('send.fee_label')}</Typography>
          {/* NEM has a single fixed fee; Symbol offers five levels, the chosen one is what the transfer pays. */}
          {isNem ? (
            <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{feeText('standard')}</Typography>
          ) : (
          <Select
            fullWidth
            size="small"
            value={feeSpeed}
            onChange={(e) => setFeeSpeed(e.target.value as FeeSpeed)}
            inputProps={{ 'aria-label': t('send.fee_label') }}
            sx={{ bgcolor: 'background.paper', borderRadius: 3, '& .MuiSelect-select': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 } }}
          >
            {FEE_SPEEDS.map((speed) => (
              <MenuItem key={speed} value={speed} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}>
                <span>{t(`send.fee_speed_${speed}`)}</span>
                <Typography component="span" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{feeText(speed)}</Typography>
              </MenuItem>
            ))}
          </Select>
          )}
          {!isNem && <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 0.75 }}>{t('send.fee_speed_hint')}</Typography>}
          {nativeShort && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography sx={{ color: 'warning.main', fontSize: 12 }}>{t(nativeSpend > 0n ? 'send.amount_plus_fee_warning' : 'send.xym_for_fee_warning')}</Typography>
            </>
          )}
        </Box>

        {/* The transfer as a transaction URI / QR (Symbol only; needs a complete, valid form). */}
        {!isNem && !(encryptActive && sendMessage) && canGo && amountAtomic !== null && fees !== 'loading' && fees !== null && feeAtomic > 0n && (
          <TransactionUriCard
            recipient={normalizedAddress}
            mosaics={[
              { id: selected?.id ?? (sendMosaicId || nativeAssetId()), amount: amountAtomic },
              ...extraLines.map((l) => ({ id: l.line.id, amount: l.atomic ?? 0n })),
            ]}
            message={messageTooLong ? '' : sendMessage}
            maxFee={feeAtomic}
            networkByte={activeNetworkByte()}
          />
        )}
      </Box>

      <Box sx={{ px: 2, pb: 2 }}>
        <Box>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canGo} onClick={onClickedOk}>
            {t('send.go_confirm')}
          </Button>
        </Box>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <NetworkMismatchDialog open={mismatch !== null} otherNetwork={mismatch?.other ?? null} onClose={() => setMismatch(null)} />

      {/* Paste an address / payment URI / transaction URI (web+symbol://...). */}
      <Dialog open={uriOpen} onClose={closeUriDialog} fullWidth maxWidth="sm">
        <DialogTitle>{t('home.import_uri_ribbon')}</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>{t('txuri.load_hint')}</Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={4}
            maxRows={10}
            value={uriText}
            onChange={(e) => { setUriText(e.target.value); setUriError(''); }}
            placeholder="web+symbol://transaction?data=..."
            error={uriError !== ''}
            helperText={uriError || undefined}
            slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeUriDialog}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={onLoadUri} disabled={uriBusy || uriText.trim() === ''}>{t('txuri.load_ok')}</Button>
        </DialogActions>
      </Dialog>

      {/* The scanner only mounts while open, so the camera is off otherwise. */}
      <Dialog fullScreen open={scanOpen} onClose={() => setScanOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar>
            <IconButton edge="start" onClick={() => setScanOpen(false)} aria-label={t('common.close')}>
              <CloseIcon />
            </IconButton>
            <Typography variant="h6" sx={{ ml: 1 }}>{t('home.scan')}</Typography>
          </Toolbar>
        </AppBar>
        <Scan isActive={scanOpen} onScanned={onScanned} />
      </Dialog>
    </Box>
  );
}
