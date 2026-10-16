// NEMのテストネットはNEMSCANへ、メインネットはこれまで通りnemtoolへリンクする。
// Run: npx tsx dev-tests/nem-testnet-explorer.test.ts
import { setNetwork } from '../src/lib/symbol/network';
import { nemExplorerAccountUrl, nemExplorerMosaicUrl, nemExplorerNamespaceUrl, nemExplorerTxUrl } from '../src/lib/nem/api';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const hash = 'ab'.repeat(32);
const addr = 'TAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAA';

setNetwork('testnet');
ok(nemExplorerTxUrl(hash) === `https://nemscan.io/tx/${hash}`, 'testnet tx -> nemscan', nemExplorerTxUrl(hash));
ok(nemExplorerAccountUrl(addr).startsWith('https://nemscan.io/account/T'), 'testnet account -> nemscan', nemExplorerAccountUrl(addr));
ok(nemExplorerNamespaceUrl('foo') === 'https://nemscan.io/namespaces', 'testnet namespace -> list page');
ok(nemExplorerMosaicUrl('foo:bar') === 'https://nemscan.io/mosaics', 'testnet mosaic -> list page');

setNetwork('mainnet');
ok(nemExplorerTxUrl(hash) === `https://explorer.nemtool.com/#/s_tx?hash=${hash}`, 'mainnet tx unchanged', nemExplorerTxUrl(hash));
ok(nemExplorerNamespaceUrl('foo') === 'https://explorer.nemtool.com/#/s_namespace?namespace=foo', 'mainnet namespace unchanged');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
