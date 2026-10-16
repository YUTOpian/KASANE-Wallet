import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, AppBar, Box, Button, Dialog, IconButton, Stack, TextField, Toolbar, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Scanner } from '@yudiel/react-qr-scanner';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import BackButton from '../../components/BackButton';
import PasswordDialog from '../../components/PasswordDialog';
import SignerTrustNotice from '../../components/SignerTrustNotice';
import BlockedSignerDialog from '../../components/BlockedSignerDialog';
import SignRiskNotice, { SignRiskDialog } from '../../components/SignRiskNotice';
import { checkSignRisks, checkSignerTrust, isUnknownSignerDenied } from '../../lib/signerTrust';
import { hasDanger } from '../../lib/signRisk';
import type { SignRisk } from '../../lib/signRisk';
import QrImageButton from '../../components/QrImageButton';
import QrTextDialog from '../../components/QrTextDialog';
import { WalletsHelper } from '../../lib/storage';
import { SymbolSendError, announceSigned, explorerTxUrl, getMosaicInfos } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { addressFromPublicKey, hexToBytes, verifySignature } from '../../lib/symbol/crypto';
import { buildKasaneQr, networkProblem } from '../../lib/symbol/kasaneQr';
import { parseAnyInput } from '../../lib/symbol/externalPayload';
import type { CosignRequestQr, CosignatureQr, ParsedKasaneQr, SignedQr, TemplateQr } from '../../lib/symbol/kasaneQr';
import { announceCosignature, fetchPartialByHash } from '../../lib/symbol/multisigApi';
import type { PartialItem } from '../../lib/symbol/multisigApi';
import { getNetworkConfig } from '../../lib/symbol/network';
import { summarizePayload } from '../../lib/symbol/payloadSummary';
import type { PayloadSummary } from '../../lib/symbol/payloadSummary';
import { cosignAggregateHash } from '../../lib/symbol/tx';
import type { CosignatureBody } from '../../lib/symbol/tx';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { parseNemSigned } from '../../lib/nem/offline';
import type { ParsedNemSigned } from '../../lib/nem/offline';
import { ItemView, mono } from '../multisig/parts';
import NemSignedView from './NemSignedView';

const TYPE_TRANSFER = 0x4154;
const TYPE_AGGREGATE_COMPLETE = 0x4141;
const TYPE_HASH_LOCK = 0x4148;

function typeLabel(t: TFunction, value: number): string {
  if (value === TYPE_TRANSFER) return t('signqr.type_transfer');
  if (value === TYPE_AGGREGATE_COMPLETE) return t('signqr.type_aggregate_complete');
  if (value === TYPE_HASH_LOCK) return t('signqr.type_hash_lock');
  return t('signqr.type_other', { type: `0x${value.toString(16).toUpperCase()}` });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ py: 1 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '0.95rem', whiteSpace: 'pre-wrap', ...mono }}>{children}</Typography>
    </Box>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1, mb: 2, textAlign: 'left' }}>
      {children}
    </Box>
  );
}

const errorText = (e: unknown) => (e instanceof SymbolSendError && e.code !== e.message ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

// --- a signed transaction: review it, then announce it -------------------------------------------------
function SignedView({ qr }: { qr: SignedQr }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<PayloadSummary | null>(null);
  const [expired, setExpired] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await summarizePayload(qr.payload);
        if (cancelled) return;
        // Everything below is read from the bytes, not from the QR's own claims.
        if (s.hash !== qr.hash) setProblem('hash_mismatch');
        else if (s.networkByte !== getNetworkConfig().networkByte) setProblem('wrong_network');
        else if (!s.signed) setProblem('not_signed');
        else if (s.bonded) setProblem('bonded_unsupported');
        else {
          setSummary(s);
          setExpired(s.deadlineMs < Date.now());
        }
      } catch {
        if (!cancelled) setProblem('invalid_payload');
      }
    })();
    return () => { cancelled = true; };
  }, [qr]);

  const onSend = async () => {
    setBusy(true);
    setSendError('');
    try {
      await announceSigned({ payload: qr.payload, hash: qr.hash });
      setSent(true);
    } catch (e) {
      console.error('Failed to announce the signed transaction', e);
      setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('signqr.signed_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.signed_note')}</Alert>
      {problem !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t(`signqr.problem_${problem}`)}</Alert>}
      {problem === '' && summary === null && <Typography sx={{ color: 'text.secondary' }}>{t('common.loading')}</Typography>}
      {summary && (
        <>
          <Card>
            <Row label={t('signqr.label_type')}>{typeLabel(t, summary.typeValue)}</Row>
            <Row label={t('signqr.label_signer')}>{summary.signerAddress}</Row>
            <Row label={t('signqr.label_fee')}>{formatAtomic(summary.fee, CURRENCY_DIVISIBILITY)} {CURRENCY_SYMBOL}</Row>
            <Row label={t('signqr.label_deadline')}>{new Date(summary.deadlineMs).toLocaleString()}</Row>
            <Row label={t('signqr.label_hash')}>{summary.hash}</Row>
          </Card>
          <Card>{summary.items.map((item, i) => <ItemView key={i} item={item} />)}</Card>
          {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
          {sendError !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t('signqr.send_failed')}: {sendError}</Alert>}
          {sent ? (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.sent')}</Alert>
              <Button href={explorerTxUrl(summary.hash)} target="_blank" rel="noopener" variant="contained" fullWidth>{t('multisig.view_explorer')}</Button>
            </>
          ) : (
            <Button variant="contained" color="primary" size="large" fullWidth disabled={busy || expired} onClick={onSend}>
              {busy ? t('signqr.sending') : t('signqr.send_button')}
            </Button>
          )}
        </>
      )}
    </>
  );
}

