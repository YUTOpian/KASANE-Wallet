import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { SymbolSendError } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { announceNemPayload, fetchNemMosaicInfos, nemExplorerTxUrl } from '../../lib/nem/api';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_NATIVE_ID, NEM_TX_TYPE_TRANSFER } from '../../lib/nem/constants';
import { nemAddressFromPublicKey, verifyNemSignature } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { nemHexToBytes, readNemTransfer } from '../../lib/nem/offline';
import type { NemAnnounceBody, NemTransferSummary, ParsedNemBundle, ParsedNemSigned } from '../../lib/nem/offline';
import { isDeviceOffline } from '../../lib/offline/issue';
import { mono } from '../multisig/parts';

// 「署名・連署QR」 / 「オフライントランザクション」の「読み込んで送信」: a transaction that was signed offline on NEM (KASANE's NEM
// QR, or the announce body NanoWallet makes). A transfer is read in full; any other kind (mosaic, namespace, multisig,
// delegated harvesting, ...) is shown by its kind, signer, fee and deadline - it was signed on the device that made it, and
// whoever announces it cannot spend anything with it.
// Everything shown is read from the signed bytes, never from the QR's own claims; the signature is checked with the
// signer's public key (which the transaction carries) before the button is offered. Nothing is sent until it is pressed.

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

/** The checks every signed NEM transaction goes through: the network and the signature. `problem` is the key of the reason it cannot be sent. */
function readItem(body: NemAnnounceBody, qrNetworkId: number | null, networkByte: number): { summary: NemTransferSummary | null; problem: string } {
  try {
    const summary = readNemTransfer(body.data);
    let problem = '';
    if (summary.networkByte !== networkByte || (qrNetworkId !== null && qrNetworkId !== networkByte)) problem = 'wrong_network';
    else if (!verifyNemSignature(summary.signerPublicKey, nemHexToBytes(body.data), nemHexToBytes(body.signature))) problem = 'bad_signature';
    return { summary, problem };
  } catch {
    return { summary: null, problem: 'invalid_payload' };
  }
}

function signerOf(summary: NemTransferSummary | null): string {
  if (!summary) return '';
  try { return nemAddressFromPublicKey(summary.signerPublicKey, summary.networkByte); } catch { return summary.signerPublicKey; }
}

/** What kind of transaction it is, as a name (a transfer, or e.g. 「モザイク定義」). */
function nemKindTitle(t: ReturnType<typeof useTranslation>['t'], typeValue: number): string {
  if (typeValue === NEM_TX_TYPE_TRANSFER) return t('signqr.type_transfer');
  return t(`offline_tx.nem_type_${typeValue}`, { defaultValue: t('signqr.type_other', { type: `0x${typeValue.toString(16).toUpperCase()}` }) });
}

