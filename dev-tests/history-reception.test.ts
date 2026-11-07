// History: a transfer signed by someone else is a reception (also when it is addressed to a namespace alias), and an
// aggregate sent by someone else shows what its inner transfers deliver to this account. Offline.
// Run: npx tsx dev-tests/history-reception.test.ts
import { addressFromPublicKey, bytesToHex, decodeAddress, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { isTransferReception, sumReceivedInner } from '../src/lib/symbol/history';
import type { RawEntry } from '../src/lib/symbol/history';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
let networkCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => { networkCalls++; return Promise.reject(new Error('offline')); };

const cfg = getNetworkConfig();
const pair = (c: string) => keyPairFromPrivateKey(c.repeat(64));
const me = addressFromPublicKey(pair('1').publicKey, cfg.networkByte);
const other = addressFromPublicKey(pair('2').publicKey, cfg.networkByte);
const third = addressFromPublicKey(pair('3').publicKey, cfg.networkByte);
const hexAddr = (a: string) => bytesToHex(decodeAddress(a) as Uint8Array);

// --- a single transfer ---------------------------------------------------------------------------------
ok(isTransferReception(other, me, me), 'signed by someone else, addressed to me -> reception');
ok(!isTransferReception(me, other, me), 'signed by me -> not a reception');
ok(!isTransferReception(me, me, me), 'sent to myself -> not a reception');
ok(isTransferReception(other, '@1234567890ABCDEF', me), 'alias recipient from someone else -> reception');
ok(!isTransferReception(me, '@1234567890ABCDEF', me), 'alias recipient signed by me -> not a reception');
ok(!isTransferReception(other, third, me), 'addressed to a third account (a plain address) -> not a reception');

// --- transfers inside an aggregate -------------------------------------------------------------------------
const inner = (signerKey: string, recipient: string, mosaics: Array<{ id: string; amount: string }>, type = 0x4154): RawEntry => ({
  transaction: { type, network: cfg.networkByte, signerPublicKey: pair(signerKey).publicKey, recipientAddress: hexAddr(recipient), mosaics } as RawEntry['transaction'],
});
const XYM = '6BED913FA20223F8';
const OTHER = '1122334455667788';
const entries: RawEntry[] = [
  inner('2', me, [{ id: XYM, amount: '1500000' }, { id: OTHER, amount: '7' }]),
  inner('2', me, [{ id: XYM, amount: '500000' }]), // same mosaic again: summed
  inner('2', third, [{ id: XYM, amount: '999' }]), // not for me
  inner('1', me, [{ id: XYM, amount: '888' }]), // signed by me: not a reception
  inner('2', me, [{ id: XYM, amount: '5' }], 0x4144), // not a transfer
  { transaction: { type: 0x4154, network: cfg.networkByte, signerPublicKey: pair('2').publicKey } as RawEntry['transaction'] }, // no recipient / mosaics
];
const sum = sumReceivedInner(entries, me);
const byId = Object.fromEntries(sum.map((m) => [m.id, m.amount]));
ok(sum.length === 2, 'two mosaics are delivered', sum);
ok(byId[XYM] === '2000000', 'the same mosaic is summed', byId);
ok(byId[OTHER] === '7', 'the other mosaic is kept', byId);
ok(sumReceivedInner([], me).length === 0, 'nothing inside -> nothing received');
ok(sumReceivedInner([{ transaction: { type: 0x4154, network: cfg.networkByte, signerPublicKey: 'zz', recipientAddress: 'zz', mosaics: [{ id: XYM, amount: '1' }] } as RawEntry['transaction'] }], me).length === 0, 'an unreadable entry is skipped');

ok(networkCalls === 0, 'no network access', networkCalls);
console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
