import type { ReactNode } from 'react';
import { useEffect, useState, useCallback } from 'react';
import { Box, ButtonBase, Card, CardActionArea, Collapse, Typography, CircularProgress, Divider, Snackbar } from '@mui/material';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CallReceivedIcon from '@mui/icons-material/CallReceived';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import CardRibbon from '../../components/CardRibbon';
import ReceivePanel from './ReceivePanel';
import SendForm from './SendForm';
import SymbolHistoryPanel from './SymbolHistoryPanel';
import NemHistoryPanel from './NemHistoryPanel';
import { useSymbolBalance } from '../../hooks/useSymbolBalance';
import { useAppStore } from '../../store/appStore';
import type { HomePanel } from '../../store/appStore';
import { WalletsHelper } from '../../lib/storage';
import { fetchHarvestRewards } from '../../lib/symbol/api';
import type { HarvestReward } from '../../lib/symbol/api';
import { activeNetworkLabel, prettyChainAddress } from '../../lib/chainApi';
import { chainMeta } from '../../lib/chain';
import NemSetup from './NemSetup';
import { getHomeCache, setHomeCache } from '../../lib/homeCache';
import iconReceiveGreen from '../../assets/icon_transaction_receive_green.png';

const HARVEST_COUNT = 10;

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Which of the three sections (受け取る / 送る / 取引履歴) is expanded - one at a time.
  const panel = useAppStore((s) => s.homePanel);
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);
  const setSendMosaicId = useAppStore((s) => s.setSendMosaicId);
  const { xymBalance, mosaicCount, fetchXymBalance, hydrateBalances } = useSymbolBalance();
  // Reading the chain / network from the store re-renders Home when either is switched.
  const network = useAppStore((st) => st.network);
  const chain = useAppStore((st) => st.chain);
  const nativeSymbol = chainMeta(chain).currencySymbol;

  const [loadingBalance, setLoadingBalance] = useState(false);
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [address, setAddress] = useState('');
  const [walletName, setWalletName] = useState('');
  const [addressCopied, setAddressCopied] = useState(false);

  // True when the active profile has no account on the selected chain yet.
  const [noWallet, setNoWallet] = useState(false);

  // Harvest rewards (loaded when the ハーベスト履歴 section is opened; Symbol only).
  const [rewards, setRewards] = useState<HarvestReward[]>([]);
  const [loadingRewards, setLoadingRewards] = useState(false);
  const [rewardsFailed, setRewardsFailed] = useState(false);

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
      setNoWallet(true);
      return;
    }
    setNoWallet(false);
    setAddress(activeWallet.address);
    if (activeWallet.accountIndex === null) {
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
      setLoadingBalance(true);
    }
    setBalanceFailed(false);

    const balanceResult = await fetchXymBalance().finally(() => setLoadingBalance(false));

    // balanceResult is null only on a transient node failure - keep what was shown before.
    if (balanceResult === null) setBalanceFailed(true);
    setHomeCache(activeWallet.address, {
      xymBalance: balanceResult?.xym ?? cached?.xymBalance ?? '0',
      mosaicCount: balanceResult?.mosaicCount ?? cached?.mosaicCount ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchXymBalance, hydrateBalances]);

  // Loads on first show, and again when the chain is switched while Home stays on screen.
  useEffect(() => {
    update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  // The node reported something for this account (WebSocket, see components/LiveUpdates.tsx): reload.
  const liveTick = useAppStore((st) => st.liveTick);
  useEffect(() => {
    if (liveTick > 0) void update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  useEffect(() => {
    if (panel !== 'harvest') return undefined;
    let cancelled = false;
    setLoadingRewards(true);
    setRewardsFailed(false);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        const list = wallet ? await fetchHarvestRewards(wallet.address, HARVEST_COUNT) : [];
        if (!cancelled) setRewards(list);
      } catch (e) {
        console.error('Failed to load harvest rewards', e);
        if (!cancelled) setRewardsFailed(true);
      } finally {
        if (!cancelled) setLoadingRewards(false);
      }
    })();
    return () => { cancelled = true; };
  }, [panel, network, address]);

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

  if (noWallet) {
    return <NemSetup onDone={update} />;
  }

  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 } }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', mt: 2 }}>
        <Card sx={{ background: (t) => t.kasane.hero, border: 'none', color: (t) => t.kasane.heroText, position: 'relative', overflow: 'hidden', textShadow: '0 1px 3px rgba(0,0,0,0.28)' }}>
          <Box sx={{ position: 'relative', px: 2, pt: 1.5, pb: 2 }}>
            <Box>
              {walletName && (
                <Typography sx={{ fontSize: '1.1rem', color: (t) => t.kasane.heroText, fontWeight: 'bold', wordBreak: 'break-all', lineHeight: 1.3, mb: 0.75 }}>
                  {walletName}
                </Typography>
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
              <Typography sx={{ fontSize: '0.7rem', color: (t) => t.kasane.heroTextSoft }}>
                {nativeSymbol} {t('home.balance_ribbon')}
              </Typography>
              {loadingBalance ? (
                <CircularProgress size={22} sx={{ color: (t) => t.kasane.heroText, mt: 0.5 }} />
              ) : (
                <Typography sx={{ fontSize: 'xx-large', color: (t) => t.kasane.heroText, fontWeight: 'bold', lineHeight: 1.2 }}>
                  {Number(xymBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })} {nativeSymbol}
                </Typography>
              )}
              {mosaicCount > 0 && (
                <Typography sx={{ fontSize: '0.8rem', color: (t) => t.kasane.heroTextSoft, mt: 0.5 }}>
                  {t('home.other_mosaics', { count: mosaicCount })}
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

        {/* 受け取る / 送る / 取引履歴 ribbons side by side; the pressed one expands below the row. */}
        <Card sx={{ mt: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, px: 2, pt: 2, pb: 1.5 }}>
            {ribbonButton('receive', t('home.receive'), 'nemOrange', <CallReceivedIcon sx={{ fontSize: 14, color: (t) => t.kasane.ink }} />)}
            {ribbonButton('send', t('home.send'), 'nemGreen', <SendOutlinedIcon sx={{ fontSize: 14 }} />)}
            {ribbonButton('history', t('home.transaction_ribbon'), 'nemBlue', <ReceiptLongOutlinedIcon sx={{ fontSize: 14 }} />)}
            {chain === 'symbol' && ribbonButton('harvest', t('home.harvest_ribbon'), 'primary.main', <AgricultureOutlinedIcon sx={{ fontSize: 14 }} />)}
          </Box>

          <Collapse in={panel === 'receive'} timeout="auto" unmountOnExit>
            <Divider />
            <ReceivePanel />
          </Collapse>

          <Collapse in={panel === 'send'} timeout="auto" unmountOnExit>
            <Divider />
            <SendForm />
          </Collapse>

          {/* The whole transaction history lives here (there is no separate history page any more). */}
          <Collapse in={panel === 'history'} timeout="auto" unmountOnExit>
            <Divider />
            {chain === 'symbol' ? <SymbolHistoryPanel /> : <NemHistoryPanel />}
          </Collapse>

          <Collapse in={panel === 'harvest' && chain === 'symbol'} timeout="auto" unmountOnExit>
            <Divider />
            {loadingRewards && rewards.length === 0 ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>
            ) : rewardsFailed ? (
              <Box sx={{ py: 3, px: 2 }}>
                <Typography sx={{ color: 'text.secondary', textAlign: 'center' }}>{t('home.harvest_failed')}</Typography>
              </Box>
            ) : rewards.length === 0 ? (
              <Box sx={{ py: 3, px: 2 }}>
                <Typography sx={{ color: 'text.secondary', textAlign: 'center' }}>{t('home.no_harvest_title')}</Typography>
              </Box>
            ) : (
              <Box sx={{ mt: 1 }}>
                {rewards.map((r, i) => (
                  <Box key={r.height}>
                    {i > 0 && <Divider />}
                    <Box sx={{ px: 2, py: 1.25 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box component="img" src={iconReceiveGreen} sx={{ width: 16, height: 16, flexShrink: 0 }} />
                        <Typography sx={{ fontWeight: 'bold', color: 'primary.main' }}>+{r.amount} {nativeSymbol}</Typography>
                        <Box sx={{ flexGrow: 1 }} />
                        {r.timestampMs !== null && (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{new Date(r.timestampMs).toLocaleDateString()}</Typography>
                        )}
                      </Box>
                      <Typography variant="body2" noWrap sx={{ mt: 0.5, color: 'text.secondary', textAlign: 'left' }}>
                        {t('home.harvest_reward')} / {t('home.harvest_block', { height: Number(r.height).toLocaleString() })}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
            <Divider />
            <CardActionArea onClick={() => navigate('/harvest')} sx={{ py: 1.25 }}>
              <Typography variant="body2" sx={{ color: 'primary.main', textAlign: 'center', fontWeight: 'bold' }}>{t('home.harvest_settings_link')}</Typography>
            </CardActionArea>
          </Collapse>
        </Card>
      </Box>

      <Snackbar
        open={addressCopied}
        autoHideDuration={2000}
        onClose={() => setAddressCopied(false)}
        message={t('home.address_copied')}
      />
    </Box>
  );
}
