import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, IconButton, MenuItem, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
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
import { isValidNemAddress, normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { buildNemSignedQr, readNemTransfer } from '../../lib/nem/offline';
import { nemMessageByteLength, nemSendFee, signNemTransfer } from '../../lib/nem/tx';
import type { NemMosaicAmount, NemMosaicFeeInfo } from '../../lib/nem/tx';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import { accountLabel, useSigningAccounts } from './signingAccounts';

// 「オフライン署名」 for NEM (NIS1). Like the Symbol one it never talks to a node: the fee is worked out here by NIS1's own
// rules (there is no fee multiplier on NEM), the deadline comes from this device's clock, and the message is plain (an
// encrypted one needs the recipient's public key from the chain). The mosaics to choose from are the ones this account
// was seen to hold while online (lib/mosaicCache.ts), with the supply and divisibility the fee needs, plus XEM.
// The result is the body of POST /transaction/announce, as KASANE's NEM QR, which 「署名・連署QR」 reads on a PC that is online.

interface RowState { id: string; amount: string }
interface Option { id: string; divisibility: number; supply: bigint; native: boolean }

const MAX_MOSAICS = 10;
const HOURS = [1, 2, 6, 12, 24]; // NIS1 accepts a deadline up to 24 hours after the time stamp
const XEM: Option = { id: NEM_NATIVE_ID, divisibility: NEM_CURRENCY_DIVISIBILITY, supply: 8_999_999_999n, native: true };

interface Result { text: string; deadlineMs: number; feeText: string; recipient: string }

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
  const [showPassword, setShowPassword] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const { accounts, setSignerId, signer } = useSigningAccounts('nem');
  const address = signer ? signer.address : '';

  // --- the mosaics to choose from ---------------------------------------------------------------
  const [known, setKnown] = useState<Option[]>([]);
  useEffect(() => {
    let cancelled = false;
    setKnown([]);
    if (address === '') return undefined;
    void loadKnownNemMosaics(getNetwork(), address).then((list) => {
      if (cancelled) return;
      setKnown(list.filter((m) => m.id !== NEM_NATIVE_ID).map((m) => ({ id: m.id, divisibility: m.divisibility, supply: BigInt(m.supply), native: false })));
    });
    return () => { cancelled = true; };
  }, [address]);
  const options: Option[] = [XEM, ...known];
  const optionText = (o: Option) => (o.native ? `${NEM_CURRENCY_SYMBOL} (${t('offline.native')})` : o.id);

  // Another account has other mosaics: rows pointing at one that is not offered any more go back to XEM.
  useEffect(() => {
    setRows((prev) => {
      const kept = prev.filter((r) => r.id === NEM_NATIVE_ID || known.some((m) => m.id === r.id));
      return kept.length === prev.length ? prev : kept.length > 0 ? kept : [{ id: NEM_NATIVE_ID, amount: '' }];
    });
  }, [known]);

  const setRow = (i: number, patch: Partial<RowState>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const optionsFor = (i: number) => {
    const usedElsewhere = new Set(rows.filter((_, j) => j !== i).map((r) => r.id));
    return options.filter((o) => o.id === rows[i].id || !usedElsewhere.has(o.id));
  };
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
  const canSign = signer !== null && address !== '' && recipientOk && allValid && messageOk && fee !== null && !signing;

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
          <SectionCard>
            <FormRow label={t('offline.network')}><ValueBox>{cfg.label}</ValueBox></FormRow>
            <FormRow label={t('offline.sender')} top>
              <Field
                select
                ariaLabel={t('offline.sender')}
                value={signer ? signer.id : ''}
                onChange={(e) => { setSignerId(e.target.value); setRows([{ id: NEM_NATIVE_ID, amount: '' }]); }}
                error={accounts.length === 0}
                helperText={accounts.length === 0 ? t('offline.nem_sender_none') : ''}
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
            {known.length === 0 && <Alert severity="info" sx={{ my: 1 }}>{t('offline.nem_mosaic_none_cached')}</Alert>}
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
                helperText={!messageOk ? t('offline.message_too_long', { max: NEM_MAX_MESSAGE_BYTES }) : t('offline.message_hint')}
              />
            </FormRow>
          </SectionCard>

          <SectionCard title={t('offline.settings_title')}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('offline.nem_settings_note')}</Typography>
            <FormRow label={t('offline.tx_fee')}>
              <Typography>{fee === null ? '–' : `${formatAtomic(fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`}</Typography>
            </FormRow>
            <FormRow label={t('offline.validity')} top>
              <Field select ariaLabel={t('offline.validity')} value={hours} onChange={(e) => setHours(Number(e.target.value))} helperText={t('offline.nem_validity_hint')}>
                {HOURS.map((h) => <MenuItem key={h} value={h}>{t('offline.hours', { count: h })}</MenuItem>)}
              </Field>
            </FormRow>
            <FormRow label={t('offline.now')}>
              <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now)}</Typography>
            </FormRow>
            <FormRow label={t('offline.deadline')}>
              <Typography sx={{ fontVariantNumeric: 'tabular-nums' }}>{timeText(now + hours * 3600 * 1000)}</Typography>
            </FormRow>
            <Alert severity="warning" sx={{ mt: 1 }}>{t('offline.nem_clock_warning')}</Alert>
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
      ) : (
        <>
          <Alert severity="success" sx={{ mb: 2 }}>{t('offline.done_note')}</Alert>
          <SectionCard>
            <Row label={t('offline.recipient')}>{result.recipient}</Row>
            <Row label={t('offline.tx_fee')}>{result.feeText}</Row>
            <Row label={t('offline.result_deadline')}>{timeText(result.deadlineMs)}</Row>
            <Typography variant="body2" sx={{ color: 'text.secondary', pb: 1 }}>{t('offline.nem_hash_later')}</Typography>
          </SectionCard>
          <SectionCard title={t('offline.qr_title')}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline.qr_hint')}</Typography>
            <QrTextPanel
              text={result.text}
              file={{ text: result.text, name: `kasane-nem-signed-${Date.now().toString(36)}.json` }}
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
