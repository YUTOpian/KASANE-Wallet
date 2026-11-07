import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, MenuItem, Select, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import OptionSelect, { OptionItem } from '../../components/OptionSelect';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { WalletsHelper } from '../../lib/storage';
import { CHAIN_ORDER } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { loadKnownMosaics } from '../../lib/mosaicCache';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { addressFromPublicKey, decodeAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { aggregateSize, signAggregate } from '../../lib/symbol/aggregate';
import type { AggregateItem, AggregateSigner } from '../../lib/symbol/aggregate';
import { buildKasaneQr } from '../../lib/symbol/kasaneQr';
import { getNetwork, getNetworkConfig } from '../../lib/symbol/network';
import { BONDED_LIFETIME_MS, DEFAULT_HASH_LOCK_AMOUNT, HASH_LOCK_DURATION_BLOCKS, HASH_LOCK_SIZE, MAX_MESSAGE_BYTES, MAX_MULTISIG_COSIGNERS, messageByteLength, signHashLock, signTransfer, transferSize } from '../../lib/symbol/tx';
import { FEE_SPEEDS, multipliersFromStats } from '../../lib/symbol/feeSpeed';
import type { FeeSpeed } from '../../lib/symbol/feeSpeed';
import type { MosaicAmount } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { SectionCard, ValueBox } from '../multisig/parts';
import OfflineTransferFields, { FeeBox, Heading } from './OfflineTransferFields';
import OfflineChainSelect from './OfflineChainSelect';
import OfflineNemTransfer from './OfflineNemTransfer';
import OfflineShell from './OfflineShell';
import { useSigningAccounts } from './signingAccounts';

// 「オフライン署名」: signs a transfer on a PC that has no network connection and hands it over as a QR code /
// JSON text / .json file. It is opened from the profile-selection screen (オフライントランザクション), so it does
// not depend on the chain selected in the app or on the active account: the chain (Symbol / NEM) and the account
// that signs (送信元) are chosen on this screen, and the recipient is any address.
// (NEM has its own form: OfflineNemTransfer.tsx.)
// Nothing on this screen talks to a node: the fee is chosen from the same speed names as Home's 「送る」 (five levels, each with a fixed
// multiplier - see OFFLINE_FEE_MULTIPLIERS) and the validity period from a short list, the deadline comes from this device's clock, and the message is never encrypted (that needs the
// recipient's public key from the chain). The mosaics are not typed in either: they are chosen from the ones this
// account was seen to hold while online (lib/mosaicCache.ts), plus the network currency, with the divisibility that
// was read from the chain at that time.
// The signed result is the same "signed" QR that 「署名・連署QR」 reads on a PC that is online.
// "In the name of a multisig account" (as on NEM) makes a request for the other cosignatories instead: a bonded aggregate that holds the
// transfer (signed by nobody but the aggregate's signer, the cosigner who starts it) and the hash lock it needs, as one "bundle" QR
// (lock first, then the bonded aggregate). The multisig account's public key cannot be looked up offline, so it is typed in; the mosaics
// offered are the ones remembered for the multisig account's address. 「オフライン連署」 reads the result on the other cosignatories' side.

interface MosaicRowState { id: string; amount: string }
interface MosaicOption { id: string; symbol: string; divisibility: number; native: boolean }

const MAX_MOSAICS = 10;
const HOURS = [1, 2, 3, 6]; // a transaction may stay valid for at most 6 hours
// The node cannot be asked for its current fee levels, so the five levels (the same ones, in the same ratios, as Home's 「送る」)
// are worked out from fixed stand-ins for the node's statistics: 100 (the network's usual minimum, so even 「最も遅い」 is
// accepted) as the minimum, 200 as the median and 300 as the highest. 「標準」 therefore pays a little more than it would
// online - a few hundredths of an XYM - which is the price of not knowing the network's real load.
const OFFLINE_FEE_MULTIPLIERS = multipliersFromStats(100, 200, 300);

const PUBLIC_KEY = /^[0-9A-F]{64}$/;
// How many cosignatures the fee of a multisig request leaves room for: the most a multisig account can have, less the cosigner who starts it
// (the number actually needed cannot be looked up offline; the fee that is charged follows the size the transaction really has).
const RESERVED_COSIGNATURES = MAX_MULTISIG_COSIGNERS - 1;

interface Result {
  text: string; hash: string; deadlineMs: number; feeText: string;
  multisig: { address: string; lockHash: string; lockFeeText: string; depositText: string } | null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ py: 1 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '0.95rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>{children}</Typography>
    </Box>
  );
}

