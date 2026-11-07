import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, MenuItem, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { loadKnownNemMosaics } from '../../lib/mosaicCache';
import { WalletsHelper } from '../../lib/storage';
import { formatAtomic } from '../../lib/symbol/amount';
import { getNetwork } from '../../lib/symbol/network';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_NATIVE_ID, NEM_TX_TYPE_TRANSFER } from '../../lib/nem/constants';
import { nemAddressFromPublicKey, verifyNemSignature } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { buildNemSignedQr, nemHexToBytes, parseNemSigned, readNemMultisigRequest, readNemTransfer } from '../../lib/nem/offline';
import type { NemMultisigRequestSummary } from '../../lib/nem/offline';
import { signNemCosignature } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox, mono } from '../multisig/parts';
import OfflineCosignImport from './OfflineCosignImport';
import { accountLabel, useSigningAccounts } from './signingAccounts';

// 「オフライン連署」 for NEM (NIS1): cosigns a multisig transaction that another cosignatory started, on a PC with no network.
// Unlike Symbol, NEM has no aggregate hash to look up on a node, so the request is the transaction the initiator signed (a "multisig
// transaction", type 0x1004, as the body of POST /transaction/announce, in KASANE's NEM QR or as a bare body). Nothing here talks to a node:
//   - everything shown is read from the bytes (the wrapped transaction, the multisig account, the hash a cosignature names);
//   - the initiator's signature is checked with the key the transaction carries;
//   - "expired" is judged by this device's clock, and mosaics are named from what this device remembers (lib/mosaicCache.ts).
// The cosignature is the body of POST /transaction/announce as KASANE's NEM QR, which 「読み込んで送信」 sends from a PC that is online.
// (NEM only accepts a cosignature once the transaction it names is waiting on the network: send the initiator's one first.)

const DETAIL_ROW_SX = { fontSize: '0.95rem', whiteSpace: 'pre-wrap', ...mono } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ py: 1 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem' }}>{label}</Typography>
      <Typography component="div" sx={DETAIL_ROW_SX}>{children}</Typography>
    </Box>
  );
}

const timeText = (ms: number) => new Date(ms).toLocaleString(undefined, { hour12: false, timeZoneName: 'short' });

interface Result { text: string; innerHash: string; cosigner: string; deadlineMs: number }

