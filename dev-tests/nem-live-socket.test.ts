// Run: node --experimental-strip-types dev-tests/nem-live-socket.test.ts   (or: npx tsx dev-tests/nem-live-socket.test.ts)
// Checks the NEM live news: the STOMP frame codec, the reporter that decides which events are told (and keeps the two
// sounds apart), and the WebSocket client against a small STOMP-over-WebSocket server made here (the way NIS1 answers:
// CONNECT -> CONNECTED, SEND /w/api/account/subscribe, SUBSCRIBE /unconfirmed/<addr> and /transactions/<addr>, MESSAGE).
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLiveReporter, liveIds } from '../src/lib/nem/liveReporter';
import { nemSocketUrlFor, startNemSocket } from '../src/lib/nem/liveSocket';
import { decodeFrames, encodeFrame, parseHeartBeat } from '../src/lib/nem/stomp';
import type { StompFrame } from '../src/lib/nem/stomp';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}

// ---- STOMP codec
{
  const connect = encodeFrame('CONNECT', { 'accept-version': '1.1,1.0', 'heart-beat': '20000,10000' });
  check('CONNECT frame', connect === 'CONNECT\naccept-version:1.1,1.0\nheart-beat:20000,10000\n\n\u0000', JSON.stringify(connect));
  const send = encodeFrame('SEND', { destination: '/w/api/account/subscribe' }, "{'account':'TABC'}");
  check('SEND frame has content-length', send.includes('content-length:18\n') && send.endsWith("\n\n{'account':'TABC'}\u0000"));
  check('content-length counts bytes, not characters', encodeFrame('SEND', {}, 'あ').includes('content-length:3\n'));

  const msg = 'MESSAGE\ndestination:/unconfirmed/TABC\nsubscription:sub-0\nmessage-id:7\ncontent-length:14\n\n{"meta":{"a":1}}\u0000';
  const [m] = decodeFrames(msg);
  check('MESSAGE decoded', m?.command === 'MESSAGE' && m.headers.destination === '/unconfirmed/TABC' && m.body === '{"meta":{"a":1}}', JSON.stringify(m));
  check('heart-beat alone gives no frame', decodeFrames('\n').length === 0 && decodeFrames('\r\n').length === 0 && decodeFrames('').length === 0);
  const two = decodeFrames(`${msg}\nCONNECTED\nversion:1.1\nheart-beat:0,0\n\n\u0000`);
  check('two frames in one message', two.length === 2 && two[1].command === 'CONNECTED' && two[1].headers['heart-beat'] === '0,0');
  check('first header wins', decodeFrames('MESSAGE\na:1\na:2\n\nx\u0000')[0].headers.a === '1');
  check('header escapes undone (MESSAGE)', decodeFrames('MESSAGE\nk:a\\cb\\nc\n\n\u0000')[0].headers.k === 'a:b\nc');
  check('CRLF frames', decodeFrames('MESSAGE\r\ndestination:/x\r\n\r\nbody\u0000')[0].body === 'body');
  const hb = parseHeartBeat('10000,20000');
  check('parseHeartBeat', hb.x === 10000 && hb.y === 20000 && parseHeartBeat(undefined).x === 0 && parseHeartBeat('0,0').y === 0 && parseHeartBeat('x,y').x === 0);
}

// ---- WebSocket URL of a node
check('https node -> wss 7779', nemSocketUrlFor('https://nem01.example.com:7891') === 'wss://nem01.example.com:7779/w/messages/websocket');
check('http node -> ws 7778', nemSocketUrlFor('http://127.0.0.1:7890') === 'ws://127.0.0.1:7778/w/messages/websocket');
check('not a URL -> null', nemSocketUrlFor('nonsense') === null && nemSocketUrlFor('ftp://x') === null);

