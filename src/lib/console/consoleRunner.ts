// コンソールのコードを動かす「実行役」。画面（ConsolePage）はこれだけを使う。
//
//   - createWorkerRunner: コードを Worker の中で動かす（consoleWorker.ts）。「停止」で止まらない処理（正規表現の総当たりなど）は、
//     少し待って Worker ごと止める。DOM にも、メインスレッドのメモリにも、コードは届かない。
//   - createLocalRunner: 従来どおりメインスレッドで動かす。Worker を開始できない環境（古いブラウザ・制限のかかった環境）用の逃げ道と、テスト用。
//   - createConsoleRunner: Worker を試し、開始できなければ local に切り替える（切り替えたことは onNotice で知らせる）。
import { createConsoleEnv } from './env';
import type { ConsoleChain, LogKind, SignHandler } from './env';
import { formatValue } from './format';
import { StopSignal } from './interpreter';
import type { ConsoleLang } from './tsStrip';
import type { NetworkProtections } from '../../store/consoleSettingsStore';
import type { MijinParams } from '../symbol/network';
import type { FromWorker, SettingsSnapshot, ToWorker, WireError } from './workerProtocol';

export interface RunOutput { hasValue: boolean; undef: boolean; text: string }

export interface ConsoleRunner {
  run(source: string, lang?: ConsoleLang): Promise<RunOutput>;
  /** 直近の実行で、最後に動いていた行（エラーの行の表示に使う）。 */
  readonly line: number;
  /** 実行を止める。変数は残るが、止まらないときは Worker ごと止めるので、そのときは変数も消える。 */
  stop(): void;
  /** タイマー・WebSocket・Worker を片づける。 */
  dispose(): void;
  /** Worker の中で動いているか。 */
  readonly isolated: boolean;
}

export interface RunnerOptions {
  chain: ConsoleChain;
  networkByte: number;
  nodeUrl: string;
  signer: { publicKey: string } | null;
  mijin?: MijinParams | null;
  onLog: (kind: LogKind, text: string) => void;
  onClear: () => void;
  onSign: SignHandler;
  limitNetwork?: () => boolean;
  protections?: () => NetworkProtections;
  /** run の外（タイマーやイベントのコールバック）で起きたエラー。 */
  onUncaught?: (e: unknown) => void;
  /** 止まらない処理を Worker ごと止めて、変数が消えたとき。 */
  onRestart?: () => void;
  /** Worker を開始できず、メインスレッドの実行に切り替えたとき。 */
  onNotice?: (message: string) => void;
}

/** Worker を作る関数（本物は consoleWorkerFactory.ts。テストでは偽物を渡す）。 */
export type WorkerFactory = () => Worker;

/** 「停止」を押してから、Worker ごと止めるまで待つ時間（ミリ秒）。ふつうのコードは、この間に止まる。 */
export const STOP_GRACE_MS = 1500;
/** Worker が起動の合図（ready）を返すまで待つ時間。 */
export const READY_TIMEOUT_MS = 15000;
/** 実行中、通信の設定が変わっていないか見る間隔。 */
const SETTINGS_POLL_MS = 250;

/** Worker を開始できなかった（その実行は、まだ何も動いていない）。 */
export class WorkerStartError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerStartError'; }
}

const ERROR_CTORS: Record<string, ErrorConstructor> = {
  TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError,
};

/** Worker から届いたエラーを、画面側の describeConsoleError が読める形（Error / StopSignal / 文字列）に戻す。 */
export function fromWireError(w: WireError): unknown {
  if (w.kind === 'stop') return new StopSignal();
  if (w.kind === 'value') return w.text;
  const Ctor = ERROR_CTORS[w.name] ?? Error;
  const err = new Ctor(w.message);
  err.name = w.name;
  if (w.loc) (err as { loc?: unknown }).loc = w.loc;
  return err;
}

const snapshot = (opts: RunnerOptions): SettingsSnapshot => {
  const p = opts.protections?.();
  return {
    limitNetwork: opts.limitNetwork ? opts.limitNetwork() : true,
    protections: { blockUrlCredentials: p?.blockUrlCredentials ?? true, omitCookies: p?.omitCookies ?? true, hideReferrer: p?.hideReferrer ?? true },
  };
};

// --- Worker で動かす ----------------------------------------------------------------------------

