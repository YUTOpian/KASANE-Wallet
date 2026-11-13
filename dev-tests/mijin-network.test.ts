// mijin v2 (Catapult): the network entry, the facade built from node-reported parameters, address handling and the
// node reader (against a fake REST gateway). 実行: npx tsx dev-tests/mijin-network.test.ts
import { addressFromPublicKey, convertAddressNetwork, facadeFor, isSupportedNetworkByte, isValidAddress } from '../src/lib/symbol/crypto';
import { getNetworkConfig, isNetworkConfigured, setMijinParams } from '../src/lib/symbol/network';
import { parseWatchAddress } from '../src/lib/watchAddress';
import { MijinReadFailure, cleanPropertyHex, detectNodeNetwork, parseEpochAdjustment, readMijinNode } from '../src/lib/symbol/mijin';
import { signTransfer } from '../src/lib/symbol/tx';
import { NETWORKS } from '../src/lib/symbol/constants';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const KEY = '3B9670B5CB19C893694FC49B461CE489BF9588BE16DBE8DC29CF06338133DEE6';
const HASH = 'AB'.repeat(32);

// --- unconfigured -------------------------------------------------------------------------
check('mijin is not configured at first', !isNetworkConfigured('mijin') && getNetworkConfig('mijin').generationHash === '');
check('mainnet / testnet are untouched', getNetworkConfig('mainnet').networkByte === 0x68 && getNetworkConfig('testnet').networkByte === 0x98);

// --- addresses ----------------------------------------------------------------------------
const mijinAddr = addressFromPublicKey(KEY, 0x60);
check('mijin address starts with M', mijinAddr.startsWith('M') && mijinAddr.length === 39, mijinAddr);
check('mijin-test address starts with S', addressFromPublicKey(KEY, 0x90).startsWith('S'));
check('valid for byte 0x60 only', isValidAddress(mijinAddr, 0x60) && !isValidAddress(mijinAddr, 0x68));
check('convert mainnet -> mijin', convertAddressNetwork(addressFromPublicKey(KEY, 0x68), 0x60) === mijinAddr);
check('watch address -> mijin network on Symbol', (() => { const p = parseWatchAddress(mijinAddr); return p?.chain === 'symbol' && p.network === 'mijin' && p.address === mijinAddr; })());
check('supported network bytes', isSupportedNetworkByte(0x68) && isSupportedNetworkByte(0x98) && isSupportedNetworkByte(0x60) && !isSupportedNetworkByte(0x11));

// --- configured ---------------------------------------------------------------------------
setMijinParams({ networkByte: 0x60, generationHash: HASH, epochAdjustment: 1573430400, currencyMosaicId: '0DC67FBE1CAD29E3', explorer: '' });
check('configured', isNetworkConfigured('mijin'));
const cfg = getNetworkConfig('mijin');
check('config merges node parameters', cfg.networkByte === 0x60 && cfg.generationHash === HASH && cfg.epochAdjustment === 1573430400 && cfg.currencyMosaicId === '0DC67FBE1CAD29E3' && cfg.label === 'mijin v2');
check('static mijin entry stays blank', NETWORKS.mijin.generationHash === '');
const facade = facadeFor(0x60);
check('facade carries the generation hash', facade.network.generationHashSeed.toString().toUpperCase() === HASH);

const transfer = {
  networkByte: 0x60, signerPublicKey: KEY, recipient: mijinAddr, mosaics: [{ id: '0DC67FBE1CAD29E3', amount: 1_000_000n }],
  message: 'hi', deadline: 1000n, maxFee: 20_000n,
} as never;
try {
  const signed = signTransfer('0000000000000000000000000000000000000000000000000000000000000001', HASH, transfer);
  check('signs a transfer on mijin', /^[0-9A-F]+$/.test(signed.payload) && signed.hash.length === 64);
  // payload header: size 4 + reserved 4 + signature 64 + signer 32 + reserved 4 = 108, then version (1), network (1)
  check('payload names network 0x60', signed.payload.slice((108 + 1) * 2, (108 + 2) * 2) === '60');
} catch (e) {
  check('signs a transfer on mijin', false, String(e));
}
try {
  signTransfer('0000000000000000000000000000000000000000000000000000000000000001', 'CD'.repeat(32), transfer);
  check('refuses another chain\'s generation hash', false);
} catch (e) {
  check('refuses another chain\'s generation hash', (e as Error).message === 'generation_hash_mismatch');
}

