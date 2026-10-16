// Decides which "unconfirmed" / "confirmed" events the NEM live listener reports, whichever way the news arrived
// (WebSocket or looking at the node). Pure: no timers of its own beyond the spacing of reports, no browser APIs.
import type { LiveEvent } from '../symbol/live';

/** Reports are at least this far apart, so ding (broadcast) and ding2 (confirmed) are heard one after the other. */
export const MIN_REPORT_GAP_MS = 1200;

interface EntryLike {
  meta?: { hash?: { data?: string }; innerHash?: { data?: string }; data?: string };
  transaction?: { signature?: string };
}

/**
 * Everything that names one transaction in a node's answer, lower-cased: its signature and the hashes in `meta`.
 * The unconfirmed list and the confirmed list (and the WebSocket channels) do not put the same hash in the same place
 * (`meta.data` / `meta.hash.data`; a multisig transaction carries the hash of what it wraps), but the signature of the
 * transaction is the same everywhere. A transaction is "the same one" when any of these matches, so a transaction that was
 * announced is not taken for a new one when it is confirmed.
 */
export function liveIds(entry: EntryLike): string[] {
  const ids = [entry.transaction?.signature, entry.meta?.hash?.data, entry.meta?.data, entry.meta?.innerHash?.data]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => v.toLowerCase());
  return [...new Set(ids)];
}

export interface LiveReporter {
  /** The node has the transaction, not yet in a block. `ids` name it (see liveIds), `hash` is shown. */
  reportUnconfirmed: (ids: string[], hash: string, txType: number | undefined) => void;
  /** The transaction is in a block. One never seen waiting is reported as "unconfirmed" first. */
  reportConfirmed: (ids: string[], hash: string, txType: number | undefined) => void;
  /** After this, news is reported. Before it, everything is only remembered (what already existed when we started). */
  prime: () => void;
  isPrimed: () => boolean;
  stop: () => void;
}

export function createLiveReporter(onEvent: (event: LiveEvent) => void, minGapMs: number = MIN_REPORT_GAP_MS): LiveReporter {
  const seenUnconfirmed = new Set<string>();
  const seenConfirmed = new Set<string>();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let primed = false;
  let stopped = false;
  let lastAt = 0;

  const has = (set: Set<string>, ids: string[]) => ids.some((id) => set.has(id));
  const remember = (set: Set<string>, ids: string[]) => ids.forEach((id) => set.add(id));

  const emit = (event: LiveEvent) => {
    if (!primed || stopped) return;
    const now = Date.now();
    const at = Math.max(now, lastAt + minGapMs);
    lastAt = at;
    if (at <= now) {
      onEvent(event);
    } else {
      timers.push(setTimeout(() => { if (!stopped) onEvent(event); }, at - now));
    }
  };

  const reportUnconfirmed = (ids: string[], hash: string, txType: number | undefined) => {
    if (ids.length === 0 || has(seenUnconfirmed, ids) || has(seenConfirmed, ids)) return;
    remember(seenUnconfirmed, ids);
    emit({ kind: 'unconfirmed', hash, txType });
  };

  const reportConfirmed = (ids: string[], hash: string, txType: number | undefined) => {
    if (ids.length === 0 || has(seenConfirmed, ids)) return;
    remember(seenConfirmed, ids);
    if (!has(seenUnconfirmed, ids)) {
      // Never seen waiting: its waiting phase fell between two looks (or the connection was down). Still tell about it,
      // as Symbol's WebSocket always does, so a new transaction is heard twice. A transaction that WAS seen waiting
      // (announced from here, or reported by the WebSocket) never gets this: after the confirmation only ding2 is heard.
      remember(seenUnconfirmed, ids);
      emit({ kind: 'unconfirmed', hash, txType });
    }
    emit({ kind: 'confirmed', hash, txType });
  };

  return {
    reportUnconfirmed,
    reportConfirmed,
    prime: () => { primed = true; },
    isPrimed: () => primed,
    stop: () => { stopped = true; timers.forEach(clearTimeout); },
  };
}
