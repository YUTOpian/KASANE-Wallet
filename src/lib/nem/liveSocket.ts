// NIS1's WebSocket API for one account: STOMP over a plain WebSocket at <node>:7779/w/messages/websocket (wss; 7778 is
// the same over ws). The official wallet does the same through SockJS (`/w/messages`). Steps, as in nem-sdk / nem-library:
//   CONNECT -> SEND /w/api/account/subscribe {account} -> SUBSCRIBE /unconfirmed/<address> and /transactions/<address>.
// Not every public node offers wss, so this tries a few nodes, keeps retrying with a growing delay, and the caller keeps
// looking at the node regularly as well (lib/nem/live.ts). Nothing here touches the browser except the WebSocket
// it is given, so it can be tested in Node.
import { decodeFrames, encodeFrame, parseHeartBeat } from './stomp';

export const NEM_WSS_PORT = 7779;
export const NEM_WS_PORT = 7778;
const SOCKET_PATH = '/w/messages/websocket';

/** REST node URL -> its WebSocket URL (https -> wss on 7779; http -> ws on 7778), or null for something else. */
export function nemSocketUrlFor(restNode: string): string | null {
  try {
    const u = new URL(restNode.trim());
    if (u.protocol === 'https:') return `wss://${u.hostname}:${NEM_WSS_PORT}${SOCKET_PATH}`;
    if (u.protocol === 'http:') return `ws://${u.hostname}:${NEM_WS_PORT}${SOCKET_PATH}`;
    return null;
  } catch {
    return null;
  }
}

/** The part of a WebSocket this uses. */
export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface NemSocketOptions {
  /** Plain account address (no dashes). */
  address: string;
  /** Where to try, in order. Asked again before every round, so it can follow node changes. */
  urls: () => Promise<string[]>;
  /** A transaction the node has just received (a TransactionMetaDataPair). */
  onUnconfirmed: (entry: unknown) => void;
  /** A transaction that has just been put in a block. */
  onConfirmed: (entry: unknown) => void;
  /** Up (subscribed) or down. */
  onStatus?: (status: { connected: boolean; url: string }) => void;
  log?: (message: string) => void;
  createSocket?: (url: string) => SocketLike;
  /** Time allowed from opening the socket to being subscribed. Default 8000. */
  connectTimeoutMs?: number;
  /** Pauses after a round in which nothing connected (the last one repeats). */
  retryDelaysMs?: number[];
  /** Pause before trying again after a connection that worked and then dropped. Default 1500. */
  reconnectDelayMs?: number;
  /** STOMP heart-beat we offer: how often we send, how often we want to hear. Default 20000 / 10000. */
  heartbeat?: { outgoing: number; incoming: number };
}

const DEFAULT_RETRY_MS = [3000, 8000, 20_000, 60_000, 120_000];

const asText = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return '';
};

/** Connects and keeps connected. Returns a function that stops everything. */
export function startNemSocket(options: NemSocketOptions): () => void {
  const log = options.log ?? (() => undefined);
  const create = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const connectTimeout = options.connectTimeoutMs ?? 8000;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_MS;
  const reconnectDelay = options.reconnectDelayMs ?? 1500;
  const offer = options.heartbeat ?? { outgoing: 20_000, incoming: 10_000 };
  const address = options.address.replace(/-/g, '').toUpperCase();

  let stopped = false;
  let stopSession: (() => void) | null = null;
  let wake: (() => void) | null = null;

  // One connection. Resolves with true if it got as far as being subscribed, when it ends for any reason.
  const runSession = (url: string): Promise<boolean> => new Promise((resolve) => {
    let connected = false;
    let finished = false;
    let sock: SocketLike | null = null;
    let lastData = Date.now();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let watchTimer: ReturnType<typeof setInterval> | undefined;

    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      clearInterval(pingTimer);
      clearInterval(watchTimer);
      stopSession = null;
      if (sock) {
        sock.onopen = null; sock.onmessage = null; sock.onerror = null; sock.onclose = null;
        try { sock.close(); } catch { /* already closed */ }
      }
      log(connected ? `WebSocket closed: ${url} (${why})` : `WebSocket not available: ${url} (${why})`);
      if (connected) options.onStatus?.({ connected: false, url });
      resolve(connected);
    };
    stopSession = () => finish('stopped');

    try {
      sock = create(url);
    } catch (e) {
      finish(e instanceof Error ? e.message : 'error');
      return;
    }
    const socket = sock;
    connectTimer = setTimeout(() => finish('timeout'), connectTimeout);

    const onFrameMessage = (frame: { destination?: string; body: string }) => {
      let entry: unknown;
      try { entry = JSON.parse(frame.body); } catch { return; }
      const destination = frame.destination ?? '';
      if (destination.startsWith('/unconfirmed/')) options.onUnconfirmed(entry);
      else if (destination.startsWith('/transactions/')) options.onConfirmed(entry);
    };

    socket.onopen = () => {
      socket.send(encodeFrame('CONNECT', { 'accept-version': '1.1,1.0', 'heart-beat': `${offer.outgoing},${offer.incoming}` }));
    };
    socket.onmessage = (event) => {
      lastData = Date.now();
      for (const frame of decodeFrames(asText(event.data))) {
        if (frame.command === 'CONNECTED' && !connected) {
          // The same order as the official wallet: say which account, then listen to its channels.
          socket.send(encodeFrame('SEND', { destination: '/w/api/account/subscribe' }, `{'account':'${address}'}`));
          socket.send(encodeFrame('SUBSCRIBE', { id: 'sub-0', destination: `/unconfirmed/${address}` }));
          socket.send(encodeFrame('SUBSCRIBE', { id: 'sub-1', destination: `/transactions/${address}` }));
          connected = true;
          clearTimeout(connectTimer);
          // Heart-beats: send a line feed as often as the server asks, and give up on a connection that goes quiet.
          const server = parseHeartBeat(frame.headers['heart-beat']);
          const send = offer.outgoing > 0 && server.y > 0 ? Math.max(offer.outgoing, server.y) : 0;
          const hear = offer.incoming > 0 && server.x > 0 ? Math.max(offer.incoming, server.x) : 0;
          if (send > 0) pingTimer = setInterval(() => { try { socket.send('\n'); } catch { finish('send failed'); } }, send);
          if (hear > 0) watchTimer = setInterval(() => { if (Date.now() - lastData > hear * 3) finish('silent'); }, hear);
          log(`WebSocket connected: ${url}`);
          options.onStatus?.({ connected: true, url });
        } else if (frame.command === 'MESSAGE') {
          onFrameMessage({ destination: frame.headers.destination, body: frame.body });
        } else if (frame.command === 'ERROR') {
          finish(`server error: ${frame.headers.message ?? frame.body.slice(0, 80)}`);
        }
      }
    };
    socket.onerror = () => finish('error');
    socket.onclose = () => finish('closed');
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  void (async () => {
    let failedRounds = 0;
    while (!stopped) {
      let urls: string[] = [];
      try { urls = await options.urls(); } catch { urls = []; }
      let wasUp = false;
      for (const url of urls) {
        if (stopped) return;
        if (await runSession(url)) { wasUp = true; break; }
      }
      if (stopped) return;
      failedRounds = wasUp ? 0 : failedRounds + 1;
      await sleep(wasUp ? reconnectDelay : retryDelays[Math.min(failedRounds - 1, retryDelays.length - 1)]);
    }
  })();

  return () => {
    stopped = true;
    stopSession?.();
    wake?.();
  };
}
