import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';

interface Options {
  /**
   * Also look again this often (ms) while the screen is open and visible. For what other people change (new votes, new blocks):
   * the node's WebSocket of the wallet's own address does not tell about those.
   */
  pollMs?: number;
  /** Turn it off while true (a dialog is open, the poll has ended, ...). */
  paused?: boolean;
}

/**
 * Refresh an open screen by itself.
 *   - When the wallet hears something about the active account (LiveUpdates bumps `liveTick`), `refresh` runs once.
 *   - With `pollMs`, it also runs on a timer, and once more when the page comes back to the front.
 * `refresh` should be a quiet reload: no spinner, and an error must keep what is on the screen. The newest `refresh` is always the one
 * called, so it can read the current state without restarting the timer. Two refreshes never overlap.
 */
export function useLiveRefresh(refresh: () => void | Promise<void>, { pollMs, paused = false }: Options = {}): void {
  const liveTick = useAppStore((s) => s.liveTick);
  const latest = useRef(refresh);
  latest.current = refresh;
  const running = useRef(false);
  // Only a change after the screen opened counts: the screen has just loaded for itself.
  const seenTick = useRef(liveTick);

  const run = useRef(async () => {
    if (running.current) return;
    running.current = true;
    try {
      await latest.current();
    } catch {
      /* a quiet refresh never shows an error */
    } finally {
      running.current = false;
    }
  }).current;

  useEffect(() => {
    if (liveTick === seenTick.current) return;
    seenTick.current = liveTick;
    if (!paused) void run();
  }, [liveTick, paused, run]);

  useEffect(() => {
    if (!pollMs || paused) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void run(); }, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollMs, paused, run]);
}
