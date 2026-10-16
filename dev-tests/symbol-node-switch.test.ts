// Symbol側のノード管理: 登録ノード一覧・接続テスト・利用不可時の自動切替。
// Run: npx tsx dev-tests/symbol-node-switch.test.ts
import { NETWORKS } from '../src/lib/symbol/constants';
import { getSavedNodes, setAutoSwitch, setCustomNodeUrl, setNetwork, setSavedNodes } from '../src/lib/symbol/network';
import { getConnectedNode, isNodeSwitched, nodeRequest, onNodeSwitched, testNode } from '../src/lib/symbol/api';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = NETWORKS.mainnet;
const A = 'https://node-a.test:3001'; // picked, goes down
const B = 'https://node-b.test:3001'; // saved, healthy
const C = 'https://node-c.test:3001'; // saved, healthy but wrong network
const down = new Set<string>([A]);
const calls: string[] = [];

(globalThis as { fetch: unknown }).fetch = async (input: string | URL) => {
  const url = String(input);
  calls.push(url);
  const host = url.match(/^https:\/\/[^/]+/)?.[0] ?? '';
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (!host.endsWith('.test:3001') || down.has(host)) throw new TypeError('network down');
  if (url.endsWith('/node/health')) return json({ status: { apiNode: 'up', db: 'up' } });
  if (url.endsWith('/node/info')) {
    return host === C
      ? json({ networkGenerationHashSeed: '00'.repeat(32), networkIdentifier: cfg.networkByte })
      : json({ networkGenerationHashSeed: cfg.generationHash, networkIdentifier: cfg.networkByte });
  }
  if (url.endsWith('/chain/info')) return json({ height: '1', served: host });
  return json({}, 404);
};

setNetwork('mainnet');
setSavedNodes('mainnet', [A, B, C, B, ' ' + A + '/ ']);
ok(getSavedNodes('mainnet').join(',') === [A, B, C].join(','), 'saved list is trimmed and de-duplicated', getSavedNodes('mainnet'));

// --- 接続テスト
const tA = await testNode(A, 'mainnet');
const tB = await testNode(B + '/', 'mainnet');
const tC = await testNode(C, 'mainnet');
ok(!tA.ok && tA.detail === 'NG', 'unreachable node fails the test', tA);
ok(tB.ok && /ms$/.test(tB.detail) && tB.url === B, 'healthy node passes with its response time', tB);
ok(!tC.ok, 'a node of another network fails the test', tC);

// --- picked node answering: no switch
down.clear();
setCustomNodeUrl('mainnet', A);
setAutoSwitch(true);
let heard: [string, string] | null = null;
const off = onNodeSwitched((from, to) => { heard = [from, to]; });
let res = await nodeRequest<{ served: string }>('/chain/info');
ok(res.served === A && getConnectedNode() === A && !isNodeSwitched(), 'the picked node is used while it answers', res);

// --- picked node goes down: auto switch to the saved healthy node (not the wrong-network one)
down.add(A);
res = await nodeRequest<{ served: string }>('/chain/info');
ok(res.served === B, 'request is served by the other saved node', res);
ok(isNodeSwitched() && getConnectedNode() === B, 'switched state is reported', getConnectedNode());
ok(heard !== null && (heard as [string, string])[0] === A && (heard as [string, string])[1] === B, 'the app is told about the switch', heard);
const before = calls.filter((c) => c.startsWith(A)).length;
await nodeRequest('/chain/info');
ok(calls.filter((c) => c.startsWith(A)).length === before, 'the failed node is not asked again right away');

// --- auto switch off: the failure is shown, nothing switches
setAutoSwitch(false);
let threw = false;
try { await nodeRequest('/chain/info'); } catch { threw = true; }
ok(threw, 'with auto switch off a failing picked node is an error');
ok(!isNodeSwitched(), 'nothing switched when it is off');

// --- no node picked: automatic choice as before
setAutoSwitch(true);
setCustomNodeUrl('mainnet', '');
setSavedNodes('mainnet', []);
down.add('https://never.test:3001');
for (const f of cfg.fallbackNodes) down.add(f.match(/^https:\/\/[^/]+/)![0]);
let autoFailed = false;
try { await nodeRequest('/chain/info'); } catch { autoFailed = true; }
ok(autoFailed, 'without any reachable node the request fails (no_node_available)');

off();
console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