// --- parsing helpers ----------------------------------------------------------------------
check('cleanPropertyHex', cleanPropertyHex("0x0DC6'7FBE'1CAD'29E3") === '0DC67FBE1CAD29E3');
check('parseEpochAdjustment', parseEpochAdjustment('1573430400s') === 1573430400 && parseEpochAdjustment('abc') === null && parseEpochAdjustment(undefined) === null);

// --- node reader against a fake gateway ---------------------------------------------------
type Route = (path: string) => unknown;
function fakeFetch(routes: Route) {
  (globalThis as { fetch: unknown }).fetch = async (input: string) => {
    const path = new URL(input).pathname;
    const body = routes(path);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}
const goodRoutes = (over: Record<string, unknown> = {}): Route => (path) => ({
  '/node/info': { networkGenerationHashSeed: HASH.toLowerCase(), networkIdentifier: 96 },
  '/node/health': { status: { apiNode: 'up', db: 'up' } },
  '/network/properties': { network: { epochAdjustment: '1573430400s' }, chain: { currencyMosaicId: "0x0DC6'7FBE'1CAD'29E3" } },
  ...over,
} as Record<string, unknown>)[path];

async function expectFail(name: string, routes: Route, code: string, url = 'https://node.example:3001') {
  fakeFetch(routes);
  try {
    await readMijinNode(url);
    check(name, false, 'did not throw');
  } catch (e) {
    check(name, e instanceof MijinReadFailure && e.code === code, String(e));
  }
}

async function main() {
  fakeFetch(goodRoutes());
  const p = await readMijinNode('https://node.example:3001/', 'https://explorer.example/');
  check('reads the chain parameters', p.networkByte === 96 && p.generationHash === HASH && p.epochAdjustment === 1573430400 && p.currencyMosaicId === '0DC67FBE1CAD29E3' && p.explorer === 'https://explorer.example');

  // The network of a node is detected: Symbol mainnet / testnet and mijin v2 (this is what moves the app between them).
  fakeFetch(goodRoutes({ '/node/info': { networkGenerationHashSeed: NETWORKS.mainnet.generationHash, networkIdentifier: 0x68 } }));
  check('detects a Symbol mainnet node', (await detectNodeNetwork('https://node.example:3001')).network === 'mainnet');
  fakeFetch(goodRoutes({ '/node/info': { networkGenerationHashSeed: NETWORKS.testnet.generationHash.toLowerCase(), networkIdentifier: 0x98 } }));
  check('detects a Symbol testnet node', (await detectNodeNetwork('https://node.example:3001')).network === 'testnet');
  fakeFetch(goodRoutes());
  const detectedMijin = await detectNodeNetwork('https://node.example:3001', 'https://explorer.example/');
  check('detects a mijin v2 node with its parameters', detectedMijin.network === 'mijin' && detectedMijin.params.generationHash === HASH && detectedMijin.params.networkByte === 96 && detectedMijin.params.explorer === 'https://explorer.example');
  fakeFetch(goodRoutes({ '/node/info': { networkGenerationHashSeed: NETWORKS.mainnet.generationHash, networkIdentifier: 0x60 } }));
  try {
    await detectNodeNetwork('https://node.example:3001');
    check('mainnet hash under a mijin byte is refused', false, 'did not throw');
  } catch (e) {
    check('mainnet hash under a mijin byte is refused', e instanceof MijinReadFailure && e.code === 'not_mijin', String(e));
  }
  // Symbol mainnet / testnet nodes stay refused by the mijin-only reader.

  await expectFail('rejects a bad URL', goodRoutes(), 'invalid_url', 'node.example');
  await expectFail('unreachable node', () => undefined, 'unreachable');
  await expectFail('unhealthy node', goodRoutes({ '/node/health': { status: { apiNode: 'up', db: 'down' } } }), 'unhealthy');
  await expectFail('Symbol mainnet node is not mijin', goodRoutes({ '/node/info': { networkGenerationHashSeed: NETWORKS.mainnet.generationHash, networkIdentifier: 0x68 } }), 'not_mijin');
  await expectFail('Symbol testnet node is not mijin', goodRoutes({ '/node/info': { networkGenerationHashSeed: NETWORKS.testnet.generationHash, networkIdentifier: 0x98 } }), 'not_mijin');
  await expectFail('missing properties', goodRoutes({ '/network/properties': undefined }), 'properties_unreadable');
  await expectFail('garbled properties', goodRoutes({ '/network/properties': { network: {}, chain: {} } }), 'properties_unreadable');

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall mijin checks passed');
}
void main();