// ---- the reporter
{
  const got: string[] = [];
  const times: number[] = [];
  const t0 = Date.now();
  const r = createLiveReporter((e) => { got.push(`${e.kind}:${e.hash}`); times.push(Date.now() - t0); }, 80);
  r.reportUnconfirmed(['old'], 'OLD', 257);
  r.reportConfirmed(['older'], 'OLDER', 257);
  check('before prime: nothing is reported', got.length === 0);
  r.prime();
  r.reportUnconfirmed(['old'], 'OLD', 257);
  r.reportConfirmed(['older'], 'OLDER', 257);
  check('what was there at the start is not reported later', got.length === 0);
  r.reportConfirmed(['old'], 'OLD', 257);
  check('seen waiting at start, then confirmed -> only "confirmed"', got.join() === 'confirmed:OLD');

  got.length = 0;
  r.reportUnconfirmed(['a'], 'A', 257);
  r.reportUnconfirmed(['a'], 'A', 257);
  r.reportConfirmed(['a'], 'A', 257);
  r.reportConfirmed(['a'], 'A', 257);
  await sleep(200);
  check('unconfirmed then confirmed: each once, in order', got.join() === 'unconfirmed:A,confirmed:A', got.join());

  got.length = 0; times.length = 0;
  const t1 = Date.now();
  r.reportConfirmed(['b'], 'B', 257); // never seen waiting
  await sleep(250);
  check('confirmed without waiting phase: "unconfirmed" comes first', got.join() === 'unconfirmed:B,confirmed:B', got.join());
  check('and the two are spaced', times.length === 2 && times[1] - times[0] >= 60, `gap ${times[1] - times[0]}ms (started ${t1 - t0})`);

  // The bug: a transaction announced from here was heard as "unconfirmed" again when it was confirmed, because the
  // unconfirmed list and the confirmed list did not name it by the same hash.
  got.length = 0;
  const waiting = { meta: { data: 'HASH-AS-IN-THE-UNCONFIRMED-LIST' }, transaction: { type: 257, signature: 'SIG1' } };
  const inBlock = { meta: { hash: { data: 'hash-as-in-the-confirmed-list' }, height: 5 }, transaction: { type: 257, signature: 'sig1' } };
  check('liveIds: signature and hashes, lower-cased', JSON.stringify(liveIds(waiting)) === '["sig1","hash-as-in-the-unconfirmed-list"]' && JSON.stringify(liveIds(inBlock)) === '["sig1","hash-as-in-the-confirmed-list"]', JSON.stringify(liveIds(waiting)));
  r.reportUnconfirmed(liveIds(waiting), 'W', 257);
  await sleep(150);
  r.reportConfirmed(liveIds(inBlock), 'C', 257);
  await sleep(250);
  check('announced, then confirmed under another hash: after the confirmation only "confirmed" (no second ding)', got.join() === 'unconfirmed:W,confirmed:C', got.join());

  got.length = 0;
  const wrapperWaiting = { meta: { data: 'INNER-HASH', innerHash: {} }, transaction: { type: 4100, signature: 'SIG2' } };
  const wrapperDone = { meta: { hash: { data: 'wrapper-hash' }, innerHash: { data: 'inner-hash' } }, transaction: { type: 4100, signature: 'sig2' } };
  r.reportUnconfirmed(liveIds(wrapperWaiting), 'W2', 4100);
  await sleep(150);
  r.reportConfirmed(liveIds(wrapperDone), 'C2', 4100);
  await sleep(250);
  check('a multisig transaction (hash of what it wraps in the list) is not heard twice either', got.join() === 'unconfirmed:W2,confirmed:C2', got.join());

  got.length = 0;
  r.reportUnconfirmed([], 'NOID', 257);
  r.reportConfirmed([], 'NOID', 257);
  await sleep(50);
  check('an entry that names nothing is ignored', got.length === 0);

  got.length = 0;
  r.reportConfirmed(['c'], 'C', 257);
  r.stop();
  await sleep(250);
  check('stop cancels reports that were still waiting', got.join() === 'unconfirmed:C', got.join());
}

