import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, Divider, IconButton, List, ListItemButton,
  Chip, ListItemText, Snackbar, TextField, Tooltip, Typography,
} from '@mui/material';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlineOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import CloseIcon from '@mui/icons-material/Close';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { QRCodeCanvas } from 'qrcode.react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import PasswordDialog from '../../components/PasswordDialog';
import WltButton from '../../components/WltButton';
import WatchAddressDialog from '../../components/WatchAddressDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { PrivateKeyHelper } from '../../lib/symbol/hd';
import { accountFromPrivateKey } from '../../lib/accounts';
import { openWlt, parseWlt } from '../../lib/nem/wlt';
import { prettyNemAddress } from '../../lib/nem/crypto';
import type { ParsedWlt } from '../../lib/nem/wlt';
import { getNetworkConfig } from '../../lib/symbol/network';
import { CHAINS, getChain } from '../../lib/chain';
import { chainAddressQr, currencySymbol, fetchChainBalances } from '../../lib/chainApi';
import { fetchAccountStatus } from '../../lib/accountStatus';
import type { AccountStatus } from '../../lib/accountStatus';
import { fetchAccountOverview, fetchAccountRestrictions, fetchMetadataEntries } from '../../lib/symbol/api';
import type { MetadataEntry } from '../../lib/symbol/api';
import { MetadataEditor } from '../metadata/MetadataPage';
import AliasLinkDialog from '../../components/AliasLinkDialog';
import LinkIcon from '@mui/icons-material/Link';
import { useAppStore } from '../../store/appStore';
import RestrictionPage from '../restriction/RestrictionPage';
import AddressBookPanel from '../addressbook/AddressBookPanel';
import ProfileSwitch from '../../components/ProfileSwitch';
import type { AccountTab } from '../../components/ProfileSwitch';
import type { RestrictionList } from '../../lib/symbol/restrictions';
import { copySensitiveText } from '../../lib/sensitiveClipboard';
import { REVEALED_KEY_IDLE_MS, useSecretAutoHide } from '../../hooks/useSecretAutoHide';

// メニューの「アカウント」。いまのプロファイル（=1つのニーモニック）のアカウントを一覧し、選んだアカウントの
// 情報（名前・アドレス・公開鍵・秘密鍵・エイリアス・メタデータ）を右側に表示する。
//  - 一覧：ニーモニックから導出したシードアカウントと、秘密鍵でインポートしたアカウント。
//  - 最初に出ているのは一部のインデックスだけ。ほかのインデックスは「アカウントを追加」から表示する。
//  - 秘密鍵でインポートして、このプロファイルにアカウントを追加できる（パスワードの確認だけ行う）。
//  - Symbol：選んだアカウント自身にメタデータを付与できる（そのアカウントの秘密鍵で署名する）。
//  - Symbol：選んだアカウントのアカウント制限（アドレス・モザイク・オペレーション）を確認・編集できる。
//  - 新規プロファイルの作成はここではしない。

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' };

/** "3.740900" -> bold "3" + light ".7409". */
function Balance({ value, symbol }: { value: string; symbol: string }) {
  const [int, dec] = value.split('.');
  const trimmed = dec ? dec.replace(/0+$/, '') : '';
  return (
    <Typography component="span" sx={{ whiteSpace: 'nowrap', fontSize: '0.95rem' }}>
      <Box component="span" sx={{ fontWeight: 600 }}>{int}</Box>
      {trimmed && <Box component="span" sx={{ opacity: 0.5 }}>.{trimmed}</Box>}
      <Box component="span" sx={{ opacity: 0.5, ml: 0.5, fontSize: '0.75rem' }}>{symbol}</Box>
    </Typography>
  );
}

function Field({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, py: 1.1, minHeight: 36 }}>
      <Typography sx={{ width: { xs: 96, sm: 120 }, flexShrink: 0, fontWeight: 500 }}>{label}</Typography>
      <Box sx={{ flexGrow: 1, minWidth: 0, wordBreak: 'break-all' }}>{children}</Box>
      {action}
    </Box>
  );
}

