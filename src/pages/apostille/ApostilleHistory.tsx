import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Typography } from '@mui/material';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import { nemExplorerAccountUrl, nemExplorerTxUrl } from '../../lib/nem/api';
import { apostilleSink, shortDate } from '../../lib/nem/apostille';
import { addApostilles, loadApostilles, purgeApostilles } from '../../lib/nem/apostilleStore';
import { parseNty, serializeNty } from '../../lib/nem/apostilleNty';
import type { ApostilleRecord } from '../../lib/nem/apostilleNty';
import { prettyNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { saveFile } from '../../lib/paperWalletExport';
import MessageDialog from '../../components/MessageDialog';
import type { UpdateTarget } from './ApostilleCreate';

interface Props {
  /** Bumped when a new apostille was made, so the list reloads. */
  version: number;
  onUpdate: (target: UpdateTarget) => void;
  /** The 更新 button needs the profile's key. */
  canUpdate?: boolean;
}

// 「履歴」: この端末に記録した公証の一覧（.nty ファイルとして書き出し・読み込みもできる。NanoWallet のものも読める）。
export default function ApostilleHistory({ version, onUpdate, canUpdate = true }: Props) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<ApostilleRecord[] | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => setRecords(await loadApostilles()), []);
  useEffect(() => { void reload(); }, [reload, version]);

  const sink = apostilleSink(getNemNetworkConfig().networkByte);

  const onImport = async (list: FileList | null) => {
    const file = list?.[0];
    if (input.current) input.current.value = '';
    if (!file) return;
    const parsed = parseNty(await file.text());
    if (!parsed) {
      setNotice({ severity: 'error', text: t('apostille.import_failed') });
      return;
    }
    const added = await addApostilles(parsed.data);
    setNotice({ severity: 'success', text: t('apostille.import_done', { added, total: parsed.data.length }) });
    await reload();
  };

  const onBackup = async () => {
    const all = await loadApostilles();
    await saveFile(new TextEncoder().encode(serializeNty(all)), `Nty-file-${shortDate(new Date())}.nty`, 'text/plain');
  };

  const shown = records ? [...records].reverse() : [];

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('apostille.history_intro')}</Typography>
      <input ref={input} type="file" accept=".nty,application/json,text/plain" hidden onChange={(e) => void onImport(e.target.files)} />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        <Button size="small" variant="outlined" startIcon={<DownloadOutlinedIcon />} disabled={shown.length === 0} onClick={() => void onBackup()}>{t('apostille.backup')}</Button>
        <Button size="small" variant="outlined" startIcon={<UploadFileOutlinedIcon />} onClick={() => input.current?.click()}>{t('apostille.import')}</Button>
        <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} disabled={shown.length === 0} onClick={() => setConfirmPurge(true)}>{t('apostille.purge')}</Button>
      </Box>
      {notice && <Alert severity={notice.severity} sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice.text}</Alert>}

      {records !== null && shown.length === 0 && <Typography sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>{t('apostille.history_empty')}</Typography>}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }, columnGap: 2, alignItems: 'start' }}>
      {shown.map((r) => {
        const isSigned = r.dedicatedAccount !== sink;
        return (
          <Box key={r.txHash} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 1.5, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all', flexGrow: 1, minWidth: 0 }}>{r.filename}</Typography>
              <Chip size="small" label={isSigned ? t('apostille.type_signed_short') : t('apostille.type_public_short')} color={isSigned ? 'primary' : 'default'} />
            </Box>
            {r.tags && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('apostille.tags_label')}: {r.tags}</Typography>}
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{r.timeStamp}</Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-all', mt: 0.5 }}>
              {t('apostille.sent_to')}: <a href={nemExplorerAccountUrl(r.dedicatedAccount)} target="_blank" rel="noopener noreferrer">{prettyNemAddress(r.dedicatedAccount)}</a>
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>
              <a href={nemExplorerTxUrl(r.txMultisigHash || r.txHash)} target="_blank" rel="noopener noreferrer">{r.fileHash}</a>
            </Typography>
            {isSigned && canUpdate && (
              <Button size="small" sx={{ mt: 1 }} onClick={() => onUpdate({ address: r.dedicatedAccount, tags: r.tags, filename: r.filename })}>{t('apostille.update')}</Button>
            )}
          </Box>
        );
      })}
      </Box>

      <MessageDialog
        open={confirmPurge}
        title={t('apostille.purge_title')}
        texts={[t('apostille.purge_text')]}
        selectable
        onCancel={() => setConfirmPurge(false)}
        onClose={() => { setConfirmPurge(false); void purgeApostilles().then(reload); }}
      />
    </Box>
  );
}
