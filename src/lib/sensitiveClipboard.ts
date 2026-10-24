// Copying a secret (private key, recovery phrase) to the clipboard, and taking it off again.
//
// The clipboard is shared with every other app and browser extension on the device, and whatever is on it
// stays there until something else is copied. So a copied secret is removed again after a while - but only if
// it is still the thing that is on the clipboard: if something else was copied in the meantime, that is not ours
// to wipe. Only for secrets; a copied address disappearing would just be a surprise.
//
// Reading the clipboard needs the page to have focus (and, in some browsers, a permission). If the page is in
// the background when the time is up, the wipe is tried again when it comes back to the front; if it still cannot
// read the clipboard then, it gives up rather than wiping blindly.

export const SECRET_CLIPBOARD_CLEAR_MS = 30_000;

let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let due = 0;
let listening = false;

type Outcome = 'done' | 'unfocused' | 'unreadable';

async function wipeIfStillThere(text: string): Promise<Outcome> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return 'unreadable';
  try {
    const current = await navigator.clipboard.readText();
    if (current === text) await navigator.clipboard.writeText('');
    return 'done';
  } catch {
    return typeof document !== 'undefined' && !document.hasFocus() ? 'unfocused' : 'unreadable';
  }
}

async function attempt(): Promise<void> {
  const text = pending;
  if (text === null) return;
  const outcome = await wipeIfStillThere(text);
  if (pending !== text) return; // a newer secret was copied while this was running
  if (outcome === 'unfocused') return; // keep it pending: tried again when the page is back in front
  pending = null; // wiped, or the clipboard cannot be read here: nothing more to do
}

function onBackInFront() {
  if (pending === null) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (Date.now() < due) return; // not yet time: the timer will do it
  void attempt();
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('focus', onBackInFront);
  document.addEventListener('visibilitychange', onBackInFront);
}

/** Wipes `text` from the clipboard after `ms` (if it is still there). A later call replaces an earlier one. */
export function scheduleClipboardClear(text: string, ms: number = SECRET_CLIPBOARD_CLEAR_MS): void {
  if (timer !== null) clearTimeout(timer);
  pending = text;
  due = Date.now() + ms;
  listen();
  timer = setTimeout(() => { timer = null; void attempt(); }, ms);
}

/** Copies a secret and arranges for it to be taken off the clipboard again. Returns false when the copy itself failed. */
export async function copySensitiveText(text: string, ms: number = SECRET_CLIPBOARD_CLEAR_MS): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  scheduleClipboardClear(text, ms);
  return true;
}
