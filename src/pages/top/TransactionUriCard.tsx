import { useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { resolveNode } from '../../lib/symbol/api';
import { getNetworkConfig } from '../../lib/symbol/network';
import { serializeUnsignedTransfer } from '../../lib/symbol/tx';
import { buildTransactionUri, TRANSFER_TX_TYPE, TX_URI_QR_MAX_LENGTH } from '../../lib/symbol/txUri';
import type { MosaicAmount } from '../../lib/symbol/tx';

interface Props {
  recipient: string; // base32 address
  mosaics: MosaicAmount[]; // atomic units
  message: string;
  maxFee: bigint; // atomic XYM, at the chosen fee level
  networkByte: number;
}

const DEADLINE_MS = 2n * 60n * 60n * 1000n; // same lifetime as a transfer sent from this wallet

/**
 * 「トランザクションURI」: the transfer being typed, as a web+symbol://transaction URI (text, copy, QR).
 * It is unsigned - whoever opens it (this wallet, another Symbol wallet) reviews and signs it themselves.
 */
export default function TransactionUriCard({ recipient, mosaics, message, maxFee, networkByte }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [uri, setUri] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const mosaicsKey = mosaics.map((m) => `${m.id}:${m.amount.toString()}`).join(',');

  // Built only while the card is open, and rebuilt (debounced) whenever the form changes.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setCopied(false);
    const timer = setTimeout(async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) throw new Error('no_wallet');
        const cfg = getNetworkConfig();
        const networkNow = BigInt(Date.now() - cfg.epochAdjustment * 1000);
        const payload = serializeUnsignedTransfer({
          signerPublicKey: wallet.publicKey,
          networkByte,
          recipient,
          mosaics,
          message,
          maxFee,
          deadline: networkNow + DEADLINE_MS,
        });
        // The node is only a hint for whoever opens the URI; leave it out if none can be resolved.
        const nodeUrl = await resolveNode().catch(() => undefined);
        if (cancelled) return;
        setUri(buildTransactionUri({ payload, type: TRANSFER_TX_TYPE, nodeUrl }));
        setFailed(false);
      } catch (e) {
        console.error('Failed to build the transaction URI', e);
        if (!cancelled) { setUri(''); setFailed(true); }
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [expanded, recipient, mosaicsKey, message, maxFee, networkByte]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
    } catch (e) {
      console.error('Failed to copy the transaction URI', e);
    }
  };

  return (
    <Accordion
      disableGutters
      elevation={0}
      expanded={expanded}
      onChange={(_, v) => setExpanded(v)}
      sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, '&:before': { display: 'none' } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography sx={{ fontWeight: 'bold' }}>{t('txuri.title')}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Typography sx={{ color: 'text.secondary', fontSize: 12, mb: 1.5 }}>{t('txuri.hint')}</Typography>
        {failed && <Typography sx={{ color: 'error.main', fontSize: 13 }}>{t('txuri.build_failed')}</Typography>}
        {!failed && uri === '' && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('common.loading')}</Typography>}
        {uri !== '' && (
          <>
            <Box
              sx={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', maxHeight: 120, overflowY: 'auto', p: 1, borderRadius: 2, bgcolor: 'action.hover', userSelect: 'all' }}
            >
              {uri}
            </Box>
            <Button size="small" sx={{ mt: 1 }} onClick={onCopy}>{copied ? t('txuri.copied') : t('txuri.copy')}</Button>
            {uri.length <= TX_URI_QR_MAX_LENGTH ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                <Box sx={{ bgcolor: '#fff', p: 1.5, borderRadius: 2, lineHeight: 0 }}>
                  <QRCodeSVG value={uri} size={220} level="L" />
                </Box>
              </Box>
            ) : (
              <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 1 }}>{t('txuri.qr_too_long')}</Typography>
            )}
            <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 1.5 }}>{t('txuri.deadline_note')}</Typography>
          </>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
