// コンソールの NEM サンプルのうち、監視（リスナーの準備・トランザクションの監視・ブロックの監視）を、偽の WebSocket で動かして確かめる。
// SDK は使わない（サンプルのコードは、WebSocket・console・タイマーだけを使う）。通信なし。
// 実行: npx tsx dev-tests/console-nem-samples-listener.test.ts
import vm from 'node:vm';
import { NEM_SAMPLES_7_TO_13 } from '../src/lib/console/samplesNem7to13';
import { decodeFrames, encodeFrame } from '../src/lib/nem/stomp';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const ADDRESS = 'TALICE2GMA34CXHD7XLJQ536NM5UNKQHTORNNT2J';

// --- 偽の WebSocket（送ったものを覚える） ---
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: { data?: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.({ type: 'close' }); }
}

const logs: string[] = [];
const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
const context = vm.createContext({
  NODE: 'https://nis.example:7891',
  alice: { address: { toString: () => ADDRESS } },
  WebSocket: FakeWebSocket,
  URL, TextEncoder, JSON, Object, Array, String, Math,
  setInterval: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearInterval: (id: number) => { timers.delete(id); },
  console: {
    log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    error: (...a: unknown[]) => logs.push(`error: ${a.join(' ')}`),
  },
});
async function run(id: string): Promise<void> {
  const code = NEM_SAMPLES_7_TO_13.find((s) => s.id === id)!.code;
  logs.length = 0;
  await vm.runInContext(`(async function () {\n${code}\n})()`, context) as unknown;
}
const sock = () => FakeWebSocket.last!;
const lastSent = () => sock().sent[sock().sent.length - 1];

// --- リスナーの準備 ---
await run('listener');
ok(sock().url === 'wss://nis.example:7779/w/messages/websocket', 'https node -> wss 7779 /w/messages/websocket', sock().url);
ok(logs[0] === 'wss://nis.example:7779/w/messages/websocket', 'prints the endpoint', logs.join('|'));
sock().onopen?.({});
ok(sock().sent.length === 1 && sock().sent[0] === encodeFrame('CONNECT', { 'accept-version': '1.1,1.0', 'heart-beat': '20000,0' }), 'CONNECT frame is the same as lib/nem/stomp encodeFrame', JSON.stringify(sock().sent[0]));
// ハートビートだけのメッセージ（改行）は、フレームにならない
sock().onmessage?.({ data: '\n' });
ok(logs.length === 1, 'a lone line feed is a heartbeat, not a frame');
// CONNECTED
sock().onmessage?.({ data: 'CONNECTED\nversion:1.1\nheart-beat:0,0\n\n\u0000' });
ok(logs.includes('connected.'), 'CONNECTED is announced', logs.join('|'));
ok(timers.size === 1 && [...timers.values()][0].ms === 20000, 'a 20 second heartbeat timer starts');
[...timers.values()][0].fn();
ok(lastSent() === '\n', 'the timer sends a line feed');

// --- トランザクションの監視 ---
await run('listen_tx');
const frames = sock().sent.slice(1).filter((s) => s !== '\n').flatMap((s) => decodeFrames(s));
ok(frames.length === 3, 'listen_tx sends SEND + 2 SUBSCRIBE', frames.length);
ok(frames[0].command === 'SEND' && frames[0].headers.destination === '/w/api/account/subscribe' && frames[0].body === `{'account':'${ADDRESS}'}`, 'account subscribe frame', JSON.stringify(frames[0]));
ok(sock().sent.includes(encodeFrame('SEND', { destination: '/w/api/account/subscribe' }, `{'account':'${ADDRESS}'}`)), 'SEND frame text is the same as encodeFrame (with content-length)');
ok(frames[1].command === 'SUBSCRIBE' && frames[1].headers.destination === `/unconfirmed/${ADDRESS}` && frames[1].headers.id === 'sub-1', 'subscribes /unconfirmed/<address>', JSON.stringify(frames[1]));
ok(frames[2].command === 'SUBSCRIBE' && frames[2].headers.destination === `/transactions/${ADDRESS}` && frames[2].headers.id === 'sub-2', 'subscribes /transactions/<address>', JSON.stringify(frames[2]));
logs.length = 0;
sock().onmessage?.({ data: encodeFrame('MESSAGE', { destination: `/unconfirmed/${ADDRESS}`, subscription: 'sub-1', 'message-id': '1' }, '{"meta":{"hash":{"data":"AB"}}}') });
ok(logs.length === 1 && logs[0] === 'unconfirmed added {"meta":{"hash":{"data":"AB"}}}', 'an unconfirmed transaction is shown', logs.join('|'));
logs.length = 0;
sock().onmessage?.({ data: encodeFrame('MESSAGE', { destination: `/transactions/${ADDRESS}`, subscription: 'sub-2', 'message-id': '2' }, '{"meta":{"height":5}}') });
ok(logs.length === 1 && logs[0] === 'confirmed added {"meta":{"height":5}}', 'a confirmed transaction is shown', logs.join('|'));
// 2つのフレームが1回で届いても、両方を処理する。知らない宛先は無視する
logs.length = 0;
sock().onmessage?.({ data: encodeFrame('MESSAGE', { destination: '/other' }, '{}') + encodeFrame('MESSAGE', { destination: `/unconfirmed/${ADDRESS}` }, '{"a":1}') });
ok(logs.length === 1 && logs[0] === 'unconfirmed added {"a":1}', 'two frames in one message: unknown destination is ignored', logs.join('|'));

// --- ブロックの監視 ---
await run('listen_block');
const blockSub = decodeFrames(lastSent())[0];
ok(blockSub.command === 'SUBSCRIBE' && blockSub.headers.destination === '/blocks/new' && blockSub.headers.id === 'sub-3', 'subscribes /blocks/new', JSON.stringify(blockSub));
logs.length = 0;
sock().onmessage?.({ data: encodeFrame('MESSAGE', { destination: '/blocks/new' }, '{"height":123}') });
ok(logs.length === 1 && logs[0] === 'block {"height":123}', 'a new block is shown', logs.join('|'));

// --- エラーフレーム・クローズ ---
logs.length = 0;
sock().onmessage?.({ data: 'ERROR\nmessage:bad\n\n\u0000' });
ok(logs[0] === 'error: bad', 'an ERROR frame is shown as an error', logs.join('|'));
sock().close();
ok(timers.size === 0, 'closing stops the heartbeat timer');
sock().onmessage?.({ data: encodeFrame('MESSAGE', { destination: '/blocks/new' }, '{"height":124}') });
ok(!logs.some((l) => l.includes('124')), 'after close, the callbacks are cleared');

// http のノードは ws の 7778
const httpCtx = vm.createContext({ ...context, NODE: 'http://nis.example:7890' });
await vm.runInContext(`(async function () {\n${NEM_SAMPLES_7_TO_13.find((s) => s.id === 'listener')!.code}\n})()`, httpCtx);
ok(FakeWebSocket.last!.url === 'ws://nis.example:7778/w/messages/websocket', 'http node -> ws 7778', FakeWebSocket.last!.url);

console.log(fails === 0 ? `all ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
if (fails > 0) process.exit(1);
