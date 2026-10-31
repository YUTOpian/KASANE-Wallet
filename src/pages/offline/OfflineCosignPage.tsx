import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AppBar, Box, Button, Dialog, IconButton, MenuItem, TextField, Toolbar, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import FileOpenOutlinedIcon from '@mui/icons-material/FileOpenOutlined';
import { Scanner } from '@yudiel/react-qr-scanner';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import SignerTrustNotice from '../../components/SignerTrustNotice';
import BlockedSignerDialog from '../../components/BlockedSignerDialog';
import { checkSignerTrust } from '../../lib/signerTrust';
import QrTextPanel from '../../components/QrTextPanel';
import { WalletsHelper } from '../../lib/storage';
import { loadKnownMosaics } from '../../lib/mosaicCache';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { buildKasaneQr, networkProblem } from '../../lib/symbol/kasaneQr';
import { parseAnyInput } from '../../lib/symbol/externalPayload';
import { decodeQrFromImageFile } from '../../lib/qrImage';
import type { CosignRequestQr } from '../../lib/symbol/kasaneQr';
import { getNetwork, getNetworkConfig } from '../../lib/symbol/network';
import { summarizePayload } from '../../lib/symbol/payloadSummary';
import type { PayloadSummary } from '../../lib/symbol/payloadSummary';
import { cosignAggregateHash } from '../../lib/symbol/tx';
import type { CosignatureBody } from '../../lib/symbol/tx';
import { Field, FormRow, ItemView, SectionCard, ValueBox, mono } from '../multisig/parts';
import OfflineShell from './OfflineShell';
import { accountLabel, useSigningAccounts } from './signingAccounts';

// 「オフライン連署」: cosigns a bonded aggregate (a multisig transfer or change that someone else started) on a PC
// that has no network connection, and hands the cosignature back as a QR code / JSON text / .json file.
// Nothing on this screen talks to a node:
//   - the request must carry the aggregate itself (a request that holds only the hash cannot be checked, so it is refused);
//   - everything shown is read from the bytes (the hash is recomputed, the network and the signature are checked);
//   - mosaics are named from the network currency and from what this device remembers (lib/mosaicCache.ts);
//     any other mosaic is shown by its id with the raw amount;
//   - "expired" is judged by this device's clock.
// The cosignature is the same "cosignature" QR that 「署名・連署QR」 reads on a PC that is online.

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