export default function OfflineNemCosign({ onStep }: { onStep: (step: number) => void }) {
  const { t } = useTranslation();
  // Another network: this screen is drawn again (cfg is that network's configuration).
  const network = useAppStore((s) => s.network);
  const cfg = getNemNetworkConfig();
  const { accounts, setSignerId, signer } = useSigningAccounts('nem');

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- reading the request ---------------------------------------------------------------------
  const [loadError, setLoadError] = useState('');
  const [request, setRequest] = useState<NemMultisigRequestSummary | null>(null);

  // Mosaics this device remembers for its accounts, so a quantity can be shown with its decimals.
  const [known, setKnown] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(accounts.map((w) => loadKnownNemMosaics(getNetwork(), w.address))).then((lists) => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const m of lists.flat()) next[m.id] = m.divisibility;
      setKnown(next);
    });
    return () => { cancelled = true; };
  }, [accounts, network]);

  const load = (raw: string): boolean => {
    const parsed = parseNemSigned(raw);
    if (parsed === null) { setLoadError(t('signqr.invalid')); return false; }
    if (parsed.networkId !== null && parsed.networkId !== cfg.networkByte) { setLoadError(t('signqr.wrong_network', { network: cfg.label })); return false; }
    let summary: NemMultisigRequestSummary;
    try {
      summary = readNemMultisigRequest(parsed.body.data);
    } catch {
      // A transaction that is not a multisig one (e.g. a plain transfer) has nothing to cosign.
      setLoadError(t('offline_cosign.nem_not_request'));
      return false;
    }
    if (summary.networkByte !== cfg.networkByte) { setLoadError(t('signqr.wrong_network', { network: cfg.label })); return false; }
    // The initiator's signature, with the key the transaction carries: a body that was changed after it was signed is refused.
    if (!verifyNemSignature(summary.initiatorPublicKey, nemHexToBytes(parsed.body.data), nemHexToBytes(parsed.body.signature))) {
      setLoadError(t('signqr.problem_bad_signature'));
      return false;
    }
    setLoadError('');
    setRequest(summary);
    return true;
  };

  const initiatorAddress = useMemo(() => (request ? nemAddressFromPublicKey(request.initiatorPublicKey, request.networkByte) : ''), [request]);
  const multisigAddress = useMemo(() => (request ? nemAddressFromPublicKey(request.multisigPublicKey, request.networkByte) : ''), [request]);

  // What the wrapped transaction does, as lines of text.
  const transfer = request?.inner.transfer ?? null;
  const mosaicLines = useMemo(() => {
    if (transfer === null) return [];
    return transfer.mosaics.map((m) => {
      if (m.id === NEM_NATIVE_ID) return `${formatAtomic(m.quantity, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;
      const divisibility = known[m.id];
      // A mosaic this device does not remember is shown in its raw units, said so.
      return divisibility === undefined ? `${m.quantity.toString()} ${m.id} (${t('signqr.nem_raw_units')})` : `${formatAtomic(m.quantity, divisibility)} ${m.id}`;
    });
  }, [transfer, known, t]);
  const kindTitle = request === null ? '' : request.inner.typeValue === NEM_TX_TYPE_TRANSFER
    ? t('signqr.type_transfer')
    : t(`offline_tx.nem_type_${request.inner.typeValue}`, { defaultValue: t('signqr.type_other', { type: `0x${request.inner.typeValue.toString(16).toUpperCase()}` }) });

  // --- cosigning ------------------------------------------------------------------------------
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const expired = request !== null && request.deadlineMs < now;
  const isInitiator = request !== null && signer !== null && request.initiatorPublicKey === signer.publicKey.toUpperCase();
  const canSign = request !== null && signer !== null && !expired && !isInitiator && !busy;

  const onPassed = async (password: string) => {
    if (request === null || signer === null) return;
    setBusy(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      // The hash that is signed is the one worked out from the bytes above, never anything the QR claimed.
      const body = signNemCosignature(privateKey, signer.publicKey, cfg.networkByte, multisigAddress, request.innerHash);
      const signed = readNemTransfer((JSON.parse(body) as { data: string }).data);
      setResult({
        text: buildNemSignedQr(body, cfg.networkByte),
        innerHash: request.innerHash,
        cosigner: signer.address,
        deadlineMs: signed.deadlineMs,
      });
    } catch (e) {
      console.error('Failed to cosign a NEM transaction offline', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setRequest(null); setResult(null); setLoadError(''); };

  const step = request === null ? 0 : result === null ? 1 : 2;
  useEffect(() => { onStep(step); }, [step, onStep]);

  return (
    <>
      <Box>
        {request === null ? (
          <OfflineCosignImport intro={t('offline_cosign.nem_intro')} error={loadError} onError={setLoadError} onLoad={load} />
        ) : result !== null ? (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>{t('offline_cosign.nem_done_note')}</Alert>
            <SectionCard>
              <Row label={t('signqr.label_cosigner')}>{result.cosigner}</Row>
              <Row label={t('offline_cosign.nem_label_multisig')}>{multisigAddress}</Row>
              <Row label={t('offline_cosign.nem_label_inner_hash')}>{result.innerHash}</Row>
              <Row label={t('offline.result_deadline')}>{timeText(result.deadlineMs)}</Row>
            </SectionCard>
            <SectionCard title={t('signqr.cosignature_qr_title')}>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline_cosign.qr_hint')}</Typography>
              <QrTextPanel text={result.text} file={{ text: result.text, name: `kasane-nem-cosignature-${result.innerHash.slice(0, 8).toLowerCase()}.json` }} />
            </SectionCard>
            <Button onClick={reset} sx={{ mt: 1 }}>{t('offline_cosign.another')}</Button>
          </>
        ) : (
          <>
            <Alert severity="info" sx={{ mb: 2 }}>{t('offline_cosign.nem_cosign_note')}</Alert>
            <SectionCard>
              <Row label={t('signqr.label_type')}>{kindTitle} (NEM)</Row>
              <Row label={t('offline_cosign.nem_label_multisig')}>{multisigAddress}</Row>
              <Row label={t('offline_cosign.nem_label_initiator')}>{initiatorAddress}</Row>
              {transfer !== null && <Row label={t('signqr.label_recipient')}>{transfer.recipient}</Row>}
              {transfer !== null && <Row label={t('signqr.label_mosaic')}>{mosaicLines.join('\n')}</Row>}
              {transfer?.message && (
                <Row label={t('signqr.label_message')}>
                  {transfer.message.encrypted ? t('signqr.nem_message_encrypted') : transfer.message.text ?? t('signqr.nem_message_unreadable')}
                </Row>
              )}
              <Row label={t('signqr.label_deadline')}>{timeText(request.deadlineMs)}</Row>
              <Row label={t('offline.now')}>{timeText(now)}</Row>
              <Row label={t('signqr.label_fee')}>{formatAtomic(request.fee, NEM_CURRENCY_DIVISIBILITY)} {NEM_CURRENCY_SYMBOL}</Row>
              <Row label={t('offline_cosign.nem_label_inner_hash')}>{request.innerHash}</Row>
            </SectionCard>
            {transfer === null && <Alert severity="info" sx={{ mb: 2 }}>{t('offline_cosign.nem_other_note')}</Alert>}
            <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.signature_valid')}</Alert>
            {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
            <Alert severity="warning" sx={{ mb: 2 }}>{t('offline_cosign.clock_warning')}</Alert>

            <SectionCard>
              <FormRow label={t('offline_cosign.cosigner')} top>
                <Field
                  select
                  ariaLabel={t('offline_cosign.cosigner')}
                  value={signer ? signer.id : ''}
                  onChange={(e) => setSignerId(e.target.value)}
                  error={accounts.length === 0}
                  helperText={accounts.length === 0 ? t('offline.nem_sender_none') : t('offline_cosign.cosigner_hint')}
                >
                  {accounts.map((w) => <MenuItem key={w.id} value={w.id}>{accountLabel(w, t('wallet.account_imported'))}</MenuItem>)}
                </Field>
                {signer && <Box sx={{ mt: 0.75 }}><ValueBox>{signer.address}</ValueBox></Box>}
              </FormRow>
            </SectionCard>
            {isInitiator && <Alert severity="success" sx={{ mb: 2 }}>{t('multisig.signed_by_me')}</Alert>}

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
              {busy ? t('offline.signing') : t('signqr.cosign_button')}
            </Button>
            <Button onClick={reset} sx={{ mt: 2 }}>{t('offline_ui.back_to_import')}</Button>
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
    </>
  );
}
