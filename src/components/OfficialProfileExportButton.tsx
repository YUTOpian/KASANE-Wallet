import { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import SyncAltOutlinedIcon from '@mui/icons-material/SyncAltOutlined';
import { useTranslation } from 'react-i18next';
import { saveFile } from '../lib/paperWalletExport';
import { officialConsoleScript, officialExportToJson } from '../lib/officialProfile/format';
import { exportProfileToOfficial } from '../lib/officialProfile/convert';
import type { ExportResult } from '../lib/officialProfile/convert';

type Done = Extract<ExportResult, { ok: true }>;

function fileNameOf(profileName: string): string {
  const safe = profileName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'kasane';
  return `${safe}-symbol-wallet-profile.json`;
}

// 「公式ウォレット用に書き出す」: このプロファイルを、Symbol 公式ウォレットのプロファイルの形（profiles / accounts）にして、
// ファイルとして保存する、または公式ウォレットのページのコンソールに貼るスクリプトとしてコピーする。この端末の中だけで作る。
interface Props {
  walletId: string | null;
  /** 渡すと、ボタンは出さず、この値でダイアログだけを開閉する（プロファイル設定のメニュー項目から開く用）。 */
  open?: boolean;
  onClose?: () => void;
}

export default function OfficialProfileExportButton({ walletId, open: controlledOpen, onClose }: Props) {
  const { t } = useTranslation();
  const [innerOpen, setOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : innerOpen;
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);

  if (walletId === null) return null;

  const close = () => {
    if (busy) return;
    setOpen(false); setPassword(''); setError(''); setDone(null); setCopied(false);
    onClose?.();
  };

  const onRun = async () => {
    if (busy || password === '') return;
    setBusy(true); setError('');
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await exportProfileToOfficial(walletId, password);
      if (result.ok) setDone(result);
      else setError(t(`wallet.official_export_${result.reason.replace('-', '_')}`));
    } catch (e) {
      console.error('OfficialProfileExportButton: export failed', e instanceof Error ? e.message : 'unknown error');
      setError(t('wallet.official_export_failed'));
    }
    setBusy(false);
  };

  const onSave = async () => {
    if (!done) return;
    try {
      await saveFile(new TextEncoder().encode(officialExportToJson(done.data)), fileNameOf(done.profileName), 'application/json');
    } catch {
      setError(t('wallet.official_export_failed'));
    }
  };

  const onCopy = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(officialConsoleScript(done.data));
      setCopied(true);
    } catch {
      setError(t('wallet.official_export_failed'));
    }
  };

  return (
    <Box sx={controlled ? undefined : { display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, mx: 2 }}>
      {!controlled && (
        <>
          <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>{t('wallet.official_export_hint')}</Typography>
          <Button variant="outlined" color="primary" onClick={() => setOpen(true)} startIcon={<SyncAltOutlinedIcon />} sx={{ minWidth: 260 }}>
            {t('wallet.official_export_button')}
          </Button>
        </>
      )}

      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>{t('wallet.official_export_title')}</DialogTitle>
        <DialogContent>
          {done === null ? (
            <>
              <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.official_export_ask')}</Typography>
              <TextField
                fullWidth type="password" autoComplete="off" autoFocus
                label={t('wallet.official_export_password_label')}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onRun(); } }}
              />
            </>
          ) : (
            <>
              <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('wallet.official_export_done', { name: done.profileName, count: done.accountCount })}</Typography>
              <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                {done.withSeed ? t('wallet.official_export_with_seed') : done.network === 'testnet' ? t('wallet.official_export_no_seed_testnet') : t('wallet.official_export_no_seed_none')}
              </Typography>
              {done.skippedCount > 0 && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('wallet.official_export_skipped', { count: done.skippedCount })}</Alert>}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 2 }}>
                <Button variant="contained" onClick={() => { void onSave(); }}>{t('wallet.official_export_save_file')}</Button>
                <Button variant="outlined" onClick={() => { void onCopy(); }}>{copied ? t('wallet.official_copied') : t('wallet.official_export_copy_script')}</Button>
              </Box>
              <Typography component="div" sx={{ fontSize: 12, color: 'text.secondary', mt: 2 }}>
                {(t('wallet.official_export_howto', { returnObjects: true }) as string[]).map((line, i) => <div key={i} style={{ marginBottom: 6 }}>{line}</div>)}
              </Typography>
              <Alert severity="warning" sx={{ mt: 2 }}>{t('wallet.official_export_warning')}</Alert>
            </>
          )}
          {error !== '' && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>{done === null ? t('common.cancel') : t('common.close')}</Button>
          {done === null && (
            <Button variant="contained" disabled={busy || password === ''} onClick={() => { void onRun(); }} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
              {t('wallet.official_export_run')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
