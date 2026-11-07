import type { ReactNode } from 'react';
import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { Alert, Box, Button, ButtonBase, Card, Chip, IconButton, Tooltip, Typography, CircularProgress, Divider, Snackbar } from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import PublicIcon from '@mui/icons-material/Public';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import TokenOutlinedIcon from '@mui/icons-material/TokenOutlined';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import CardRibbon from '../../components/CardRibbon';
import { Environment } from '../../lib/environment';
import MosaicsPanel from './MosaicsPanel';
import InvoicePanel from './InvoicePanel';
import SendForm from './SendForm';
import SymbolHistoryPanel from './SymbolHistoryPanel';
import NemHistoryPanel from './NemHistoryPanel';
// The import sections are only needed when opened; the QR reader pulls in the camera scanner and the signing screens.
const NetworkStatsPanel = lazy(() => import('./NetworkStatsPanel'));
const NemNetworkStatsPanel = lazy(() => import('./NemNetworkStatsPanel'));
const ApostilleRibbon = lazy(() => import('../apostille/ApostilleRibbon'));
const ImportQrDialog = lazy(() => import('../settings/ImportQrDialog'));
import { useSymbolBalance } from '../../hooks/useSymbolBalance';
import { useAppStore } from '../../store/appStore';
import type { HomePanel } from '../../store/appStore';
import { WalletsHelper } from '../../lib/storage';
import { activeNetworkLabel, prettyChainAddress } from '../../lib/chainApi';
import { chainMeta } from '../../lib/chain';
import NemSetup from './NemSetup';
import WatchAddressEmpty from './WatchAddressEmpty';
import { useNoKey, useWatchOnly } from '../../hooks/useWatchOnly';
import { getBalanceCardMosaic, getBalanceHidden, getHomeCache, setBalanceCardMosaic, setBalanceHidden, setHomeCache } from '../../lib/homeCache';

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // mijin v2 has no built-in nodes: until a node is connected (設定 > ノード) nothing can be read or sent.
  const mijinSetupNeeded = useAppStore((s) => s.network === 'mijin' && s.mijinParams === null);
  // Which section (保有モザイク / インボイス / 送る / 履歴) is expanded - one at a time.
  const panel = useAppStore((s) => s.homePanel);
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);
  const setSendMosaicId = useAppStore((s) => s.setSendMosaicId);
  const { xymBalance, mosaicCount, balances, fetchXymBalance, hydrateBalances } = useSymbolBalance();
  // Reading the chain / network from the store re-renders Home when either is switched.
  const network = useAppStore((st) => st.network);
  const chain = useAppStore((st) => st.chain);
  const nativeSymbol = chainMeta(chain).currencySymbol;
  // The balance card shows the currency (XYM / XEM) unless another mosaic the wallet holds was picked from its menu.
  const [cardMosaic, setCardMosaic] = useState(() => getBalanceCardMosaic(chain, network));
  useEffect(() => { setCardMosaic(getBalanceCardMosaic(chain, network)); }, [chain, network]);
  const cardOptions = balances.filter((b, i) => i === 0 || b.amount > 0n);
  const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const cardPicked = cardMosaic === '' ? undefined : cardOptions.find((b, i) => i > 0 && sameId(b.id, cardMosaic));
  const cardSymbol = cardPicked ? cardPicked.symbol : nativeSymbol;
  const cardAmount = cardPicked ? cardPicked.balance : xymBalance;
  const cardDivisibility = cardPicked ? cardPicked.divisibility : 6;
  const cardOthers = balances.length > 0
    ? balances.filter((b, i) => b.amount > 0n && (cardPicked ? !sameId(b.id, cardPicked.id) : i > 0)).length
    : mosaicCount;
  // 残高を隠す: the amount on the balance card (and in its menu) is replaced by dots until it is shown again.
  const [balanceHidden, setBalanceHiddenState] = useState(getBalanceHidden);
  const toggleBalanceHidden = () => { const next = !balanceHidden; setBalanceHiddenState(next); setBalanceHidden(next); };
  const MASK = '••••••';
  // Showing a mosaic on the balance card (from 保有モザイク) also brings a hidden balance back.
  const pickCardMosaic = (id: string) => {
    setCardMosaic(id); setBalanceCardMosaic(chain, network, id);
    if (balanceHidden) { setBalanceHiddenState(false); setBalanceHidden(false); }
  };
  // 閲覧用プロファイル（アドレスだけ）：署名が要る「送る」やハーベスト設定は出さない。
  const watchOnly = useWatchOnly();
  // QRコードのインポート reads signing QR codes (Symbol only); a view-only or Ledger profile cannot sign them.
  const noKey = useNoKey();
  const [showImportQr, setShowImportQr] = useState(false);
  // 秘密鍵が無いプロファイル（閲覧用・Ledger）：署名QR・トランザクションURIの取り込みは、秘密鍵で署名する機能なので出さない。

  const [loadingBalance, setLoadingBalance] = useState(false);
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [address, setAddress] = useState('');
  const [walletName, setWalletName] = useState('');
  const [addressCopied, setAddressCopied] = useState(false);
  // Importing a signing QR code / transaction URI is a Symbol feature that needs the key (a view-only profile cannot sign).

  // True when the active profile has no account on the selected chain yet.
  const [noWallet, setNoWallet] = useState(false);
  // ...and that profile is a view-only one (the answer is then to add an address, not to set the chain up).
  const [noWalletWatch, setNoWalletWatch] = useState(false);

  // リボンを切り替えたとき、中身はアニメーションなしでそのまま入れ替わる（開閉・フェードなし）。
  const shown = panel;

  // Addresses are shown in the 6-character groups the wallets of the chain use; copying
  // always copies the plain address.
  const displayedAddress = address ? prettyChainAddress(address) : '';

  const onCopyAddress = useCallback(async () => {
    if (!displayedAddress) return;
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
    } catch (e) {
      console.error('Failed to copy address', e);
    }
  }, [address]);

  const update = useCallback(async () => {
    const activeWallet = await WalletsHelper.getActive();
    if (activeWallet == null) {
      // The selected chain has no account in this profile yet (NEM not set up): offer to set it up.
      setAddress('');
      setWalletName('');
      setLoadingBalance(false);
      setNoWalletWatch(await WalletsHelper.isActiveWatchOnly());
      setNoWallet(true);
      return;
    }
    setNoWallet(false);
    setAddress(activeWallet.address);
    if (activeWallet.watchOnly) {
      // 閲覧用：プロファイル名（アドレスに名前をつけていればそれも添える）。
      setWalletName(activeWallet.accountName ? `${activeWallet.name} · ${activeWallet.accountName}` : activeWallet.name);
    } else if (activeWallet.accountIndex === null) {
      // 秘密鍵でインポートしたアカウント。プロファイルに追加したものだけ、名前を添えて区別する。
      const addedToProfile = activeWallet.profileId !== '' && activeWallet.profileId !== activeWallet.id;
      setWalletName(addedToProfile
        ? `${activeWallet.name} · ${activeWallet.accountName || t('wallet.account_imported')}`
        : activeWallet.name);
    } else {
      setWalletName(activeWallet.accountName ? `${activeWallet.name} · ${activeWallet.accountName}` : `${activeWallet.name} #${activeWallet.accountIndex}`);
    }

    // Show the last-known balance for this wallet instantly (see lib/homeCache.ts) while a
    // fresh fetch runs underneath and silently corrects it. No cache hit -> spinner.
    const cached = getHomeCache(activeWallet.address);
    if (cached) {
      hydrateBalances({ xym: cached.xymBalance, mosaicCount: cached.mosaicCount });
    } else {
      // Another chain / network: do not leave the previous one's balance on screen while this one loads.
      hydrateBalances({ xym: '0', mosaicCount: 0 });
      setLoadingBalance(true);
    }
    setBalanceFailed(false);

    const startedOn = `${useAppStore.getState().chain}:${useAppStore.getState().network}`;
    const balanceResult = await fetchXymBalance().finally(() => setLoadingBalance(false));
    // The chain / network was switched while this was loading: the answer belongs to the previous one (the reload for the new one is already running).
    if (startedOn !== `${useAppStore.getState().chain}:${useAppStore.getState().network}`) return;

    // balanceResult is null only on a transient node failure - keep what was shown before.
    if (balanceResult === null) setBalanceFailed(true);
    setHomeCache(activeWallet.address, {
      xymBalance: balanceResult?.xym ?? cached?.xymBalance ?? '0',
      mosaicCount: balanceResult?.mosaicCount ?? cached?.mosaicCount ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchXymBalance, hydrateBalances]);

  // Loads on first show, and again when the chain or the network (mainnet <-> testnet) is switched while Home stays on screen.
  useEffect(() => {
    update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, network]);

  // The node reported something for this account (WebSocket, see components/LiveUpdates.tsx): reload.
  const liveTick = useAppStore((st) => st.liveTick);
  useEffect(() => {
    if (liveTick > 0) void update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  // Pressing a ribbon expands its section below it (and collapses the others); pressing the
  // expanded one collapses it. Opening 送る from collapsed starts a fresh transfer, with no
  // leftover recipient / amount / message / mosaic.
  const onToggle = (target: Exclude<HomePanel, null>) => {
    if (panel === target) {
      setHomePanel(null);
      return;
    }
    if (target === 'send') {
      clearReceiverAddress();
      clearSendDraft();
      setSendMosaicId('');
    }
    setHomePanel(target);
  };

  // One tappable ribbon of the row that heads the sections. The expanded one is shown in its own
  // colour, every other one is grey. Only the colour changes - the ribbon never moves.
  const ribbonButton = (target: Exclude<HomePanel, null>, text: string, color: string, icon: ReactNode) => (
    <ButtonBase onClick={() => onToggle(target)} aria-expanded={panel === target} sx={{ borderRadius: 999 }}>
      <CardRibbon text={text} bgcolor={panel === target ? color : 'grey.500'} icon={icon} sx={{ m: 0, transition: 'background-color 0.2s' }} />
    </ButtonBase>
  );

  // スマホ（iOS / Android）: リボンの横並びは窓が狭く、ごちゃごちゃして分かりにくいので、タイル（2列）にする。
  // タイルを押すとその画面に切り替わり、画面の上の「戻る」でタイルに戻る。PCは今までのリボンのまま。
  const mobile = Environment.isMobile();
  const tileDefs: { key: Exclude<HomePanel, null>; text: string; color: string; iconColor?: string; icon: ReactNode; hidden?: boolean }[] = [
    { key: 'mosaics', text: t('home.mosaics_ribbon'), color: 'nemOrange', iconColor: 'onGradient', icon: <TokenOutlinedIcon /> },
    { key: 'history', text: t('home.transaction_ribbon'), color: 'nemBlue', icon: <ReceiptLongOutlinedIcon /> },
    { key: 'send', text: t('home.send'), color: 'nemGreen', icon: <SendOutlinedIcon />, hidden: watchOnly },
    { key: 'invoice', text: t('home.invoice_ribbon'), color: 'ribbonBlue', icon: <QrCode2Icon /> },
    { key: 'apostille', text: t('home.apostille_ribbon'), color: 'nemOrange', iconColor: 'onGradient', icon: <VerifiedOutlinedIcon /> },
    { key: 'network', text: t('home.network_ribbon'), color: 'nemGreen', icon: <PublicIcon /> },
  ];
  const tileSx = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, minHeight: 104, px: 0.5, py: 1.5, borderRadius: 3, border: 1, borderColor: 'divider', bgcolor: 'action.hover', textAlign: 'center', width: '100%' } as const;
  const tileCircle = (color: string, iconColor: string | undefined, icon: ReactNode) => (
    <Box sx={{ width: 48, height: 48, borderRadius: '50%', bgcolor: color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: (th) => (iconColor === 'onGradient' ? th.kasane.onGradient : th.palette.mode === 'dark' ? th.kasane.ink : '#FFFFFF'), '& svg': { fontSize: 26 } }}>
      {icon}
    </Box>
  );
  // 「アポスティーユ」「ネットワーク統計」が途中で折り返されないよう、語の途中では改行しない（収まらない端末では文字を少し小さくする）。
  const tileLabel = (text: string) => <Typography sx={{ fontSize: 'clamp(0.75rem, 3.6vw, 0.95rem)', fontWeight: 'bold', lineHeight: 1.3, color: 'text.primary', wordBreak: 'keep-all', overflowWrap: 'normal', whiteSpace: 'nowrap' }}>{text}</Typography>;
  const activeTile = tileDefs.find((d) => d.key === panel);

  if (noWallet) {
    return noWalletWatch ? <WatchAddressEmpty onDone={update} /> : <NemSetup onDone={update} />;
  }

  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 } }}>
      {mijinSetupNeeded && (
        <Alert severity="warning" sx={{ mt: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate('/settings/top')}>{t('home.mijin_setup_button')}</Button>}>
          {t('home.mijin_setup_notice')}
        </Alert>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', mt: 2 }}>
        <Card sx={{ background: (t) => t.kasane.hero, border: 'none', color: (t) => t.kasane.heroText, position: 'relative', overflow: 'hidden', textShadow: (t) => t.kasane.heroTextShadow }}>
          <Box sx={{ position: 'relative', px: 2, pt: 1.5, pb: 2 }}>
            <Box>
              {walletName && (
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, mb: 0.75 }}>
                  <Typography sx={{ fontSize: '1.1rem', color: (t) => t.kasane.heroText, fontWeight: 'bold', wordBreak: 'break-all', lineHeight: 1.3 }}>
                    {walletName}
                  </Typography>
                  {watchOnly && (
                    <Chip size="small" label={t('watch.badge')} sx={{ height: 20, fontSize: '0.7rem', color: (t) => t.kasane.heroText, bgcolor: (t) => t.kasane.heroChipBg, textShadow: 'none' }} />
                  )}
                </Box>
              )}
              <Typography sx={{ fontSize: '0.75rem', color: (t) => t.kasane.heroTextSoft }}>
                {t('home.address_label')} ({activeNetworkLabel()})
              </Typography>
              <Box
                onClick={onCopyAddress}
                sx={{ display: 'flex', alignItems: 'center', gap: 0.75, cursor: displayedAddress ? 'pointer' : 'default', minWidth: 0 }}
              >
                <Typography sx={{ fontSize: '1rem', color: (t) => t.kasane.heroText, fontWeight: 'bold', wordBreak: 'break-all', lineHeight: 1.4 }}>
                  {displayedAddress || '-'}
                </Typography>
                {displayedAddress && <ContentCopyIcon sx={{ fontSize: 16, color: (t) => t.kasane.heroTextSoft, flexShrink: 0 }} />}
              </Box>
            </Box>

            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography sx={{ fontSize: '0.7rem', color: (t) => t.kasane.heroTextSoft, wordBreak: 'break-all', textAlign: 'left' }}>
                {cardSymbol} {t('home.balance_ribbon')}
              </Typography>
              <Tooltip title={balanceHidden ? t('home.balance_reveal') : t('home.balance_hide')}>
                <IconButton size="small" onClick={toggleBalanceHidden} aria-label={balanceHidden ? t('home.balance_reveal') : t('home.balance_hide')} aria-pressed={balanceHidden} sx={{ color: (t) => t.kasane.heroTextSoft, p: 0.25 }}>
                  {balanceHidden ? <VisibilityOutlinedIcon sx={{ fontSize: 18 }} /> : <VisibilityOffOutlinedIcon sx={{ fontSize: 18 }} />}
                </IconButton>
              </Tooltip>
              </Box>
              {loadingBalance ? (
                <CircularProgress size={22} sx={{ color: (t) => t.kasane.heroText, mt: 0.5, display: 'block' }} />
              ) : (
                <Typography sx={{ fontSize: 'xx-large', color: (t) => t.kasane.heroText, fontWeight: 'bold', lineHeight: 1.2, wordBreak: 'break-all' }}>
                  {balanceHidden ? MASK : Number(cardAmount).toLocaleString(undefined, { maximumFractionDigits: cardDivisibility })} {cardSymbol}
                </Typography>
              )}
              {cardOthers > 0 && (
                <Typography sx={{ fontSize: '0.8rem', color: (t) => t.kasane.heroTextSoft, mt: 0.5 }}>
                  {t('home.other_mosaics', { count: cardOthers })}
                </Typography>
              )}
              {balanceFailed && (
                <Typography sx={{ fontSize: '0.75rem', color: (t) => t.kasane.heroText, mt: 0.5 }}>
                  {t(chain === 'nem' ? 'home.balance_failed_nem' : 'home.balance_failed')}
                </Typography>
              )}
            </Box>
          </Box>
        </Card>

        {/* 保有モザイク / 履歴 / 送る / インボイス / ネットワーク統計（NEM はアポスティーユ） ribbons side by side; the pressed one expands below the row. */}
        <Card sx={{ mt: 2, mb: 2 }}>
          {mobile ? (
            !activeTile ? (
              // スマホ: タイル（押すとその画面が開く）
              <Box sx={{ p: 2 }}>
                {/* QRコードのインポート: タイルではなく、これまで通りの右端のアイコン（ポップアップを開く）。Symbol only. */}
                {chain === 'symbol' && !noKey && (
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
                    <IconButton size="small" aria-label={t('home.import_qr_ribbon')} onClick={() => setShowImportQr(true)}>
                      <QrCodeScannerIcon />
                    </IconButton>
                  </Box>
                )}
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
                {tileDefs.filter((d) => !d.hidden).map((d) => (
                  <ButtonBase key={d.key} onClick={() => onToggle(d.key)} aria-label={d.text} sx={tileSx}>
                    {tileCircle(d.color, d.iconColor, d.icon)}
                    {tileLabel(d.text)}
                  </ButtonBase>
                ))}
              </Box>
              </Box>
            ) : (
              // スマホ: 開いた画面の見出し（左の矢印でタイルに戻る）
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 1 }}>
                <IconButton onClick={() => setHomePanel(null)} aria-label={t('common.back')}>
                  <ArrowBackIcon />
                </IconButton>
                <Typography sx={{ fontSize: '1.05rem', fontWeight: 'bold' }}>{activeTile.text}</Typography>
              </Box>
            )
          ) : (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, px: 2, pt: 2, pb: 1.5 }}>
              {ribbonButton('mosaics', t('home.mosaics_ribbon'), 'nemOrange', <TokenOutlinedIcon sx={{ fontSize: 14, color: (t) => t.kasane.onGradient }} />)}
              {ribbonButton('history', t('home.transaction_ribbon'), 'nemBlue', <ReceiptLongOutlinedIcon sx={{ fontSize: 14 }} />)}
              {!watchOnly && ribbonButton('send', t('home.send'), 'nemGreen', <SendOutlinedIcon sx={{ fontSize: 14 }} />)}
              {ribbonButton('invoice', t('home.invoice_ribbon'), 'ribbonBlue', <QrCode2Icon sx={{ fontSize: 14 }} />)}
              {ribbonButton('apostille', t('home.apostille_ribbon'), 'nemOrange', <VerifiedOutlinedIcon sx={{ fontSize: 14, color: (t) => t.kasane.onGradient }} />)}
              {ribbonButton('network', t('home.network_ribbon'), 'nemGreen', <PublicIcon sx={{ fontSize: 14 }} />)}
              {/* QRコードのインポート: an icon at the right end of the row; opens a popup (署名・連署のQR、アドレス・請求書のQR). Symbol only. */}
              {chain === 'symbol' && !noKey && (
                <Tooltip title={t('home.import_qr_ribbon')}>
                  <IconButton size="small" aria-label={t('home.import_qr_ribbon')} onClick={() => setShowImportQr(true)} sx={{ ml: 'auto' }}>
                    <QrCodeScannerIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )}

          <Box>
                {shown === 'mosaics' && (
                  <>
                    <Divider />
                    <MosaicsPanel onShowOnBalanceCard={pickCardMosaic} balanceHidden={balanceHidden} />
                  </>
                )}

                {/* The invoice (a payment-request QR): Symbol and NEM each have their own format. */}
                {shown === 'invoice' && (
                  <>
                    <Divider />
                    <InvoicePanel />
                  </>
                )}

                {shown === 'send' && !watchOnly && (
                  <>
                    <Divider />
                    <SendForm />
                  </>
                )}

                {/* アポスティーユ（公証）: NEM と Symbol の両方。Home にはエクスプローラー（公開のアポスティーユの一覧）と履歴。作成と監査は サービス → アポスティーユ。 */}
                {shown === 'apostille' && (
                  <>
                    <Divider />
                    <Box sx={{ width: '100%', px: { xs: 2, md: 3 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
                      <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}>
                        <ApostilleRibbon />
                      </Suspense>
                    </Box>
                  </>
                )}

                {/* The whole history lives here: the transactions and (Symbol) the harvest rewards. */}
                {shown === 'history' && (
                  <>
                    <Divider />
                    {chain === 'symbol' ? <SymbolHistoryPanel /> : <NemHistoryPanel />}
                  </>
                )}

                {/* ネットワーク統計: chain height, peers, block time … (Symbol: also finalization and fees; NEM: the NIS1 node's figures. Read-only, so view-only profiles see it too). */}
                {shown === 'network' && (
                  <>
                    <Divider />
                    <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}>
                      {chain === 'symbol' ? <NetworkStatsPanel /> : <NemNetworkStatsPanel />}
                    </Suspense>
                  </>
                )}
          </Box>
        </Card>
      </Box>

      {showImportQr && (
        <Suspense fallback={null}>
          <ImportQrDialog open onClose={() => setShowImportQr(false)} />
        </Suspense>
      )}

      <Snackbar
        open={addressCopied}
        autoHideDuration={2000}
        onClose={() => setAddressCopied(false)}
        message={t('home.address_copied')}
      />
    </Box>
  );
}
