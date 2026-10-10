import { useEffect, useRef, useState } from 'react';
import {
  Box, Button, Typography, List, ListItemButton, ListItemText, Divider,
  Dialog, DialogTitle, DialogContent, TextField,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import InfoCard, { tileGridSx } from '../../components/InfoCard';
import PasswordDialog from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { PrivateKeyHelper } from '../../lib/symbol/hd';
import { accountFromPrivateKey } from '../../lib/accounts';
import { getChain } from '../../lib/chain';
import { currencySymbol, fetchChainBalances, prettyChainAddress } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';

// NABCDE…XYZ123 — short enough to fit on one line.
function shortenAddress(address: string): string {
  const pretty = prettyChainAddress(address);
  return pretty.length <= 20 ? pretty : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

// メニューの「ウォレット切替」。今のプロファイル（=1つのニーモニック）から導出済みの、別インデックスの
// アカウントを選ぶ画面。
//  - 最初に出ているのは一部のインデックスだけ。ほかのインデックスは「インデックスを表示する」で手動で出す。
//  - 各インデックスには自分で名前をつけられる（空欄なら「インデックス N」）。
//  - インデックス 0 以外は、「非表示」にしてこの一覧から隠せる（あとから「インデックスを表示する」で戻せる）。
//  - 秘密鍵でインポートして、このプロファイルにアカウントを追加できる（パスワードの確認だけ行う）。
//  - 新規プロファイルの作成はここではしない。
export default function WalletSwitch() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const network = useAppStore((st) => st.network);
  const [accounts, setAccounts] = useState<Wallet[]>([]);
  const [activeId, setActiveId] = useState('');
  const [profileName, setProfileName] = useState('');
  // Any account of the profile in use (the profile is what a private key gets added to).
  const [profileRefId, setProfileRefId] = useState('');
  const [profileKeyOfUse, setProfileKeyOfUse] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const requested = useRef<Set<string>>(new Set());

  const [renameTarget, setRenameTarget] = useState<Wallet | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showPicker, setShowPicker] = useState(false);

  // 秘密鍵でインポート
  const [showImport, setShowImport] = useState(false);
  const [importKey, setImportKey] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const load = async () => {
    // The profile in use. On NEM it may have no NEM account yet (then the list is empty and a
    // private key can be added); a profile-less state goes back to the profile screen.
    const profile = await WalletsHelper.getActiveAny();
    if (!profile) {
      navigate('/wallet/select', { replace: true });
      return;
    }
    const active = await WalletsHelper.getActive();
    setActiveId(active?.id ?? '');
    setProfileName(profile.name);
    setProfileRefId(profile.id);
    setProfileKeyOfUse(profile.profileKey);
    // Only the accounts of the selected chain (Symbol indices / NEM indices).
    setAccounts(await WalletsHelper.getProfileWallets(profile.id, getChain()));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 今アクティブなアカウントは、非表示のものであっても必ず表示する。
  const visible = accounts.filter((wallet) => !wallet.hidden || wallet.id === activeId);
  const hiddenAccounts = accounts.filter((wallet) => wallet.hidden && wallet.id !== activeId);

  // 表示されているアカウントの残高を取得する（ネットワークごとに1回だけ。あとから表示したぶんも取得）。
  useEffect(() => {
    visible.forEach(async (wallet) => {
      const cacheKey = `${network}:${wallet.id}`;
      if (requested.current.has(cacheKey)) {
        return;
      }
      requested.current.add(cacheKey);
      let balance = '-';
      try {
        balance = (await fetchChainBalances(wallet.address))[0]?.balance ?? '0';
      } catch (e) {
        console.error(`Failed to fetch balance for wallet ${wallet.id}`, e);
      }
      setBalances((prev) => ({ ...prev, [cacheKey]: balance }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, activeId, network]);

  // 秘密鍵でインポートしたアカウントにはインデックスが無い。
  // いま使っているアカウントのプロファイル（パスワードはプロファイルごと）。
  const activeProfileKey = profileKeyOfUse;

  const defaultLabel = (wallet: Wallet) => (
    wallet.accountIndex === null
      ? t('wallet.account_imported')
      : t('wallet.account_index', { index: wallet.accountIndex })
  );

  // インデックス 0 は隠せない。いま使っているアカウントも隠せない（先に別のアカウントへ切り替える）。
  const canHide = (wallet: Wallet) => wallet.accountIndex !== 0 && wallet.id !== activeId;

  const selectAccount = async (wallet: Wallet) => {
    await WalletsHelper.setActive(wallet.id);
    navigate('/top');
  };

  const openRename = (wallet: Wallet) => {
    setRenameValue(wallet.accountName);
    setRenameTarget(wallet);
  };

  const saveRename = async () => {
    if (!renameTarget) {
      return;
    }
    await WalletsHelper.updateAccount(renameTarget.id, { accountName: renameValue.trim() });
    setRenameTarget(null);
    await load();
  };

  const hideAccount = async (wallet: Wallet) => {
    await WalletsHelper.updateAccount(wallet.id, { hidden: true });
    await load();
  };

  const openImport = () => {
    setImportKey('');
    setShowImport(true);
  };

  const importKeyValid = PrivateKeyHelper.isValid(importKey);

  // 入力した秘密鍵が正しければ、このプロファイルのパスワードを確認してから追加する。
  const askPasswordForImport = () => {
    setShowPin(true);
  };

  const importWithPassword = async (password: string) => {
    try {
      // A Symbol or a NEM private key, depending on the chain selected.
      const account = accountFromPrivateKey(importKey);
      const result = await WalletsHelper.addImportedKeyToProfile(
        profileRefId, account.publicKey, account.privateKey, password, getChain(),
      );
      if (result === 'other-profile') {
        setErrorMessage(t('wallet.account_import_exists_other'));
      } else {
        setShowImport(false);
        setImportKey('');
        await load();
      }
    } catch (e) {
      console.error('Failed to import private key', e);
      setErrorMessage(t('wallet.invalid_key'));
    } finally {
      setShowPin(false);
    }
  };

  const showAccount = async (wallet: Wallet) => {
    await WalletsHelper.updateAccount(wallet.id, { hidden: false });
    setShowPicker(false);
    await load();
  };

  return (
    <div>
      <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <Typography variant="h6" align="center" sx={{ fontWeight: 700, mt: 2 }}>
          {t('wallet.switch_title')}
        </Typography>
        <Typography align="center" sx={{ mt: 1, color: 'primary.main', fontWeight: 600 }}>
          {t('wallet.switch_profile_label', { name: profileName })}
        </Typography>
        <Typography variant="body2" align="center" color="text.secondary" sx={{ mx: 3, mt: 1 }}>
          {t('wallet.switch_message')}
        </Typography>

        <Box sx={tileGridSx}>
          {visible.map((wallet) => (
            <InfoCard
              key={wallet.id}
              title={wallet.accountName || defaultLabel(wallet)}
              mono={shortenAddress(wallet.address)}
              value={`${balances[`${network}:${wallet.id}`] ?? '…'} ${currencySymbol()}`}
              caption={wallet.accountName ? defaultLabel(wallet) : t('wallet.card_balance_label')}
              selected={wallet.id === activeId}
              onClick={() => selectAccount(wallet)}
              footer={(
                <>
                  <Button size="small" sx={{ color: 'text.secondary' }} onClick={() => openRename(wallet)}>
                    {t('wallet.account_rename')}
                  </Button>
                  {canHide(wallet) && (
                    <Button size="small" sx={{ color: 'text.secondary' }} onClick={() => hideAccount(wallet)}>
                      {t('wallet.account_hide')}
                    </Button>
                  )}
                </>
              )}
            />
          ))}
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, my: 2 }}>
          {hiddenAccounts.length > 0 && (
            <Button variant="outlined" color="primary" onClick={() => setShowPicker(true)}>
              {t('wallet.account_show')}
            </Button>
          )}
          <Button variant="outlined" color="primary" onClick={openImport}>
            {t('wallet.account_import')}
          </Button>
        </Box>
      </Box>

      {/* インデックス名の変更 */}
      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.account_rename_title')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            autoFocus
            label={t('wallet.account_rename_hint')}
            placeholder={renameTarget ? defaultLabel(renameTarget) : ''}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 2 }}>
            <Button variant="contained" color="primary" onClick={saveRename}>OK</Button>
            <Button variant="contained" color="secondary" onClick={() => setRenameTarget(null)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>

      {/* 秘密鍵でインポート：このプロファイルにアカウントを追加する */}
      <Dialog open={showImport} onClose={() => setShowImport(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.account_import_title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('wallet.account_import_message')}
          </Typography>
          <TextField
            fullWidth
            autoFocus
            label={t('wallet.import_input_label_privatekey')}
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            error={importKey.trim().length > 0 && !importKeyValid}
            helperText={importKey.trim().length > 0 && !importKeyValid ? t('wallet.invalid_key') : ' '}
            slotProps={{ input: { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } }}
            sx={{ mt: 1 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 2 }}>
            <Button variant="contained" color="primary" disabled={!importKeyValid} onClick={askPasswordForImport}>OK</Button>
            <Button variant="contained" color="secondary" onClick={() => setShowImport(false)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>
      <PasswordDialog
        open={showPin}
        mode="check"
        profileKey={activeProfileKey}
        onClose={() => {}}
        onCancel={() => setShowPin(false)}
        onPass={importWithPassword}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />

      {/* 非表示のインデックスから、表示したいものを選ぶ */}
      <Dialog open={showPicker} onClose={() => setShowPicker(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.account_show_title')}</DialogTitle>
        <DialogContent>
          {hiddenAccounts.length === 0 ? (
            <Typography color="text.secondary" sx={{ pb: 2 }}>{t('wallet.account_show_empty')}</Typography>
          ) : (
            <List disablePadding>
              {hiddenAccounts.map((wallet) => (
                <Box key={wallet.id}>
                  <ListItemButton onClick={() => showAccount(wallet)}>
                    <ListItemText primary={defaultLabel(wallet)} secondary={shortenAddress(wallet.address)} />
                  </ListItemButton>
                  <Divider />
                </Box>
              ))}
            </List>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <Button variant="contained" color="secondary" onClick={() => setShowPicker(false)}>{t('common.close')}</Button>
          </Box>
        </DialogContent>
      </Dialog>
    </div>
  );
}
