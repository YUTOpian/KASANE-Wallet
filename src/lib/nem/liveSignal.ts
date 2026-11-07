// A tiny signal between "a NEM transaction was announced" (lib/nem/api.ts) and the live listener
// (lib/nem/live.ts), so the listener can look at the node at once instead of waiting for its next poll.
// Kept in its own module so that api.ts and live.ts do not import each other.
const listeners = new Set<() => void>();

export function onNemAnnounced(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyNemAnnounced(): void {
  listeners.forEach((l) => { try { l(); } catch { /* a listener must never break sending */ } });
}
