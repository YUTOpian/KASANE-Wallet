// リンク集: NEM テストネットのファウセット、Symbol のリンクから Everyday Symbol を外したこと。Run: npx tsx dev-tests/links.test.ts
import { faucetLink, officialLinks } from '../src/lib/links';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

ok(faucetLink('nem', 'testnet')?.url === 'https://testnet.nem.tools', 'NEM testnet faucet', faucetLink('nem', 'testnet'));
ok(faucetLink('nem', 'testnet')?.labelKey === 'guide.faucet_nem', 'NEM faucet label key');
ok(faucetLink('symbol', 'testnet')?.url === 'https://testnet.symbol.tools/', 'Symbol testnet faucet is unchanged');
ok(faucetLink('nem', 'mainnet') === null && faucetLink('symbol', 'mainnet') === null, 'no faucet on mainnet');

for (const network of ['mainnet', 'testnet'] as const) {
  const symbol = officialLinks('symbol', network);
  ok(!symbol.some((l) => l.labelKey === 'guide.link_everyday' || /everyday/i.test(l.url)), `Symbol ${network}: no Everyday Symbol`);
  ok(symbol.length === 6 && symbol[0].labelKey === 'guide.link_site' && symbol.some((l) => l.labelKey === 'guide.link_community') && symbol.some((l) => l.labelKey === 'guide.link_nodes_symbol'), `Symbol ${network}: the other links are kept`, symbol.map((l) => l.labelKey));
  const nem = officialLinks('nem', network);
  ok(nem.length === 6 && !nem.some((l) => /everyday/i.test(l.url)), `NEM ${network}: links unchanged`);
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