// --- a request to cosign: review it, sign the aggregate's hash, hand the cosignature back ----------------
interface CosignData { items: PartialItem[]; initiator: string; deadlineMs: number; signedByMe: boolean; cosignedBy: number; hash: string }

function CosignRequestView({ qr }: { qr: CosignRequestQr }) {
  const { t } = useTranslation();
  const [data, setData] = useState<CosignData | null>(null);
  const [expired, setExpired] = useState(false);
  const [problem, setProblem] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  const [askBlocked, setAskBlocked] = useState(false);
  // 依頼の中身に危険な点があるとき、パスワード入力の前に出す最後の確認。
  const [askRisk, setAskRisk] = useState<SignRisk[] | null>(null);
  const [body, setBody] = useState<CosignatureBody | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        let next: CosignData | null = null;
        if (qr.payload) {
          const s = await summarizePayload(qr.payload);
          if (!s.bonded) setProblem('not_bonded');
          else if (s.hash !== qr.hash) setProblem('hash_mismatch');
          else if (s.networkByte !== getNetworkConfig().networkByte) setProblem('wrong_network');
          else if (!s.signed) setProblem('not_signed');
          else if (!s.contentsMatchHash) setProblem('contents_mismatch');
          else {
            next = { items: s.items, initiator: s.signerAddress, deadlineMs: s.deadlineMs, signedByMe: s.signerPublicKey === wallet.publicKey.toUpperCase(), cosignedBy: s.cosignatureCount, hash: s.hash };
          }
        } else {
          // Hash only: what is being signed is read from the node's copy of the partial transaction.
          const p = await fetchPartialByHash(qr.hash, wallet.publicKey);
          if (!p) setProblem('not_found');
          else next = { items: p.items, initiator: p.initiator, deadlineMs: p.deadlineMs, signedByMe: p.signedByMe, cosignedBy: p.cosignedBy, hash: p.hash || qr.hash };
        }
        if (cancelled || next === null) return;
        setData(next);
        setExpired(next.deadlineMs < Date.now());
      } catch (e) {
        console.error('Failed to read the cosign request', e);
        if (!cancelled) setProblem('invalid_payload');
      }
    })();
    return () => { cancelled = true; };
  }, [qr]);

  // パスワード入力へ進む。ただし中身に危険な点（要注意のアドレスが関わる）があれば、その前に確認を出す。
  const proceedToSign = async () => {
    if (!data) return;
    const risks = await checkSignRisks(data.items);
    if (hasDanger(risks)) setAskRisk(risks);
    else setAskPassword(true);
  };

  const onPassword = async (password: string) => {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setError(t('wallet.invalid_key'));
        return;
      }
      setBody(cosignAggregateHash(privateKey, data.hash));
    } catch (e) {
      console.error('Cosign failed', e);
      setError(`${t('multisig.cosign_failed')}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await announceCosignature(body);
      setSent(true);
    } catch (e) {
      console.error('Failed to announce the cosignature', e);
      setError(`${t('signqr.send_failed')}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('signqr.cosign_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.cosign_note')}</Alert>
      {problem !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t(`signqr.problem_${problem}`)}</Alert>}
      {problem === '' && data === null && <Typography sx={{ color: 'text.secondary' }}>{t('common.loading')}</Typography>}
      {data && (
        <>
          <Card>
            <Row label={t('signqr.label_initiator')}>{data.initiator}</Row>
            <Row label={t('signqr.label_deadline')}>{new Date(data.deadlineMs).toLocaleString()} / {t('multisig.cosigned_count', { count: data.cosignedBy })}</Row>
            <Row label={t('signqr.label_hash')}>{data.hash}</Row>
          </Card>
          <SignerTrustNotice address={data.initiator} sx={{ mb: 2 }} />
          <SignRiskNotice items={data.items} sx={{ mb: 2 }} />
          <Card>{data.items.map((item, i) => <ItemView key={i} item={item} />)}</Card>
          {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
          {data.signedByMe && body === null && <Alert severity="success" sx={{ mb: 2 }}>{t('multisig.signed_by_me')}</Alert>}
          {error !== '' && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {body === null ? (
            <Button variant="contained" color="primary" size="large" fullWidth disabled={busy || expired || data.signedByMe} onClick={async () => {
              const trust = await checkSignerTrust(data.initiator);
              if (isUnknownSignerDenied(trust)) setError(t('addressbook.signer_unknown_denied'));
              else if (trust === 'black') setAskBlocked(true);
              else await proceedToSign();
            }}>
              {t('signqr.cosign_button')}
            </Button>
          ) : (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{sent ? t('signqr.cosignature_sent') : t('signqr.cosign_done')}</Alert>
              <Button variant="outlined" color="primary" fullWidth onClick={() => setQrOpen(true)} sx={{ mb: 1 }}>{t('signqr.show_cosignature_qr')}</Button>
              {!sent && <Button variant="contained" color="primary" fullWidth disabled={busy} onClick={onSend}>{busy ? t('signqr.sending') : t('signqr.send_cosignature')}</Button>}
              <QrTextDialog
                open={qrOpen}
                title={t('signqr.cosignature_qr_title')}
                hint={t('signqr.cosignature_qr_hint')}
                text={buildKasaneQr({ kind: 'cosignature', parentHash: body.parentHash, signerPublicKey: body.signerPublicKey, signature: body.signature, version: body.version })}
                onClose={() => setQrOpen(false)}
              />
            </>
          )}
        </>
      )}
      <PasswordDialog open={askPassword} mode="check" popup onClose={() => setAskPassword(false)} onPass={onPassword} />
      <BlockedSignerDialog open={askBlocked} onCancel={() => setAskBlocked(false)} onContinue={() => { setAskBlocked(false); void proceedToSign(); }} />
      <SignRiskDialog risks={askRisk} onCancel={() => setAskRisk(null)} onContinue={() => { setAskRisk(null); setAskPassword(true); }} />
    </>
  );
}

