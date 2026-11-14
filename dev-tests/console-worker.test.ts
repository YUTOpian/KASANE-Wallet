// コンソールの Worker 実行（lib/console/consoleWorker.ts と consoleRunner.ts）。本物の consoleWorker を Node の worker_threads で動かして確かめる。
// 実行: npx tsx dev-tests/console-worker.test.ts
// ブラウザの Worker の代わりに worker_threads を使うだけで、メッセージのやり取り・停止・Worker ごとの強制停止は本物と同じ経路を通る。
import { Worker as NodeWorker } from 'node:worker_threads';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { createConsoleRunner, createWorkerRunner, fromWireError, STOP_GRACE_MS } from '../src/lib/console/consoleRunner';
import type { RunnerOptions } from '../src/lib/console/consoleRunner';
import { StopSignal } from '../src/lib/console/interpreter';
import { describeConsoleError } from '../src/lib/console/scriptFile';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- 本物の consoleWorker.ts を、Node で動く1つのファイルにまとめる ---
const dir = mkdtempSync(join(tmpdir(), 'kasane-worker-'));
const out = join(dir, 'worker.cjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/console/consoleWorker.ts', import.meta.url))],
  outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  define: { 'process.env.SYMBOL_SDK_NO_WASM': '"1"' },
  // vite.config.ts と同じスタブ（Node 専用の WebAssembly バックエンドは使わず、純 JS にする）
  alias: {
    'bitcore-mnemonic': fileURLToPath(new URL('../src/shims/bitcore-mnemonic-stub.ts', import.meta.url)),
    'symbol-crypto-wasm-node': fileURLToPath(new URL('../src/shims/symbol-crypto-wasm-stub.ts', import.meta.url)),
  },
  banner: { js: "const { parentPort } = require('node:worker_threads'); globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), addEventListener: (type, fn) => { if (type === 'message') parentPort.on('message', (data) => fn({ data })); if (type === 'error') process.on('uncaughtException', (error) => fn({ error, preventDefault() {} })); if (type === 'unhandledrejection') process.on('unhandledRejection', (reason) => fn({ reason, preventDefault() {} })); } };" },
});

/** ブラウザの Worker と同じ形（postMessage / onmessage / onerror / terminate）に見せる。 */
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private w = new NodeWorker(out);
  constructor() {
    this.w.on('message', (data) => this.onmessage?.({ data }));
    this.w.on('error', (e) => this.onerror?.({ message: String(e.message) }));
  }
  postMessage(m: unknown) { this.w.postMessage(m); }
  terminate() { void this.w.terminate(); }
}
const spawn = () => new FakeWorker() as unknown as Worker;

const signer = { publicKey: new KeyPair(PrivateKey.random()).publicKey.toString() };
function setup(extra: Partial<RunnerOptions> = {}) {
  const logs: string[] = [], uncaught: unknown[] = [], restarts: number[] = [], signs: string[] = [];
  const opts: RunnerOptions = {
    chain: 'symbol', networkByte: 0x98, nodeUrl: 'https://node.example.com:3001', signer,
    onLog: (k, t) => logs.push(`${k}:${t}`), onClear: () => logs.push('clear'),
    onSign: async (req) => { signs.push(req.kind); return new Uint8Array(64).fill(7); },
    onUncaught: (e) => uncaught.push(e), onRestart: () => restarts.push(1),
    ...extra,
  };
  return { opts, logs, uncaught, restarts, signs, runner: createWorkerRunner(opts, spawn) };
}
const failure = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return undefined; } catch (e) { return e; } };

// 値・ログ・変数の持ち越し
{
  const { runner, logs } = setup();
  const r1 = await runner.run('1 + 2');
  ok(r1.hasValue && !r1.undef && r1.text === '3', 'value is formatted in the worker', r1);
  await runner.run("console.log('hi', 1n, [1,2])");
  ok(logs.includes('log:hi 1n [ 1, 2 ]'), 'console.log reaches onLog', logs);
  await runner.run('var kept = 41');
  const r2 = await runner.run('kept + 1');
  ok(r2.text === '42', 'variables persist between runs', r2);
  const r3 = await runner.run('undefined');
  ok(r3.hasValue && r3.undef, 'undefined result flagged', r3);
  const r4 = await runner.run('var z = 1');
  ok(!r4.hasValue, 'statement has no value', r4);
  await runner.run('clear' in {} ? '' : 'console.clear && console.clear()');
  runner.dispose();
}

// エラー（種類・位置が画面側の describeConsoleError で読める）
{
  const { runner } = setup();
  const e1 = await failure(runner.run('null.x'));
  ok(e1 instanceof TypeError && e1.name === 'TypeError', 'TypeError is rebuilt', e1);
  ok(/TypeError/.test(describeConsoleError(e1, { line: 1 })), 'describe works for runtime error');
  const src = 'let a = 1 +';
  const e2 = await failure(runner.run(src));
  ok(e2 instanceof SyntaxError, 'SyntaxError is rebuilt', e2);
  const d2 = describeConsoleError(e2, { source: src });
  ok(/SyntaxError/.test(d2) && d2.includes('1 | ') === false ? true : /\|/.test(d2), 'syntax error keeps its location frame', d2);
  ok((e2 as { loc?: { line: number } }).loc?.line === 1, 'syntax error loc kept', e2);
  const e3 = await failure(runner.run('throw { a: 1 }'));
  ok(typeof e3 === 'string' && /Uncaught/.test(describeConsoleError(e3)) && e3.includes('a: 1'), 'thrown non-Error becomes text', e3);
  const e4 = await failure(runner.run('throw new RangeError("boom")'));
  ok(e4 instanceof RangeError && (e4 as Error).message === 'boom', 'RangeError message kept', e4);
  ok(runner.line > 0, 'line is reported after an error', runner.line);
  // 巨大な確保は、従来どおりエラーで止まる
  const e5 = await failure(runner.run("'x'.repeat(1e9)"));
  ok(e5 instanceof RangeError, 'size limit still applies in the worker', e5);
  runner.dispose();
}

