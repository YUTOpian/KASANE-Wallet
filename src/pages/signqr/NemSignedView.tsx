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
import type { ParsedNemSigned } from '../../lib/nem/offline';
import { mono } from '../multisig/parts';

// 「署名・連署QR」: a transfer that was signed offline on NEM (KASANE's NEM QR, or the announce body NanoWallet makes).
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

const errorText = (e: unknown) => (e instanceof SymbolSendError && e.code !== e.message ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

export default function NemSignedView({ qr }: { qr: ParsedNemSigned }) {
  const { t } = useTranslation();
  const cfg = getNemNetworkConfig();

  // Read and checked once per QR code; `problem` is the key of the reason it cannot be sent.
  const read = useMemo(() => {
    try {
      const summary = readNemTransfer(qr.body.data);
      let problem = '';
      if (summary.networkByte !== cfg.networkByte || (qr.networkId !== null && qr.networkId !== cfg.networkByte)) problem = 'wrong_network';
      else if (summary.typeValue !== NEM_TX_TYPE_TRANSFER || summary.transfer === null) problem = 'nem_unsupported_type';
      else if (!verifyNemSignature(summary.signerPublicKey, nemHexToBytes(qr.body.data), nemHexToBytes(qr.body.signature))) problem = 'bad_signature';
      return { summary, problem };
    } catch {
      return { summary: null, problem: 'invalid_payload' };
    }
  }, [qr, cfg.networkByte]);
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

  const signerAddress = useMemo(() => {
    if (!summary) return '';
    try { return nemAddressFromPublicKey(summary.signerPublicKey, summary.networkByte); } catch { return summary.signerPublicKey; }
  }, [summary]);

  const expired = summary !== null && summary.deadlineMs < Date.now();
  const [busy, setBusy] = useState(false);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');

  const onSend = async () => {
    setBusy(true);
    setSendError('');
    try {
      const { hash } = await announceNemPayload(JSON.stringify({ data: qr.body.data, signature: qr.body.signature }));
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