const errorText = (e: unknown) => (e instanceof SymbolSendError && e.code !== e.message ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

export default function NemSignedView({ qr }: { qr: ParsedNemSigned }) {
  const { t } = useTranslation();
  const cfg = getNemNetworkConfig();

  // Read and checked once per QR code; `problem` is the key of the reason it cannot be sent.
  const read = useMemo(() => readItem(qr.body, qr.networkId, cfg.networkByte), [qr, cfg.networkByte]);
  const { summary, problem } = read;
  const transfer = summary?.transfer ?? null;

  // Quantities are atomic: the divisibility of each mosaic comes from the node (this PC is online). XEM is built in.
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    if (!transfer || problem !== '') return undefined;
    (async () => {
      const ids = transfer.mosaics.map((m) => m.id).filter((id) => id !== NEM_NATIVE_ID);
      const infos: Record<string, { divisibility: number } | undefined> = ids.length > 0 ? await fetchNemMosaicInfos(ids).catch(() => ({})) : {};
      if (cancelled) return;
      setLines(transfer.mosaics.map((m) => {
        if (m.id === NEM_NATIVE_ID) return `${formatAtomic(m.quantity, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;
        const info = infos[m.id];
        // A mosaic the node cannot describe is shown in its raw units, said so.
        return info ? `${formatAtomic(m.quantity, info.divisibility)} ${m.id}` : `${m.quantity.toString()} ${m.id} (${t('signqr.nem_raw_units')})`;
      }));
    })();
    return () => { cancelled = true; };
  }, [transfer, problem, t]);

  const signerAddress = useMemo(() => signerOf(summary), [summary]);

  const expired = summary !== null && summary.deadlineMs < Date.now();
  const [busy, setBusy] = useState(false);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');

  const onSend = async () => {
    // 読み込んで送る画面: オフラインなら、またQRにせず、そう伝える。
    if (isDeviceOffline()) { setSendError(t('offline_tx.reader_offline')); return; }
    setBusy(true);
    setSendError('');
    try {
      const { hash } = await announceNemPayload(JSON.stringify({ data: qr.body.data, signature: qr.body.signature }), { issue: false });
      setSentHash(hash);
    } catch (e) {
      console.error('Failed to announce the signed NEM transaction', e);
      setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('signqr.nem_signed_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('signqr.signed_note')}</Alert>
      {problem !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t(`signqr.problem_${problem}`)}</Alert>}
      {summary && transfer === null && problem === '' && (
        <>
          <Card>
            <Row label={t('signqr.label_type')}>{nemKindTitle(t, summary.typeValue)} (NEM)</Row>
            <Row label={t('signqr.label_signer')}>{signerAddress}</Row>
            <Row label={t('signqr.label_fee')}>{formatAtomic(summary.fee, NEM_CURRENCY_DIVISIBILITY)} {NEM_CURRENCY_SYMBOL}</Row>
            <Row label={t('signqr.label_deadline')}>{new Date(summary.deadlineMs).toLocaleString()}</Row>
          </Card>
          <Alert severity="info" sx={{ mb: 2 }}>{t('offline_tx.nem_other_note')}</Alert>
          <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.signature_valid')}</Alert>
          {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
          {sendError !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t('signqr.send_failed')}: {sendError}</Alert>}
          {sentHash !== null ? (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.sent')}</Alert>
              {sentHash !== '' && <Card><Row label={t('signqr.label_hash')}>{sentHash}</Row></Card>}
              {sentHash !== '' && <Button href={nemExplorerTxUrl(sentHash)} target="_blank" rel="noopener" variant="contained" fullWidth>{t('multisig.view_explorer')}</Button>}
            </>
          ) : (
            <Button variant="contained" color="primary" size="large" fullWidth disabled={busy || expired} onClick={onSend}>
              {busy ? t('signqr.sending') : t('signqr.send_button')}
            </Button>
          )}
        </>
      )}
      {summary && transfer && problem === '' && (
        <>
          <Card>
            <Row label={t('signqr.label_type')}>{t('signqr.type_transfer')} (NEM)</Row>
            <Row label={t('signqr.label_signer')}>{signerAddress}</Row>
            <Row label={t('signqr.label_recipient')}>{transfer.recipient}</Row>
            <Row label={t('signqr.label_mosaic')}>{lines === null ? t('common.loading') : lines.join('\n')}</Row>
            {transfer.message && (
              <Row label={t('signqr.label_message')}>
                {transfer.message.encrypted ? t('signqr.nem_message_encrypted') : transfer.message.text ?? t('signqr.nem_message_unreadable')}
              </Row>
            )}
            <Row label={t('signqr.label_fee')}>{formatAtomic(summary.fee, NEM_CURRENCY_DIVISIBILITY)} {NEM_CURRENCY_SYMBOL}</Row>
            <Row label={t('signqr.label_deadline')}>{new Date(summary.deadlineMs).toLocaleString()}</Row>
          </Card>
          <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.signature_valid')}</Alert>
          {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
          {sendError !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t('signqr.send_failed')}: {sendError}</Alert>}
          {sentHash !== null ? (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.sent')}</Alert>
              {sentHash !== '' && <Card><Row label={t('signqr.label_hash')}>{sentHash}</Row></Card>}
              {sentHash !== '' && <Button href={nemExplorerTxUrl(sentHash)} target="_blank" rel="noopener" variant="contained" fullWidth>{t('multisig.view_explorer')}</Button>}
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

// --- several transactions signed offline on NEM: review them, then announce them one after another ---------------------
export function NemBundleView({ qr }: { qr: ParsedNemBundle }) {
  const { t } = useTranslation();
  const cfg = getNemNetworkConfig();
  const reads = useMemo(() => qr.items.map((item) => readItem(item, qr.networkId, cfg.networkByte)), [qr, cfg.networkByte]);
  const problem = reads.find((r) => r.problem !== '')?.problem ?? '';
  const total = qr.items.length;
  const [busy, setBusy] = useState(false);
  const [hashes, setHashes] = useState<string[]>([]);
  const [sendError, setSendError] = useState('');
  const done = hashes.length;
  const expired = problem === '' && done < total && reads.slice(done).some((r) => r.summary !== null && r.summary.deadlineMs < Date.now());

  const onSend = async () => {
    if (isDeviceOffline()) { setSendError(t('offline_tx.reader_offline')); return; }
    setBusy(true);
    setSendError('');
    const sent = [...hashes];
    try {
      for (let i = sent.length; i < total; i += 1) {
        const { hash } = await announceNemPayload(JSON.stringify({ data: qr.items[i].data, signature: qr.items[i].signature }), { issue: false });
        sent.push(hash);
        setHashes([...sent]);
      }
    } catch (e) {
      console.error('Failed to announce the signed NEM transactions', e);
      setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('offline_tx.bundle_title')}</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>{t('offline_tx.nem_bundle_note', { count: total })}</Alert>
      {problem !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t(`signqr.problem_${problem}`)}</Alert>}
      {problem === '' && reads.map((r, i) => (
        <Card key={qr.items[i].signature}>
          <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', pt: 0.5 }}>{i + 1} / {total}{i < done ? ' \u2713' : ''}</Typography>
          {r.summary && (
            <>
              <Row label={t('signqr.label_type')}>{nemKindTitle(t, r.summary.typeValue)} (NEM)</Row>
              <Row label={t('signqr.label_signer')}>{signerOf(r.summary)}</Row>
              {r.summary.transfer && <Row label={t('signqr.label_recipient')}>{r.summary.transfer.recipient}</Row>}
              {r.summary.transfer && (
                <Row label={t('signqr.label_mosaic')}>
                  {r.summary.transfer.mosaics.map((m) => (m.id === NEM_NATIVE_ID ? `${formatAtomic(m.quantity, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}` : `${m.quantity.toString()} ${m.id} (${t('signqr.nem_raw_units')})`)).join('\n')}
                </Row>
              )}
              {r.summary.transfer?.message && (
                <Row label={t('signqr.label_message')}>
                  {r.summary.transfer.message.encrypted ? t('signqr.nem_message_encrypted') : r.summary.transfer.message.text ?? t('signqr.nem_message_unreadable')}
                </Row>
              )}
              <Row label={t('signqr.label_fee')}>{formatAtomic(r.summary.fee, NEM_CURRENCY_DIVISIBILITY)} {NEM_CURRENCY_SYMBOL}</Row>
              <Row label={t('signqr.label_deadline')}>{new Date(r.summary.deadlineMs).toLocaleString()}</Row>
            </>
          )}
        </Card>
      ))}
      {problem === '' && (
        <>
          <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.signature_valid')}</Alert>
          {expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.expired')}</Alert>}
          {sendError !== '' && <Alert severity="error" sx={{ mb: 2 }}>{t('signqr.send_failed')}: {sendError}</Alert>}
          {done >= total ? (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('signqr.sent')}</Alert>
              {hashes[total - 1] !== '' && <Button href={nemExplorerTxUrl(hashes[total - 1])} target="_blank" rel="noopener" variant="contained" fullWidth>{t('multisig.view_explorer')}</Button>}
            </>
          ) : (
            <>
              {done > 0 && <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1 }}>{t('offline_tx.bundle_progress', { done, count: total })}</Typography>}
              <Button variant="contained" color="primary" size="large" fullWidth disabled={busy || expired} onClick={onSend}>
                {busy ? t('signqr.sending') : done > 0 ? t('offline_tx.bundle_resume') : t('signqr.send_button')}
              </Button>
            </>
          )}
        </>
      )}
    </>
  );
}
