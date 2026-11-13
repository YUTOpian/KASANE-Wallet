import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, MenuItem, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import OptionSelect, { OptionItem } from '../../components/OptionSelect';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { loadKnownNemMosaics } from '../../lib/mosaicCache';
import { WalletsHelper } from '../../lib/storage';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { getNetwork } from '../../lib/symbol/network';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_MAX_MESSAGE_BYTES, NEM_NATIVE_ID } from '../../lib/nem/constants';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { buildNemSignedQr, readNemMultisigRequest, readNemTransfer } from '../../lib/nem/offline';
import { NEM_MULTISIG_WRAPPER_FEE, nemMessageByteLength, nemSendFee, signNemMultisigWrapped, signNemTransfer } from '../../lib/nem/tx';
import type { NemMosaicAmount, NemMosaicFeeInfo } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { SectionCard, ValueBox } from '../multisig/parts';
import OfflineTransferFields, { FeeBox, Heading } from './OfflineTransferFields';
import { useSigningAccounts } from './signingAccounts';

// 「オフライン署名」 for NEM (NIS1). Like the Symbol one it never talks to a node: the fee is worked out here by NIS1's own
// rules (there is no fee multiplier on NEM), the deadline comes from this device's clock, and the message is plain (an
// encrypted one needs the recipient's public key from the chain). The mosaics to choose from are the ones this account
// was seen to hold while online (lib/mosaicCache.ts), with the supply and divisibility the fee needs, plus XEM.
// The result is the body of POST /transaction/announce, as KASANE's NEM QR, which 「署名・連署QR」 reads on a PC that is online.
// "In the name of a multisig account" makes a request for the other cosignatories instead: a multisig transaction (type 0x1004) that the
// chosen cosigner signs and that wraps the transfer (signed by nobody). The multisig account's public key cannot be looked up offline, so it
// is typed in; the mosaics offered are the ones remembered for the multisig account's address. 「トランザクションに連署」 reads the result.

interface RowState { id: string; amount: string }
interface Option { id: string; divisibility: number; supply: bigint; native: boolean }

const MAX_MOSAICS = 10;
const HOURS = [1, 2, 6, 12, 24]; // NIS1 accepts a deadline up to 24 hours after the time stamp
const XEM: Option = { id: NEM_NATIVE_ID, divisibility: NEM_CURRENCY_DIVISIBILITY, supply: 8_999_999_999n, native: true };

interface Result { text: string; deadlineMs: number; feeText: string; recipient: string; multisig: { address: string; innerHash: string; wrapperFeeText: string } | null }

const MULTISIG_HOURS = 2; // signNemMultisigWrapped fixes the validity of the wrapper
const PUBLIC_KEY = /^[0-9A-F]{64}$/;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ py: 1 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '0.95rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>{children}</Typography>
    </Box>
  );
}

