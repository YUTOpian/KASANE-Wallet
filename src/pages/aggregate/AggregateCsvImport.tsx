import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Typography } from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useTranslation } from 'react-i18next';
import { saveTextFile } from '../../lib/saveTextFile';
import { MAX_AGGREGATE_INNER } from '../../lib/symbol/aggregate';
import type { AggregateItem } from '../../lib/symbol/aggregate';
import { resolveCsvRows } from '../../lib/symbol/aggregateCsv';
import type { CsvPreview, CsvProblem } from '../../lib/symbol/aggregateCsv';
import {
  MAX_CSV_BYTES, buildSampleCsv, decodeCsvBytes, detectDelimiter, parseCsv, readCsvRows,
} from '../../lib/symbol/aggregateCsvText';
import type { CsvRow } from '../../lib/symbol/aggregateCsvText';
import { fetchAccountRestrictions, fetchExistingMosaicInfo, resolveRecipientInput } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { prettyAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { FormRow } from '../multisig/parts';
import type { AggregateContext } from './AggregateItemForm';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

interface Props {
  ctx: AggregateContext;
  /** The draft is full: nothing more can be added. */
  full: boolean;
  onAdd: (items: AggregateItem[]) => void;
}

// CSVでまとめて送信: 見本CSVをダウンロード → 編集 → アップロード。読み込んだ各行を確認し、すべて問題なければ
// 「まとめる内容」へ送金として追加する(1行でもエラーがあれば何も追加しない: アグリゲートは全部成功か全部失敗のため)。
// Ventus Wallet のCSV一括送信(1列目 メモ / 2列目 アドレス・ネームスペース / 3列目 数量 / 4列目 モザイクID / 5列目 メッセージ)に倣った形式。
export default function AggregateCsvImport({ ctx, full, onAdd }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const run = useRef(0); // a check that was overtaken by a newer file / setting is dropped
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<CsvRow[] | null>(null);
  const [checkRestrictions, setCheckRestrictions] = useState(true);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState(0);
  const network = getNetworkConfig();
  const noBalances = ctx.balances.length === 0;

  const check = async (list: CsvRow[], withRestrictions: boolean) => {
    run.current += 1;
    const mine = run.current;
    setChecking(true);
    setNotice('');
    try {
      const result = await resolveCsvRows(list, {
        networkByte: network.networkByte,
        ownAddress: ctx.address,
        currencyMosaicId: network.currencyMosaicId,
        held: ctx.balances,
        existingItems: ctx.items,
        resolveRecipient: (input) => resolveRecipientInput(input, network.networkByte),
        lookupMosaic: async (id) => {
          const info = await fetchExistingMosaicInfo(id);
          return info ? { id: info.id, symbol: info.symbol, divisibility: info.divisibility, transferable: info.transferable } : null;
        },
        getRestrictions: withRestrictions ? fetchAccountRestrictions : undefined,
        newUid: uid,
      });
      if (run.current === mine) setPreview(result);
    } catch (e) {
      console.error('Failed to check the CSV file', e);
      if (run.current === mine) { setPreview(null); setNotice(t('aggregate.csv_check_failed')); }
    } finally {
      if (run.current === mine) setChecking(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so that the same file can be chosen again after it has been edited
    if (!file) return;
    run.current += 1;
    setFileName(file.name);
    setPreview(null);
    setRows(null);
    setNotice('');
    setAdded(0);
    setChecking(false);
    if (file.size > MAX_CSV_BYTES) { setNotice(t('aggregate.csv_too_large')); return; }
    let parsed: CsvRow[];
    try {
      const text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
      parsed = readCsvRows(parseCsv(text, detectDelimiter(text)));
    } catch (error) {
      console.error('Failed to read the CSV file', error);
      setNotice(t('aggregate.csv_read_failed'));
      return;
    }
    setRows(parsed);
    await check(parsed, checkRestrictions);
  };

  const downloadSample = () => {
    const comments = t('aggregate.csv_sample_comments', { returnObjects: true }) as string[];
    // The BOM makes Excel (and Windows Notepad) read the file as UTF-8.
    saveTextFile(buildSampleCsv(ctx.address, network.currencyMosaicId, comments), 'kasane-aggregate-sample.csv', 'text/csv;charset=utf-8', true);
  };

  const problemText = (p: CsvProblem) => t(p.key, p.params);
  const canAdd = preview !== null && !checking && preview.errorCount === 0 && preview.items.length > 0 && !full;

  const onAddClick = () => {
    if (!preview || !canAdd) return;
    const count = preview.items.length;
    onAdd(preview.items);
    setAdded(count);
    setPreview(null);
    setRows(null);
    setFileName('');
  };

  // What the file sends in total, per mosaic ("1.5 XYM, 2 company.token").
  const totalText = (() => {
    if (!preview || preview.items.length === 0) return '';
    const sums = new Map<string, { symbol: string; divisibility: number; amount: bigint }>();
    for (const item of preview.items) {
      if (item.kind !== 'transfer' || item.amount <= 0n) continue;
      const sum = sums.get(item.mosaicId) ?? { symbol: item.mosaicSymbol, divisibility: item.divisibility, amount: 0n };
      sum.amount += item.amount;
      sums.set(item.mosaicId, sum);
    }
    return [...sums.values()].map((s) => `${formatAtomic(s.amount, s.divisibility)} ${s.symbol}`).join(', ');
  })();

  return (
    <Box>
      <Typography sx={{ fontWeight: 'bold', fontSize: '1.15rem', color: 'primary.main', mt: 1, mb: 2 }}>{t('aggregate.csv_heading')}</Typography>
      <Alert severity="info" sx={{ mb: 1 }}>{t('aggregate.csv_intro')}</Alert>

      <FormRow label={t('aggregate.csv_step1')} hint={t('aggregate.csv_step1_hint')}>
        <Button variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={downloadSample} disabled={ctx.address === ''}>{t('aggregate.csv_download')}</Button>
      </FormRow>
      <FormRow label={t('aggregate.csv_step2')}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('aggregate.csv_step2_text')}</Typography>
      </FormRow>
      <FormRow label={t('aggregate.csv_step3')} hint={t('aggregate.csv_capacity', { count: Math.max(0, MAX_AGGREGATE_INNER - ctx.items.length) })}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          <Button variant="contained" startIcon={<UploadFileOutlinedIcon />} onClick={() => fileInput.current?.click()} disabled={full || noBalances || checking}>{t('aggregate.csv_upload')}</Button>
          <input ref={fileInput} type="file" accept=".csv,.txt,text/csv,text/plain,application/vnd.ms-excel" hidden onChange={(e) => { void onFile(e); }} />
          <Typography variant="body2" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>{fileName !== '' ? fileName : t('aggregate.csv_no_file')}</Typography>
        </Box>
        <FormControlLabel
          sx={{ mt: 0.5 }}
          label={<Typography variant="body2">{t('aggregate.csv_check_restrictions')}</Typography>}
          control={<Checkbox size="small" checked={checkRestrictions} onChange={(e) => { setCheckRestrictions(e.target.checked); if (rows) void check(rows, e.target.checked); }} />}
        />
      </FormRow>

      {full && <Alert severity="warning" sx={{ mt: 1 }}>{t('aggregate.full_notice')}</Alert>}
      {noBalances && <Alert severity="warning" sx={{ mt: 1 }}>{t('aggregate.csv_no_balances')}</Alert>}
      {notice !== '' && <Alert severity="error" sx={{ mt: 1 }}>{notice}</Alert>}
      {added > 0 && <Alert severity="success" sx={{ mt: 1 }}>{t('aggregate.csv_added', { count: added })}</Alert>}

      {checking && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">{t('aggregate.csv_checking')}</Typography>
        </Box>
      )}

      {preview && !checking && (
        <Box sx={{ mt: 2 }}>
          {preview.errorCount > 0
            ? <Alert severity="error">{t('aggregate.csv_loaded_error', { count: preview.errorCount })}</Alert>
            : <Alert severity={preview.warningCount > 0 ? 'warning' : 'success'}>
              {t('aggregate.csv_loaded_ok', { count: preview.items.length })}
              {preview.warningCount > 0 ? ` ${t('aggregate.csv_loaded_warn', { count: preview.warningCount })}` : ''}
            </Alert>}
          {preview.errors.map((p, i) => <Alert key={`e${i}`} severity="error" sx={{ mt: 1 }}>{problemText(p)}</Alert>)}
          {preview.warnings.map((p, i) => <Alert key={`w${i}`} severity="warning" sx={{ mt: 1 }}>{problemText(p)}</Alert>)}

          {preview.rows.length > 0 && (
            <Box sx={{ mt: 1.5, border: 1, borderColor: 'divider', borderRadius: 3, maxHeight: 440, overflowY: 'auto' }}>
              {preview.rows.map((p, i) => {
                const recipient = p.toAddress !== '' ? (p.alias ? `${p.alias} (${prettyAddress(p.toAddress)})` : prettyAddress(p.toAddress)) : p.row.recipient;
                const amount = p.item
                  ? (p.item.amount > 0n ? `${formatAtomic(p.item.amount, p.item.divisibility)} ${p.item.mosaicSymbol}` : '')
                  : [p.row.amount, p.row.mosaic].filter((x) => x !== '').join(' ');
                return (
                  <Box key={p.row.line} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, px: 2, py: 1.25, borderTop: i > 0 ? 1 : 0, borderColor: 'divider' }}>
                    {p.errors.length > 0 ? <ErrorOutlineOutlinedIcon color="error" fontSize="small" sx={{ mt: 0.25 }} />
                      : p.warnings.length > 0 ? <WarningAmberIcon color="warning" fontSize="small" sx={{ mt: 0.25 }} />
                        : <CheckCircleOutlinedIcon color="success" fontSize="small" sx={{ mt: 0.25 }} />}
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                        {t('aggregate.csv_row_title', { line: p.row.line })}{p.row.label !== '' ? ` · ${p.row.label}` : ''}
                      </Typography>
                      <Typography variant="body2" sx={mono}>{recipient}</Typography>
                      {amount !== '' && <Typography variant="body2" sx={mono}>{amount}</Typography>}
                      {p.row.message !== '' && <Typography variant="body2" sx={{ ...mono, whiteSpace: 'pre-wrap', color: 'text.secondary' }}>{t('common.message')}: {p.row.message}</Typography>}
                      {p.errors.map((e, j) => <Typography key={`e${j}`} variant="body2" sx={{ color: 'error.main', mt: 0.25 }}>{problemText(e)}</Typography>)}
                      {p.warnings.map((w, j) => <Typography key={`w${j}`} variant="body2" sx={{ color: 'warning.main', mt: 0.25 }}>{problemText(w)}</Typography>)}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}

          {preview.errorCount === 0 && totalText !== '' && (
            <Typography sx={{ mt: 1.5, fontWeight: 'bold', wordBreak: 'break-all' }}>{t('aggregate.csv_total', { text: totalText })}</Typography>
          )}
          <Button variant="contained" size="large" fullWidth disabled={!canAdd} onClick={onAddClick} sx={{ mt: 2, py: 1.25, width: { md: 'auto' }, px: { md: 6 } }}>
            {t('aggregate.csv_add_button', { count: preview.items.length })}
          </Button>
        </Box>
      )}

      <Box sx={{ mt: 3, bgcolor: 'action.hover', borderRadius: 3, px: 2, py: 1.5 }}>
        <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', mb: 0.5 }}>{t('aggregate.csv_format_title')}</Typography>
        {(t('aggregate.csv_format', { returnObjects: true }) as string[]).map((line, i) => (
          <Typography key={i} variant="body2" sx={{ color: 'text.secondary', py: 0.15 }}>{line}</Typography>
        ))}
      </Box>
    </Box>
  );
}
