import { useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Typography } from '@mui/material';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import { useTranslation } from 'react-i18next';
import { fetchNemTransactionByHash, nemExplorerTxUrl } from '../../lib/nem/api';
import { parseApostilleFileName, verifyApostille } from '../../lib/nem/apostille';
import { nemAddressFromPublicKey, prettyNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';

type Verdict = 'valid' | 'invalid' | 'not_found' | 'wrong_format' | 'not_apostille' | 'error';

interface Row {
  key: number;
  fileName: string;
  verdict: Verdict;
  owner?: string;
  message?: string;
  txHash?: string;
  detail?: string;
}

const COLOR: Record<Verdict, 'success' | 'error' | 'warning'> = {
  valid: 'success', invalid: 'error', not_found: 'warning', wrong_format: 'warning', not_apostille: 'error', error: 'warning',
};

// 「監査」: 公証したときに保存した（名前に取引ハッシュが入った）ファイルを選ぶと、ブロックチェーンの記録と照らして、
// 変更されていないかを確かめる。ファイルは端末の外に出ない（取引ハッシュだけをノードに問い合わせる）。
export default function ApostilleAudit() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(1);

  const audit = async (file: File): Promise<Row> => {
    const key = counter.current++;
    const parsed = parseApostilleFileName(file.name);
    if (!parsed) return { key, fileName: file.name, verdict: 'wrong_format' };
    try {
      const tx = await fetchNemTransactionByHash(parsed.txHash);
      if (!tx) return { key, fileName: parsed.originalName, verdict: 'not_found', txHash: parsed.txHash };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verdict = verifyApostille(bytes, tx.payloadHex, tx.signer);
      return {
        key, fileName: parsed.originalName, verdict, txHash: parsed.txHash, message: tx.payloadHex,
        owner: nemAddressFromPublicKey(tx.signer, getNemNetworkConfig().networkByte),
      };
    } catch (e) {
      return { key, fileName: parsed.originalName, verdict: 'error', txHash: parsed.txHash, detail: (e as Error).message };
    }
  };

  const onPick = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    if (input.current) input.current.value = '';
    setBusy(true);
    try {
      for (const file of files) {
        const row = await audit(file);
        setRows((prev) => [row, ...prev]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('apostille.audit_intro')}</Typography>
      <input ref={input} type="file" multiple hidden onChange={(e) => void onPick(e.target.files)} />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        <Button variant="contained" disabled={busy} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <FileUploadOutlinedIcon />} onClick={() => input.current?.click()}>
          {t('apostille.audit_pick')}
        </Button>
        {rows.length > 0 && <Button onClick={() => setRows([])}>{t('apostille.audit_clear')}</Button>}
      </Box>

      {rows.map((r) => (
        <Alert key={r.key} severity={COLOR[r.verdict]} icon={false} sx={{ mb: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Chip size="small" color={COLOR[r.verdict]} label={t(`apostille.verdict_${r.verdict}`)} />
            <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{r.fileName}</Typography>
          </Box>
          {r.owner && <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{t('apostille.owner')}: {prettyNemAddress(r.owner)}</Typography>}
          {r.message && <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>{t('apostille.message_hex')}: {r.message}</Typography>}
          {r.txHash && (
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
              <a href={nemExplorerTxUrl(r.txHash)} target="_blank" rel="noopener noreferrer">{r.txHash}</a>
            </Typography>
          )}
          {r.verdict === 'wrong_format' && <Typography variant="body2">{t('apostille.wrong_format_hint')}</Typography>}
          {r.verdict === 'error' && <Typography variant="body2">{t('apostille.audit_error_hint')}{r.detail ? ` (${r.detail})` : ''}</Typography>}
        </Alert>
      ))}
    </Box>
  );
}
