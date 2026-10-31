import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, IconButton, MenuItem, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { WalletsHelper } from '../../lib/storage';
import { CHAINS, CHAIN_ORDER } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { loadKnownMosaics } from '../../lib/mosaicCache';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { decodeAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { buildKasaneQr } from '../../lib/symbol/kasaneQr';
import { getNetwork, getNetworkConfig } from '../../lib/symbol/network';
import { MAX_MESSAGE_BYTES, messageByteLength, signTransfer, transferSize } from '../../lib/symbol/tx';
import type { MosaicAmount } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import OfflineNemTransfer from './OfflineNemTransfer';
import OfflineShell from './OfflineShell';
import { accountLabel, useSigningAccounts } from './signingAccounts';

// 「オフライン署名」: signs a transfer on a PC that has no network connection and hands it over as a QR code /
// JSON text / .json file. It is opened from the profile-selection screen (オフライントランザクション), so it does
// not depend on the chain selected in the app or on the active account: the chain (Symbol / NEM) and the account
// that signs (送信元) are chosen on this screen, and the recipient is any address.
// (NEM has its own form: OfflineNemTransfer.tsx.)
// Nothing on this screen talks to a node: the fee multiplier and the validity period are typed in (the defaults are
// the usual values), the deadline comes from this device's clock, and the message is never encrypted (that needs the
// recipient's public key from the chain). The mosaics are not typed in either: they are chosen from the ones this
// account was seen to hold while online (lib/mosaicCache.ts), plus the network currency, with the divisibility that
// was read from the chain at that time.
// The signed result is the same "signed" QR that 「署名・連署QR」 reads on a PC that is online.

interface MosaicRowState { id: string; amount: string }
interface MosaicOption { id: string; symbol: string; divisibility: number; native: boolean }

const MAX_MOSAICS = 10;
const HOURS = [1, 2, 3, 6]; // a transaction may stay valid for at most 6 hours
const DEFAULT_FEE_MULTIPLIER = '100';
const MAX_FEE_MULTIPLIER = 100000;

interface Result { text: string; hash: string; deadlineMs: number; feeText: string }

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
  const [feeMultiplier, setFeeMultiplier] = useState(DEFAULT_FEE_MULTIPLIER);
  const [hours, setHours] = useState(2);
  const [showPassword, setShowPassword] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  // --- the account that signs (送信元) -----------------------------------------------------------
  const { accounts, setSignerId, signer } = useSigningAccounts();
  // Derived from the key for the network that is selected (so it follows 設定 > ネットワーク).
  const address = signer ? signer.address : '';

  // --- the mosaics to choose from ----------------------------------------------------------------
  const [known, setKnown] = useState<MosaicOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    setKnown([]);
    if (address === '') return undefined;
    void loadKnownMosaics(getNetwork(), address).then((list) => {
      if (cancelled) return;
      setKnown(list.filter((m) => m.id !== nativeId).map((m) => ({ id: m.id, symbol: m.symbol, divisibility: m.divisibility, native: false })));
    });
    return () => { cancelled = true; };
  }, [address, network, nativeId]);
  const options: MosaicOption[] = [{ id: nativeId, symbol: CURRENCY_SYMBOL, divisibility: CURRENCY_DIVISIBILITY, native: true }, ...known];
  const optionText = (o: MosaicOption) => (o.native ? `${o.symbol} (${t('offline.native')})` : o.symbol === o.id ? o.id : `${o.symbol} (${o.id})`);

  // Another account (or network) has other mosaics: rows pointing at one that is not offered any more go back to the currency.
  useEffect(() => {
    setRows((prev) => {
      const kept = prev.filter((r) => r.id === nativeId || known.some((m) => m.id === r.id));
      return kept.length === prev.length ? prev : kept.length > 0 ? kept : [{ id: nativeId, amount: '' }];
    });
  }, [known, nativeId]);

  const setRow = (i: number, patch: Partial<MosaicRowState>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const optionsFor = (i: number) => {
    const usedElsewhere = new Set(rows.filter((_, j) => j !== i).map((r) => r.id));
    return options.filter((o) => o.id === rows[i].id || !usedElsewhere.has(o.id));
  };
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
  const multiplier = /^\d+$/.test(feeMultiplier.trim()) ? Number(feeMultiplier.trim()) : 0;
  const multiplierOk = multiplier >= 1 && multiplier <= MAX_FEE_MULTIPLIER;
  const fee = multiplierOk ? BigInt(transferSize(rows.length, message || undefined)) * BigInt(multiplier) : null;
  const canSign = signer !== null && address !== '' && recipientOk && parsedRows.every((r) => r.valid) && !duplicate && messageOk && multiplierOk && !signing;

  // --- signing --------------------------------------------------------------------------------
  const onPassed = async (password: string) => {
    if (fee === null || signer === null) return;
    setSigning(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const mosaics: MosaicAmount[] = parsedRows.map((r) => ({ id: r.id, amount: r.amount as bigint }));
      // The deadline is counted in ms since the network epoch, from this device's own clock (no /node/time).
      const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + BigInt(hours) * 3600n * 1000n;
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
            <SectionCard>
              <FormRow label={t('offline.chain')}>
                <ToggleButtonGroup
                  exclusive
                  fullWidth
                  size="small"
                  color="primary"
                  value={target}
                  onChange={(_, v: ChainKey | null) => { if (v !== null) { setTarget(v); setNemDone(false); } }}
                  aria-label={t('offline.chain')}
                >
                  {CHAIN_ORDER.map((key) => <ToggleButton key={key} value={key}>{CHAINS[key].name}</ToggleButton>)}
                </ToggleButtonGroup>
              </FormRow>
            </SectionCard>
            )}

            {target === 'nem' ? (
              <OfflineNemTransfer onDone={setNemDone} />
            ) : (
              <>
                <SectionCard>
                  <FormRow label={t('offline.network')}><ValueBox>{cfg.label}</ValueBox></FormRow>
                  <FormRow label={t('offline.sender')} top>
                    <Field
                      select
                      ariaLabel={t('offline.sender')}
                      value={signer ? signer.id : ''}
                      onChange={(e) => { setSignerId(e.target.value); setRows([{ id: nativeId, amount: '' }]); }}
                      error={accounts.length === 0}
                      helperText={accounts.length === 0 ? t('offline.sender_none') : ''}
                    >
                      {accounts.map((w) => <MenuItem key={w.id} value={w.id}>{accountLabel(w, t('wallet.account_imported'))}</MenuItem>)}
                    </Field>
                    {address !== '' && <Box sx={{ mt: 0.75 }}><ValueBox>{address}</ValueBox></Box>}
                  </FormRow>
                  <FormRow label={t('offline.recipient')} top>
                    <Field
                      ariaLabel={t('offline.recipient')}
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      error={recipient !== '' && !recipientOk}
                      helperText={recipient !== '' && !recipientOk ? t('offline.recipient_invalid') : t('offline.recipient_hint')}
                      htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                    />
                  </FormRow>

                  {rows.map((r, i) => {
                    const p = parsedRows[i];
                    return (
                      <Box key={i} sx={{ borderTop: 1, borderColor: 'divider', mt: 1, pt: 1 }}>
                        <FormRow label={rows.length > 1 ? t('offline.mosaic_n', { n: i + 1 }) : t('offline.mosaic')} top>
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Field
                                select
                                ariaLabel={t('offline.mosaic')}
                                value={r.id}
                                onChange={(e) => setRow(i, { id: e.target.value })}
                                helperText={i === 0 ? t('offline.mosaic_hint') : ''}
                              >
                                {optionsFor(i).map((o) => <MenuItem key={o.id} value={o.id} sx={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{optionText(o)}</MenuItem>)}
                              </Field>
                            </Box>
                            {rows.length > 1 && (
                              <IconButton onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))} aria-label={t('offline.remove_mosaic')}><DeleteOutlinedIcon /></IconButton>
                            )}
                          </Box>
                        </FormRow>
                        <FormRow label={t('offline.amount')} top>
                          <Field
                            ariaLabel={t('offline.amount')}
                            value={r.amount}
                            onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                            error={r.amount !== '' && (p.amount === null || p.amount <= 0n)}
                            helperText={r.amount !== '' && p.amount === null ? t('offline.amount_invalid') : t('offline.amount_hint', { n: p.divisibility })}
                            htmlInput={{ inputMode: 'decimal' }}
                          />
                        </FormRow>
                      </Box>
                    );
                  })}
                  {duplicate && <Alert severity="error" sx={{ my: 1 }}>{t('offline.duplicate_mosaic')}</Alert>}
                  {known.length === 0 && <Alert severity="info" sx={{ my: 1 }}>{t('offline.mosaic_none_cached')}</Alert>}
                  {rows.length < MAX_MOSAICS && unusedCount > 0 && (
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      onClick={() => setRows((prev) => [...prev, { id: options.find((o) => !prev.some((r) => r.id === o.id))?.id ?? '', amount: '' }])}
                      sx={{ mb: 1 }}
                    >
                      {t('offline.add_mosaic')}
                    </Button>
                  )}

                  <FormRow label={t('offline.message')} top>
                    <Field
                      ariaLabel={t('offline.message')}
                      multiline
                      minRows={2}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      error={!messageOk}
                      helperText={!messageOk ? t('offline.message_too_long', { max: MAX_MESSAGE_BYTES }) : t('offline.message_hint')}
                    />
                  </FormRow>
                </SectionCard>

                <SectionCard title={t('offline.settings_title')}>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('offline.settings_note')}</Typography>
                  <FormRow label={t('offline.fee_multiplier')} top>
                    <Field
                      ariaLabel={t('offline.fee_multiplier')}
                      value={feeMultiplier}
                      onChange={(e) => setFeeMultiplier(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                      error={!multiplierOk}
                      helperText={t('offline.fee_multiplier_hint')}
                      htmlInput={{ inputMode: 'numeric' }}
                    />
                  </FormRow>
                  <FormRow label={t('offline.tx_fee')}>
                    <Typography>{fee === null ? '–' : `${formatAtomic(fee, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`}</Typography>
                  </FormRow>
                  <FormRow label={t('offline.validity')} top>
                    <Field select ariaLabel={t('offline.validity')} value={hours} onChange={(e) => setHours(Number(e.target.value))} helperText={t('offline.validity_hint')}>
                      {HOURS.map((h) => <MenuItem key={h} value={h}>{t('offline.hours', { count: h })}</MenuItem>)}
                    </Field>
                  </FormRow>
                  <FormRow label={t('offline.now')}>
                    <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now)}</Typography>
                  </FormRow>
                  <FormRow label={t('offline.deadline')}>
                    <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now + hours * 3600 * 1000)}</Typography>
                  </FormRow>
                  <Alert severity="warning" sx={{ mt: 1 }}>{t('offline.clock_warning')}</Alert>
                </SectionCard>

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
            <Alert severity="success" sx={{ mb: 2 }}>{t('offline.done_note')}</Alert>
            <SectionCard>
              <Row label={t('offline.result_hash')}>{result.hash}</Row>
              <Row label={t('offline.tx_fee')}>{result.feeText}</Row>
              <Row label={t('offline.result_deadline')}>{timeText(result.deadlineMs)}</Row>
            </SectionCard>
            <SectionCard title={t('offline.qr_title')}>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline.qr_hint')}</Typography>
              <QrTextPanel
                text={result.text}
                file={{ text: result.text, name: `kasane-signed-${result.hash.slice(0, 8).toLowerCase()}.json` }}
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
