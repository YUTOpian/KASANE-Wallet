// Live updates from the Symbol node's WebSocket (wss://<node>:3001/ws). The wallet subscribes to the
// channels of its own address and reports each event; screens refresh when told to.
import { resolveNode } from './api';
import { normalizeAddress } from './crypto';

export type LiveEventKind = 'confirmed' | 'unconfirmed' | 'partial' | 'cosignature' | 'status' | 'removed';

export interface LiveEvent {
  kind: LiveEventKind;
  hash: string;
  txType?: number; // transaction type (confirmed / unconfirmed / partial events)
  code?: string; // rejection reason (status events), e.g. "Failure_Core_Insufficient_Balance"
}

/** REST node URL -> its WebSocket URL (https -> wss, http -> ws, path /ws). */
export function wsUrlFor(node: string): string {
  return `${node.trim().replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws`;
}

const CHANNELS = ['confirmedAdded', 'unconfirmedAdded', 'unconfirmedRemoved', 'partialAdded', 'partialRemoved', 'cosignature', 'status'];

interface WsMessage {
  uid?: string;
  topic?: string;
  data?: {
    transaction?: { type?: number };
    meta?: { hash?: string };
    parentHash?: string;
    hash?: string;
    code?: string;
  };
}

/** Turns one WebSocket message into a LiveEvent (null for anything the wallet does not use). */
export function parseLiveMessage(raw: string): LiveEvent | null {
  let msg: WsMessage;
  try {
    msg = JSON.parse(raw) as WsMessage;
  } catch {
    return null;
  }
  if (!msg.topic || !msg.data) return null;
  const name = msg.topic.split('/')[0];
  const d = msg.data;
  switch (name) {
    case 'confirmedAdded': return { kind: 'confirmed', hash: d.meta?.hash ?? '', txType: d.transaction?.type };
    case 'unconfirmedAdded': return { kind: 'unconfirmed', hash: d.meta?.hash ?? '', txType: d.transaction?.type };
    case 'partialAdded': return { kind: 'partial', hash: d.meta?.hash ?? '', txType: d.transaction?.type };
    case 'unconfirmedRemoved':
    case 'partialRemoved': return { kind: 'removed', hash: d.meta?.hash ?? '' };
    case 'cosignature': return { kind: 'cosignature', hash: d.parentHash ?? '' };
    case 'status': return { kind: 'status', hash: d.hash ?? '', code: d.code };
    default: return null;
  }
}

/**
 * Connects and keeps the connection alive (reconnecting with a growing delay, on another node after
 * a failure). Returns a function that stops everything.
 */
export function startLiveListener(address: string, onEvent: (event: LiveEvent) => void): () => void {
  const addr = normalizeAddress(address);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** retry, 30_000);
    retry += 1;
    timer = setTimeout(() => { void connect(); }, delay);
  };

  const connect = async () => {
    if (stopped) return;
    let url: string;
    try {
      url = wsUrlFor(await resolveNode(retry > 0));
    } catch {
      schedule();
      return;
    }
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    socket = ws;
    let subscribed = false;
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!subscribed) {
        // The first message carries this connection's uid; subscribe with it.
        try {
          const { uid } = JSON.parse(text) as { uid?: string };
          if (uid) {
            subscribed = true;
            retry = 0;
            for (const channel of CHANNELS) ws.send(JSON.stringify({ uid, subscribe: `${channel}/${addr}` }));
          }
        } catch { /* not the handshake */ }
        return;
      }
      const event = parseLiveMessage(text);
      if (event) onEvent(event);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      schedule();
    };
  };

  void connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    const ws = socket;
    socket = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* ignore */ } }
  };
}