// ---- a STOMP-over-WebSocket server (what NIS1 does), made by hand
interface Conn { socket: import('node:net').Socket; send: (text: string) => void; close: () => void }
function startServer(options: { heartBeat?: string; silent?: boolean } = {}) {
  const frames: StompFrame[] = [];
  const conns: Conn[] = [];
  let connects = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const sendText = (text: string) => {
      const payload = Buffer.from(text);
      const n = payload.length;
      const head = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
      if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
    };
    const conn: Conn = { socket, send: sendText, close: () => socket.destroy() };
    conns.push(conn);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        const masked = (buf[1] & 0x80) !== 0;
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
        buf = buf.subarray(need);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode !== 0x1) continue;
        for (const f of decodeFrames(data.toString('utf8'))) {
          frames.push(f);
          if (f.command === 'CONNECT') {
            connects += 1;
            if (!options.silent) sendText(encodeFrame('CONNECTED', { version: '1.1', 'heart-beat': options.heartBeat ?? '0,0' }));
          }
        }
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise<{ url: string; frames: StompFrame[]; conns: Conn[]; connects: () => number; stop: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${port}/w/messages/websocket`, frames, conns, connects: () => connects, stop: () => { conns.forEach((c) => c.close()); server.close(); } });
    });
  });
}

const ADDR = 'TBPTK3RMYVNYMJFNC7NTVS5QO6JXKLEC4MJHZK7J';
const entry = (hash: string, type = 257) => JSON.stringify({ meta: { data: hash }, transaction: { type, amount: 1 } });

// ---- the client against it
{
  const srv = await startServer();
  const unconfirmed: unknown[] = [];
  const confirmed: unknown[] = [];
  const status: boolean[] = [];
  const logs: string[] = [];
  const stop = startNemSocket({
    address: 'TBPTK3-RMYVNY-MJFNC7-NTVS5Q-O6JXKL-EC4MJH-ZK7J',
    urls: async () => [srv.url],
    onUnconfirmed: (e) => unconfirmed.push(e),
    onConfirmed: (e) => confirmed.push(e),
    onStatus: (s) => status.push(s.connected),
    log: (m) => logs.push(m),
    reconnectDelayMs: 40,
    retryDelaysMs: [40],
  });
  check('connects and subscribes', await until(() => status[0] === true && srv.frames.length >= 4), JSON.stringify(srv.frames.map((f) => f.command)));
  const [connect, account, subU, subC] = srv.frames;
  check('CONNECT: STOMP 1.1 with heart-beat', connect?.command === 'CONNECT' && connect.headers['accept-version'] === '1.1,1.0' && connect.headers['heart-beat'] === '20000,10000');
  check('subscribe the account first (as the official wallet)', account?.command === 'SEND' && account.headers.destination === '/w/api/account/subscribe' && account.body === `{'account':'${ADDR}'}`, account?.body);
  check('listens to /unconfirmed/<address>', subU?.command === 'SUBSCRIBE' && subU.headers.destination === `/unconfirmed/${ADDR}`);
  check('listens to /transactions/<address>', subC?.command === 'SUBSCRIBE' && subC.headers.destination === `/transactions/${ADDR}`);
  check('ids differ', subU?.headers.id !== subC?.headers.id);

  const c0 = srv.conns[0];
  c0.send(encodeFrame('MESSAGE', { destination: `/unconfirmed/${ADDR}`, subscription: 'sub-0', 'message-id': '1' }, entry('H1')));
  c0.send(encodeFrame('MESSAGE', { destination: `/transactions/${ADDR}`, subscription: 'sub-1', 'message-id': '2' }, entry('H1')));
  c0.send(encodeFrame('MESSAGE', { destination: `/account/${ADDR}` }, '{"x":1}'));
  c0.send(encodeFrame('MESSAGE', { destination: `/unconfirmed/${ADDR}` }, 'not json'));
  c0.send('\n');
  check('news from each channel goes to its handler', await until(() => unconfirmed.length === 1 && confirmed.length === 1), `${unconfirmed.length}/${confirmed.length}`);
  check('payload arrives parsed', (unconfirmed[0] as { meta: { data: string } }).meta.data === 'H1');
  await sleep(50);
  check('other channels, broken JSON and heart-beats are ignored', unconfirmed.length === 1 && confirmed.length === 1);

  // The server drops the connection: the client comes back and subscribes again.
  c0.close();
  check('reports the drop', await until(() => status.length >= 2 && status[1] === false), JSON.stringify(status));
  check('reconnects and subscribes again', await until(() => srv.connects() === 2 && status[2] === true && srv.frames.filter((f) => f.command === 'SUBSCRIBE').length === 4), `${srv.connects()} ${JSON.stringify(status)}`);
  srv.conns[1].send(encodeFrame('MESSAGE', { destination: `/unconfirmed/${ADDR}` }, entry('H2')));
  check('news after the reconnect', await until(() => unconfirmed.length === 2));

  // A STOMP ERROR frame ends the connection too.
  srv.conns[1].send(encodeFrame('ERROR', { message: 'boom' }));
  check('ERROR frame -> reconnect', await until(() => srv.connects() === 3), `${srv.connects()}`);
  check('the failure is logged', logs.some((l) => l.includes('server error: boom')), logs.join(' | '));

  stop();
  const before = srv.connects();
  await sleep(200);
  check('after stop: no more connecting', srv.connects() === before);
  srv.stop();
}

// First address is dead: the next one is used.
{
  const srv = await startServer();
  const status: string[] = [];
  const logs: string[] = [];
  const stop = startNemSocket({
    address: ADDR,
    urls: async () => ['ws://127.0.0.1:1/w/messages/websocket', srv.url],
    onUnconfirmed: () => undefined,
    onConfirmed: () => undefined,
    onStatus: (s) => status.push(`${s.connected}:${s.url}`),
    log: (m) => logs.push(m),
    connectTimeoutMs: 1500,
  });
  check('falls back to the next node', await until(() => status[0] === `true:${srv.url}`, 4000), `${JSON.stringify(status)} ${logs.join(' | ')}`);
  check('the dead one is logged', logs.some((l) => l.includes('not available') && l.includes('127.0.0.1:1')), logs.join(' | '));
  stop();
  srv.stop();
}

// A node that accepts the connection but never answers STOMP is given up on after the timeout.
{
  const srv = await startServer({ silent: true });
  const logs: string[] = [];
  const stop = startNemSocket({
    address: ADDR,
    urls: async () => [srv.url],
    onUnconfirmed: () => undefined,
    onConfirmed: () => undefined,
    log: (m) => logs.push(m),
    connectTimeoutMs: 150,
    retryDelaysMs: [60],
  });
  check('no CONNECTED in time -> timeout, then it tries again', await until(() => srv.connects() >= 2 && logs.some((l) => l.includes('timeout')), 3000), `${srv.connects()} ${logs.join(' | ')}`);
  stop();
  srv.stop();
}

// The server promised heart-beats and then goes quiet: the connection is dropped and re-made.
{
  const srv = await startServer({ heartBeat: '100,0' });
  const status: boolean[] = [];
  const logs: string[] = [];
  const stop = startNemSocket({
    address: ADDR,
    urls: async () => [srv.url],
    onUnconfirmed: () => undefined,
    onConfirmed: () => undefined,
    onStatus: (s) => status.push(s.connected),
    log: (m) => logs.push(m),
    heartbeat: { outgoing: 0, incoming: 50 },
    reconnectDelayMs: 40,
  });
  check('silent connection is dropped and re-made', await until(() => srv.connects() >= 2 && logs.some((l) => l.includes('silent')), 4000), `${srv.connects()} ${logs.join(' | ')}`);
  stop();
  srv.stop();
}

// No usable address at all: it keeps asking, and stops cleanly.
{
  let asked = 0;
  const stop = startNemSocket({ address: ADDR, urls: async () => { asked += 1; return []; }, onUnconfirmed: () => undefined, onConfirmed: () => undefined, retryDelaysMs: [30] });
  check('with no address it asks again later', await until(() => asked >= 3, 2000), `${asked}`);
  stop();
  const n = asked;
  await sleep(120);
  check('and stops when told', asked <= n + 1, `${n} -> ${asked}`);
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
