// オフライントランザクション: QR の形式（Symbol の bundle、NEM の bundle）と、「ノードに届かなかった」判定。SDK を使わない部分。
// Run: npx tsx dev-tests/offline-issue.test.ts
import { buildKasaneQr, parseKasaneQr } from '../src/lib/symbol/kasaneQr';
import { buildNemBundleQr, buildNemSignedQr, parseNemBundle, parseNemSigned } from '../src/lib/nem/offline';
import { isNetworkFailure } from '../src/lib/offline/detect';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const H1 = 'A'.repeat(64), H2 = 'B'.repeat(64);
const P1 = 'AB'.repeat(200), P2 = 'CD'.repeat(300);

// --- Symbol bundle: lock then bonded -------------------------------------------------------------------------------------
const text = buildKasaneQr({ kind: 'bundle', items: [{ role: 'lock', payload: P1.toLowerCase(), hash: H1.toLowerCase() }, { role: 'bonded', payload: P2, hash: H2 }] });
const parsed = parseKasaneQr(text);
ok(parsed !== null && parsed.qr.kind === 'bundle', 'bundle is read back');
if (parsed && parsed.qr.kind === 'bundle') {
  ok(parsed.qr.items.length === 2, 'two items');
  ok(parsed.qr.items[0].role === 'lock' && parsed.qr.items[1].role === 'bonded', 'order and roles kept');
  ok(parsed.qr.items[0].payload === P1 && parsed.qr.items[0].hash === H1, 'hex is upper-cased');
}
ok(parsed !== null && parsed.networkId !== null && parsed.chainId !== null, 'the network is named');

const bad = (mutate: (j: { data: { items: Array<Record<string, unknown>> } }) => void) => {
  const j = JSON.parse(text); mutate(j); return parseKasaneQr(JSON.stringify(j));
};
ok(bad((j) => { j.data.items[0].role = 'x'; }) === null, 'unknown role is refused');
ok(bad((j) => { j.data.items[0].hash = 'zz'; }) === null, 'bad hash is refused');
ok(bad((j) => { j.data.items[1].payload = 'abc'; }) === null, 'odd-length payload is refused');
ok(bad((j) => { j.data.items = []; }) === null, 'empty bundle is refused');
ok(bad((j) => { j.data.items = Array.from({ length: 17 }, () => ({ role: 'tx', payload: P1, hash: H1 })); }) === null, 'too many items are refused');

// A single transaction stays a plain `signed` QR (older readers keep working).
const single = parseKasaneQr(buildKasaneQr({ kind: 'signed', payload: P1, hash: H1 }));
ok(single !== null && single.qr.kind === 'signed', 'single stays signed');

// --- NEM -----------------------------------------------------------------------------------------------------------------
const body = (n: number) => ({ data: n.toString(16).padStart(2, '0').repeat(120), signature: 'EF'.repeat(64) });
const nemText = buildNemBundleQr([body(1), body(2), body(3)], 104);
const nem = parseNemBundle(nemText);
ok(nem !== null && nem.items.length === 3 && nem.networkId === 104, 'NEM bundle is read back');
ok(parseNemSigned(nemText) === null, 'a NEM bundle is not a single NEM QR');
ok(parseNemBundle(buildNemSignedQr(JSON.stringify(body(1)), 104)) === null, 'a single NEM QR is not a bundle');
let threw = false; try { buildNemBundleQr([], 104); } catch { threw = true; }
ok(threw, 'an empty NEM bundle cannot be built');
threw = false; try { buildNemBundleQr([{ data: 'zz', signature: 'EF'.repeat(64) }], 104); } catch { threw = true; }
ok(threw, 'a malformed NEM item cannot be built');
ok(parseNemBundle(nemText.replace(/"signature":"EFEF/, '"signature":"EF')) === null, 'a short signature is refused');

// --- "the node could not be reached" -------------------------------------------------------------------------------------
ok(isNetworkFailure(new TypeError('Failed to fetch')), 'fetch failure');
ok(isNetworkFailure(new Error('offline')), 'offline marker');
ok(isNetworkFailure(new Error('no_node_available')), 'no node');
ok(isNetworkFailure(new Error('NetworkError when attempting to fetch resource.')), 'firefox');
ok(isNetworkFailure(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout abort');
ok(!isNetworkFailure(Object.assign(new Error('HTTP 500'), { status: 500 })), 'node answered 500: not offline');
ok(!isNetworkFailure(Object.assign(new Error('Failure_Core_Insufficient_Balance'), { status: 409 })), 'node refused: not offline');
ok(!isNetworkFailure(new Error('Failure_Core_Insufficient_Balance')), 'a refusal code is not offline');
ok(!isNetworkFailure(new Error('lock_timeout')), 'the lock not being confirmed in time is not offline');
ok(!isNetworkFailure(null) && !isNetworkFailure(undefined), 'null / undefined');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} FAILED`);
process.exit(fails === 0 ? 0 : 1);