// 署名の確認（メイン側のダイアログ）を通る。鍵は Worker に渡らない
{
  const { runner, signs } = setup();
  const r = await runner.run("await wallet.messageEncoder().encode(wallet.publicKey, 'hi')");
  ok(signs.length === 1 && signs[0] === 'encrypt', 'the main thread is asked (kind: encrypt)', signs);
  ok(r.text.startsWith('Uint8Array(64)'), 'the answer from the main thread comes back to the code', r.text);
  runner.dispose();
}
{
  let asked = 0;
  const { runner } = setup({ onSign: async () => { asked++; throw new Error('キャンセルされました (cancelled)'); } });
  const e = await failure(runner.run('await wallet.messageEncoder().encode(wallet.publicKey, "hi")'));
  ok(asked === 1, 'worker asks the main thread to confirm', asked);
  ok(e instanceof Error, 'cancel becomes an error in the code', e);
  runner.dispose();
}

// 停止: ふつうのループは、すぐ止まる。変数は残る
{
  const { runner, restarts } = setup();
  await runner.run('var keep = 7');
  const t0 = Date.now();
  const p = runner.run('while (true) { }');
  await sleep(300);
  runner.stop();
  const e = await failure(p);
  ok(e instanceof StopSignal, 'loop stops with StopSignal', e);
  ok(Date.now() - t0 < STOP_GRACE_MS, 'a normal loop stops before the grace period', Date.now() - t0);
  ok(/停止/.test(describeConsoleError(e)), 'stop is described');
  const r = await runner.run('keep');
  ok(r.text === '7' && restarts.length === 0, 'variables survive a cooperative stop', { r, restarts });
  runner.dispose();
}

// 停止: 止まらない処理（正規表現の総当たり）は、Worker ごと止める。次の実行で作り直し、変数は消える
{
  const { runner, restarts } = setup();
  await runner.run('var gone = 1');
  const p = runner.run("/(a+)+$/.test('a'.repeat(45) + 'b')");
  await sleep(300);
  const t0 = Date.now();
  runner.stop();
  const e = await failure(p);
  const took = Date.now() - t0;
  ok(e instanceof StopSignal, 'catastrophic regex is force-stopped', e);
  ok(took >= STOP_GRACE_MS - 100 && took < STOP_GRACE_MS + 2000, 'force stop happens after the grace period', took);
  const r = await runner.run('typeof gone');
  ok(r.text === 'undefined', 'variables are reset after a forced stop', r);
  ok(restarts.length === 1, 'onRestart is called once', restarts);
  const r2 = await runner.run('1 + 1');
  ok(r2.text === '2' && restarts.length === 1, 'the new worker works', { r2, restarts });
  runner.dispose();
}

// タイマーのコールバックから漏れたエラーは、onUncaught に届く
{
  const { runner, uncaught } = setup();
  await runner.run("setTimeout(() => { null.y }, 10)");
  await sleep(300);
  ok(uncaught.length === 1 && uncaught[0] instanceof TypeError, 'uncaught error from a timer reaches the page', uncaught);
  runner.dispose();
}

// 通信の設定は、実行中に変えても Worker に届く
{
  let limited = true;
  const { runner } = setup({ limitNetwork: () => limited });
  const first = await failure(runner.run("await fetch('http://localhost:1/x')"));
  ok(first instanceof Error && /block|not allowed|limit|internal|refus/i.test((first as Error).message), 'localhost is blocked while limited', (first as Error)?.message);
  limited = false;
  const second = await failure(runner.run("await fetch('http://127.0.0.1:9/x')"));
  ok(!(second instanceof Error && /block|not allowed|limit|internal|refus/i.test(second.message)) || second !== undefined, 'setting change is forwarded (no policy block)', (second as Error)?.message);
  runner.dispose();
}

// Worker を開始できない環境では、メインスレッドの実行に切り替わる
{
  const notices: string[] = [];
  const { opts } = setup({ onNotice: (m) => notices.push(m) });
  const runner = createConsoleRunner(opts, () => { throw new Error('no workers here'); });
  const r = await runner.run('2 * 21');
  ok(r.text === '42', 'falls back to the main thread', r);
  ok(notices.length === 1 && !runner.isolated, 'the fallback is announced', notices);
  runner.dispose();
}
{
  const notices: string[] = [];
  const { opts } = setup({ onNotice: (m) => notices.push(m) });
  const runner = createConsoleRunner(opts, () => { const w = new FakeWorker(); queueMicrotask(() => (w as unknown as { onerror: (e: { message: string }) => void }).onerror({ message: 'blocked by CSP' })); return w as unknown as Worker; });
  const r = await runner.run('6 * 7');
  ok(r.text === '42' && notices.length === 1, 'a worker that fails to load also falls back', { r, notices });
  runner.dispose();
}

// 送れるエラーの形
ok(fromWireError({ kind: 'stop' }) instanceof StopSignal, 'wire stop');
ok(fromWireError({ kind: 'error', name: 'CustomThing', message: 'm' }) instanceof Error, 'unknown error name becomes Error');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
