// NEM invoice QR (NanoWallet format, type 2): build -> parse back.
// Run: npx tsx dev-tests/nem-invoice-qr.test.ts
import { buildNemInvoiceQr, parseNemScanned } from '../src/lib/nem/qr';
import { nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import { getNemNetworkConfig } from '../src/lib/nem/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNemNetworkConfig();
const me = nemAddressFromPublicKey('A'.repeat(64), cfg.networkByte);
const qr = buildNemInvoiceQr({ recipient: me, amountMicro: 12_500_000n, message: 'ご請求 #42 ☕' });
const json = JSON.parse(qr);
ok(json.v === 2 && json.type === 2, 'v2 (mainnet) / type 2', json);
ok(json.data.addr === me && json.data.amount === 12_500_000 && typeof json.data.name === 'string', 'data fields', json.data);

const back = parseNemScanned(qr);
ok(back !== null && back.address === me, 'address round-trips', back);
ok(back?.amount === '12.5', 'amount round-trips as XEM', back?.amount);
ok(back?.message === 'ご請求 #42 ☕', 'message round-trips', back?.message);

const noMsg = parseNemScanned(buildNemInvoiceQr({ recipient: me, amountMicro: 1n }));
ok(noMsg !== null && noMsg.message === undefined && noMsg.amount === '0.000001', 'no message, 1 micro XEM', noMsg);

let threw = false;
try { buildNemInvoiceQr({ recipient: 'NOT-AN-ADDRESS', amountMicro: 1n }); } catch { threw = true; }
ok(threw, 'invalid address rejected');
threw = false;
try { buildNemInvoiceQr({ recipient: me, amountMicro: -1n }); } catch { threw = true; }
ok(threw, 'negative amount rejected');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
