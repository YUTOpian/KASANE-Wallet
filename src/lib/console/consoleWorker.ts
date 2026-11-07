// コンソールのコードを動かす Worker。
//
// インタープリタ（interpreter.ts）と実行環境（env.ts、symbol-sdk を含む）はこの中で動く。メインスレッドには、
//   - 画面（ログ・署名の確認ダイアログ）は、メッセージで頼む
//   - 秘密鍵は、そもそも渡さない（署名のたびにメイン側の確認ダイアログとパスワードを通る。以前と同じ）
// 長い計算（正規表現の総当たりなど）で固まっても、メイン側が Worker ごと止められる（consoleRunner.ts の stop）。
import { createConsoleEnv, type ConsoleEnv, type SignRequest } from './env';
import { formatValue } from './format';
import { StopSignal, isInterpreterError } from './interpreter';
import { setMijinParams } from '../symbol/network';
import type { FromWorker, SettingsSnapshot, ToWorker, WireError } from './workerProtocol';

const post = (m: FromWorker, transfer: Transferable[] = []): void => { (self as unknown as Worker).postMessage(m, transfer); };

let env: ConsoleEnv | null = null;
let settings: SettingsSnapshot = {
  limitNetwork: true,
  protections: { blockUrlCredentials: true, omitCookies: true, hideReferrer: true },
};
let signSeq = 0;
const signWaiters = new Map<number, { resolve: (sig: Uint8Array | null) => void; reject: (e: Error) => void }>();

function toWire(e: unknown): WireError {
  if (e instanceof StopSignal) return { kind: 'stop' };
  if (e instanceof Error) {
    const loc = (e as { loc?: { line?: unknown; column?: unknown } }).loc;
    const wire: WireError = { kind: 'error', name: e.name, message: e.message };
    if (loc && typeof loc.line === 'number' && typeof loc.column === 'number') wire.loc = { line: loc.line, column: loc.column };
    return wire;
  }
  return { kind: 'value', text: formatValue(e) };
}

function init(m: Extract<ToWorker, { type: 'init' }>): void {
  settings = m.settings;
  setMijinParams(m.mijin); // mijin の設定はモジュールの中の値なので、Worker にも写す
  env?.dispose();
  env = createConsoleEnv({
    chain: m.chain,
    networkByte: m.networkByte,
    nodeUrl: m.nodeUrl,
    signer: m.signer,
    onLog: (kind, text) => post({ type: 'log', kind, text }),
    onClear: () => post({ type: 'clear' }),
    onSign: (req: SignRequest) => new Promise<Uint8Array | null>((resolve, reject) => {
      const id = ++signSeq;
      signWaiters.set(id, { resolve, reject });
      post({ type: 'sign', id, req });
    }),
    limitNetwork: () => settings.limitNetwork,
    protections: () => settings.protections,
  });
  post({ type: 'ready' });
}

async function run(m: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  if (env === null) { post({ type: 'fail', id: m.id, error: { kind: 'error', name: 'Error', message: '[console] not initialized' }, line: 0 }); return; }
  const interp = env.interpreter;
  try {
    const r = await interp.run(m.source, m.lang);
    post({ type: 'done', id: m.id, hasValue: r.hasValue, undef: r.value === undefined, text: r.hasValue ? formatValue(r.value) : '', line: interp.line });
  } catch (e) {
    post({ type: 'fail', id: m.id, error: toWire(e), line: interp.line });
  }
}

self.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': init(m); break;
    case 'settings': settings = m.settings; break;
    case 'run': void run(m); break;
    case 'stop':
      if (env) { env.interpreter.stopRequested = true; env.dispose(); }
      for (const w of signWaiters.values()) w.reject(new Error('キャンセルされました (cancelled)'));
      signWaiters.clear();
      break;
    case 'signResult': {
      const w = signWaiters.get(m.id);
      if (!w) break;
      signWaiters.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(m.error));
      else w.resolve(m.sig);
      break;
    }
  }
});

// コンソールのコードのコールバック（タイマー・イベント）から漏れたエラーも、画面に出す
self.addEventListener('error', (ev: ErrorEvent) => {
  if (isInterpreterError(ev.error)) { post({ type: 'uncaught', error: toWire(ev.error) }); ev.preventDefault(); }
});
self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  if (isInterpreterError(ev.reason)) { post({ type: 'uncaught', error: toWire(ev.reason) }); ev.preventDefault(); }
});
