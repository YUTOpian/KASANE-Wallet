// Invoice QR (Symbol QR v3 type 3): build -> parse back, and the envelope the official wallets expect.
// Run: npx tsx dev-tests/symbol-invoice-qr.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/symbol';
import { addressFromPublicKey, hexToBytes } from '../src/lib/symbol/crypto';
import { buildInvoiceQr, parseScanned } from '../src/lib/symbol/qr';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const me = addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), cfg.networkByte);
const qr = buildInvoiceQr({ recipient: me, mosaics: [{ id: cfg.currencyMosaicId, amount: 1_500_000n }, { id: '0DC67FBE1CAD29E3', amount: 7n }], message: 'ご請求 #42 ☕' });
const json = JSON.parse(qr);
ok(json.v === 3 && json.type === 3, 'v3 / type 3');
ok(json.network_id === cfg.networkByte && json.chain_id === cfg.generationHash, 'network_id and chain_id');
ok(/^[0-9A-F]+$/.test(json.data.payload) && Object.keys(json.data).join() === 'payload', 'data.payload is hex only');

const tx = models.TransactionFactory.deserialize(hexToBytes(json.data.payload)) as InstanceType<typeof models.TransferTransactionV1>;
ok(tx.signerPublicKey.toString() === '0'.repeat(64), 'zero signer');
ok(tx.signature.toString() === '0'.repeat(128), 'no signature');
ok(tx.fee.value === 0n, 'fee 0');
ok(tx.network.value === cfg.networkByte, 'network');

const back = parseScanned(qr);
ok(back !== null && back.address === me, 'recipient round-trips', back);
ok(back?.message === 'ご請求 #42 ☕', 'message round-trips', back?.message);
const ids = [back?.mosaicId, back?.extraMosaics?.[0]?.id].sort();
ok(JSON.stringify(ids) === JSON.stringify([cfg.currencyMosaicId, '0DC67FBE1CAD29E3'].sort()), 'both mosaics', back);
ok(back?.generationHash === cfg.generationHash, 'generation hash carried');
const amounts = [back?.amount, back?.extraMosaics?.[0]?.amount].sort();
ok(JSON.stringify(amounts) === JSON.stringify(['atomic:1500000', 'atomic:7']), 'atomic amounts', amounts);

const noMsg = parseScanned(buildInvoiceQr({ recipient: me, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }] }));
ok(noMsg !== null && noMsg.message === undefined, 'no message');
const long = buildInvoiceQr({ recipient: me, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }], message: 'x'.repeat(1023) });
ok(long.length > 2000, 'max message makes a large QR (UI must check the size)', long.length);

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
