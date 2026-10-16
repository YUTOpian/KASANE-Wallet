import { useEffect, useState } from 'react';
import { Box, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Typography, Snackbar } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import SyncAltOutlinedIcon from '@mui/icons-material/SyncAltOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ChoiceCard, { choiceGridSx } from '../../components/ChoiceCard';
import KasaneStage from '../../components/kasane/KasaneStage';
import ChangePasswordDialog from '../../components/ChangePasswordDialog';
import OfficialProfileExportButton from '../../components/OfficialProfileExportButton';
import { PinCodeHelper, WalletsHelper } from '../../lib/storage';
import { Environment } from '../../lib/environment';
import { clearHomeCache } from '../../lib/homeCache';
import { CHAINS } from '../../lib/chain';
import cautionIcon from '../../assets/icon_caution.png';

export default function WalletSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id') || '';

  const [renameDialog, setRenameDialog] = useState(false);
  const [newWalletName, setNewWalletName] = useState('');
  // プロファイルの削除は、画面遷移ではなくポップアップで確認する。
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [profileKey, setProfileKey] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [changePasswordDialog, setChangePasswordDialog] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [officialExportDialog, setOfficialExportDialog] = useState(false);

  // プロファイルのバックアップはニーモニック。ニーモニックを持たないプロファイル
  // （秘密鍵だけでインポートしたもの）は、バックアップの手段がなくならないよう秘密鍵を表示する。
  const [hasMnemonic, setHasMnemonic] = useState(true);
  // 閲覧用プロファイル（アドレスだけ）：バックアップするものも、パスワードも無い。
  const [watchOnly, setWatchOnly] = useState(false);
  // Ledger のプロファイル：バックアップ（ニーモニックはデバイスが持つ）もパスワードも、この端末には無い。
  const [ledger, setLedger] = useState(false);
  const [watchChain, setWatchChain] = useState('');
  useEffect(() => {
    (async () => {
      setHasMnemonic((await WalletsHelper.getProfileMnemonicWallet(id)) !== null);
      const wallet = await WalletsHelper.get(id);
      if (wallet) {
        setProfileKey(wallet.profileKey);
        setWatchOnly(wallet.watchOnly);
        setLedger(wallet.ledger);
        setWatchChain(CHAINS[wallet.chain].name);
      }
    })();
  }, [id]);

  const items = [
    ...(watchOnly || ledger ? [] : [
      {
        text: t('wallet.settings_backup'),
        icon: BackupOutlinedIcon,
        action: () => navigate(`/wallet/backup_caution?id=${id}${hasMnemonic ? '&mode=mnemonic' : ''}`),
      },
      { text: t('wallet.settings_change_password'), icon: LockOutlinedIcon, action: () => setChangePasswordDialog(true) },
      { text: t('wallet.official_export_button'), icon: SyncAltOutlinedIcon, action: () => setOfficialExportDialog(true) },
    ]),
    { text: t('wallet.settings_rename'), icon: EditOutlinedIcon, action: () => { setNewWalletName(''); setRenameDialog(true); } },
    { text: t('wallet.settings_delete'), icon: DeleteOutlineIcon, action: () => setDeleteDialog(true) },
  ];

  const rename = async () => {
    await WalletsHelper.setName(id, newWalletName);
    setRenameDialog(false);
  };

  const deleteProfile = async () => {
    setDeleting(true);
    try {
      // このプロファイルのアカウントをすべて消す：ニーモニックフレーズ、導出済みの各インデックスの秘密鍵、
      // このプロファイルにインポートした秘密鍵（WalletsHelper.delete は同じプロファイルの全アカウントを削除する）。
      await WalletsHelper.delete(id);
      clearHomeCache();
      setDeleteDialog(false);
      if ((await WalletsHelper.gets()).length === 0) {
        // そのプロファイルのパスワードは WalletsHelper.delete が消している。最後のプロファイルを消したら、
        // 旧バージョンの共通のパスワードも含めてすべて削除し、最初のウェルカム画面に戻る。
        await PinCodeHelper.remove();
        navigate('/welcome', { replace: true });
        return;
      }
      navigate('/wallet/select', { replace: true });
    } finally {
      setDeleting(false);
    }
  };

  // 削除ボタン: パスワードは求めない。パスワードを忘れたプロファイルも消せるようにするため。
  // 確認は、上の警告ダイアログ（REMOVE ボタン）で行う。
  const onConfirmDelete = async () => {
    await deleteProfile();
  };

  const goBack = () => {
    if (Environment.isIos() && Environment.isInStandaloneMode()) navigate('/wallet/select');
    else navigate(-1);
  };

  return (
    <KasaneStage onBack={goBack} title={t('wallet.settings_title')} maxWidth={760}>
      {watchOnly && watchChain && (
        <Typography variant="body2" align="center" color="text.secondary" sx={{ mt: 1 }}>{t('watch.badge')} · {watchChain}</Typography>
      )}
      <Box sx={{ ...choiceGridSx, mt: 2 }}>
        {items.map((item) => (
          <ChoiceCard key={item.text} icon={item.icon} title={item.text} onClick={item.action} />
        ))}
      </Box>

      <Dialog open={renameDialog} onClose={() => setRenameDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.rename_title')}</DialogTitle>
        <DialogContent>
          <TextField fullWidth autoFocus label={t('wallet.rename_hint')} value={newWalletName} onChange={(e) => setNewWalletName(e.target.value)} sx={{ mt: 1, mb: 2 }} />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 1 }}>
            <Button variant="contained" color="primary" disabled={newWalletName.length === 0} onClick={rename}>OK</Button>
            <Button variant="outlined" color="primary" onClick={() => setRenameDialog(false)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialog} onClose={() => !deleting && setDeleteDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box component="img" src={cautionIcon} sx={{ width: 18, height: 18 }} />
          {t('wallet.settings_delete')}
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>{t(watchOnly ? 'watch.delete_caution_title' : 'wallet.key_caution_title')}</Typography>
          <Typography variant="body2" sx={{ lineHeight: 1.8 }}>
            {(t(watchOnly ? 'watch.delete_caution_message' : 'wallet.delete_caution_message', { returnObjects: true }) as string[]).map((line, i) => (
              <span key={i}>{line}<br /></span>
            ))}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'center', gap: 2, pb: 2.5 }}>
          <Button variant="outlined" color="primary" disabled={deleting} onClick={() => setDeleteDialog(false)}>CANCEL</Button>
          <Button variant="contained" color="primary" disabled={deleting} onClick={onConfirmDelete}>REMOVE</Button>
        </DialogActions>
      </Dialog>

      <ChangePasswordDialog
        open={changePasswordDialog}
        profileKey={profileKey}
        onClose={() => setChangePasswordDialog(false)}
        onChanged={() => { setChangePasswordDialog(false); setPasswordChanged(true); }}
      />
      <OfficialProfileExportButton walletId={id || null} open={officialExportDialog} onClose={() => setOfficialExportDialog(false)} />
      <Snackbar
        open={passwordChanged}
        autoHideDuration={3000}
        onClose={() => setPasswordChanged(false)}
        message={t('wallet.change_password_done')}
      />
    </KasaneStage>
  );
}