export default function OfflineSignPage() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const cfg = getNetworkConfig();
  const nativeId = cfg.currencyMosaicId.toUpperCase();

  // This device's clock, ticking, so the screen shows the same time the device does (the deadline is worked out from it).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const timeText = (ms: number) => new Date(ms).toLocaleString(undefined, { hour12: false, timeZoneName: 'short' });

  // Which blockchain the transfer is for (Symbol here; NEM in OfflineNemTransfer, which holds its own form and result).
  const [target, setTarget] = useState<ChainKey>('symbol');
  const [nemDone, setNemDone] = useState(false);

  const [recipient, setRecipient] = useState('');
  const [rows, setRows] = useState<MosaicRowState[]>([{ id: nativeId, amount: '' }]);
  const [message, setMessage] = useState('');
  const [feeSpeed, setFeeSpeed] = useState<FeeSpeed>('standard');
  const [hours, setHours] = useState(2);
  const [asMultisig, setAsMultisig] = useState(false);
  const [multisigKey, setMultisigKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  // --- the account that signs (送信元) -----------------------------------------------------------
  const { accounts, setSignerId, signer } = useSigningAccounts();
  // Derived from the key for the network that is selected (so it follows 設定 > ネットワーク).
  const address = signer ? signer.address : '';

  // --- in the name of a multisig account -------------------------------------------------------
  const msKey = multisigKey.trim().toUpperCase();
  const msKeyFormatOk = PUBLIC_KEY.test(msKey);
  const msIsSigner = signer !== null && msKey === signer.publicKey.toUpperCase();
  const msKeyOk = msKeyFormatOk && !msIsSigner;
  let msAddress = '';
  if (msKeyFormatOk) { try { msAddress = addressFromPublicKey(msKey, cfg.networkByte); } catch { msAddress = ''; } }
  // Whose mosaics are offered: the multisig account's, when sending in its name.
  const holder = asMultisig ? msAddress : address;

  // --- the mosaics to choose from ----------------------------------------------------------------
  const [known, setKnown] = useState<MosaicOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    setKnown([]);
    if (holder === '') return undefined;
    void loadKnownMosaics(getNetwork(), holder).then((list) => {
      if (cancelled) return;
      setKnown(list.filter((m) => m.id !== nativeId).map((m) => ({ id: m.id, symbol: m.symbol, divisibility: m.divisibility, native: false })));
    });
    return () => { cancelled = true; };
  }, [holder, network, nativeId]);
  const options: MosaicOption[] = [{ id: nativeId, symbol: CURRENCY_SYMBOL, divisibility: CURRENCY_DIVISIBILITY, native: true }, ...known];

  // Another account (or network) has other mosaics: rows pointing at one that is not offered any more go back to the currency.
  useEffect(() => {
    setRows((prev) => {
      const kept = prev.filter((r) => r.id === nativeId || known.some((m) => m.id === r.id));
      return kept.length === prev.length ? prev : kept.length > 0 ? kept : [{ id: nativeId, amount: '' }];
    });
  }, [known, nativeId]);

  const setRow = (i: number, patch: Partial<MosaicRowState>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unusedCount = options.filter((o) => !rows.some((r) => r.id === o.id)).length;

  // --- checks ---------------------------------------------------------------------------------
  const recipientOk = decodeAddress(normalizeAddress(recipient)) !== null;
  const parsedRows = rows.map((r) => {
    const option = options.find((o) => o.id === r.id);
    const amount = option ? parseDecimal(r.amount, option.divisibility) : null;
    return { id: r.id, divisibility: option?.divisibility ?? 0, amount, valid: option !== undefined && amount !== null && amount > 0n };
  });
  const duplicate = new Set(parsedRows.map((r) => r.id)).size !== parsedRows.length;
  const messageBytes = messageByteLength(message);
  const messageOk = messageBytes <= MAX_MESSAGE_BYTES;
  const allValid = parsedRows.every((r) => r.valid) && !duplicate;
  const transferFeeOf = (speed: FeeSpeed): bigint => BigInt(transferSize(rows.length, message || undefined)) * BigInt(OFFLINE_FEE_MULTIPLIERS[speed]);
  // The request for the other cosignatories: ONE transfer (all the mosaics in it) inside a bonded aggregate, in the name of the multisig account.
  const buildMsItems = (): AggregateItem[] | null => {
    if (!asMultisig || signer === null || !msKeyOk || msAddress === '' || !recipientOk || !allValid || !messageOk) return null;
    const msSigner: AggregateSigner = { address: msAddress, publicKey: msKey, multisig: true, selfSufficient: false, cosignatures: RESERVED_COSIGNATURES };
    const first = parsedRows[0];
    return [{
      uid: 'offline-multisig-transfer',
      kind: 'transfer',
      signer: msSigner,
      recipient: normalizeAddress(recipient),
      mosaicId: first.id,
      mosaicSymbol: options.find((o) => o.id === first.id)?.symbol ?? first.id,
      divisibility: first.divisibility,
      amount: first.amount as bigint,
      extraMosaics: parsedRows.slice(1).map((r) => ({ mosaicId: r.id, amount: r.amount as bigint })),
      message,
    }];
  };
  const msItems = buildMsItems();
  const msSize = msItems !== null && signer !== null ? aggregateSize(signer.publicKey, signer.address, cfg.networkByte, msItems) : null;
  const aggFeeOf = (speed: FeeSpeed): bigint | null => (msSize === null ? null : BigInt(msSize) * BigInt(OFFLINE_FEE_MULTIPLIERS[speed]));
  const lockFeeOf = (speed: FeeSpeed): bigint => BigInt(HASH_LOCK_SIZE) * BigInt(OFFLINE_FEE_MULTIPLIERS[speed]);
  const xym = (v: bigint | null) => (v === null ? '–' : `${formatAtomic(v, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`);
  // What the cosigner who starts it pays at most: the request and the hash lock (the deposit comes back).
  const feeText = (speed: FeeSpeed) => {
    if (!asMultisig) return xym(transferFeeOf(speed));
    const agg = aggFeeOf(speed);
    return xym(agg === null ? null : agg + lockFeeOf(speed));
  };
  const fee = transferFeeOf(feeSpeed);
  const canSign = signer !== null && address !== '' && recipientOk && allValid && messageOk && !signing && (!asMultisig || (msKeyOk && msAddress !== '' && msItems !== null));

  // --- signing --------------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (signer === null) return;
    setSigning(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const mosaics: MosaicAmount[] = parsedRows.map((r) => ({ id: r.id, amount: r.amount as bigint }));
      // The deadline is counted in ms since the network epoch, from this device's own clock (no /node/time).
      const epochNow = BigInt(Date.now() - cfg.epochAdjustment * 1000);
      const deadline = epochNow + BigInt(hours) * 3600n * 1000n;
      if (asMultisig) {
        // A request for the other cosignatories: the bonded aggregate (signed by the cosigner who starts it) and the hash lock it needs.
        if (msItems === null) return;
        const multiplier = OFFLINE_FEE_MULTIPLIERS[feeSpeed];
        const aggregate = signAggregate(privateKey, cfg.generationHash, {
          signerPublicKey: signer.publicKey,
          ownerAddress: signer.address,
          networkByte: cfg.networkByte,
          items: msItems,
          feeMultiplier: multiplier,
          deadline: epochNow + BONDED_LIFETIME_MS,
          bonded: true,
        });
        const lock = signHashLock(privateKey, cfg.generationHash, {
          signerPublicKey: signer.publicKey,
          networkByte: cfg.networkByte,
          currencyMosaicId: cfg.currencyMosaicId,
          amount: DEFAULT_HASH_LOCK_AMOUNT,
          duration: HASH_LOCK_DURATION_BLOCKS,
          aggregateHash: aggregate.hash,
          feeMultiplier: multiplier,
          deadline,
        });
        setResult({
          // The lock first: the aggregate is announced once the lock is confirmed.
          text: buildKasaneQr({ kind: 'bundle', items: [{ role: 'lock', payload: lock.payload, hash: lock.hash }, { role: 'bonded', payload: aggregate.payload, hash: aggregate.hash }] }),
          hash: aggregate.hash,
          deadlineMs: Number(epochNow + BONDED_LIFETIME_MS) + cfg.epochAdjustment * 1000,
          feeText: xym(aggregate.fee),
          multisig: { address: msAddress, lockHash: lock.hash, lockFeeText: xym(lockFeeOf(feeSpeed)), depositText: xym(DEFAULT_HASH_LOCK_AMOUNT) },
        });
        return;
      }
      const signed = signTransfer(privateKey, cfg.generationHash, {
        signerPublicKey: signer.publicKey,
        networkByte: cfg.networkByte,
        recipient: normalizeAddress(recipient),
        mosaics,
        message: message || undefined,
        maxFee: fee,
        deadline,
      });
      setResult({
        text: buildKasaneQr({ kind: 'signed', payload: signed.payload, hash: signed.hash }),
        hash: signed.hash,
        deadlineMs: Number(deadline) + cfg.epochAdjustment * 1000,
        feeText: `${formatAtomic(fee, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`,
        multisig: null,
      });
    } catch (e) {
      console.error('Failed to sign offline', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  const reset = () => { setResult(null); setRecipient(''); setMessage(''); setRows([{ id: nativeId, amount: '' }]); };

  return (
    <OfflineShell tab="transfer" steps={[t('offline_ui.step_prepare'), t('offline_ui.step_download')]} step={(target === 'nem' ? nemDone : result !== null) ? 1 : 0}>
      <Box>
        {result === null ? (
          <>
            {!(target === 'nem' && nemDone) && (
              // The blockchain and its network, as one choice. Another one starts the form over (a NEM result that was shown is dropped).
              <OfflineChainSelect chains={CHAIN_ORDER} chain={target} onChain={(chain) => { setTarget(chain); setNemDone(false); }} />
            )}

            {target === 'nem' ? (
              <OfflineNemTransfer onDone={setNemDone} />
            ) : (
              <>
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
                    setRows([{ id: nativeId, amount: '' }]);
                  }}
                  aria-label={t('offline_cosign.nem_ms_mode')}
                  sx={{ width: { xs: '100%', sm: 420 }, maxWidth: '100%' }}
                >
                  <OptionItem value="self">{t('offline_cosign.nem_ms_self')}</OptionItem>
                  <OptionItem value="multisig">{t('offline_cosign.nem_ms_multisig')}</OptionItem>
                </OptionSelect>
                {asMultisig && (
                  <Box sx={{ mt: 2 }}>
                    <Alert severity="info" sx={{ mb: 2 }}>{t('offline_cosign.sym_ms_note')}</Alert>
                    <Heading>{t('offline_cosign.nem_ms_key')}</Heading>
                    <TextField
                      fullWidth
                      value={multisigKey}
                      onChange={(e) => { setMultisigKey(e.target.value); setRows([{ id: nativeId, amount: '' }]); }}
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
                  onSignerChange={(id) => { setSignerId(id); setRows([{ id: nativeId, amount: '' }]); }}
                  senderNone={t('offline.sender_none')}
                  senderLabel={asMultisig ? t('offline_cosign.nem_ms_sender') : undefined}
                  address={address}
                  recipient={recipient}
                  onRecipientChange={setRecipient}
                  recipientOk={recipientOk}
                  options={options}
                  rows={rows}
                  parsedRows={parsedRows}
                  onRow={setRow}
                  onRemoveRow={(i) => setRows((prev) => prev.filter((_, j) => j !== i))}
                  onAddRow={() => setRows((prev) => [...prev, { id: options.find((o) => !prev.some((r) => r.id === o.id))?.id ?? '', amount: '' }])}
                  canAddRow={rows.length < MAX_MOSAICS && unusedCount > 0}
                  maxRows={MAX_MOSAICS}
                  duplicate={duplicate}
                  hasCached={known.length > 0}
                  noCachedNote={t('offline.mosaic_none_cached')}
                  message={message}
                  onMessageChange={setMessage}
                  messageBytes={messageBytes}
                  maxMessageBytes={MAX_MESSAGE_BYTES}
                  messageOk={messageOk}
                  messageHint={t('offline.message_hint')}
                />

                {/* Fee and validity: chosen from fixed lists, as the network cannot be asked. */}
                <Heading mt={3}>{t('offline.settings_title')}</Heading>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('offline.settings_note')}</Typography>
                <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('send.fee_label')}</Typography>
                <Select
                  fullWidth
                  value={feeSpeed}
                  onChange={(e) => setFeeSpeed(e.target.value as FeeSpeed)}
                  inputProps={{ 'aria-label': t('send.fee_label') }}
                  sx={{ bgcolor: 'background.paper', '& .MuiSelect-select': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 } }}
                >
                  {FEE_SPEEDS.map((speed) => (
                    <MenuItem key={speed} value={speed} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}>
                      <span>{t(`send.fee_speed_${speed}`)}</span>
                      <Typography component="span" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{feeText(speed)}</Typography>
                    </MenuItem>
                  ))}
                </Select>
                <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.5 }}>{t('offline.fee_speed_hint')}</Typography>
                {asMultisig && (
                  <>
                    <FeeBox label={t('offline_cosign.sym_ms_agg_fee')}><Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{xym(aggFeeOf(feeSpeed))}</Typography></FeeBox>
                    <FeeBox label={t('offline_cosign.sym_ms_lock_fee')}><Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{xym(lockFeeOf(feeSpeed))}</Typography></FeeBox>
                    <FeeBox label={t('offline_cosign.sym_ms_lock_deposit')}><Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{xym(DEFAULT_HASH_LOCK_AMOUNT)}</Typography></FeeBox>
                  </>
                )}
                <Heading mt={3}>{t('offline.validity')}</Heading>
                <TextField
                  select
                  fullWidth
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                  helperText={asMultisig ? t('offline_cosign.sym_ms_validity_note') : t('offline.validity_hint')}
                  slotProps={{ htmlInput: { 'aria-label': t('offline.validity') } }}
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
                >
                  {HOURS.map((h) => <MenuItem key={h} value={h}>{t('offline.hours', { count: h })}</MenuItem>)}
                </TextField>
                <Box sx={{ mt: 2 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem' }}>{t('offline.now')}</Typography>
                  <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now)}</Typography>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mt: 1 }}>{t('offline.deadline')}</Typography>
                  <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now + hours * 3600 * 1000)}</Typography>
                </Box>
                <Alert severity="warning" sx={{ mt: 2, mb: 3 }}>{t('offline.clock_warning')}</Alert>

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
            )}
          </>
        ) : (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>{result.multisig ? t('offline_cosign.sym_ms_done_note') : t('offline.done_note')}</Alert>
            <SectionCard>
              {result.multisig && <Row label={t('offline_cosign.nem_label_multisig')}>{result.multisig.address}</Row>}
              <Row label={t('offline.result_hash')}>{result.hash}</Row>
              {result.multisig && <Row label={t('offline_cosign.sym_ms_lock_hash')}>{result.multisig.lockHash}</Row>}
              <Row label={result.multisig ? t('offline_cosign.sym_ms_agg_fee') : t('offline.tx_fee')}>{result.feeText}</Row>
              {result.multisig && <Row label={t('offline_cosign.sym_ms_lock_fee')}>{result.multisig.lockFeeText}</Row>}
              {result.multisig && <Row label={t('offline_cosign.sym_ms_lock_deposit')}>{result.multisig.depositText}</Row>}
              <Row label={t('offline.result_deadline')}>{timeText(result.deadlineMs)}</Row>
            </SectionCard>
            <SectionCard title={t('offline.qr_title')}>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline.qr_hint')}</Typography>
              <QrTextPanel
                text={result.text}
                file={{ text: result.text, name: `kasane-${result.multisig ? 'multisig-request' : 'signed'}-${result.hash.slice(0, 8).toLowerCase()}.json` }}
                note={t('signqr.export_note', { time: new Date(result.deadlineMs).toLocaleString() })}
              />
            </SectionCard>
            <Button onClick={reset} sx={{ mt: 2 }}>{t('offline.another')}</Button>
          </>
        )}
      </Box>

      <PasswordDialog
        open={showPassword}
        mode="check" popup
        onClose={() => setShowPassword(false)}
        onPass={(password) => { setShowPassword(false); void onPassed(password); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </OfflineShell>
  );
}
