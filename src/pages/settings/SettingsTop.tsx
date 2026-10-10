import { useState } from 'react';
import { Box, List, ListItemButton, ListItemText, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert, CircularProgress } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MessageDialog from '../../components/MessageDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { useAppStore } from '../../store/appStore';
import type { AppLanguage, ThemeMode } from '../../store/appStore';
import { checkNode } from '../../lib/symbol/api';
import { checkNemNode, diagnoseNemNodes, isHttpsUrl } from '../../lib/nem/api';
import type { NemNodeDiagnosis } from '../../lib/nem/api';
import { CHAINS } from '../../lib/chain';
import { NETWORKS } from '../../lib/symbol/constants';
import type { SymbolNetwork } from '../../lib/symbol/constants';
import InfoCard, { tileGridSx } from '../../components/InfoCard';

export default function SettingsTop() {
  const { t } = useTranslation();
  // Each language's own name, shown in its own script regardless of the app's current
  // display language (the standard "endonym" pattern - e.g. always "日本語", never a
  // translated word like "Japanese"/"日本語" depending on which language happens to be
  // active right now).
  const LANGUAGE_OPTIONS: { code: AppLanguage; label: string }[] = [
    { code: 'ja', label: t('settings.language_name_ja') },
    { code: 'en', label: t('settings.language_name_en') },
  ];
  const navigate = useNavigate();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const THEME_OPTIONS: { code: ThemeMode; label: string }[] = [
    { code: 'dark', label: t('settings.theme_dark') },
    { code: 'light', label: t('settings.theme_light') },
  ];
  const network = useAppStore((s) => s.network);
  const setNetwork = useAppStore((s) => s.setNetwork);
  const chain = useAppStore((s) => s.chain);
  const liveNotifications = useAppStore((s) => s.liveNotifications);
  const setLiveNotifications = useAppStore((s) => s.setLiveNotifications);
  const liveSound = useAppStore((s) => s.liveSound);
  const setLiveSound = useAppStore((s) => s.setLiveSound);
  const chainName = CHAINS[chain].name;
  // Hand-entered node: a Symbol REST node or a NEM (NIS1) node, depending on the selected chain.
  const symbolNodes = useAppStore((s) => s.customNodes);
  const nemNodes = useAppStore((s) => s.nemCustomNodes);
  const customNodes = chain === 'nem' ? nemNodes : symbolNodes;
  const setSymbolNode = useAppStore((s) => s.setCustomNode);
  const setNemNode = useAppStore((s) => s.setNemCustomNode);
  const setCustomNode = chain === 'nem' ? setNemNode : setSymbolNode;
  const [showNetworkDialog, setShowNetworkDialog] = useState(false);
  const [showNodeDialog, setShowNodeDialog] = useState(false);
  const [nodeInput, setNodeInput] = useState('');
  const [nodeError, setNodeError] = useState('');
  const [nodeChecking, setNodeChecking] = useState(false);
  // Result of the NEM connection test: null = not run, 'loading' while running.
  const [diagnosis, setDiagnosis] = useState<NemNodeDiagnosis[] | 'loading' | null>(null);
  const [showLanguageDialog, setShowLanguageDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');


  // 選択中（アクティブ）のウォレットの秘密鍵をバックアップする。注意画面 → 表示の流れ。
  // id は渡さない（WalletBackup は id が空ならアクティブなウォレットを使う）。
  // `back` だけ指定して、「←」「完了」で設定画面に戻る。
  const goToBackup = () => {
    navigate('/wallet/backup_caution?back=/settings/top');
  };

  const onSelectNetwork = (code: SymbolNetwork) => {
    setNetwork(code);
    setShowNetworkDialog(false);
  };

  const openNodeDialog = () => {
    setNodeInput(customNodes[network]);
    setNodeError('');
    setDiagnosis(null);
    setShowNodeDialog(true);
  };

  // Saves a hand-entered REST node after checking it answers and belongs to the selected network.
  // An empty field goes back to automatic node selection.
  const runNodeTest = async () => {
    setDiagnosis('loading');
    try {
      setDiagnosis(await diagnoseNemNodes());
    } catch {
      setDiagnosis([]);
    }
  };

  const saveNode = async () => {
    const url = nodeInput.trim().replace(/\/+$/, '');
    if (url === '') {
      setCustomNode(network, '');
      setShowNodeDialog(false);
      return;
    }
    if (!/^https?:\/\/[^\s/]+/i.test(url)) {
      setNodeError(t('settings.node_invalid_url'));
      return;
    }
    if (chain === 'nem' && !isHttpsUrl(url)) {
      // A page served over HTTPS cannot call plain-HTTP nodes, and NEM nodes should be reached encrypted.
      setNodeError(t('settings.node_https_only'));
      return;
    }
    setNodeChecking(true);
    setNodeError('');
    const ok = chain === 'nem' ? await checkNemNode(url, network) : await checkNode(url, network);
    setNodeChecking(false);
    if (!ok) {
      setNodeError(t('settings.node_check_failed', { chain: chainName, network: NETWORKS[network].label }));
      return;
    }
    setCustomNode(network, url);
    setShowNodeDialog(false);
  };

  // ログアウト：データは何も消さず、プロファイル選択画面へ移動するだけ。
  // （リカバリーフレーズ・秘密鍵・パスワードは端末に残る）
  // 「ログアウトしますか？」の確認ダイアログを出し、OK でプロファイル選択画面へ移動する。
  const onLogout = () => {
    setShowLogoutConfirm(false);
    navigate('/wallet/select');
  };

  const currentLanguageLabel = LANGUAGE_OPTIONS.find((o) => o.code === language)?.label ?? '';

  const onSelectLanguage = (code: AppLanguage) => {
    setLanguage(code);
    setShowLanguageDialog(false);
  };

  const currentThemeLabel = THEME_OPTIONS.find((o) => o.code === themeMode)?.label ?? '';

  const onSelectTheme = (code: ThemeMode) => {
    setThemeMode(code);
    setShowThemeDialog(false);
  };

  const generalItems = [
    { text: t('settings.network_select'), secondary: `${chainName} ${NETWORKS[network].label}`, action: () => setShowNetworkDialog(true) },
    { text: t('settings.node_select'), secondary: customNodes[network] || t('settings.node_auto'), action: openNodeDialog },
    { text: t('settings.language_select'), secondary: currentLanguageLabel, action: () => setShowLanguageDialog(true) },
    { text: t('settings.theme_select'), secondary: currentThemeLabel, action: () => setShowThemeDialog(true) },
    // Live updates come from the Symbol node's WebSocket, so these only exist on Symbol.
    ...(chain === 'symbol' ? [
      { text: t('settings.live_notifications'), secondary: t(liveNotifications ? 'settings.on' : 'settings.off'), action: () => setLiveNotifications(!liveNotifications) },
      { text: t('settings.live_sound'), secondary: t(liveSound ? 'settings.on' : 'settings.off'), action: () => setLiveSound(!liveSound) },
    ] : []),
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ ...tileGridSx, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {generalItems.map((item) => (
            <InfoCard key={item.text} title={item.text} caption={item.secondary || undefined} onClick={item.action} />
          ))}
          <InfoCard title={t('wallet.private_key_backup_title')} onClick={goToBackup} />
          <InfoCard title={t('settings.logout')} onClick={() => setShowLogoutConfirm(true)} />
        </Box>
      </Box>

      <Dialog open={showNetworkDialog} onClose={() => setShowNetworkDialog(false)}>
        <DialogTitle>{t('settings.network_select')}</DialogTitle>
        <List sx={{ minWidth: 240, pt: 0 }}>
          {(Object.keys(NETWORKS) as SymbolNetwork[]).map((code) => (
            <ListItemButton key={code} selected={code === network} onClick={() => onSelectNetwork(code)}>
              <ListItemText primary={`${chainName} ${NETWORKS[code].label}`} secondary={t(code === 'mainnet' ? 'settings.network_mainnet_hint' : 'settings.network_testnet_hint')} />
            </ListItemButton>
          ))}
        </List>
      </Dialog>
      <Dialog open={showNodeDialog} onClose={() => !nodeChecking && setShowNodeDialog(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('settings.node_select')}</DialogTitle>
        <DialogContent>
          <Box sx={{ color: 'text.secondary', fontSize: 'small', mb: 1 }}>{t('settings.node_message', { chain: chainName, network: NETWORKS[network].label })}</Box>
          {chain === 'nem' && <Box sx={{ color: 'text.secondary', fontSize: 'small', mb: 1 }}>{t('settings.nem_node_hint')}</Box>}
          <TextField
            label="URL"
            placeholder="https://example.com:3001"
            fullWidth
            margin="dense"
            value={nodeInput}
            onChange={(e) => setNodeInput(e.target.value)}
            disabled={nodeChecking}
            slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
          />
          {nodeError && <Alert severity="error" sx={{ mt: 1 }}>{nodeError}</Alert>}
          {chain === 'nem' && (
            <Box sx={{ mt: 1.5 }}>
              <Button size="small" variant="outlined" onClick={runNodeTest} disabled={diagnosis === 'loading' || nodeChecking}>
                {diagnosis === 'loading' ? <CircularProgress size={18} /> : t('settings.nem_node_test')}
              </Button>
              {Array.isArray(diagnosis) && (
                <Box sx={{ mt: 1, maxHeight: 220, overflowY: 'auto' }}>
                  {diagnosis.length === 0 && <Box sx={{ fontSize: 'small', color: 'text.secondary' }}>{t('settings.nem_node_test_none')}</Box>}
                  {diagnosis.map((d) => (
                    <Box
                      key={d.url}
                      onClick={() => d.ok && setNodeInput(d.url)}
                      sx={{ display: 'flex', gap: 1, fontSize: 12, py: 0.25, cursor: d.ok ? 'pointer' : 'default', color: d.ok ? 'success.main' : 'text.disabled', wordBreak: 'break-all' }}
                    >
                      <span>{d.ok ? '✓' : '✗'}</span>
                      <span style={{ flexGrow: 1 }}>{d.url.replace('https://', '')}</span>
                      <span>{d.detail}</span>
                    </Box>
                  ))}
                  {diagnosis.some((d) => d.ok) && <Box sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>{t('settings.nem_node_test_pick')}</Box>}
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowNodeDialog(false)} disabled={nodeChecking}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={saveNode} disabled={nodeChecking}>
            {nodeChecking ? <CircularProgress size={20} /> : t('common.done')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={showLanguageDialog} onClose={() => setShowLanguageDialog(false)}>
        <DialogTitle>{t('settings.language_select')}</DialogTitle>
        <List sx={{ minWidth: 240, pt: 0 }}>
          {LANGUAGE_OPTIONS.map((option) => (
            <ListItemButton key={option.code} selected={option.code === language} onClick={() => onSelectLanguage(option.code)}>
              <ListItemText primary={option.label} />
            </ListItemButton>
          ))}
        </List>
      </Dialog>
      <Dialog open={showThemeDialog} onClose={() => setShowThemeDialog(false)}>
        <DialogTitle>{t('settings.theme_select')}</DialogTitle>
        <List sx={{ minWidth: 240, pt: 0 }}>
          {THEME_OPTIONS.map((option) => (
            <ListItemButton key={option.code} selected={option.code === themeMode} onClick={() => onSelectTheme(option.code)}>
              <ListItemText primary={option.label} />
            </ListItemButton>
          ))}
        </List>
      </Dialog>
      <MessageDialog
        open={showLogoutConfirm}
        title={t('settings.logout_confirm_title')}
        texts={t('settings.logout_confirm_message', { returnObjects: true }) as string[]}
        selectable
        onClose={onLogout}
        onCancel={() => setShowLogoutConfirm(false)}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
