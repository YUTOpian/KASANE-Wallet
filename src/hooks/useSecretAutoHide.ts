import { useEffect, useRef } from 'react';

/** How long a screen that shows a recovery phrase / private key may sit untouched before it hides them (writing 24 words down takes minutes). */
export const BACKUP_SCREEN_IDLE_MS = 3 * 60 * 1000;
/** The same for a private key revealed on the account screen (it is usually copied, not written down). */
export const REVEALED_KEY_IDLE_MS = 90 * 1000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

/**
 * While `active` (a secret is on screen), calls `onHide` when the person has not touched the page for `idleMs`,
 * and at once when the page goes to the background (another tab or app, screen lock). `onHide` should drop the
 * secret from state. Stops listening as soon as `active` is false.
 */
export function useSecretAutoHide(active: boolean, onHide: () => void, idleMs: number): void {
  const hide = useRef(onHide);
  hide.current = onHide;

  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastReset = 0;
    const fire = () => { hide.current(); };
    const reset = () => {
      const now = Date.now();
      if (timer !== null && now - lastReset < 1000) return; // pointermove / scroll fire constantly: once a second is enough
      lastReset = now;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, idleMs);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') fire(); };

    reset();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== null) clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset, { capture: true }));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, idleMs]);
}
