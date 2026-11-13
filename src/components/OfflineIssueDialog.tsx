import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import QrTextPanel from './QrTextPanel';
import { useOfflineIssueStore } from '../store/offlineIssueStore';
import type { IssuePart, OfflineIssue } from '../store/offlineIssueStore';
import { isDeviceOffline } from '../lib/offline/issue';
import { summarizePayload } from '../lib/symbol/payloadSummary';
import { readNemTransfer } from '../lib/nem/offline';
import { formatAtomic } from '../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../lib/symbol/constants';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_TX_TYPE_TRANSFER } from '../lib/nem/constants';

// 端末がオフラインのとき（ノードに届かないとき）に、送ろうとしたトランザクションを署名済みのQRコードにして出す確認画面。
// QRはここにしか無い（保存しない）ので、背景をクリックしても閉じない。「閉じる」を押したときだけ閉じる。
// 読み込む側は、プロファイル選択の「オフライントランザクション」の「読み込んで送信」（pages/offline/OfflineImportPage.tsx）。

interface PartInfo { title: string; hash?: string; fee?: string; deadlineMs?: number }

const TYPE_TRANSFER = 0x4154;
const TYPE_AGGREGATE_COMPLETE = 0x4141;
const TYPE_AGGREGATE_BONDED = 0x4241;
const TYPE_HASH_LOCK = 0x4148;

function symbolTypeTitle(t: TFunction, typeValue: number): string {
  if (typeValue === TYPE_TRANSFER) return t('signqr.type_transfer');
  if (typeValue === TYPE_AGGREGATE_COMPLETE) return t('signqr.type_aggregate_complete');
  if (typeValue === TYPE_AGGREGATE_BONDED) return t('offline_tx.type_aggregate_bonded');
  if (typeValue === TYPE_HASH_LOCK) return t('signqr.type_hash_lock');
  return t('signqr.type_other', { type: `0x${typeValue.toString(16).toUpperCase()}` });
}

/** What each part is, read from its own bytes (nothing is trusted from anywhere else). */
async function describePart(t: TFunction, part: IssuePart): Promise<PartInfo> {
  if (part.kind === 'symbol_cosignature') return { title: t('offline_tx.part_cosignature'), hash: part.parentHash.toUpperCase() };
  if (part.kind === 'nem_tx') {
    try {
      const s = readNemTransfer(part.data);
      const title = s.typeValue === NEM_TX_TYPE_TRANSFER ? t('signqr.type_transfer') : t(`offline_tx.nem_type_${s.typeValue}`, { defaultValue: t('signqr.type_other', { type: `0x${s.typeValue.toString(16).toUpperCase()}` }) });
      return { title, fee: `${formatAtomic(s.fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`, deadlineMs: s.deadlineMs };
    } catch {
      return { title: t('offline_tx.part_unknown') };
    }
  }
  try {
    const s = await summarizePayload(part.payload);
    const title = part.role === 'lock' ? t('offline_tx.role_lock') : part.role === 'bonded' ? t('offline_tx.role_bonded') : symbolTypeTitle(t, s.typeValue);
    return { title, hash: s.hash, fee: `${formatAtomic(s.fee, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`, deadlineMs: s.deadlineMs };
  } catch {
    return { title: t('offline_tx.part_unknown'), hash: part.hash };
  }
}

function Field({ label, children }: { label: string; children: string }) {
  return (
    <Box sx={{ py: 0.5 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.75rem' }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: '0.85rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>{children}</Typography>
    </Box>
  );
}

function IssueBody({ issue }: { issue: OfflineIssue }) {
  const { t } = useTranslation();
  const [infos, setInfos] = useState<PartInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfos(null);
    void Promise.all(issue.parts.map((p) => describePart(t, p))).then((list) => { if (!cancelled) setInfos(list); });
    return () => { cancelled = true; };
  }, [issue, t]);

  // 一番早い期限（ロックとアグリゲートがあるときは、ロックの期限）。これを過ぎると、発行できない。
  const earliest = useMemo(() => {
    const times = (infos ?? []).map((i) => i.deadlineMs).filter((x): x is number => typeof x === 'number');
    return times.length > 0 ? Math.min(...times) : null;
  }, [infos]);

  const chainName = issue.chain === 'nem' ? 'NEM' : 'Symbol';
  // 読み取れるまでは、「読み込み中」の行を件数ぶん出す。
  const rows: Array<PartInfo | null> = infos ?? issue.parts.map(() => null);
  const fileName = `kasane-offline-${issue.chain}-${new Date(issue.createdAt).toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`;

  return (
    <>
      <Alert severity="info" sx={{ mb: 2 }}>{issue.reason === 'offline' ? t('offline_tx.reason_offline') : t('offline_tx.reason_unreachable')}</Alert>
      <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('offline_tx.network', { name: `${chainName} ${issue.networkLabel}` })}</Typography>
      {issue.parts.length > 1 && <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1 }}>{t('offline_tx.count_title', { count: issue.parts.length })}</Typography>}

      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 0.5, mb: 2 }}>
        {rows.map((info, i) => (
          <Box key={i} sx={{ py: 0.75, borderTop: i > 0 ? 1 : 0, borderColor: 'divider' }}>
            {info === null ? <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('common.loading')}</Typography> : (
              <>
                <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{issue.parts.length > 1 ? `${i + 1}. ` : ''}{info.title}</Typography>
                {info.fee !== undefined && <Field label={t('signqr.label_fee')}>{info.fee}</Field>}
                {info.hash !== undefined && <Field label={t('signqr.label_hash')}>{info.hash}</Field>}
              </>
            )}
          </Box>
        ))}
      </Box>

      {earliest !== null && <Alert severity="warning" sx={{ mb: 2 }}>{t('offline_tx.deadline_warning', { time: new Date(earliest).toLocaleString() })}</Alert>}

      <QrTextPanel text={issue.text} file={{ text: issue.text, name: fileName }} note={t('offline_tx.qr_note')} imageButtonUnderQr imageName={fileName.replace(/\.json$/, '.png')} />

      <Typography sx={{ fontWeight: 'bold', mt: 2.5, mb: 0.5 }}>{t('offline_tx.steps_title')}</Typography>
      <Box component="ol" sx={{ m: 0, pl: 2.5, color: 'text.secondary', fontSize: 13, lineHeight: 1.8 }}>
        <li>{t('offline_tx.step1')}</li>
        <li>{t('offline_tx.step2')}</li>
        <li>{t('offline_tx.step3')}</li>
      </Box>
    </>
  );
}

export default function OfflineIssueDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const issue = useOfflineIssueStore((s) => s.issue);
  const clear = useOfflineIssueStore((s) => s.clear);
  if (issue === null) return null;

  // いま、この端末がオンラインなら、そのままこの端末で読み込んで送れる。
  const online = !isDeviceOffline();
  const sendNow = () => {
    const { text, chain } = issue;
    clear();
    navigate('/offline/import', { state: { text, chain } });
  };

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      // QRはここにしか無い: 背景のクリックや Esc では閉じない。
      onClose={(_, reason) => { if (reason !== 'backdropClick' && reason !== 'escapeKeyDown') clear(); }}
    >
      <DialogTitle>{t('offline_tx.dialog_title')}</DialogTitle>
      <DialogContent>
        <IssueBody issue={issue} />
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {online && <Button variant="outlined" onClick={sendNow}>{t('offline_tx.send_now')}</Button>}
        <Button variant="contained" onClick={clear}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