export default function OfflineNemTransfer({ onDone }: { onDone: (done: boolean) => void }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const cfg = getNemNetworkConfig();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const timeText = (ms: number) => new Date(ms).toLocaleString(undefined, { hour12: false, timeZoneName: 'short' });

  const [recipient, setRecipient] = useState('');
  const [rows, setRows] = useState<RowState[]>([{ id: NEM_NATIVE_ID, amount: '' }]);
  const [message, setMessage] = useState('');
  const [hours, setHours] = useState(2);
  const [asMultisig, setAsMultisig] = useState(false);
  const [multisigKey, setMultisigKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const { accounts, setSignerId, signer } = useSigningAccounts('nem');
  const address = signer ? signer.address : '';

  // --- in the name of a multisig account ---------------------------------------------------------
  const msKey = multisigKey.trim().toUpperCase();
  const msKeyFormatOk = PUBLIC_KEY.test(msKey);
  const msIsSigner = signer !== null && msKey === signer.publicKey.toUpperCase();
  const msKeyOk = msKeyFormatOk && !msIsSigner;
  let msAddress = '';
  if (msKeyFormatOk) { try { msAddress = nemAddressFromPublicKey(msKey, cfg.networkByte); } catch { msAddress = ''; } }
  // Whose mosaics are offered: the multisig account's, when sending in its name.
  const holder = asMultisig ? msAddress : address;
  const effectiveHours = asMultisig ? MULTISIG_HOURS : hours;

  // --- the mosaics to choose from ---------------------------------------------------------------
  const [known, setKnown] = useState<Option[]>([]);
  useEffect(() => {
    let cancelled = false;
    setKnown([]);
    if (holder === '') return undefined;
    void loadKnownNemMosaics(getNetwork(), holder).then((list) => {
      if (cancelled) return;
      setKnown(list.filter((m) => m.id !== NEM_NATIVE_ID).map((m) => ({ id: m.id, divisibility: m.divisibility, supply: BigInt(m.supply), native: false })));
    });
    return () => { cancelled = true; };
  }, [holder, network]);
  const options: Option[] = [XEM, ...known];

  // Another account has other mosaics: rows pointing at one that is not offered any more go back to XEM.
  useEffect(() => {
    setRows((prev) => {
      const kept = prev.filter((r) => r.id === NEM_NATIVE_ID || known.some((m) => m.id === r.id));
      return kept.length === prev.length ? prev : kept.length > 0 ? kept : [{ id: NEM_NATIVE_ID, amount: '' }];
    });
  }, [known]);

  const setRow = (i: number, patch: Partial<RowState>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unusedCount = options.filter((o) => !rows.some((r) => r.id === o.id)).length;

  // --- checks ------------------------------------------------------------------------------------
  const normalizedRecipient = normalizeNemAddress(recipient);
  // The network byte is part of a NEM address (N... / T...): one of the other network is refused here, not at the node.
  const recipientOk = isValidNemAddress(normalizedRecipient, cfg.networkByte);
  const parsedRows = rows.map((r) => {
    const option = options.find((o) => o.id === r.id);
    const amount = option ? parseDecimal(r.amount, option.divisibility) : null;
    return { id: r.id, divisibility: option?.divisibility ?? 0, amount, valid: option !== undefined && amount !== null && amount > 0n };
  });
  const duplicate = new Set(parsedRows.map((r) => r.id)).size !== parsedRows.length;
  const messageBytes = nemMessageByteLength(message);
  const messageOk = messageBytes <= NEM_MAX_MESSAGE_BYTES;
  const allValid = parsedRows.every((r) => r.valid) && !duplicate;

  const lines: NemMosaicAmount[] | null = allValid ? parsedRows.map((r) => ({ id: r.id, quantity: r.amount as bigint })) : null;
  const feeInfos: Record<string, NemMosaicFeeInfo> = Object.fromEntries(known.map((m) => [m.id, { supply: m.supply, divisibility: m.divisibility }]));
  let fee: bigint | null = null;
  if (lines !== null && messageOk) {
    try { fee = nemSendFee(cfg.networkByte, lines, feeInfos, message || undefined); } catch { fee = null; }
  }
  const canSign = signer !== null && address !== '' && recipientOk && allValid && messageOk && fee !== null && !signing && (!asMultisig || (msKeyOk && msAddress !== ''));

  // --- signing -----------------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (fee === null || lines === null || signer === null) return;
    setSigning(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      // A single XEM line is a plain transfer; anything else carries every line as an attached mosaic (version 2).
      const single = lines.length === 1 && lines[0].id === NEM_NATIVE_ID;
      if (asMultisig) {
        // A request for the other cosignatories: the transfer is wrapped, and only the wrapper is signed (by the chosen cosigner).
        const body = signNemMultisigWrapped(privateKey, signer.publicKey, cfg.networkByte, msKey, single
          ? { kind: 'transfer', recipient: normalizedRecipient, amount: lines[0].quantity, message: message || undefined }
          : { kind: 'mosaicTransfer', recipient: normalizedRecipient, mosaics: lines, message: message || undefined, fee });
        // What is shown is read back from the signed bytes.
        const request = readNemMultisigRequest((JSON.parse(body) as { data: string }).data);
        setResult({
          text: buildNemSignedQr(body, cfg.networkByte),
          deadlineMs: request.deadlineMs,
          feeText: `${formatAtomic(request.inner.fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`,
          recipient: request.inner.transfer?.recipient ?? normalizedRecipient,
          multisig: {
            address: nemAddressFromPublicKey(request.multisigPublicKey, request.networkByte),
            innerHash: request.innerHash,
            wrapperFeeText: `${formatAtomic(request.fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`,
          },
        });
        onDone(true);
        return;
      }
      const body = signNemTransfer(privateKey, {
        publicKey: signer.publicKey,
        networkByte: cfg.networkByte,
        recipient: normalizedRecipient,
        amount: single ? lines[0].quantity : 0n,
        mosaics: single ? undefined : lines,
        message: message || undefined,
        fee,
        timeoutSeconds: hours * 3600,
      });
      // What is shown is read back from the signed bytes, not taken from the form.
      const parsed = JSON.parse(body) as { data: string };
      const summary = readNemTransfer(parsed.data);
      setResult({
        text: buildNemSignedQr(body, cfg.networkByte),
        deadlineMs: summary.deadlineMs,
        feeText: `${formatAtomic(summary.fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`,
        recipient: summary.transfer?.recipient ?? normalizedRecipient,
        multisig: null,
      });
      onDone(true);
    } catch (e) {
      console.error('Failed to sign a NEM transfer offline', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  const reset = () => { setResult(null); setRecipient(''); setMessage(''); setRows([{ id: NEM_NATIVE_ID, amount: '' }]); onDone(false); };

  return (
    <>
      {result === null ? (
        <>
          <Alert severity="info" sx={{ mb: 2 }}>{t('offline.nem_note')}</Alert>

          {/* From this account, or in the name of a multisig account (a request for its other cosignatories). */}
          <Heading>{t('offline_cosign.nem_ms_mode')}</Heading>
          <OptionSelect
            exclusive
            size="small"
            color="primary"
            value={asMultisig ? 'multisig' : 'self'}
            onChange={(_, v: string | null) => {
              if (v === null) return;
              setAsMultisig(v === 'multisig');
              setRows([{ id: NEM_NATIVE_ID, amount: '' }]);
            }}
            aria-label={t('offline_cosign.nem_ms_mode')}
            sx={{ width: { xs: '100%', sm: 420 }, maxWidth: '100%' }}
          >
            <OptionItem value="self">{t('offline_cosign.nem_ms_self')}</OptionItem>
            <OptionItem value="multisig">{t('offline_cosign.nem_ms_multisig')}</OptionItem>
          </OptionSelect>
          {asMultisig && (
            <Box sx={{ mt: 2 }}>
              <Alert severity="info" sx={{ mb: 2 }}>{t('offline_cosign.nem_ms_note')}</Alert>
              <Heading>{t('offline_cosign.nem_ms_key')}</Heading>
              <TextField
                fullWidth
                value={multisigKey}
                onChange={(e) => { setMultisigKey(e.target.value); setRows([{ id: NEM_NATIVE_ID, amount: '' }]); }}
                error={multisigKey.trim() !== '' && !msKeyOk}
                helperText={multisigKey.trim() !== '' && !msKeyFormatOk ? t('offline_cosign.nem_ms_key_invalid') : msIsSigner ? t('offline_cosign.nem_ms_key_self') : t('offline_cosign.nem_ms_key_hint')}
                slotProps={{ formHelperText: { sx: { wordBreak: 'break-all' } }, htmlInput: { 'aria-label': t('offline_cosign.nem_ms_key'), autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, style: { fontFamily: 'monospace' } } }}
                sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
              />
              {msAddress !== '' && !msIsSigner && <Box sx={{ mt: 0.75 }}><ValueBox>{msAddress}</ValueBox></Box>}
            </Box>
          )}
          <Box sx={{ mt: 3 }} />
          <OfflineTransferFields
            accounts={accounts}
            signerId={signer ? signer.id : ''}
            onSignerChange={(id) => { setSignerId(id); setRows([{ id: NEM_NATIVE_ID, amount: '' }]); }}
            senderNone={t('offline.nem_sender_none')}
            senderLabel={asMultisig ? t('offline_cosign.nem_ms_sender') : undefined}
            address={address}
            recipient={recipient}
            onRecipientChange={setRecipient}
            recipientOk={recipientOk}
            options={options.map((o) => ({ id: o.id, symbol: o.native ? NEM_CURRENCY_SYMBOL : o.id, divisibility: o.divisibility }))}
            rows={rows}
            parsedRows={parsedRows}
            onRow={setRow}
            onRemoveRow={(i) => setRows((prev) => prev.filter((_, j) => j !== i))}
            onAddRow={() => setRows((prev) => [...prev, { id: options.find((o) => !prev.some((r) => r.id === o.id))?.id ?? '', amount: '' }])}
            canAddRow={rows.length < MAX_MOSAICS && unusedCount > 0}
            maxRows={MAX_MOSAICS}
            duplicate={duplicate}
            hasCached={known.length > 0}
            noCachedNote={t('offline.nem_mosaic_none_cached')}
            message={message}
            onMessageChange={setMessage}
            messageBytes={messageBytes}
            maxMessageBytes={NEM_MAX_MESSAGE_BYTES}
            messageOk={messageOk}
            messageHint={t('offline.message_hint')}
          />

          {/* Fee (worked out here by NIS1's rules) and validity. */}
          <Heading mt={3}>{t('offline.settings_title')}</Heading>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('offline.nem_settings_note')}</Typography>
          <FeeBox label={asMultisig ? t('offline_cosign.nem_ms_inner_fee') : t('offline.tx_fee')}>
            <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{fee === null ? '–' : `${formatAtomic(fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`}</Typography>
          </FeeBox>
          {asMultisig && (
            <FeeBox label={t('offline_cosign.nem_ms_wrapper_fee')}>
              <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{`${formatAtomic(NEM_MULTISIG_WRAPPER_FEE, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`}</Typography>
            </FeeBox>
          )}
          <Heading mt={3}>{t('offline.validity')}</Heading>
          {asMultisig ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('offline_cosign.nem_ms_validity_fixed')}</Typography>
          ) : (
            <TextField
              select
              fullWidth
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              helperText={t('offline.nem_validity_hint')}
              slotProps={{ htmlInput: { 'aria-label': t('offline.validity') } }}
              sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
            >
              {HOURS.map((h) => <MenuItem key={h} value={h}>{t('offline.hours', { count: h })}</MenuItem>)}
            </TextField>
          )}
          <Box sx={{ mt: 2 }}>
            <Typography sx={{ color: 'primary.main', fontSize: '0.85rem' }}>{t('offline.now')}</Typography>
            <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now)}</Typography>
            <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mt: 1 }}>{t('offline.deadline')}</Typography>
            <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now + effectiveHours * 3600 * 1000)}</Typography>
          </Box>
          <Alert severity="warning" sx={{ mt: 2, mb: 3 }}>{t('offline.nem_clock_warning')}</Alert>

          <Button
            variant="contained"
            color="primary"
            size="large"
            fullWidth
            disabled={!canSign}
            onClick={() => setShowPassword(true)}
            startIcon={<LockOutlinedIcon />}
            sx={{ py: 1.25 }}
          >
            {signing ? t('offline.signing') : t('offline.sign_button')}
          </Button>
        </>
      ) : (
        <>
          <Alert severity="success" sx={{ mb: 2 }}>{result.multisig ? t('offline_cosign.nem_ms_done_note') : t('offline.done_note')}</Alert>
          <SectionCard>
            {result.multisig && <Row label={t('offline_cosign.nem_label_multisig')}>{result.multisig.address}</Row>}
            <Row label={t('offline.recipient')}>{result.recipient}</Row>
            <Row label={result.multisig ? t('offline_cosign.nem_ms_inner_fee') : t('offline.tx_fee')}>{result.feeText}</Row>
            {result.multisig && <Row label={t('offline_cosign.nem_ms_wrapper_fee')}>{result.multisig.wrapperFeeText}</Row>}
            {result.multisig && <Row label={t('offline_cosign.nem_label_inner_hash')}>{result.multisig.innerHash}</Row>}
            <Row label={t('offline.result_deadline')}>{timeText(result.deadlineMs)}</Row>
            <Typography variant="body2" sx={{ color: 'text.secondary', pb: 1 }}>{t('offline.nem_hash_later')}</Typography>
          </SectionCard>
          <SectionCard title={t('offline.qr_title')}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline.qr_hint')}</Typography>
            <QrTextPanel
              text={result.text}
              file={{ text: result.text, name: `kasane-nem-${result.multisig ? 'multisig-request' : 'signed'}-${Date.now().toString(36)}.json` }}
              note={t('signqr.export_note', { time: new Date(result.deadlineMs).toLocaleString() })}
            />
          </SectionCard>
          <Button onClick={reset} sx={{ mt: 2 }}>{t('offline.another')}</Button>
        </>
      )}

      <PasswordDialog
        open={showPassword}
        mode="check" popup
        onClose={() => setShowPassword(false)}
        onPass={(password) => { setShowPassword(false); void onPassed(password); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </>
  );
}
