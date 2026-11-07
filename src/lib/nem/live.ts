// Live updates for NEM (NIS1). Symbol gets them from the node's WebSocket (lib/symbol/live.ts). NEM now does the same:
// NIS1 has a WebSocket API too (STOMP, lib/nem/liveSocket.ts) - on wss port 7779 of the nodes that offer it. Not every
// node does, so the wallet also looks at the node regularly (the unconfirmed list -> "unconfirmed", the newest confirmed
// transactions -> "confirmed"): every 6 seconds while there is no WebSocket, every 30 seconds as a safety net while there is.
// It reports the same LiveEvent as the Symbol listener, so components/LiveUpdates.tsx treats both chains alike.
import type { LiveEvent } from '../symbol/live';
import { logDebug, logInfo } from '../diagnostics';
import { getNetwork } from '../symbol/network';
import { nodeRequest, resolveNemNode } from './api';
import { normalizeNemAddress } from './crypto';
import { NEM_TX_TYPE_MULTISIG } from './constants';
import { onNemAnnounced } from './liveSignal';
import { createLiveReporter, liveIds } from './liveReporter';
import { nemSocketUrlFor, startNemSocket } from './liveSocket';
import { getNemCustomNode, getNemNetworkConfig } from './network';

const POLL_MS = 6000;
// While the WebSocket is up, looking is only a safety net (it also notices what the socket missed).
const POLL_WITH_SOCKET_MS = 30_000;
// After an announce, look again a few times quickly: the node lists the transaction at once, a block takes ~1 min.
const AFTER_ANNOUNCE_MS = [300, 2500];
// How many other nodes are tried besides the one the wallet talks to.
const EXTRA_SOCKET_NODES = 3;

interface RawEntry {
  meta?: { hash?: { data?: string }; innerHash?: { data?: string }; data?: string };
  transaction: { type: number; signature?: string; otherTrans?: { type: number } };
}

const hashOf = (e: RawEntry): string => e.meta?.hash?.data ?? e.meta?.data ?? '';
// A multisig wrapper is reported as what it carries.
const typeOf = (e: RawEntry): number => (e.transaction.type === NEM_TX_TYPE_MULTISIG && e.transaction.otherTrans ? e.transaction.otherTrans.type : e.transaction.type);
const isEntry = (value: unknown): value is RawEntry => typeof value === 'object' && value !== null && typeof (value as RawEntry).transaction === 'object' && (value as RawEntry).transaction !== null;

/** Where to try the WebSocket: the node the wallet already talks to first, then a few others (not when a node was typed in by hand). */
async function socketUrls(): Promise<string[]> {
  const urls: string[] = [];
  const add = (rest: string) => {
    const url = nemSocketUrlFor(rest);
    if (url && !urls.includes(url)) urls.push(url);
  };
  const custom = getNemCustomNode();
  try {
    add(custom || await resolveNemNode());
  } catch {
    // No REST node yet; the next round asks again.
  }
  if (!custom) {
    const others = [...getNemNetworkConfig(getNetwork()).fallbackNodes];
    for (let i = others.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    others.slice(0, EXTRA_SOCKET_NODES).forEach(add);
  }
  return urls;
}

/**
 * Starts following an account. The first look only records what is already there (no sound, no
 * notification for old transactions). Returns a function that stops everything.
 *
 * Like Symbol's WebSocket, every new transaction is reported twice: when the node has it ("unconfirmed", ding)
 * and when it is in a block ("confirmed", ding2). With the WebSocket that is exact. When news only comes from looking
 * regularly the block may come between two looks, so a transaction that is first seen already confirmed gets the
 * "unconfirmed" event just before its "confirmed" one (lib/nem/liveReporter.ts).
 */
export function startNemLiveListener(address: string, onEvent: (event: LiveEvent) => void): () => void {
  let addr: string;
  try {
    addr = normalizeNemAddress(address);
  } catch {
    return () => undefined;
  }
  const reporter = createLiveReporter(onEvent);
  let stopped = false;
  let busy = false;
  let again = false; // a poll was asked for while one was running
  let socketUp = false;
  let lastPollAt = 0;

  const poll = async () => {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    lastPollAt = Date.now();
    try {
      const [pending, confirmed] = await Promise.all([
        nodeRequest<{ data?: RawEntry[] }>(`/account/unconfirmedTransactions?address=${addr}`),
        nodeRequest<{ data?: RawEntry[] }>(`/account/transfers/all?address=${addr}`),
      ]);
      if (stopped) return;
      for (const e of pending.data ?? []) reporter.reportUnconfirmed(liveIds(e), hashOf(e), typeOf(e));
      // Oldest first, so several new blocks are reported in order.
      for (const e of [...(confirmed.data ?? [])].reverse()) reporter.reportConfirmed(liveIds(e), hashOf(e), typeOf(e));
      reporter.prime();
    } catch {
      // The node is unreachable right now; the next poll tries again.
    } finally {
      busy = false;
      if (again && !stopped) { again = false; void poll(); }
    }
  };

  const timer = setInterval(() => {
    // The page may be in the background (a faucet or another page in front): the browser slows the timer
    // down but it keeps running, and the WebSocket keeps listening.
    if (socketUp && Date.now() - lastPollAt < POLL_WITH_SOCKET_MS) return;
    void poll();
  }, POLL_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
  document.addEventListener('visibilitychange', onVisible);

  const followUps: Array<ReturnType<typeof setTimeout>> = [];
  const offAnnounce = onNemAnnounced(() => {
    // Never before the first look: the baseline must not contain the transaction that was just sent.
    if (!reporter.isPrimed()) return;
    AFTER_ANNOUNCE_MS.forEach((ms) => followUps.push(setTimeout(() => { void poll(); }, ms)));
  });

  // The WebSocket: news the moment the node has it. What it reports goes through the same reporter as the looking above,
  // so nothing is told twice.
  const stopSocket = startNemSocket({
    address: addr,
    urls: socketUrls,
    onUnconfirmed: (entry) => {
      if (!isEntry(entry)) return;
      logDebug('nem-live', `unconfirmed (WebSocket) ${hashOf(entry)}`);
      reporter.reportUnconfirmed(liveIds(entry), hashOf(entry), typeOf(entry));
    },
    onConfirmed: (entry) => {
      if (!isEntry(entry)) return;
      logDebug('nem-live', `confirmed (WebSocket) ${hashOf(entry)}`);
      reporter.reportConfirmed(liveIds(entry), hashOf(entry), typeOf(entry));
    },
    onStatus: ({ connected }) => {
      socketUp = connected;
      // Look once right away: whatever happened while the connection was down is picked up now.
      if (connected) void poll();
    },
    log: (message) => logInfo('nem-live', message),
  });

  void poll();
  return () => {
    stopped = true;
    reporter.stop();
    stopSocket();
    clearInterval(timer);
    followUps.forEach(clearTimeout);
    document.removeEventListener('visibilitychange', onVisible);
    offAnnounce();
  };
}
