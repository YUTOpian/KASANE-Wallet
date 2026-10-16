import { useEffect, useMemo, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, InputAdornment, MenuItem, Select, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { loadSendAssets } from '../../lib/sendAssets';
import type { AssetOption } from '../../lib/sendAssets';
import { fetchExistingMosaicInfo } from '../../lib/symbol/api';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { downloadInvoicePdf } from '../../lib/invoicePdfExport';
import { buildInvoiceQr } from '../../lib/symbol/qr';
import { MAX_MESSAGE_BYTES, messageByteLength } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';

// Most mosaics one invoice can carry from this form (the QR gets denser with each).
const MAX_INVOICE_MOSAICS = 5;
// What a QR (error correction L) can hold; a longer invoice has to be shortened.
const QR_MAX_LENGTH = 2900;
const OTHER = '__other__';
// The QR as drawn on the desktop layout (the form is on its left).
const QR_SIZE = 280;

interface Line {
  key: number;
  choice: string; // an asset id, or OTHER = typed mosaic id
  amount: string;
  typedId: string;
}

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
 * 「請求書QR」(Symbol): a payment request for this wallet with amount, mosaics and a message, as the official
 * Symbol wallets' transaction-request QR (v3, type 3). Scanning it opens a transfer form prefilled with these.
 */
export default function InvoiceCard({ address }: Props) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  // The invoice form is always open (the Home 「インボイス」 section is the invoice).
  const expanded = true;
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [lines, setLines] = useState<Line[]>([{ key: 0, choice: '', amount: '', typedId: '' }]);
  const [nextKey, setNextKey] = useState(1);
  const [message, setMessage] = useState('');
  // Mosaics typed by id: 'loading', null = does not exist / could not be read, or what the chain says.
  const [typedInfo, setTypedInfo] = useState<Record<string, AssetOption | 'loading' | 'missing' | 'failed'>>({});
  const [copied, setCopied] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);

  // The wallet's own mosaics (XYM first) are offered; the first line starts on XYM.
  useEffect(() => {
    if (!expanded || !address) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await loadSendAssets(address, 'invoice');
        if (cancelled) return;
        setAssets(list);
        setLines((ls) => ls.map((l) => (l.choice === '' && list[0] ? { ...l, choice: list[0].id } : l)));
      } catch (e) {
        console.error('Failed to load mosaics for the invoice', e);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, address, network]);

  // Look up each typed mosaic id once (divisibility is needed to turn the amount into atomic units).
  useEffect(() => {
    for (const l of lines) {
      const id = l.typedId.trim().toUpperCase();
      if (l.choice !== OTHER || !/^[0-9A-F]{16}$/.test(id) || typedInfo[id]) continue;
      setTypedInfo((m) => ({ ...m, [id]: 'loading' }));
      fetchExistingMosaicInfo(id)
        .then((info) => setTypedInfo((m) => ({ ...m, [id]: info ? { ...info, amount: 0n, balance: '0' } : 'missing' })))
        .catch(() => setTypedInfo((m) => ({ ...m, [id]: 'failed' }))); // not retried in a loop; retyping the id tries again
    }
  }, [lines, typedInfo]);

  const resolved = lines.map((l) => {
    const typed = l.typedId.trim().toUpperCase();
    const info: AssetOption | 'loading' | 'missing' | 'failed' | null = l.choice === OTHER
      ? (typedInfo[typed] ?? (/^[0-9A-F]{16}$/.test(typed) ? 'loading' : null))
      : assets.find((a) => a.id === l.choice) ?? null;
    const asset = info !== null && typeof info === 'object' ? info : null;
    const atomic = asset ? parseDecimal(l.amount, asset.divisibility) : null;
    return { line: l, info, asset, atomic };
  });
  const ids = resolved.map((r) => r.asset?.id.toUpperCase() ?? '');
  const duplicate = ids.some((id, i) => id !== '' && ids.indexOf(id) !== i);
  const lineOk = resolved.every((r) => r.asset !== null && r.atomic !== null && r.atomic > 0n);
  const messageBytes = messageByteLength(message);
  const messageTooLong = messageBytes > MAX_MESSAGE_BYTES;

  const qr = useMemo(() => {
    if (!expanded || !lineOk || duplicate || messageTooLong || !address) return '';
    try {
      return buildInvoiceQr({
        recipient: address,
        mosaics: resolved.map((r) => ({ id: r.asset!.id, amount: r.atomic! })),
        message,
      });
    } catch (e) {
      console.error('Failed to build the invoice QR', e);
      return '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, address, message, messageTooLong, duplicate, lineOk, resolved.map((r) => `${r.asset?.id}:${r.atomic}`).join(',')]);
  const tooLarge = qr.length > QR_MAX_LENGTH;
  useEffect(() => { setCopied(false); }, [qr]);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    const unused = assets.find((a) => !lines.some((l) => l.choice === a.id));
    setLines((ls) => [...ls, { key: nextKey, choice: unused?.id ?? OTHER, amount: '', typedId: '' }]);
    setNextKey((k) => k + 1);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(qr);
      setCopied(true);
    } catch (e) {
      console.error('Failed to copy the invoice QR', e);
    }
  };

  // 「PDFで保存」: the same invoice as a KASANE-designed A4 sheet. The QR is made again right now so its
  // 2 hour validity (printed on the sheet) starts when the sheet is made.
  const onDownloadPdf = async () => {
    if (pdfBusy || qr === '') return;
    setPdfBusy(true);
    setPdfFailed(false);
    try {
      const mosaics = resolved.map((r) => ({ id: r.asset!.id, amount: r.atomic! }));
      await downloadInvoicePdf({
        recipient: address,
        mosaics: resolved.map((r) => ({ symbol: r.asset!.symbol, amount: formatAtomic(r.atomic!, r.asset!.divisibility) })),
        message,
        qr: buildInvoiceQr({ recipient: address, mosaics, message }),
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
      <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2.5 }}>{t('invoice.hint')}</Typography>

      {/* Desktop: the form on the left, the QR (kept in view while scrolling) on the right. A narrow window stacks them. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 340px' }, columnGap: 6, rowGap: 3, alignItems: 'start' }}>
        <Box>
          {resolved.map(({ line, info, asset }, i) => (
            <Box key={line.key} sx={{ mb: 2 }}>
              <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 1.5, alignItems: { md: 'flex-start' } }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: { xs: '100%', md: 260 }, flexShrink: 0 }}>
                  <Select
                    size="small"
                    fullWidth
                    value={line.choice}
                    displayEmpty
                    onChange={(e) => update(line.key, { choice: e.target.value as string, amount: '' })}
                  >
                    {assets.map((a) => <MenuItem key={a.id} value={a.id}>{a.symbol}</MenuItem>)}
                    <MenuItem value={OTHER}>{t('invoice.other_mosaic')}</MenuItem>
                  </Select>
                  {lines.length > 1 && (
                    <IconButton size="small" onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))} aria-label={t('send.remove_mosaic')}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
                <TextField
                  size="small"
                  fullWidth
                  value={line.amount}
                  disabled={asset === null}
                  onChange={(e) => update(line.key, { amount: sanitizeAmount(e.target.value, asset?.divisibility ?? 0) })}
                  placeholder={t('send.amount_placeholder')}
                  aria-label={`${t('common.amount')} ${i + 1}`}
                  slotProps={{
                    htmlInput: { inputMode: 'decimal', autoComplete: 'off' },
                    input: { endAdornment: asset ? <InputAdornment position="end">{asset.symbol}</InputAdornment> : undefined },
                  }}
                />
              </Box>
              {line.choice === OTHER && (
                <TextField
                  size="small"
                  fullWidth
                  sx={{ mt: 1 }}
                  value={line.typedId}
                  onChange={(e) => {
                    const id = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16);
                    // Retyping after a failed lookup tries again.
                    setTypedInfo((m) => (m[id.toUpperCase()] === 'failed' ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== id.toUpperCase())) : m));
                    update(line.key, { typedId: id, amount: '' });
                  }}
                  placeholder={t('invoice.mosaic_id_placeholder')}
                  error={info === 'missing' || info === 'failed'}
                  helperText={info === 'missing' ? t('invoice.mosaic_missing') : info === 'failed' ? t('invoice.mosaic_lookup_failed') : info === 'loading' ? t('common.loading') : asset ? asset.symbol : undefined}
                  slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'characters', spellCheck: false, style: { fontFamily: 'monospace' } } }}
                />
              )}
            </Box>
          ))}
          <Button size="small" startIcon={<AddIcon />} disabled={lines.length >= MAX_INVOICE_MOSAICS} onClick={addLine}>{t('send.add_mosaic')}</Button>
          {duplicate && <Typography sx={{ color: 'error.main', fontSize: 12, mt: 0.5 }}>{t('invoice.duplicate_mosaic')}</Typography>}

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
            helperText={`${messageBytes} / ${MAX_MESSAGE_BYTES} bytes`}
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
                <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.75, textAlign: 'center' }}>{t('invoice.deadline_note')}</Typography>
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