export default function OfflineCosignPage() {
  const { t } = useTranslation();
  const cfg = getNetworkConfig();
  const { accounts, setSignerId, signer } = useSigningAccounts();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- reading the request ---------------------------------------------------------------------
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [request, setRequest] = useState<CosignRequestQr | null>(null);
  const [summary, setSummary] = useState<PayloadSummary | null>(null);
  const [problem, setProblem] = useState('');

  // Mosaics this device remembers for its accounts, so an amount can be shown with its symbol and decimals.
  const [known, setKnown] = useState<Record<string, { symbol: string; divisibility: number }>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(accounts.map((w) => loadKnownMosaics(getNetwork(), w.address))).then((lists) => {
      if (cancelled) return;
      const next: Record<string, { symbol: string; divisibility: number }> = {};
      for (const m of lists.flat()) next[m.id] = { symbol: m.symbol, divisibility: m.divisibility };
      setKnown(next);
    });
    return () => { cancelled = true; };
  }, [accounts]);

  const load = (raw: string) => {
    const parsed = parseAnyInput(raw);
    if (parsed === null) { setLoadError(t('signqr.invalid')); return; }
    if (networkProblem(parsed) !== null) { setLoadError(t('signqr.wrong_network', { network: cfg.label })); return; }
    if (parsed.qr.kind !== 'cosign_request') { setLoadError(t('offline_cosign.not_request')); return; }
    if (!parsed.qr.payload) { setLoadError(t('offline_cosign.hash_only')); return; }
    setLoadError('');
    setScanOpen(false);
    setProblem('');
    setSummary(null);
    setRequest(parsed.qr);
  };

  useEffect(() => {
    if (request === null || !request.payload) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const s = await summarizePayload(request.payload as string, { offline: true, knownMosaics: known });
        if (cancelled) return;
        // Everything below is read from the bytes, not from the QR's own claims.
        if (!s.bonded) setProblem('not_bonded');
        else if (s.hash !== request.hash) setProblem('hash_mismatch');
        else if (s.networkByte !== cfg.networkByte) setProblem('wrong_network');
        else if (!s.signed) setProblem('not_signed');
        else if (!s.contentsMatchHash) setProblem('contents_mismatch');
        else setSummary(s);
      } catch {
        if (!cancelled) setProblem('invalid_payload');
      }
    })();
    return () => { cancelled = true; };
  }, [request, known, cfg.networkByte]);

  // --- cosigning ------------------------------------------------------------------------------
  const [showPassword, setShowPassword] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [body, setBody] = useState<CosignatureBody | null>(null);

  const expired = summary !== null && summary.deadlineMs < now;
  const isInitiator = summary !== null && signer !== null && summary.signerPublicKey === signer.publicKey.toUpperCase();
  const canSign = summary !== null && signer !== null && !expired && !isInitiator && !busy;

  const onPassed = async (password: string) => {
    if (summary === null || signer === null) return;
    setBusy(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      // The hash that is signed is the one recomputed from the bytes above, never the one the QR claimed.
      setBody(cosignAggregateHash(privateKey, summary.hash));
    } catch (e) {
      console.error('Failed to cosign offline', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resultText = body === null
    ? ''
    : buildKasaneQr({ kind: 'cosignature', parentHash: body.parentHash, signerPublicKey: body.signerPublicKey, signature: body.signature, version: body.version });

  const reset = () => { setRequest(null); setSummary(null); setProblem(''); setBody(null); setText(''); setLoadError(''); };

  const step = request === null ? 0 : body === null ? 1 : 2;

  return (
    <OfflineShell tab="cosign" steps={[t('offline_ui.step_import'), t('offline_ui.step_review'), t('offline_ui.step_download')]} step={step}>
      <Box>
        {request === null ? (
          <SectionCard>
            <Typography sx={{ fontWeight: 'bold', fontSize: '1.1rem', textAlign: 'center', mb: 0.5 }}>{t('offline_ui.import_title')}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, textAlign: 'center', mb: 2 }}>{t('offline_cosign.intro')}</Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, maxWidth: 420, mx: 'auto', mb: 2 }}>
              <Button variant="contained" color="primary" size="large" fullWidth startIcon={<QrCodeScannerIcon />} onClick={() => setScanOpen(true)}>{t('offline_ui.import_qr')}</Button>
              {/* One button for a saved QR image and a JSON file alike: an image is read for its QR code, anything else is read as text. */}
              <Button component="label" variant="outlined" color="primary" size="large" fullWidth startIcon={<FileOpenOutlinedIcon />}>
                {t('offline_ui.import_file')}
                <input
                  type="file"
                  hidden
                  accept="image/*,.json,application/json,text/plain"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (file.type.startsWith('image/')) {
                      decodeQrFromImageFile(file)
                        .then((qr) => { if (qr === null) setLoadError(t('signqr.image_not_found')); else load(qr); })
                        .catch(() => setLoadError(t('signqr.image_not_found')));
                      return;
                    }
                    file.text().then((content) => { setText(content); load(content); }).catch(() => setLoadError(t('signqr.invalid')));
                  }}
                />
              </Button>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', mb: 1 }}>{t('offline_ui.import_payload_note')}</Typography>
            {loadError !== '' && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.5, alignItems: 'stretch' }}>
              <TextField
                fullWidth
                multiline
                minRows={4}
                maxRows={10}
                placeholder={t('offline_ui.payload_placeholder')}
                value={text}
                onChange={(e) => { setText(e.target.value); setLoadError(''); }}
                error={loadError !== ''}
                slotProps={{ htmlInput: { 'aria-label': t('offline_ui.payload_placeholder'), autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } } }}
              />
              <Button variant="contained" color="primary" disabled={text.trim() === ''} onClick={() => load(text)} sx={{ minWidth: { sm: 180 }, whiteSpace: 'nowrap' }}>{t('offline_ui.import_payload')}</Button>
            </Box>
          </SectionCard>
        ) : body !== null ? (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>{t('offline_cosign.done_note')}</Alert>
            <SectionCard>
              <Row label={t('signqr.label_cosigner')}>{signer?.address ?? ''}</Row>
              <Row label={t('signqr.label_parent_hash')}>{body.parentHash}</Row>
            </SectionCard>
            <SectionCard title={t('signqr.cosignature_qr_title')}>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('offline_cosign.qr_hint')}</Typography>
              <QrTextPanel text={resultText} file={{ text: resultText, name: `kasane-cosignature-${body.parentHash.slice(0, 8).toLowerCase()}.json` }} />
            </SectionCard>
            <Button onClick={reset} sx={{ mt: 1 }}>{t('offline_cosign.another')}</Button>
          </>
        ) : (
          <>
            <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.cosign_note')}</Alert>
            {problem !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t(`signqr.problem_${problem}`)}</Alert>}
            {problem === '' && summary === null && <Typography sx={{ color: 'text.secondary' }}>{t('common.loading')}</Typography>}
            {summary && (
              <>
                <SectionCard>
                  <Row label={t('signqr.label_initiator')}>{summary.signerAddress}</Row>
                  <Row label={t('signqr.label_deadline')}>{timeText(summary.deadlineMs)}</Row>
                  <Row label={t('offline.now')}>{timeText(now)}</Row>
                  <Row label={t('signqr.label_fee')}>{formatAtomic(summary.fee, CURRENCY_DIVISIBILITY)} {CURRENCY_SYMBOL}</Row>
                  <Row label={t('signqr.label_hash')}>{summary.hash}</Row>
                </SectionCard>
                <SignerTrustNotice address={summary.signerAddress} sx={{ mb: 2 }} />
                <SectionCard>{summary.items.map((item, i) => <ItemView key={i} item={item} />)}</SectionCard>
                <Alert severity="info" sx={{ mb: 2 }}>{t('offline_cosign.unknown_mosaic_note')}</Alert>
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
                      helperText={accounts.length === 0 ? t('offline.sender_none') : t('offline_cosign.cosigner_hint')}
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
                  onClick={async () => { if ((await checkSignerTrust(summary.signerAddress)) === 'black') setShowBlocked(true); else setShowPassword(true); }}
                  startIcon={<LockOutlinedIcon />}
                  sx={{ py: 1.25 }}
                >
                  {busy ? t('offline.signing') : t('signqr.cosign_button')}
                </Button>
              </>
            )}
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
      <BlockedSignerDialog open={showBlocked} onCancel={() => setShowBlocked(false)} onContinue={() => { setShowBlocked(false); setShowPassword(true); }} />
      {/* The scanner only mounts while open, so the camera is off otherwise. */}
      <Dialog fullScreen open={scanOpen} onClose={() => setScanOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar>
            <IconButton edge="start" onClick={() => setScanOpen(false)} aria-label={t('common.close')}><CloseIcon /></IconButton>
            <Typography variant="h6" sx={{ ml: 1 }}>{t('signqr.scan_title')}</Typography>
          </Toolbar>
        </AppBar>
        {loadError !== '' && <Alert severity="error" sx={{ m: 2 }}>{loadError}</Alert>}
        <Scanner
          onScan={(results) => { if (results[0]) load(results[0].rawValue); }}
          onError={(e) => setLoadError(`Camera is not available: ${e instanceof Error ? e.message : 'Unknown'}`)}
        />
      </Dialog>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </OfflineShell>
  );
}
