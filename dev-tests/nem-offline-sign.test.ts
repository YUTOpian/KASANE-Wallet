// NEM のオフライン署名: SDK で署名したものを、読み取り側（lib/nem/offline.ts）が正しく読めること、署名が検証できること。
// Run: npx tsx dev-tests/nem-offline-sign.test.ts   （symbol-sdk が必要）
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import { nemAddressFromPublicKey, verifyNemSignature } from '../src/lib/nem/crypto';
import { buildNemSignedQr, nemHexToBytes, parseNemSigned, readNemTransfer } from '../src/lib/nem/offline';
import { NEM_EPOCH_SECONDS } from '../src/lib/nem/constants';
import { NEM_XEM_MOSAIC_ID, nemSendFee, nemTransferFee, signNemTransfer } from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const TESTNET = 0x98;
const priv = '0000000000000000000000000000000000000000000000000000000000000001';
const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString().toUpperCase();
const recipient = nemAddressFromPublicKey(new KeyPair(new PrivateKey('00000000000000000000000000000000000000000000000000000000000000AA')).publicKey.toString(), TESTNET);

// a plain XEM transfer, valid for 6 hours
const before = Date.now();
const fee = nemTransferFee(12_500_000n, 'hello');
const bodyText = signNemTransfer(priv, { publicKey: pub, networkByte: TESTNET, recipient, amount: 12_500_000n, message: 'hello', fee, timeoutSeconds: 6 * 3600 });
const body = JSON.parse(bodyText) as { data: string; signature: string };
const s = readNemTransfer(body.data);
ok(s.typeValue === 0x101 && s.version === 1 && s.networkByte === TESTNET, 'header', [s.typeValue, s.version, s.networkByte]);
ok(s.signerPublicKey === pub, 'signer');
ok(s.fee === fee, 'fee');
ok(s.transfer?.recipient === recipient, 'recipient');
ok(s.transfer?.mosaics.length === 1 && s.transfer.mosaics[0].id === NEM_XEM_MOSAIC_ID && s.transfer.mosaics[0].quantity === 12_500_000n, 'amount');
ok(s.transfer?.message?.text === 'hello', 'message');
const validForMs = s.deadlineMs - s.timestampMs;
ok(validForMs === 6 * 3600 * 1000, 'the deadline is timeoutSeconds after the time stamp', validForMs);
ok(Math.abs(s.timestampMs - before) < 5 * 60 * 1000, "the time stamp is this device's clock", [s.timestampMs, before, NEM_EPOCH_SECONDS]);
ok(verifyNemSignature(s.signerPublicKey, nemHexToBytes(body.data), nemHexToBytes(body.signature)), 'the signature verifies');
const tampered = body.data.slice(0, -2) + (body.data.endsWith('00') ? '01' : '00');
ok(!verifyNemSignature(s.signerPublicKey, nemHexToBytes(tampered), nemHexToBytes(body.signature)), 'a changed byte breaks the signature');

// the QR carries exactly the announce body
const qr = parseNemSigned(buildNemSignedQr(bodyText, TESTNET));
ok(qr !== null && qr.body.data === body.data.toUpperCase() && qr.body.signature === body.signature.toUpperCase(), 'QR round trip');

// mosaics (version 2)
const lines = [{ id: 'ns.sub:token', quantity: 12_345n }, { id: NEM_XEM_MOSAIC_ID, quantity: 2_500_000n }];
const infos = { 'ns.sub:token': { supply: 1_000_000n, divisibility: 2 } };
const fee2 = nemSendFee(TESTNET, lines, infos, undefined);
const m = readNemTransfer((JSON.parse(signNemTransfer(priv, { publicKey: pub, networkByte: TESTNET, recipient, amount: 0n, mosaics: lines, fee: fee2 })) as { data: string }).data);
ok(m.version === 2 && m.transfer?.mosaics.length === 2, 'v2: mosaics', m.transfer?.mosaics);
ok(m.transfer?.mosaics[0].id === 'ns.sub:token' && m.transfer.mosaics[0].quantity === 12_345n && m.transfer.mosaics[1].quantity === 2_500_000n, 'v2: ids and quantities');
ok(m.deadlineMs - m.timestampMs === 2 * 3600 * 1000, 'default validity is still 2 hours');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