export function createWorkerRunner(opts: RunnerOptions, spawn: WorkerFactory): ConsoleRunner {
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let everReady = false;
  let disposed = false;
  let restartNeeded = false; // 一度 Worker ごと止めた。次の実行で作り直し、変数が消えたことを知らせる
  let line = 0;
  let seq = 0;
  let lastSettings = '';
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, { resolve: (o: RunOutput) => void; reject: (e: unknown) => void }>();

  const send = (m: ToWorker): void => { worker?.postMessage(m); };

  const clearTimers = (): void => {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
  };

  const failAll = (e: unknown): void => {
    const all = [...pending.values()];
    pending.clear();
    clearTimers();
    for (const p of all) p.reject(e);
  };

  const kill = (): void => {
    const w = worker;
    worker = null;
    ready = null;
    everReady = false;
    if (w) { w.onmessage = null; w.onerror = null; w.onmessageerror = null; w.terminate(); }
  };

  const syncSettings = (): void => {
    const s = snapshot(opts);
    const key = JSON.stringify(s);
    if (key === lastSettings) return;
    lastSettings = key;
    send({ type: 'settings', settings: s });
  };

  const onMessage = (ev: MessageEvent<FromWorker>): void => {
    const m = ev.data;
    switch (m.type) {
      case 'ready': break; // start() が別に待っている
      case 'log': opts.onLog(m.kind, m.text); break;
      case 'clear': opts.onClear(); break;
      case 'sign': {
        const { id, req } = m;
        opts.onSign(req).then(
          (sig) => send({ type: 'signResult', id, sig }),
          (e: unknown) => send({ type: 'signResult', id, sig: null, error: e instanceof Error ? e.message : String(e) }),
        );
        break;
      }
      case 'done': {
        const p = pending.get(m.id);
        if (!p) break;
        pending.delete(m.id);
        line = m.line;
        if (pending.size === 0) clearTimers();
        p.resolve({ hasValue: m.hasValue, undef: m.undef, text: m.text });
        break;
      }
      case 'fail': {
        const p = pending.get(m.id);
        if (!p) break;
        pending.delete(m.id);
        line = m.line;
        if (pending.size === 0) clearTimers();
        p.reject(fromWireError(m.error));
        break;
      }
      case 'uncaught': opts.onUncaught?.(fromWireError(m.error)); break;
    }
  };

  const start = (): Promise<void> => {
    if (ready !== null) return ready;
    let w: Worker;
    try {
      w = spawn();
    } catch (e) {
      return Promise.reject(new WorkerStartError(e instanceof Error ? e.message : String(e)));
    }
    worker = w;
    lastSettings = JSON.stringify(snapshot(opts));
    const p = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new WorkerStartError('timeout')); }, READY_TIMEOUT_MS);
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        if (ev.data.type === 'ready') { clearTimeout(timer); everReady = true; resolve(); return; }
        onMessage(ev);
      };
      w.onerror = (ev: ErrorEvent) => {
        clearTimeout(timer);
        const msg = ev.message || 'worker error';
        if (!everReady) { reject(new WorkerStartError(msg)); return; }
        // 動いている途中で Worker が落ちた（メモリ不足など）
        kill();
        failAll(new Error(`[console] the worker stopped unexpectedly: ${msg}`));
      };
      w.onmessageerror = () => { opts.onLog('warn', '[console] a message from the worker could not be read'); };
    });
    p.catch(() => { if (worker === w) kill(); });
    ready = p;
    const init: ToWorker = {
      type: 'init', chain: opts.chain, networkByte: opts.networkByte, nodeUrl: opts.nodeUrl,
      signer: opts.signer, mijin: opts.mijin ?? null, settings: snapshot(opts),
    };
    w.postMessage(init);
    return p;
  };

  return {
    get line() { return line; },
    get isolated() { return true; },
    async run(source, lang = 'js') {
      if (disposed) throw new Error('[console] the console was closed');
      const restarted = restartNeeded && worker === null;
      await start();
      if (restarted) { restartNeeded = false; opts.onRestart?.(); }
      const id = ++seq;
      return new Promise<RunOutput>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        syncSettings();
        if (pollTimer === null) pollTimer = setInterval(syncSettings, SETTINGS_POLL_MS);
        send({ type: 'run', id, source, lang });
      });
    },
    stop() {
      if (worker === null) return;
      send({ type: 'stop' }); // ふつうはこれで止まる（変数は残る）
      if (pending.size === 0) return;
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (pending.size === 0) return;
        // 止まらない処理（ネイティブの関数の中）。Worker ごと止める。
        kill();
        restartNeeded = true;
        failAll(new StopSignal());
      }, STOP_GRACE_MS);
    },
    dispose() {
      disposed = true;
      kill();
      failAll(new StopSignal());
    },
  };
}

// --- メインスレッドで動かす（従来どおり） -------------------------------------------------------------

export function createLocalRunner(opts: RunnerOptions): ConsoleRunner {
  const env = createConsoleEnv({
    chain: opts.chain, networkByte: opts.networkByte, nodeUrl: opts.nodeUrl, signer: opts.signer,
    onLog: opts.onLog, onClear: opts.onClear, onSign: opts.onSign,
    limitNetwork: opts.limitNetwork, protections: opts.protections,
  });
  return {
    get line() { return env.interpreter.line; },
    get isolated() { return false; },
    async run(source, lang = 'js') {
      const r = await env.interpreter.run(source, lang);
      return { hasValue: r.hasValue, undef: r.value === undefined, text: r.hasValue ? formatValue(r.value) : '' };
    },
    stop() { env.interpreter.stopRequested = true; env.dispose(); },
    dispose() { env.interpreter.stopRequested = true; env.dispose(); },
  };
}

// --- Worker を試して、だめなら local ---------------------------------------------------------------

export function createConsoleRunner(opts: RunnerOptions, spawn: WorkerFactory | null): ConsoleRunner {
  let current: ConsoleRunner = spawn === null ? createLocalRunner(opts) : createWorkerRunner(opts, spawn);
  return {
    get line() { return current.line; },
    get isolated() { return current.isolated; },
    async run(source, lang) {
      try {
        return await current.run(source, lang);
      } catch (e) {
        if (!(e instanceof WorkerStartError)) throw e;
        // Worker を開始できなかった。まだ何も動いていないので、メインスレッドで同じ実行をやり直す。
        current.dispose();
        current = createLocalRunner(opts);
        opts.onNotice?.(`[console] could not start the worker (${e.message}); running on the main thread instead`);
        return current.run(source, lang);
      }
    },
    stop() { current.stop(); },
    dispose() { current.dispose(); },
  };
}
