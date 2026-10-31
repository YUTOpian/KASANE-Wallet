import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../lib/storage';
import { backupDone, isBackupSnoozed, snoozeBackup } from '../lib/onboarding';

/**
 * Modal shown over Home:
 *  - バックアップ注意モーダル: while the active profile (not a view-only one) has never been backed up / confirmed.
 * (The first-run 使い方ウィザード has been retired; nothing is shown on first launch except this reminder.)
 */
export default function HomeGuides() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [backupOpen, setBackupOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await WalletsHelper.getActiveAny();
        if (cancelled || !profile) return;
        const wallet = await WalletsHelper.getActive();
        const key = wallet?.profileKey ?? '';
        if (!profile.keyless && key !== '' && !backupDone(key) && !isBackupSnoozed()) {
          setBackupOpen(true);
        }
      } catch (e) {
        console.error('HomeGuides: could not decide which guide to show', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const goBackup = () => {
    setBackupOpen(false);
    navigate('/wallet/backup_caution?mode=mnemonic&back=/top');
  };
  const later = () => {
    snoozeBackup();
    setBackupOpen(false);
  };

  return (
    <Dialog open={backupOpen} onClose={later} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ color: 'warning.main' }}>{t('guide.backup_title')}</DialogTitle>
      <DialogContent>
        {(t('guide.backup_message', { returnObjects: true }) as string[]).map((line, i) => (
          <Typography key={i} variant="body2" sx={{ mb: 1, lineHeight: 1.8 }}>{line}</Typography>
        ))}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'center', pb: 2, gap: 1 }}>
        <Button color="inherit" onClick={later}>{t('guide.backup_later')}</Button>
        <Button variant="contained" onClick={goBackup}>{t('guide.backup_now')}</Button>
      </DialogActions>
    </Dialog>
  );
}
