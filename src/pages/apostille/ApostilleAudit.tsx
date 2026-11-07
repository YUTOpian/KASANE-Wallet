import { useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Typography } from '@mui/material';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import { useTranslation } from 'react-i18next';
import { apostilleDriver } from '../../lib/apostilleChain';
import { parseApostilleFileName } from '../../lib/nem/apostille';
import { useAppStore } from '../../store/appStore';
import { EmptyPanel, TwoColumns } from '../../components/DesktopPage';
import { SectionCard } from '../multisig/parts';

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
  const chain = useAppStore((st) => st.chain);
  const driver = apostilleDriver(chain);

  const audit = async (file: File): Promise<Row> => {
    const key = counter.current++;
    const parsed = parseApostilleFileName(file.name);
    if (!parsed) return { key, fileName: file.name, verdict: 'wrong_format' };
    try {
      const tx = await driver.fetchTx(parsed.txHash);
      if (!tx) return { key, fileName: parsed.originalName, verdict: 'not_found', txHash: parsed.txHash };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verdict = driver.verify(bytes, tx.payloadHex, tx.signer);
      return {
        key, fileName: parsed.originalName, verdict, txHash: parsed.txHash, message: tx.payloadHex,
        owner: driver.addressOfSigner(tx.signer),
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

  // Laid out like the signed-message verify screen: the file picker and its explanation on the left, the result bands on the right.
  // The bands stay inside their own column, so a long address or hex no longer stretches across the whole screen.
  return (
    <TwoColumns columns sx={{ textAlign: 'left' }}>
      {/* 左: ファイルを選ぶ欄と説明 */}
      <Box>
        <SectionCard>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('apostille.audit_intro')}</Typography>
          <input ref={input} type="file" multiple hidden onChange={(e) => void onPick(e.target.files)} />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button variant="contained" disabled={busy} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <FileUploadOutlinedIcon />} onClick={() => input.current?.click()}>
              {t('apostille.audit_pick')}
            </Button>
            {rows.length > 0 && <Button onClick={() => setRows([])}>{t('apostille.audit_clear')}</Button>}
          </Box>
        </SectionCard>
      </Box>

      {/* 右: 結果の帯 */}
      <Box sx={{ minWidth: 0 }}>
        <SectionCard title={t('apostille.audit_results_title')}>
          {rows.length === 0 ? (
            <EmptyPanel>{t('apostille.audit_empty')}</EmptyPanel>
          ) : rows.map((r) => (
            <Alert key={r.key} severity={COLOR[r.verdict]} icon={false} sx={{ mb: 1.5, alignItems: 'flex-start' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
                <Chip size="small" color={COLOR[r.verdict]} label={t(`apostille.verdict_${r.verdict}`)} />
                <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{r.fileName}</Typography>
              </Box>
              {r.owner && <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{t('apostille.owner')}: {driver.prettyAddress(r.owner)}</Typography>}
              {r.message && <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>{t('apostille.message_hex')}: {r.message}</Typography>}
              {r.txHash && (
                <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                  <a href={driver.txUrl(r.txHash)} target="_blank" rel="noopener noreferrer">{r.txHash}</a>
                </Typography>
              )}
              {r.verdict === 'wrong_format' && <Typography variant="body2">{t('apostille.wrong_format_hint')}</Typography>}
              {r.verdict === 'error' && <Typography variant="body2">{t('apostille.audit_error_hint')}{r.detail ? ` (${r.detail})` : ''}</Typography>}
            </Alert>
          ))}
        </SectionCard>
      </Box>
    </TwoColumns>
  );
}
