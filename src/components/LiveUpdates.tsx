import { useEffect, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import SwipeDismiss from './SwipeDismiss';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import type { ChainKey } from '../lib/chain';
import { WalletsHelper } from '../lib/storage';
import { startLiveListener } from '../lib/symbol/live';
import { startNemLiveListener } from '../lib/nem/live';
import { nemTypeKey } from '../lib/nem/history';
import type { LiveEvent } from '../lib/symbol/live';
import { typeKey } from '../lib/symbol/history';
import dingUrl from '../assets/ding.ogg';
import ding2Url from '../assets/ding2.ogg';

// Events that arrive together (confirmed + unconfirmed-removed of one transaction) trigger one refresh.
const REFRESH_DELAY_MS = 1500;
// A confirmation reaches the WebSocket slightly before the node's REST database has the new balance: look once more a little later.
const CONFIRMED_RECHECK_MS = 6000;

interface Toast { key: number; severity: 'success' | 'info' | 'warning' | 'error'; text: string; link: string | null }

/**
 * Listens to the node for the active account (Symbol: WebSocket; NEM: regular polling, lib/nem/live.ts) and, when something happens, refreshes the open
 * screens (liveTick), shows a notification and plays a sound (the sound can be switched off in settings; it covers both the sound of a new transaction and the sound of a confirmed one).
 * Renders nothing but the notification.
 */
export default function LiveUpdates() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const sound = useAppStore((s) => s.liveSound);
  const bumpLiveTick = useAppStore((s) => s.bumpLiveTick);

  // The account being followed, with the chain / network it was looked up for: right after a switch the chain is
  // already the new one while this still holds the previous account (a Symbol address would be sent to a NEM node).
  const [target, setTarget] = useState<{ address: string; chain: ChainKey; network: string }>({ address: '', chain, network });
  const address = target.address;
  const targetReady = target.chain === chain && target.network === network;
  const [toast, setToast] = useState<Toast | null>(null);
  const [open, setOpen] = useState(false);

  // The newest settings, read inside the long-lived listener without restarting it.
  const settings = useRef({ sound, t });
  settings.current = { sound, t };
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ding: a transaction has started (announced to the node); ding2: it is confirmed.
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioDone = useRef<HTMLAudioElement | null>(null);

  // Which account to follow: the active one (it changes when the person switches wallets).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wallet = await WalletsHelper.getActive(chain);
      if (!cancelled) setTarget({ address: wallet?.address ?? '', chain, network });
    })();
    return () => { cancelled = true; };
  }, [chain, network, pathname]);

  useEffect(() => {
    if (!address || !targetReady) return undefined;
    const onEvent = (e: LiveEvent) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(bumpLiveTick, REFRESH_DELAY_MS);
      if (e.kind === 'confirmed') {
        clearTimeout(recheckTimer.current);
        recheckTimer.current = setTimeout(bumpLiveTick, CONFIRMED_RECHECK_MS);
      }

      const { sound: ding, t: tr } = settings.current;
      if (e.kind === 'removed') return;
      const typeName = e.txType !== undefined ? tr(`history.type.${chain === 'nem' ? nemTypeKey(e.txType) : typeKey(e.txType)}`) : '';
      // The Symbol detail screen is looked up by hash; NEM's detail screen needs the row picked in the history, so no link there.
      const linkTo = (status: string) => (chain === 'symbol' && e.hash ? `/transaction/view?hash=${e.hash}&status=${status}` : null);
      let next: Toast;
      switch (e.kind) {
        case 'confirmed':
          next = { key: Date.now(), severity: 'success', text: tr('live.confirmed', { type: typeName }), link: linkTo('confirmed') };
          break;
        case 'unconfirmed':
          next = { key: Date.now(), severity: 'info', text: tr('live.unconfirmed', { type: typeName }), link: linkTo('unconfirmed') };
          break;
        case 'partial':
          next = { key: Date.now(), severity: 'warning', text: tr('live.partial', { type: typeName }), link: linkTo('partial') };
          break;
        case 'cosignature':
          next = { key: Date.now(), severity: 'info', text: tr('live.cosignature'), link: linkTo('partial') };
          break;
        default:
          next = { key: Date.now(), severity: 'error', text: tr('live.rejected', { code: e.code ?? '' }), link: null };
      }
      setToast(next);
      setOpen(true);
      if (ding) {
        try {
          let player: HTMLAudioElement;
          if (e.kind === 'confirmed') {
            audioDone.current ??= new Audio(ding2Url);
            player = audioDone.current;
          } else {
            audio.current ??= new Audio(dingUrl);
            player = audio.current;
          }
          player.currentTime = 0;
          // Browsers refuse sound before the first tap on the page; that is fine, just skip it.
          void player.play().catch(() => undefined);
        } catch { /* no audio support */ }
      }
    };
    const stop = chain === 'nem' ? startNemLiveListener(address, onEvent) : startLiveListener(address, onEvent);
    // A page in the background may have missed events (the connection sleeps): look again when it comes back to the front.
    const onVisible = () => { if (document.visibilityState === 'visible') bumpLiveTick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(refreshTimer.current);
      clearTimeout(recheckTimer.current);
    };
  }, [address, targetReady, chain, network, bumpLiveTick]);

  return (
    <Snackbar
      key={toast?.key}
      open={open && toast !== null}
      autoHideDuration={6000}
      onClose={(_, reason) => { if (reason !== 'clickaway') setOpen(false); }}
    >
      <SwipeDismiss onDismiss={() => setOpen(false)}>
      <Alert
        severity={toast?.severity ?? 'info'}
        variant="filled"
        onClose={() => setOpen(false)}
        onClick={() => { if (toast?.link) { setOpen(false); navigate(toast.link); } }}
        sx={{ cursor: toast?.link ? 'pointer' : 'default', width: '100%' }}
      >
        {toast?.text}
      </Alert>
      </SwipeDismiss>
    </Snackbar>
  );
}
