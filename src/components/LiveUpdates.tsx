import { useEffect, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { WalletsHelper } from '../lib/storage';
import { startLiveListener } from '../lib/symbol/live';
import type { LiveEvent } from '../lib/symbol/live';
import { typeKey } from '../lib/symbol/history';
import dingUrl from '../assets/ding.ogg';
import ding2Url from '../assets/ding2.ogg';

// Events that arrive together (confirmed + unconfirmed-removed of one transaction) trigger one refresh.
const REFRESH_DELAY_MS = 1500;

interface Toast { key: number; severity: 'success' | 'info' | 'warning' | 'error'; text: string; link: string | null }

/**
 * Listens to the node for the active Symbol account and, when something happens, refreshes the open
 * screens (liveTick), shows a notification and plays a sound (each can be switched off in settings).
 * Renders nothing but the notification.
 */
export default function LiveUpdates() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const notify = useAppStore((s) => s.liveNotifications);
  const sound = useAppStore((s) => s.liveSound);
  const bumpLiveTick = useAppStore((s) => s.bumpLiveTick);

  const [address, setAddress] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [open, setOpen] = useState(false);

  // The newest settings, read inside the long-lived listener without restarting it.
  const settings = useRef({ notify, sound, t });
  settings.current = { notify, sound, t };
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ding: a transaction has started (announced to the node); ding2: it is confirmed.
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioDone = useRef<HTMLAudioElement | null>(null);

  // Which account to follow: the active one (it changes when the person switches wallets).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wallet = chain === 'symbol' ? await WalletsHelper.getActive() : null;
      if (!cancelled) setAddress(wallet?.address ?? '');
    })();
    return () => { cancelled = true; };
  }, [chain, network, pathname]);

  useEffect(() => {
    if (!address) return undefined;
    const onEvent = (e: LiveEvent) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(bumpLiveTick, REFRESH_DELAY_MS);

      const { notify: on, sound: ding, t: tr } = settings.current;
      if (!on || e.kind === 'removed') return;
      const typeName = e.txType !== undefined ? tr(`history.type.${typeKey(e.txType)}`) : '';
      let next: Toast;
      switch (e.kind) {
        case 'confirmed':
          next = { key: Date.now(), severity: 'success', text: tr('live.confirmed', { type: typeName }), link: e.hash ? `/transaction/view?hash=${e.hash}&status=confirmed` : null };
          break;
        case 'unconfirmed':
          next = { key: Date.now(), severity: 'info', text: tr('live.unconfirmed', { type: typeName }), link: e.hash ? `/transaction/view?hash=${e.hash}&status=unconfirmed` : null };
          break;
        case 'partial':
          next = { key: Date.now(), severity: 'warning', text: tr('live.partial', { type: typeName }), link: e.hash ? `/transaction/view?hash=${e.hash}&status=partial` : null };
          break;
        case 'cosignature':
          next = { key: Date.now(), severity: 'info', text: tr('live.cosignature'), link: e.hash ? `/transaction/view?hash=${e.hash}&status=partial` : null };
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
    const stop = startLiveListener(address, onEvent);
    return () => {
      stop();
      clearTimeout(refreshTimer.current);
    };
  }, [address, bumpLiveTick]);

  return (
    <Snackbar
      key={toast?.key}
      open={open && toast !== null}
      autoHideDuration={6000}
      onClose={(_, reason) => { if (reason !== 'clickaway') setOpen(false); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity={toast?.severity ?? 'info'}
        variant="filled"
        onClose={() => setOpen(false)}
        onClick={() => { if (toast?.link) { setOpen(false); navigate(toast.link); } }}
        sx={{ cursor: toast?.link ? 'pointer' : 'default', width: '100%' }}
      >
        {toast?.text}
      </Alert>
    </Snackbar>
  );
}