function AccountsView({ switcher }: { switcher: React.ReactNode }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const network = useAppStore((st) => st.network);
  const chain = getChain();
  const isSymbol = chain === 'symbol';

  const [accounts, setAccounts] = useState<Wallet[]>([]);
  const [activeId, setActiveId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileRefId, setProfileRefId] = useState('');
  // 閲覧用プロファイル（アドレスだけ）：鍵は無いので、秘密鍵・公開鍵・メタデータ追加・バックアップは出さず、アドレスを追加できる。
  const [profileWatch, setProfileWatch] = useState(false);
  const [showWatchAdd, setShowWatchAdd] = useState(false);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const requested = useRef<Set<string>>(new Set());
  const qrRef = useRef<HTMLCanvasElement | null>(null);
  // QR は1つだけ。「アドレス」（送金先として読み取れる）か「公開鍵つき」（公開情報の共有用。秘密鍵は含まない）を切り替える。

  const [errorMessage, setErrorMessage] = useState('');
  const [toast, setToast] = useState('');

  // 名前の変更
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // 追加メニュー / まだ追加していないシードアカウント（インデックス順） / 秘密鍵でインポート
  const [showPicker, setShowPicker] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importKey, setImportKey] = useState('');
  const [importPassword, setImportPassword] = useState(false);
  // NEM: a wallet file (.wlt, the official NEM wallet's) that was picked and is waiting for its password.
  const [wltFile, setWltFile] = useState<ParsedWlt | null>(null);
  const [wltPassword, setWltPassword] = useState('');
  const [wltError, setWltError] = useState('');
  const wltInputRef = useRef<HTMLInputElement | null>(null);

  // 削除
  const [showDelete, setShowDelete] = useState(false);

  // 秘密鍵の表示
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  // インポータンス・エイリアス（Symbol）
  const [overview, setOverview] = useState<{ importancePercent: number | null; aliases: string[] } | 'loading'>('loading');

  // 公開状態・マルチシグ（ネットワークの情報）
  const [status, setStatus] = useState<AccountStatus | 'loading' | 'failed'>('loading');

  // メタデータ（Symbol）
  const [entries, setEntries] = useState<MetadataEntry[] | 'loading' | 'failed'>('loading');
  const [entriesTick, setEntriesTick] = useState(0);
  const [showMetadata, setShowMetadata] = useState(false);

  // ネームスペース連携（Symbol）：選んだアカウントのアドレスにネームスペースをリンク / 解除する。
  const [showAlias, setShowAlias] = useState(false);
  const [aliasTick, setAliasTick] = useState(0);

  // アカウント制限（Symbol）：現在の設定を一覧し、「制限を編集」で編集画面（RestrictionPage）を開く。
  const [restrictions, setRestrictions] = useState<RestrictionList[] | 'loading' | 'failed'>('loading');
  const [restrictionTick, setRestrictionTick] = useState(0);
  const [showRestriction, setShowRestriction] = useState(false);

  const load = async (keepSelection = true) => {
    const profile = await WalletsHelper.getActiveAny();
    if (!profile) {
      navigate('/wallet/select', { replace: true });
      return;
    }
    const active = await WalletsHelper.getActive();
    const list = await WalletsHelper.getProfileWallets(profile.id, chain);
    setActiveId(active?.id ?? '');
    setProfileName(profile.name);
    setProfileRefId(profile.id);
    setProfileWatch(profile.watchOnly);
    setAccounts(list);
    setSelectedId((cur) => (keepSelection && list.some((w) => w.id === cur) ? cur : (active?.id ?? list[0]?.id ?? '')));
  };

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 今アクティブなアカウントと、いま選んでいるアカウントは、非表示でも必ず出す。
  const visible = useMemo(
    () => accounts.filter((w) => !w.hidden || w.id === activeId || w.id === selectedId),
    [accounts, activeId, selectedId],
  );
  const hiddenAccounts = accounts.filter((w) => w.hidden && !visible.includes(w));
  // デフォルトのアカウント：印の付いたもの。無ければ、表示中のいちばん若いインデックス（開くときと同じ決め方）。
  const defaultId = (accounts.find((w) => w.isDefault) ?? accounts.find((w) => !w.hidden) ?? accounts[0])?.id ?? '';
  const seedAccounts = visible.filter((w) => w.accountIndex !== null);
  const watchAccounts = visible.filter((w) => w.watchOnly);
  const importedAccounts = visible.filter((w) => w.accountIndex === null && !w.watchOnly);
  const selected = accounts.find((w) => w.id === selectedId) ?? null;

  const defaultLabel = (w: Wallet) => (
    w.watchOnly ? t('watch.default_account')
      : w.accountIndex === null ? t('wallet.account_imported') : t('wallet.account_index', { index: w.accountIndex })
  );
  const displayName = (w: Wallet) => w.accountName || defaultLabel(w);

  // 表示しているアカウントの残高（ネットワークごとに1回だけ）。
  useEffect(() => {
    visible.forEach(async (w) => {
      const cacheKey = `${network}:${w.id}`;
      if (requested.current.has(cacheKey)) return;
      requested.current.add(cacheKey);
      let balance = '-';
      try {
        balance = (await fetchChainBalances(w.address))[0]?.balance ?? '0';
      } catch (e) {
        console.error(`Failed to fetch balance for wallet ${w.id}`, e);
      }
      setBalances((prev) => ({ ...prev, [cacheKey]: balance }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, activeId, network]);

  // アカウントを切り替えたら、秘密鍵の表示は閉じる。
  useEffect(() => { setRevealed(null); }, [selectedId, network]);

  // 表示した秘密鍵は画面を離れたら必ず消す：このコンポーネントが外れるとき（戻る操作・他画面への遷移）、
  // またアプリがバックグラウンドに回ったとき（他アプリへの切り替え・画面ロック・タブを隠す）も即座に消す。
  // 「アカウントを切り替えたとき」だけでは、見せたまま他画面に移動したりアプリを離れたりしても
  // 秘密鍵が画面とメモリに残り続けてしまうため。
  useEffect(() => {
    const clear = () => { if (document.visibilityState === 'hidden') setRevealed(null); };
    document.addEventListener('visibilitychange', clear);
    return () => {
      document.removeEventListener('visibilitychange', clear);
      setRevealed(null);
    };
  }, []);
  // 表示したまま放置されたときも消す（画面を見せっぱなしで席を離れた場合など）。
  useSecretAutoHide(revealed !== null, () => setRevealed(null), REVEALED_KEY_IDLE_MS);

  // 選んだアカウントのインポータンスとエイリアス。
  const selectedAddress = selected?.address ?? '';
  useEffect(() => {
    if (!isSymbol || selectedAddress === '') return undefined;
    let cancelled = false;
    setOverview('loading');
    fetchAccountOverview(selectedAddress)
      .then((o) => { if (!cancelled) setOverview(o); })
      .catch(() => { if (!cancelled) setOverview({ importancePercent: null, aliases: [] }); });
    return () => { cancelled = true; };
  }, [isSymbol, selectedAddress, network, aliasTick]);

  // 選んだアカウントの公開状態（公開鍵がネットワークに登録済みか）とマルチシグの状態。
  useEffect(() => {
    if (selectedAddress === '') return undefined;
    let cancelled = false;
    setStatus('loading');
    fetchAccountStatus(selectedAddress)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus('failed'); });
    return () => { cancelled = true; };
  }, [selectedAddress, network, chain]);

  // 選んだアカウントのメタデータ。
  useEffect(() => {
    if (!isSymbol || selectedAddress === '') return undefined;
    let cancelled = false;
    setEntries('loading');
    fetchMetadataEntries({ type: 'account', address: selectedAddress })
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch(() => { if (!cancelled) setEntries('failed'); });
    return () => { cancelled = true; };
  }, [isSymbol, selectedAddress, network, entriesTick]);

  // 選んだアカウントのアカウント制限。
  useEffect(() => {
    if (!isSymbol || selectedAddress === '') return undefined;
    let cancelled = false;
    setRestrictions('loading');
    fetchAccountRestrictions(selectedAddress)
      .then((l) => { if (!cancelled) setRestrictions(l.filter((x) => x.values.length > 0)); })
      .catch(() => { if (!cancelled) setRestrictions('failed'); });
    return () => { cancelled = true; };
  }, [isSymbol, selectedAddress, network, restrictionTick]);

  // --- 操作 ---------------------------------------------------------------------------
  // 一覧からアカウントを選んだら、そのアカウントを使っている状態にする（画面は移動しない）。
  const selectAccount = async (w: Wallet) => {
    setSelectedId(w.id);
    if (w.id === activeId) return;
    try {
      await WalletsHelper.setActive(w.id);
      setActiveId(w.id);
    } catch (e) {
      console.error('Failed to switch the active account', e);
    }
  };

  const saveRename = async () => {
    if (!selected) return;
    await WalletsHelper.updateAccount(selected.id, { accountName: renameValue.trim() });
    setRenaming(false);
    await load();
  };

  const hideSelected = async () => {
    if (!selected) return;
    await WalletsHelper.updateAccount(selected.id, { hidden: true });
    await load(false);
  };

  const setDefaultSelected = async () => {
    if (!selected) return;
    await WalletsHelper.updateAccount(selected.id, { isDefault: true });
    await load();
    setToast(t('account.default_set'));
  };

  const deleteSelected = async () => {
    if (!selected) return;
    setShowDelete(false);
    if (await WalletsHelper.removeImportedAccount(selected.id)) {
      await load(false);
    } else {
      // 何も起きないまま終わらせない。画面の情報が古かったときのために、一覧も読み直す。
      setErrorMessage(t('account.delete_failed'));
      await load();
    }
  };

  const showIndex = async (w: Wallet) => {
    await WalletsHelper.updateAccount(w.id, { hidden: false });
    setShowPicker(false);
    setSelectedId(w.id);
    await load();
  };

  // .wlt: read the picked file, then ask for the password it was sealed with.
  const onWltPicked = async (file: File | undefined) => {
    if (wltInputRef.current) wltInputRef.current.value = '';
    if (!file) return;
    try {
      setWltFile(parseWlt(await file.text()));
      setWltPassword('');
      setWltError('');
    } catch (e) {
      setErrorMessage(t(e instanceof Error && e.message === 'unsupported_wlt' ? 'wallet.wlt_unsupported' : 'wallet.wlt_invalid'));
    }
  };
  const closeWlt = () => {
    setWltFile(null);
    setWltPassword('');
    setWltError('');
  };
  const openWltWithPassword = () => {
    if (!wltFile) return;
    if (wltFile.networkByte !== getNetworkConfig().networkByte) {
      setWltError(t('wallet.wlt_network_mismatch'));
      return;
    }
    try {
      const account = openWlt(wltFile, wltPassword);
      // From here it is the same as typing the private key: the profile's password is asked, then the account is added.
      setImportKey(account.privateKey);
      closeWlt();
      setImportPassword(true);
    } catch {
      setWltError(t('wallet.wlt_wrong_password'));
    }
  };

  const importKeyValid = PrivateKeyHelper.isValid(importKey);
  const importWithPassword = async (password: string) => {
    try {
      const account = accountFromPrivateKey(importKey);
      const result = await WalletsHelper.addImportedKeyToProfile(profileRefId, account.publicKey, account.privateKey, password, chain);
      if (result === 'other-profile') {
        setErrorMessage(t('wallet.account_import_exists_other'));
      } else {
        setShowImport(false);
        setImportKey('');
        await load();
        const added = (await WalletsHelper.getProfileWallets(profileRefId, chain)).find((w) => w.publicKey === account.publicKey);
        if (added) setSelectedId(added.id);
      }
    } catch (e) {
      console.error('Failed to import private key', e);
      setErrorMessage(t('wallet.invalid_key'));
    } finally {
      setImportPassword(false);
    }
  };

  const revealWithPassword = async (password: string) => {
    setRevealPassword(false);
    if (!selected) return;
    const secret = await WalletsHelper.decryptKey(selected.id, password);
    if (secret == null) {
      setErrorMessage(t('wallet.invalid_key'));
      return;
    }
    setRevealed(secret);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(t('account.copied'));
    } catch {
      setToast('');
    }
  };

  // 秘密鍵など、クリップボードに長く残しておきたくない値を貼り付け用にコピーする。アドレスなど非機密の
  // コピーには使わない（無言でクリップボードが消えるのは、それらにとっては単なる驚きでしかないため）。
  // 一定時間後、まだその値がクリップボードにあるときだけ消す（lib/sensitiveClipboard.ts）。
  const copySensitive = async (text: string) => {
    const ok = await copySensitiveText(text);
    setToast(ok ? t('account.copied') : '');
  };

  const downloadCanvas = (canvas: HTMLCanvasElement | null, fileName: string) => {
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = fileName;
    a.click();
  };
  const downloadQr = () => { if (selected) downloadCanvas(qrRef.current, `${selected.address}.png`); };

  // 公開鍵：自分で持っている鍵、無ければ（閲覧用）ネットワークに登録されている鍵。
  const shownPublicKey = selected === null ? '' : (selected.publicKey || (typeof status === 'object' ? status.networkPublicKey ?? '' : ''));
  const published = typeof status === 'object' ? status.networkPublicKey !== null : null;
  const multisigText = (s: AccountStatus) => {
    const count = s.cosignatoryCount;
    if (s.isMultisig && s.cosignerOfCount > 0) return t('account.multisig_both');
    if (s.isMultisig) {
      return s.minApproval > 0 && s.minApproval < count
        ? t('account.multisig_account', { min: s.minApproval, count })
        : t('account.multisig_account_all', { count });
    }
    if (s.cosignerOfCount > 0) return t('account.multisig_cosigner', { count: s.cosignerOfCount });
    return t('account.multisig_none');
  };

  // --- 描画 ---------------------------------------------------------------------------
  const cardSx = {
    bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, boxSizing: 'border-box',
  } as const;

  const accountRow = (w: Wallet) => {
    const isSelected = w.id === selectedId;
    return (
      <ListItemButton
        key={w.id}
        selected={isSelected}
        onClick={() => selectAccount(w)}
        sx={{ borderRadius: 2, py: 1.2, gap: 1.5, alignItems: 'center' }}
      >
        <ListItemText
          primary={displayName(w)}
          secondary={[w.id === activeId ? t('account.in_use') : '', w.id === defaultId ? t('account.default_label') : ''].filter(Boolean).join(' ・ ') || undefined}
          slotProps={{ primary: { noWrap: true, sx: { fontWeight: isSelected ? 700 : 400 } }, secondary: { sx: { color: 'primary.main', fontSize: '0.72rem' } } }}
        />
        <Balance value={balances[`${network}:${w.id}`] ?? '…'} symbol={currencySymbol()} />
      </ListItemButton>
    );
  };

  const sectionTitle = (text: string) => (
    <Typography sx={{ fontWeight: 700, mt: 2.5, mb: 0.5, px: 1 }}>{text}</Typography>
  );

  const canDelete = selected !== null && selected.accountIndex === null && selected.id !== defaultId;
  const canHide = selected !== null && selected.accountIndex !== null && selected.accountIndex !== 0 && selected.id !== defaultId;

  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, p: { xs: 1.5, md: 3 }, alignItems: 'stretch', width: '100%', boxSizing: 'border-box', textAlign: 'left' }}>
      {/* ---- 左：アカウント一覧 ---- */}
      <Box sx={{ ...cardSx, width: { xs: '100%', md: 340 }, flexShrink: 0, display: 'flex', flexDirection: 'column', p: 2, minHeight: { md: 520 } }}>
        {switcher}
        <Typography variant="body2" sx={{ color: 'text.secondary', px: 1, mt: 0.5 }}>
          {t('account.profile_label', { name: profileName })}
        </Typography>

        <Box sx={{ flexGrow: 1 }}>
          {seedAccounts.length > 0 && (
            <>
              {sectionTitle(t('account.seed_accounts'))}
              <List disablePadding>{seedAccounts.map(accountRow)}</List>
            </>
          )}
          {importedAccounts.length > 0 && (
            <>
              {sectionTitle(t('account.imported_accounts'))}
              <List disablePadding>{importedAccounts.map(accountRow)}</List>
            </>
          )}
          {watchAccounts.length > 0 && (
            <>
              {sectionTitle(t('watch.accounts'))}
              <List disablePadding>{watchAccounts.map(accountRow)}</List>
            </>
          )}
        </Box>

        <Divider sx={{ my: 2 }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          {profileWatch ? (
            <Button startIcon={<AddCircleOutlineIcon />} onClick={() => setShowWatchAdd(true)}>
              {t('watch.add')}
            </Button>
          ) : (
            <>
              <Button startIcon={<AddCircleOutlineIcon />} onClick={() => setShowPicker(true)}>
                {t('account.add_show_index')}
              </Button>
              <Button startIcon={<AddCircleOutlineIcon />} onClick={() => { setImportKey(''); setShowImport(true); }}>
                {t('account.add_import_key')}
              </Button>
            </>
          )}
        </Box>
      </Box>

      {/* ---- 右：アカウント情報 ---- */}
      <Box sx={{ ...cardSx, flexGrow: 1, minWidth: 0, p: { xs: 2, md: 4 } }}>
        <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', mb: 3 }}>{t('account.info_title')}</Typography>

        {selected === null && profileWatch && accounts.length === 0 ? (
          <Typography sx={{ color: 'text.secondary', lineHeight: 1.7 }}>{t('watch.empty_message', { chain: CHAINS[chain].name })}</Typography>
        ) : selected === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : (
          <>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', lg: 'row' }, gap: { xs: 2, lg: 4 }, alignItems: { xs: 'center', lg: 'flex-start' } }}>
              {/* QR（アドレスのみ。公式ウォレットでも読み込める形式: Symbol は type 0、NEM は type 1） */}
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0, maxWidth: 220 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', textAlign: 'center' }}>{t('account.qr_label')}</Typography>
                <Box sx={{ p: 1, bgcolor: '#fff', borderRadius: 2, lineHeight: 0 }}>
                  <QRCodeCanvas
                    ref={qrRef}
                    value={chainAddressQr(selected.address, displayName(selected), selected.publicKey)}
                    size={180}
                    marginSize={1}
                  />
                </Box>
                <Button size="small" startIcon={<DownloadIcon />} onClick={downloadQr}>{t('account.download')}</Button>
              </Box>

              {/* fields */}
              <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
                <Field
                  label={t('account.name')}
                  action={(
                    <Tooltip title={t('account.edit_name')}>
                      <IconButton size="small" onClick={() => { setRenameValue(selected.accountName); setRenaming(true); }} aria-label={t('account.edit_name')}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                >
                  {displayName(selected)}
                </Field>

                {isSymbol && (
                  <Field label={t('account.importance')}>
                    {overview === 'loading' ? <CircularProgress size={14} /> : overview.importancePercent === null ? '-' : `${overview.importancePercent.toFixed(overview.importancePercent < 0.01 ? 4 : 2).replace(/\.?0+$/, '') || '0'}%`}
                  </Field>
                )}

                <Field
                  label={t('account.address')}
                  action={<IconButton size="small" onClick={() => copy(selected.address)} aria-label={t('account.copy')}><ContentCopyIcon fontSize="small" /></IconButton>}
                >
                  <Box component="span" sx={mono}>{selected.address}</Box>
                </Field>

                <Field
                  label={t('account.public_key')}
                  action={shownPublicKey ? <IconButton size="small" onClick={() => copy(shownPublicKey)} aria-label={t('account.copy')}><ContentCopyIcon fontSize="small" /></IconButton> : undefined}
                >
                  {shownPublicKey
                    ? <Box component="span" sx={mono}>{shownPublicKey}</Box>
                    : status === 'loading' ? <CircularProgress size={14} /> : '-'}
                </Field>

                <Field label={t('account.public_state')}>
                  {status === 'loading' ? <CircularProgress size={14} /> : status === 'failed' ? (
                    <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>{t('account.status_failed')}</Typography>
                  ) : (
                    <>
                      <Box component="span" sx={{ fontWeight: 600, color: published ? 'success.main' : 'text.secondary' }}>
                        {published ? t('account.published') : t('account.unpublished')}
                      </Box>
                      {!published && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('account.unpublished_hint')}</Typography>}
                    </>
                  )}
                </Field>

                <Field label={t('account.multisig')}>
                  {status === 'loading' ? <CircularProgress size={14} /> : status === 'failed' ? '-' : (
                    <Box component="span" sx={{ fontWeight: status.isMultisig || status.cosignerOfCount > 0 ? 600 : 400, color: status.isMultisig || status.cosignerOfCount > 0 ? 'primary.main' : 'text.secondary' }}>
                      {multisigText(status)}
                    </Box>
                  )}
                </Field>

                {!(selected.watchOnly || selected.ledger) && (
                <Field
                  label={t('account.private_key')}
                  action={revealed !== null ? (
                    <IconButton size="small" onClick={() => copySensitive(revealed)} aria-label={t('account.copy')}><ContentCopyIcon fontSize="small" /></IconButton>
                  ) : undefined}
                >
                  {revealed === null ? (
                    <Button size="small" sx={{ p: 0, minWidth: 0 }} startIcon={<LockOutlinedIcon fontSize="small" />} onClick={() => setRevealPassword(true)}>
                      {t('account.show')}
                    </Button>
                  ) : (
                    <>
                      <Box component="span" sx={mono}>{revealed}</Box>
                      <Box><Button size="small" sx={{ p: 0, minWidth: 0 }} onClick={() => setRevealed(null)}>{t('account.hide')}</Button></Box>
                    </>
                  )}
                </Field>
                )}

                {/* NEM: the wallet file (.wlt) of the official NEM wallet, offered once the private key is shown (the password was just checked). */}
                {!isSymbol && revealed !== null && !(selected.watchOnly || selected.ledger) && (
                  <WltButton source={{ name: selected.name, privateKey: revealed, publicKey: selected.publicKey }} />
                )}

                {isSymbol && (
                  <Field
                    label={t('account.aliases')}
                    action={!(selected.watchOnly || selected.ledger) ? (
                      <Tooltip title={t('account.alias_link')}>
                        <IconButton size="small" color="primary" onClick={() => setShowAlias(true)} aria-label={t('account.alias_link')}><LinkIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    ) : undefined}
                  >
                    {overview === 'loading' ? <CircularProgress size={14} /> : overview.aliases.length === 0 ? '-' : overview.aliases.map((a) => <div key={a}>{a}</div>)}
                  </Field>
                )}

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
                  {selected.id !== defaultId && <Button variant="outlined" color="inherit" onClick={setDefaultSelected}>{t('account.set_default')}</Button>}
                  {canHide && <Button variant="outlined" color="inherit" onClick={hideSelected}>{t('account.hide_account')}</Button>}
                  {canDelete && <Button variant="outlined" color="inherit" onClick={() => setShowDelete(true)}>{t('account.delete')}</Button>}
                </Box>
              </Box>
            </Box>

            {/* メタデータ（Symbol） */}
            {isSymbol && (
              <Box sx={{ mt: 4 }}>
                <Divider sx={{ mb: 2 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                  <Typography sx={{ fontWeight: 700 }}>{t('account.metadata')}</Typography>
                  {!(selected.watchOnly || selected.ledger) && (
                    <Button size="small" variant="outlined" startIcon={<AddCircleOutlineIcon />} onClick={() => setShowMetadata(true)}>
                      {t('account.metadata_add')}
                    </Button>
                  )}
                </Box>
                {entries === 'loading' ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}><CircularProgress size={22} /></Box>
                ) : entries === 'failed' ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('account.load_failed')}</Typography>
                ) : entries.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('account.metadata_empty')}</Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {entries.map((e) => (
                      <Box
                        key={e.key}
                        onClick={(selected.watchOnly || selected.ledger) ? undefined : () => setShowMetadata(true)}
                        sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 2, py: 1, cursor: e.valueText === null || (selected.watchOnly || selected.ledger) ? 'default' : 'pointer' }}
                      >
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ...mono }}>{e.key}</Typography>
                        <Typography sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{e.valueText ?? `0x${e.valueHex}`}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            )}

            {/* アカウント制限（Symbol） */}
            {isSymbol && (
              <Box sx={{ mt: 4 }}>
                <Divider sx={{ mb: 2 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                  <Typography sx={{ fontWeight: 700 }}>{t('account.restriction')}</Typography>
                  <Button size="small" variant="outlined" startIcon={(selected.watchOnly || selected.ledger) ? undefined : <EditOutlinedIcon />} onClick={() => setShowRestriction(true)}>
                    {t((selected.watchOnly || selected.ledger) ? 'account.restriction_view' : 'account.restriction_edit')}
                  </Button>
                </Box>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('account.restriction_hint')}</Typography>
                {restrictions === 'loading' ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}><CircularProgress size={22} /></Box>
                ) : restrictions === 'failed' ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('account.load_failed')}</Typography>
                ) : restrictions.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('account.restriction_none')}</Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {restrictions.map((l) => (
                      <Box key={`${l.rule.kind}-${l.rule.direction}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography sx={{ flexGrow: 1 }}>
                          {l.rule.kind === 'address' ? `${t('restriction.kind_address')} (${t(`restriction.dir_${l.rule.direction}`)})` : t(`restriction.kind_${l.rule.kind}`)}
                        </Typography>
                        <Chip size="small" color={l.mode === 'allow' ? 'success' : 'error'} label={t(`restriction.mode_${l.mode}`)} />
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('account.restriction_count', { count: l.values.length })}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </>
        )}
      </Box>

      {/* ネームスペース連携（選んだアカウントのアドレスが対象。そのアカウントの鍵で署名する） */}
      <AliasLinkDialog
        open={showAlias && selected !== null && isSymbol}
        onClose={() => setShowAlias(false)}
        account={selected}
        target={selected ? { type: 'address', address: selected.address } : null}
        onChanged={() => setAliasTick((n) => n + 1)}
      />

      {/* アカウント制限の編集（選んだアカウントを対象に、そのアカウントの鍵で署名する） */}
      <Dialog
        open={showRestriction && selected !== null && isSymbol}
        onClose={() => { setShowRestriction(false); setRestrictionTick((n) => n + 1); }}
        maxWidth="md"
        fullWidth
        scroll="paper"
      >
        <DialogContent sx={{ p: 0 }}>
          {selected && (
            <RestrictionPage
              key={selected.id}
              embedded
              wallet={selected}
              onClose={() => { setShowRestriction(false); setRestrictionTick((n) => n + 1); }}
            />
          )}
        </DialogContent>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <Button color="inherit" onClick={() => { setShowRestriction(false); setRestrictionTick((n) => n + 1); }}>{t('common.close')}</Button>
        </Box>
      </Dialog>

      {/* 閲覧用アドレスを追加 */}
      <WatchAddressDialog
        open={showWatchAdd}
        profileWalletId={profileRefId}
        onClose={() => setShowWatchAdd(false)}
        onAdded={async () => { setShowWatchAdd(false); await load(); }}
      />

      {/* 名前の変更 */}
      <Dialog open={renaming} onClose={() => setRenaming(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('account.rename_title')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            autoFocus
            label={t('account.rename_hint')}
            placeholder={selected ? defaultLabel(selected) : ''}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); }}
            sx={{ mt: 1, mb: 2 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 2 }}>
            <Button variant="contained" color="primary" onClick={saveRename}>OK</Button>
            <Button variant="contained" color="secondary" onClick={() => setRenaming(false)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>

      {/* 非表示のインデックスから選ぶ */}
      <Dialog open={showPicker} onClose={() => setShowPicker(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.account_show_title')}</DialogTitle>
        <DialogContent>
          {hiddenAccounts.length === 0 ? (
            <Typography color="text.secondary" sx={{ pb: 2 }}>{t('wallet.account_show_empty')}</Typography>
          ) : (
            <List disablePadding>
              {[...hiddenAccounts].sort((a, b) => (a.accountIndex ?? 0) - (b.accountIndex ?? 0)).map((w) => (
                <Box key={w.id}>
                  <ListItemButton onClick={() => showIndex(w)}>
                    <ListItemText primary={defaultLabel(w)} secondary={w.address} slotProps={{ secondary: { sx: { wordBreak: 'break-all' } } }} />
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

      {/* 秘密鍵でインポート */}
      <Dialog open={showImport} onClose={() => setShowImport(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('wallet.account_import_title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('wallet.account_import_message')}</Typography>
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
          {/* NEM: the wallet file (.wlt) of the official NEM wallet. No `accept`: iOS greys out unknown extensions. */}
          {!isSymbol && (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 2 }}>
              <input ref={wltInputRef} type="file" hidden onChange={(e) => { void onWltPicked(e.target.files?.[0]); }} />
              <Button variant="outlined" startIcon={<UploadFileOutlinedIcon />} onClick={() => wltInputRef.current?.click()}>{t('wallet.wlt_import')}</Button>
              <Typography variant="caption" color="text.secondary" align="center" sx={{ mt: 0.5 }}>{t('wallet.wlt_import_hint')}</Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 2 }}>
            <Button variant="contained" color="primary" disabled={!importKeyValid} onClick={() => setImportPassword(true)}>OK</Button>
            <Button variant="contained" color="secondary" onClick={() => setShowImport(false)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>
      <Dialog open={wltFile !== null} onClose={closeWlt} maxWidth="xs" fullWidth>
        <DialogTitle>{t('wallet.wlt_open_title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('wallet.wlt_open_message', { name: wltFile?.name ?? '' })}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1, wordBreak: 'break-all', ...mono }}>{wltFile ? prettyNemAddress(wltFile.address) : ''}</Typography>
          <TextField
            fullWidth
            autoFocus
            type="password"
            autoComplete="off"
            label={t('wallet.wlt_password_label_open')}
            value={wltPassword}
            onChange={(e) => { setWltPassword(e.target.value); setWltError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && wltPassword !== '') openWltWithPassword(); }}
            error={wltError !== ''}
            helperText={wltError !== '' ? wltError : ' '}
            sx={{ mt: 1 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, pb: 2 }}>
            <Button variant="contained" color="primary" disabled={wltPassword === ''} onClick={openWltWithPassword}>OK</Button>
            <Button variant="contained" color="secondary" onClick={closeWlt}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>
      <PasswordDialog
        open={importPassword}
        mode="check"
        popup
        profileKey={selected?.profileKey}
        onClose={() => setImportPassword(false)}
        onPass={importWithPassword}
      />

      {/* 削除の確認 */}
      <Dialog open={showDelete} onClose={() => setShowDelete(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('account.delete_title')}</DialogTitle>
        <DialogContent>
          {(t(selected?.watchOnly ? 'watch.delete_account_message' : 'account.delete_message', { returnObjects: true }) as string[]).map((line, i) => (
            <Typography key={i} variant="body2" sx={{ mb: 0.5 }}>{line}</Typography>
          ))}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, py: 2 }}>
            <Button variant="contained" color="primary" onClick={deleteSelected}>{t('account.delete_ok')}</Button>
            <Button variant="contained" color="secondary" onClick={() => setShowDelete(false)}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>

      {/* 秘密鍵を表示するためのパスワード */}
      <PasswordDialog
        open={revealPassword}
        mode="check"
        popup
        profileKey={selected?.profileKey}
        onClose={() => setRevealPassword(false)}
        onPass={revealWithPassword}
      />

      {/* メタデータの付与: the same editor as the mosaic / namespace screens (own account or another account's, and the entries others set). */}
      <Dialog open={showMetadata && selected !== null} onClose={() => setShowMetadata(false)} maxWidth="sm" fullWidth scroll="paper">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('account.metadata_title')}
          <IconButton aria-label={t('common.close')} onClick={() => setShowMetadata(false)}><CloseIcon /></IconButton>
        </DialogTitle>
        <Box sx={{ overflowY: 'auto' }}>
          {selected !== null && (
            <MetadataEditor
              key={selected.id}
              embedded
              lockedType="account"
              account={selected}
              onSent={() => setEntriesTick((n) => n + 1)}
              onClose={() => setShowMetadata(false)}
            />
          )}
        </Box>
      </Dialog>

      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <Snackbar open={toast !== ''} autoHideDuration={1800} onClose={() => setToast('')} message={toast} />
    </Box>
  );
}

// 「アカウント」画面：左のカードの見出しの「マイアカウント | マイ連絡先」で、アカウント（これまでのアカウント画面そのまま）と
// アドレス帳（以前は独立したメニュー）を切り替える。切り替えは URL の ?tab=addressbook で決まる。
// `&pick=1` は送金先を選ぶ画面（切り替えは出さず、押した連絡先が送金先になる）。
export default function AccountPage() {
  const [params, setParams] = useSearchParams();
  const tab: AccountTab = params.get('tab') === 'addressbook' ? 'addressbook' : 'accounts';
  const picking = tab === 'addressbook' && params.get('pick') === '1';
  const switcher = <ProfileSwitch value={tab} onChange={(v) => setParams(v === 'addressbook' ? { tab: 'addressbook' } : {}, { replace: true })} />;

  if (picking) {
    return (
      <>
        <BackButton back="/top" />
        <AddressBookPanel picking />
      </>
    );
  }
  return tab === 'addressbook' ? <AddressBookPanel switcher={switcher} /> : <AccountsView switcher={switcher} />;
}
