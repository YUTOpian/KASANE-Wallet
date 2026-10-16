import { useEffect, useState } from 'react';
import { Box, Typography, List, ListItemButton, ListItemText, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert, CircularProgress } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MessageDialog from '../../components/MessageDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { useAppStore } from '../../store/appStore';
import type { AppLanguage } from '../../store/appStore';
import { LANGUAGES } from '../../i18n/languages';
import { checkNode, diagnoseSymbolNodes, resolveNode } from '../../lib/symbol/api';
import { FEE_SPEEDS, isBelowAverageFee } from '../../lib/symbol/feeSpeed';
import { checkNemNode, diagnoseNemNodes, isHttpsUrl, resolveNemNode } from '../../lib/nem/api';
import { CHAINS } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { NETWORKS } from '../../lib/symbol/constants';
import type { SymbolNetwork } from '../../lib/symbol/constants';
import { nemNetworkOf } from '../../lib/nem/network';
import SymbolNodeDialog from '../../components/SymbolNodeDialog';
import ImportQrDialog from './ImportQrDialog';
import InfoCard, { tileGridSx } from '../../components/InfoCard';
import { useNoKey, useWatchOnly } from '../../hooks/useWatchOnly';
import TestnetReturnDialog from '../../components/TestnetReturnDialog';
import CustomThemeDialog from '../../components/CustomThemeDialog';
import { applyThemeChoice, useThemeChoice, useThemeChoices } from '../../theme/useThemeChoices';