// --- a finished cosignature: check it, then announce it ---------------------------------------------------
function CosignatureView({ qr }: { qr: CosignatureQr }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<{ items: PartialItem[]; deadlineMs: number } | null | 'unknown'>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const valid = useMemo(() => {
    try {
      return verifySignature(qr.signerPublicKey, hexToBytes(qr.parentHash), hexToBytes(qr.signature));
    } catch {
      return false;
    }
  }, [qr]);
  const signerAddress = useMemo(() => {
    try { return addressFromPublicKey(qr.signerPublicKey, getNetworkConfig().networkByte); } catch { return qr.signerPublicKey; }
  }, [qr]);

  // Which transaction it is for, when this device's node still has it waiting for signatures.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wallet = await WalletsHelper.getActive();
      const p = wallet ? await fetchPartialByHash(qr.parentHash, wallet.publicKey) : null;
      if (!cancelled) setTarget(p ? { items: p.items, deadlineMs: p.deadlineMs } : 'unknown');
    })().catch(() => { if (!cancelled) setTarget('unknown'); });
    return () => { cancelled = true; };
  }, [qr]);

  const onSend = async () => {
    setBusy(true);
    setError('');
    try {
      await announceCosignature({ parentHash: qr.parentHash, signature: qr.signature, signerPublicKey: qr.signerPublicKey, version: qr.version });
      setSent(true);
    } catch (e) {
      console.error('Failed to announce the cosignature', e);
      setError(`${t('signqr.send_failed')}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('signqr.cosignature_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.cosignature_note')}</Alert>
      <Card>
        <Row label={t('signqr.label_cosigner')}>{signerAddress}</Row>
        <Row label={t('signqr.label_parent_hash')}>{qr.parentHash}</Row>
      </Card>
      {valid ? <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.signature_valid')}</Alert> : <Alert severity="error" sx={{ mb: 2 }}>{t('signqr.problem_bad_signature')}</Alert>}
      {target !== null && target !== 'unknown' && <Card>{target.items.map((item, i) => <ItemView key={i} item={item} />)}</Card>}
      {target === 'unknown' && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.target_unknown')}</Alert>}
      {error !== '' && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {sent ? <Alert severity="success">{t('signqr.cosignature_sent')}</Alert> : (
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!valid || busy} onClick={onSend}>
          {busy ? t('signqr.sending') : t('signqr.send_cosignature')}
        </Button>
      )}
    </>
  );
}

// --- a multisig transfer template: open it in the multisig send form --------------------------------------
function TemplateView({ qr }: { qr: TemplateQr }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = qr.mosaics.map((m) => m.id);
      const infos = await getMosaicInfos(ids).catch(() => ({} as Awaited<ReturnType<typeof getMosaicInfos>>));
      if (!cancelled) setLines(qr.mosaics.map((m) => `${formatAtomic(BigInt(m.amount), infos[m.id]?.divisibility ?? 0)} ${infos[m.id]?.symbol ?? m.id}`));
    })();
    return () => { cancelled = true; };
  }, [qr]);

  const multiple = qr.mosaics.length > 1;
  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('signqr.template_read_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.template_read_note')}</Alert>
      <Card>
        <Row label={t('signqr.label_from_account')}>{qr.account}</Row>
        <Row label={t('signqr.label_recipient')}>{qr.recipient}</Row>
        <Row label={t('signqr.label_mosaic')}>{lines === null ? t('common.loading') : lines.join('\n')}</Row>
        {qr.message && <Row label={t('signqr.label_message')}>{qr.message}</Row>}
      </Card>
      {multiple && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.template_multiple')}</Alert>}
      <Button variant="contained" color="primary" size="large" fullWidth disabled={multiple} onClick={() => navigate('/multisig/send', { state: { template: qr } })}>
        {t('signqr.template_open_button')}
      </Button>
    </>
  );
}

interface SignQrReaderProps {
  /**
   * Called with a text that is not a signing QR / payload. Resolves to null when it handled the text (the reader then
   * closes the camera and clears its input) or to the message to show. Without it such a text is just "invalid".
   */
  onOther?: (raw: string) => Promise<string | null>;
  /** Without the side padding, for use inside a popup that already has its own. */
  compact?: boolean;
}

// The 「読み込めるもの」 list at the top of the reader: a short lead, one row per kind of code, the safety note and the
// technical details (symbol-cli / SDK / REST) folded away.
function ReaderIntro({ withAddress }: { withAddress: boolean }) {
  const { t } = useTranslation();
  const kinds: Array<[string, string]> = [
    ['signqr.kind_signed_title', 'signqr.kind_signed_desc'],
    ['signqr.kind_cosign_title', 'signqr.kind_cosign_desc'],
    ['signqr.kind_template_title', 'signqr.kind_template_desc'],
  ];
  if (withAddress) kinds.push(['signqr.kind_address_title', 'signqr.kind_address_desc']);
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography variant="body1" sx={{ fontWeight: 500, mb: 1.5, lineHeight: 1.7 }}>{t('signqr.intro_lead')}</Typography>
      <Stack spacing={1}>
        {kinds.map(([title, desc]) => (
          <Box key={title} sx={{ px: 1.75, py: 1.25, borderRadius: 2, bgcolor: 'action.hover', borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.6 }}>{t(title)}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>{t(desc)}</Typography>
          </Box>
        ))}
      </Stack>
      <Alert severity="info" variant="outlined" sx={{ mt: 1.5, lineHeight: 1.7 }}>{t('signqr.intro_safe')}</Alert>
      <Accordion disableGutters elevation={0} square sx={{ mt: 1.5, bgcolor: 'transparent', border: '1px solid', borderColor: 'divider', borderRadius: 2, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>{t('signqr.intro_adv_title')}</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8 }}>{t('signqr.intro_adv_body')}</Typography>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

// The reader of 「署名・連署QR」: the QR codes (or pasted text / image / JSON file) of signed transactions, cosign requests,
// cosignatures and multisig transfer templates. Nothing is signed or sent until the person presses the button on its card.
// Shown as the /signqr screen and, on Home, as the 「QRコードのインポート」 section.
export function SignQrReader({ onOther, compact = false }: SignQrReaderProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedKasaneQr | null>(null);
  // A transfer signed offline on NEM (it has no generation hash, so it is read on its own).
  const [nemParsed, setNemParsed] = useState<ParsedNemSigned | null>(null);
  const [error, setError] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  // The camera reports the same code again and again while an earlier one is still being handled.
  const busy = useRef(false);

  const load = async (raw: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const nem = parseNemSigned(raw);
      if (nem !== null) {
        if (nem.networkId !== null && nem.networkId !== getNemNetworkConfig().networkByte) {
          setError(t('signqr.wrong_network', { network: getNemNetworkConfig().label }));
          return;
        }
        setError('');
        setScanOpen(false);
        setNemParsed(nem);
        return;
      }
      const p = parseAnyInput(raw);
      if (p === null) {
        const message = onOther ? await onOther(raw) : t('signqr.invalid');
        if (message === null) {
          setError('');
          setText('');
          setScanOpen(false);
        } else {
          setError(message);
        }
        return;
      }
      if (networkProblem(p) !== null) {
        setError(t('signqr.wrong_network', { network: getNetworkConfig().label }));
        return;
      }
      setError('');
      setScanOpen(false);
      setParsed(p);
    } finally {
      busy.current = false;
    }
  };

  const reset = () => { setParsed(null); setNemParsed(null); setText(''); setError(''); };
  // A new card (and its state) for every QR code that is read.
  const key = nemParsed ? nemParsed.body.signature : parsed ? JSON.stringify(parsed.qr).slice(0, 200) : '';

  return (
    <>
      <Box sx={{ width: '100%', maxWidth: 560, mx: 'auto', px: compact ? 0 : 3, py: compact ? 0 : 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {parsed === null && nemParsed === null ? (
          <>
            <ReaderIntro withAddress={onOther !== undefined} />
            <Button variant="contained" color="primary" size="large" fullWidth onClick={() => setScanOpen(true)} sx={{ mb: 1.5 }}>{t('signqr.scan_button')}</Button>
            <QrImageButton onDecoded={(raw) => { void load(raw); }} onNotFound={() => setError(t('signqr.image_not_found'))} sx={{ mb: 1.5 }} />
            <Button component="label" variant="outlined" color="primary" size="large" fullWidth sx={{ mb: 2 }}>
              {t('signqr.json_file_button')}
              <input
                type="file"
                hidden
                accept=".json,application/json,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  file.text().then((content) => { setText(content); void load(content); }).catch(() => setError(t('signqr.invalid')));
                }}
              />
            </Button>
            {error !== '' && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <TextField
              fullWidth
              multiline
              minRows={4}
              maxRows={10}
              label={t('signqr.paste_label')}
              value={text}
              onChange={(e) => { setText(e.target.value); setError(''); }}
              error={error !== ''}
              slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } } }}
            />
            <Button variant="outlined" color="primary" fullWidth disabled={text.trim() === ''} onClick={() => { void load(text); }} sx={{ mt: 1.5 }}>{t('signqr.load_button')}</Button>
          </>
        ) : (
          <>
            {nemParsed !== null && <NemSignedView key={key} qr={nemParsed} />}
            {parsed !== null && parsed.qr.kind === 'signed' && <SignedView key={key} qr={parsed.qr} />}
            {parsed !== null && parsed.qr.kind === 'cosign_request' && <CosignRequestView key={key} qr={parsed.qr} />}
            {parsed !== null && parsed.qr.kind === 'cosignature' && <CosignatureView key={key} qr={parsed.qr} />}
            {parsed !== null && parsed.qr.kind === 'template' && <TemplateView key={key} qr={parsed.qr} />}
            <Button onClick={reset} sx={{ mt: 2 }}>{t('signqr.another_button')}</Button>
          </>
        )}
      </Box>

      {/* The scanner only mounts while open, so the camera is off otherwise. */}
      <Dialog fullScreen open={scanOpen} onClose={() => setScanOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar>
            <IconButton edge="start" onClick={() => setScanOpen(false)} aria-label={t('common.close')}><CloseIcon /></IconButton>
            <Typography variant="h6" sx={{ ml: 1 }}>{t('signqr.scan_title')}</Typography>
          </Toolbar>
        </AppBar>
        {error !== '' && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        <Scanner
          onScan={(results) => { if (results[0]) void load(results[0].rawValue); }}
          onError={(e) => setError(`Camera is not available: ${e instanceof Error ? e.message : 'Unknown'}`)}
        />
      </Dialog>
    </>
  );
}

// 「署名・連署QR」 as a screen of its own (opened from 「オフライントランザクション」 on the profile selection screen).
export default function SignQrPage() {
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton back="/wallet/select" />
      <SignQrReader />
    </Box>
  );
}
