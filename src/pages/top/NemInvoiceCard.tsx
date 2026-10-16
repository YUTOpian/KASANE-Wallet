import { useEffect, useMemo, useState } from 'react';
import { Box, Button, CircularProgress, InputAdornment, TextField, Typography } from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { downloadInvoicePdf } from '../../lib/invoicePdfExport';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_MAX_MESSAGE_BYTES } from '../../lib/nem/constants';
import { prettyNemAddress } from '../../lib/nem/crypto';
import { buildNemInvoiceQr } from '../../lib/nem/qr';
import { nemMessageByteLength } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';

// What a QR (error correction L) can hold; a longer invoice has to be shortened.
const QR_MAX_LENGTH = 2900;
// The QR as drawn on the desktop layout (the form is on its left).
const QR_SIZE = 280;

// Digits and a single '.', limited to `decimals` places (',' accepted as the decimal point).
function sanitizeAmount(raw: string, decimals: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = s.split('.');
  if (frac !== undefined) s = `${whole}.${frac.slice(0, decimals)}`;
  return s;
}

interface Props {
  address: string;
}

/**
 * 「インボイス」(NEM): a payment request for this wallet with an XEM amount and a message, as the NEM wallets'
 * invoice QR (NanoWallet / NEM mobile wallets: {"v","type":2,"data":{addr,amount,msg,name}}). Scanning it opens
 * a transfer form prefilled with these. Unlike a Symbol request it carries no deadline.
 */
export default function NemInvoiceCard({ address }: Props) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);

  const atomic = parseDecimal(amount, NEM_CURRENCY_DIVISIBILITY);
  const amountOk = atomic !== null && atomic > 0n;
  const messageBytes = nemMessageByteLength(message);
  const messageTooLong = messageBytes > NEM_MAX_MESSAGE_BYTES;

  const qr = useMemo(() => {
    if (!amountOk || messageTooLong || !address) return '';
    try {
      return buildNemInvoiceQr({ recipient: address, amountMicro: atomic, message });
    } catch (e) {
      console.error('Failed to build the NEM invoice QR', e);
      return '';
    }
    // The QR also depends on the network (the v field), so a switch rebuilds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, atomic, amountOk, message, messageTooLong, network]);
  const tooLarge = qr.length > QR_MAX_LENGTH;
  useEffect(() => { setCopied(false); }, [qr]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(qr);
      setCopied(true);
    } catch (e) {
      console.error('Failed to copy the invoice QR', e);
    }
  };

  const onDownloadPdf = async () => {
    if (pdfBusy || qr === '' || atomic === null) return;
    setPdfBusy(true);
    setPdfFailed(false);
    try {
      await downloadInvoicePdf({
        chain: 'nem',
        recipient: prettyNemAddress(address),
        mosaics: [{ symbol: NEM_CURRENCY_SYMBOL, amount: formatAtomic(atomic, NEM_CURRENCY_DIVISIBILITY) }],
        message,
        qr,
      });
    } catch (e) {
      console.error('Failed to create the invoice PDF', e);
      setPdfFailed(true);
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <Box sx={{ width: '100%', maxWidth: 1040, mx: 'auto', px: { xs: 2, md: 4 }, py: { xs: 2, md: 3 }, boxSizing: 'border-box', textAlign: 'left' }}>
      <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2.5 }}>{t('invoice.nem_hint')}</Typography>

      {/* Desktop: the form on the left, the QR (kept in view while scrolling) on the right. A narrow window stacks them. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 340px' }, columnGap: 6, rowGap: 3, alignItems: 'start' }}>
        <Box>
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('invoice.nem_pay_to')}</Typography>
          <Typography sx={{ fontFamily: 'monospace', fontSize: 15, wordBreak: 'break-all', mb: 2.5 }}>{prettyNemAddress(address)}</Typography>

          <TextField
            size="small"
            fullWidth
            value={amount}
            onChange={(e) => setAmount(sanitizeAmount(e.target.value, NEM_CURRENCY_DIVISIBILITY))}
            placeholder={t('send.amount_placeholder')}
            aria-label={t('common.amount')}
            slotProps={{
              htmlInput: { inputMode: 'decimal', autoComplete: 'off' },
              input: { endAdornment: <InputAdornment position="end">{NEM_CURRENCY_SYMBOL}</InputAdornment> },
            }}
          />

          <TextField
            sx={{ mt: 2.5 }}
            fullWidth
            multiline
            minRows={4}
            size="small"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('common.message_input')}
            error={messageTooLong}
            helperText={`${messageBytes} / ${NEM_MAX_MESSAGE_BYTES} bytes`}
          />
        </Box>

          <Box sx={{ position: { md: 'sticky' }, top: { md: 16 }, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {qr !== '' && !tooLarge ? (
              <>
                <Box sx={{ bgcolor: '#fff', p: 2, borderRadius: 3, lineHeight: 0, border: 1, borderColor: 'divider' }}>
                  <QRCodeSVG value={qr} size={QR_SIZE} level="L" />
                </Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1, mt: 1.5 }}>
                  <Button size="small" onClick={onCopy}>{copied ? t('txuri.copied') : t('invoice.copy')}</Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={pdfBusy}
                    onClick={onDownloadPdf}
                    startIcon={pdfBusy ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
                  >
                    {pdfBusy ? t('invoice.pdf_creating') : t('invoice.download_pdf')}
                  </Button>
                </Box>
                {pdfFailed && <Typography sx={{ color: 'error.main', fontSize: 12, mt: 0.5 }}>{t('invoice.pdf_failed')}</Typography>}
                <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.75, textAlign: 'center' }}>{t('invoice.nem_note')}</Typography>
              </>
            ) : (
              <Box sx={{ width: QR_SIZE + 32, maxWidth: '100%', aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', px: 3, boxSizing: 'border-box', border: '2px dashed', borderColor: tooLarge ? 'error.main' : 'divider', borderRadius: 3, color: tooLarge ? 'error.main' : 'text.secondary', fontSize: 13 }}>
                {tooLarge ? t('invoice.qr_too_large') : t('invoice.qr_placeholder')}
              </Box>
            )}
          </Box>
      </Box>
    </Box>
  );
}