export default function SettingsTop() {
  const { t } = useTranslation();
  // Each language's own name, shown in its own script regardless of the app's current
  // display language (the standard "endonym" pattern - e.g. always "日本語", never a
  // translated word like "Japanese"/"日本語" depending on which language happens to be
  // active right now).
  const LANGUAGE_OPTIONS: { code: AppLanguage; label: string }[] = LANGUAGES.map(({ code, label }) => ({ code, label }));
  const navigate = useNavigate();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const themeChoice = useThemeChoice();
  const [showCustomTheme, setShowCustomTheme] = useState(false);
  // The built-in themes, then every saved カスタムテーマ by name (they are made in the dialog below).
  const THEME_OPTIONS = useThemeChoices();
  const defaultFeeSpeed = useAppStore((s) => s.defaultFeeSpeed);
  const setDefaultFeeSpeed = useAppStore((s) => s.setDefaultFeeSpeed);
  const network = useAppStore((s) => s.network);
  const setNetwork = useAppStore((s) => s.setNetwork);
  const chain = useAppStore((s) => s.chain);
  const liveSound = useAppStore((s) => s.liveSound);
  const setLiveSound = useAppStore((s) => s.setLiveSound);
  const showMultisigHistory = useAppStore((s) => s.showMultisigHistory);
  const setShowMultisigHistory = useAppStore((s) => s.setShowMultisigHistory);
  const allowUnknownSigners = useAppStore((s) => s.allowUnknownSigners);
  const setAllowUnknownSigners = useAppStore((s) => s.setAllowUnknownSigners);
  // QRコードのインポート reads signing QR codes (Symbol only); a view-only or Ledger profile cannot sign them.
  const noKey = useNoKey();
  // テストXYM / テストXEM の返還は、テストネットのときだけ（閲覧用のプロファイルは署名できないので出さない）。
  const watchOnly = useWatchOnly();
  const [showTestnetReturn, setShowTestnetReturn] = useState(false);
  const chainName = CHAINS[chain].name;
  // Hand-entered node: a Symbol REST node or a NEM (NIS1) node, depending on the selected chain.
  const symbolNodes = useAppStore((s) => s.customNodes);
  const nemNodes = useAppStore((s) => s.nemCustomNodes);
  const customNodes: Record<string, string | undefined> = chain === 'nem' ? nemNodes : symbolNodes;
  const setSymbolNode = useAppStore((s) => s.setCustomNode);
  const setNemNode = useAppStore((s) => s.setNemCustomNode);
  // NEM has no mijin v2 (the app is never on NEM while the network is mijin), so its nodes are kept for mainnet / testnet only.
  const setCustomNode = (network: SymbolNetwork, url: string) => (chain === 'nem' ? setNemNode(nemNetworkOf(network), url) : setSymbolNode(network, url));
  const [showNetworkDialog, setShowNetworkDialog] = useState(false);
  const [showNodeDialog, setShowNodeDialog] = useState(false);
  const [nodeInput, setNodeInput] = useState('');
  const [nodeError, setNodeError] = useState('');
  const [nodeChecking, setNodeChecking] = useState(false);
  // Result of the NEM connection test: null = not run, 'loading' while running.
  const [diagnosis, setDiagnosis] = useState<Array<{ url: string; ok: boolean; detail: string }> | 'loading' | null>(null);
  const [showLanguageDialog, setShowLanguageDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showFeeDialog, setShowFeeDialog] = useState(false);
  const [showImportQr, setShowImportQr] = useState(false);
  const [showSymbolNodes, setShowSymbolNodes] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // The node requests actually go to right now ('' while still being picked or when none is reachable).
  const [connectedNode, setConnectedNode] = useState('');
  const [connectedChecking, setConnectedChecking] = useState(false);
  const savedNode = customNodes[network] ?? '';
  useEffect(() => {
    let cancelled = false;
    setConnectedNode('');
    setConnectedChecking(true);
    (async () => {
      try {
        const node = savedNode || (chain === 'nem' ? await resolveNemNode() : await resolveNode());
        if (!cancelled) setConnectedNode(node);
      } catch {
        if (!cancelled) setConnectedNode('');
      } finally {
        if (!cancelled) setConnectedChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chain, network, savedNode]);


  // One list for chain + network together: Symbol mainnet / testnet, NEM mainnet / testnet, mijin v2 (Symbol only).
  const setAppChain = useAppStore((s) => s.setChain);
  const NETWORK_CHOICES: { chain: ChainKey; network: SymbolNetwork }[] = [
    { chain: 'symbol', network: 'mainnet' },
    { chain: 'symbol', network: 'testnet' },
    { chain: 'nem', network: 'mainnet' },
    { chain: 'nem', network: 'testnet' },
    { chain: 'symbol', network: 'mijin' },
  ];
  const choiceLabel = (c: { chain: ChainKey; network: SymbolNetwork }) =>
    c.network === 'mijin' ? t('settings.network_mijin') : `${CHAINS[c.chain].name} ${t(`settings.network_${c.network}`)}`;
  const onSelectNetwork = (choice: { chain: ChainKey; network: SymbolNetwork }) => {
    setShowNetworkDialog(false);
    if (choice.network !== network) setNetwork(choice.network); // moving to mijin also leaves NEM
    // Stay on this screen, like a mainnet <-> testnet switch.
    if (choice.chain !== chain) setAppChain(choice.chain);
  };

  const openNodeDialog = () => {
    setNodeInput(customNodes[network] ?? '');
    setNodeError('');
    setDiagnosis(null);
    setShowNodeDialog(true);
    if (chain === 'symbol') void runNodeTest(); // Symbol's candidate list is short and quick to probe, so it loads by itself.
  };

  // Saves a hand-entered REST node after checking it answers and belongs to the selected network.
  // An empty field goes back to automatic node selection.
  const runNodeTest = async () => {
    setDiagnosis('loading');
    try {
      setDiagnosis(chain === 'nem' ? await diagnoseNemNodes() : await diagnoseSymbolNodes());
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
  // （ニーモニックフレーズ・秘密鍵・パスワードは端末に残る）
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

  const currentThemeLabel = THEME_OPTIONS.find((o) => o.code === themeChoice)?.label ?? '';

  const onSelectTheme = (code: string) => {
    applyThemeChoice(code);
    setShowThemeDialog(false);
  };

  const generalItems = [
    { text: t('settings.network_select'), secondary: choiceLabel({ chain, network }), action: watchOnly ? undefined : () => setShowNetworkDialog(true) }, // 閲覧用プロファイルは、アドレスのネットワークで固定（表示だけで選べない）
    { text: t('settings.node_select'), secondary: savedNode || (connectedNode ? `${t('settings.node_auto')} (${connectedNode.replace(/^https?:\/\//, '')})` : t('settings.node_auto')), action: chain === 'symbol' ? () => setShowSymbolNodes(true) : openNodeDialog },
    { text: t('settings.language_select'), secondary: currentLanguageLabel, action: () => setShowLanguageDialog(true) },
    { text: t('settings.theme_select'), secondary: currentThemeLabel, action: () => setShowThemeDialog(true) },
    { text: t('settings.diag_title'), secondary: t('settings.diag_caption'), action: () => navigate('/settings/diagnostics') },
    // Both chains listen for new transactions (Symbol: WebSocket, NEM: polling). One switch for the sounds: the new-transaction sound and the confirmed sound play together or not at all.
    { text: t('settings.live_sound'), secondary: t(liveSound ? 'settings.on' : 'settings.off'), action: () => setLiveSound(!liveSound) },
    // テストネットのときだけ：使い終わったテストXYM / テストXEM を全額返還する。
    ...(network === 'testnet' && !watchOnly ? [
      { text: t(chain === 'nem' ? 'settings.testnet_return_xem_title' : 'settings.testnet_return_xym_title'), secondary: t('settings.testnet_return_caption'), action: () => setShowTestnetReturn(true) },
    ] : []),
    // The rest is Symbol only.
    ...(chain === 'symbol' && !noKey ? [
      { text: t('home.import_qr_ribbon'), secondary: t('settings.import_qr_caption'), action: () => setShowImportQr(true) },
    ] : []),
    ...(chain === 'symbol' ? [
      { text: t('settings.fee_default'), secondary: t(`send.fee_speed_${defaultFeeSpeed}`), action: () => setShowFeeDialog(true) },
      // Multisig accounts and signature requests exist on Symbol only.
      { text: t('settings.multisig_history'), secondary: t(showMultisigHistory ? 'settings.on' : 'settings.off'), action: () => setShowMultisigHistory(!showMultisigHistory) },
      { text: t('settings.unknown_signers'), secondary: t(allowUnknownSigners ? 'settings.allowed' : 'settings.denied'), action: () => setAllowUnknownSigners(!allowUnknownSigners) },
    ] : []),
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ ...tileGridSx, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {generalItems.map((item) => (
            <InfoCard key={item.text} title={item.text} caption={item.secondary || undefined} onClick={item.action} />
          ))}
          <InfoCard title={t('settings.logout')} onClick={() => setShowLogoutConfirm(true)} />
        </Box>
        {chain === 'symbol' && (
          <Box sx={{ px: 1, pt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.multisig_history_hint')}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.unknown_signers_hint')}</Typography>
          </Box>
        )}
      </Box>

      <Dialog open={showNetworkDialog} onClose={() => setShowNetworkDialog(false)}>
        <DialogTitle>{t('settings.network_select')}</DialogTitle>
        <List sx={{ minWidth: 240, pt: 0 }}>
          {NETWORK_CHOICES.map((c) => (
            <ListItemButton key={`${c.chain}-${c.network}`} selected={c.chain === chain && c.network === network} onClick={() => onSelectNetwork(c)}>
              <ListItemText primary={choiceLabel(c)} />
            </ListItemButton>
          ))}
        </List>
      </Dialog>
      <Dialog open={showNodeDialog} onClose={() => !nodeChecking && setShowNodeDialog(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('settings.node_select')}</DialogTitle>
        <DialogContent>
          <Box sx={{ fontSize: 'small', mb: 1, wordBreak: 'break-all' }}>
            <Box component="span" sx={{ color: 'text.secondary' }}>{t('settings.node_current')}: </Box>
            {connectedNode ? connectedNode : connectedChecking ? t('settings.node_connecting') : t('settings.node_none')}
            {connectedNode && !savedNode && <Box component="span" sx={{ color: 'text.secondary' }}> ({t('settings.node_auto')})</Box>}
          </Box>
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
          {(chain === 'nem' || chain === 'symbol') && (
            <Box sx={{ mt: 1.5 }}>
              <Button size="small" variant="outlined" onClick={runNodeTest} disabled={diagnosis === 'loading' || nodeChecking}>
                {diagnosis === 'loading' ? <CircularProgress size={18} /> : t('settings.node_candidates_load')}
              </Button>
              {Array.isArray(diagnosis) && (
                <Box sx={{ mt: 1, maxHeight: 220, overflowY: 'auto' }}>
                  {diagnosis.length === 0 && <Box sx={{ fontSize: 'small', color: 'text.secondary' }}>{t('settings.node_candidates_none')}</Box>}
                  {diagnosis.map((d) => (
                    <Box
                      key={d.url}
                      onClick={() => d.ok && setNodeInput(d.url)}
                      sx={{ display: 'flex', gap: 1, fontSize: 12, py: 0.25, cursor: d.ok ? 'pointer' : 'default', color: d.ok ? 'success.main' : 'text.disabled', wordBreak: 'break-all' }}
                    >
                      <span>{d.ok ? '✓' : '✗'}</span>
                      <span style={{ flexGrow: 1, fontWeight: d.url === connectedNode ? 700 : 400 }}>{d.url.replace('https://', '')}{d.url === connectedNode ? ` (${t('settings.node_in_use')})` : ''}</span>
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
            <ListItemButton key={option.code} selected={option.code === themeChoice} onClick={() => onSelectTheme(option.code)}>
              <ListItemText primary={option.label} />
            </ListItemButton>
          ))}
          <ListItemButton onClick={() => { setShowThemeDialog(false); setShowCustomTheme(true); }}>
            <ListItemText primary={t('settings.custom_theme_menu')} />
          </ListItemButton>
        </List>
      </Dialog>
      {/* Mounted only while open, so a closed dialog keeps no half-read file. */}
      {showCustomTheme && <CustomThemeDialog open onClose={() => setShowCustomTheme(false)} />}
      {showTestnetReturn && network === 'testnet' && <TestnetReturnDialog open onClose={() => setShowTestnetReturn(false)} />}
      <SymbolNodeDialog open={showSymbolNodes && chain === 'symbol'} onClose={() => setShowSymbolNodes(false)} />
      {/* Mounted only while open, so a closed popup keeps no half-read code or camera. */}
      {showImportQr && <ImportQrDialog open onClose={() => setShowImportQr(false)} />}
      <Dialog open={showFeeDialog} onClose={() => setShowFeeDialog(false)}>
        <DialogTitle>{t('settings.fee_default')}</DialogTitle>
        <List sx={{ minWidth: 240, pt: 0 }}>
          {FEE_SPEEDS.map((speed) => (
            <ListItemButton key={speed} selected={speed === defaultFeeSpeed} onClick={() => { setDefaultFeeSpeed(speed); setShowFeeDialog(false); }}>
              <ListItemText primary={t(`send.fee_speed_${speed}`)} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ px: 3, pb: 2, maxWidth: 360 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{t('settings.fee_default_hint')}</Typography>
          {isBelowAverageFee(defaultFeeSpeed) && <Alert severity="warning" sx={{ mt: 1 }}>{t('harvest.keys_fee_slow_warning')}</Alert>}
        </Box>
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
