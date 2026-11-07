// NEM: モザイクを添付した送金（TransferTransactionV2）の組み立て・署名・手数料。
// Run: npx tsx dev-tests/nem-mosaic-transfer.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/nem';
import { nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import {
  NEM_XEM_MOSAIC_ID, nemMosaicTransferFee, nemSendFee, nemTransferFee, normalizeNemTransferMosaics, signNemTransfer, splitNemMosaicId,
} from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
function throws(fn: () => unknown, what: string) { let t = false; try { fn(); } catch { t = true; } ok(t, what); }

const TESTNET = 0x98;
const priv = '0000000000000000000000000000000000000000000000000000000000000001';
const kp = new KeyPair(new PrivateKey(priv));
const pub = kp.publicKey.toString();
const recipient = nemAddressFromPublicKey(new KeyPair(new PrivateKey('00000000000000000000000000000000000000000000000000000000000000AA')).publicKey.toString(), TESTNET);

// --- ids and normalisation
ok(JSON.stringify(splitNemMosaicId('foo.bar:baz')) === '{"namespace":"foo.bar","name":"baz"}', 'dotted namespace is kept whole');
throws(() => splitNemMosaicId('nocolon'), 'id without a colon is rejected');
throws(() => splitNemMosaicId('ns:'), 'id without a name is rejected');
ok(normalizeNemTransferMosaics([{ id: NEM_XEM_MOSAIC_ID, quantity: 5_000_000n }]).mosaics === undefined, 'a single XEM line is a plain transfer');
ok(normalizeNemTransferMosaics([{ id: NEM_XEM_MOSAIC_ID, quantity: 5_000_000n }]).amount === 5_000_000n, '… with its amount');
ok(normalizeNemTransferMosaics([{ id: 'ns:a', quantity: 1n }]).mosaics?.length === 1, 'a custom mosaic is a mosaic transfer');
ok(normalizeNemTransferMosaics([{ id: NEM_XEM_MOSAIC_ID, quantity: 1n }, { id: 'ns:a', quantity: 1n }]).mosaics?.length === 2, 'XEM + mosaic keeps XEM as an attached mosaic');
throws(() => normalizeNemTransferMosaics([]), 'nothing to send');
ok(normalizeNemTransferMosaics([{ id: 'ns:a', quantity: 0n }]).mosaics?.length === 1, 'zero quantity is allowed');
ok(normalizeNemTransferMosaics([{ id: NEM_XEM_MOSAIC_ID, quantity: 0n }]).amount === 0n, 'a 0 XEM transfer is allowed (plain)');
throws(() => normalizeNemTransferMosaics([{ id: 'ns:a', quantity: -1n }]), 'negative quantity');
throws(() => normalizeNemTransferMosaics([{ id: 'ns:a', quantity: 1n }, { id: 'ns:a', quantity: 2n }]), 'duplicated mosaic');

// --- fees (the SDK's calculator is the reference)
const small = { supply: 1000n, divisibility: 0 }; // small-business mosaic: one unit
ok(nemMosaicTransferFee(TESTNET, [{ id: 'ns:a', quantity: 3n }], { 'ns:a': small }, undefined) === 50_000n, 'small-business mosaic costs 0.05 XEM');
ok(nemMosaicTransferFee(TESTNET, [{ id: 'ns:a', quantity: 3n }], { 'ns:a': small }, 'x'.repeat(40)) === 150_000n, '… plus 0.05 XEM per 32 bytes of message (40 bytes = 2 units)');
ok(nemMosaicTransferFee(TESTNET, [{ id: 'ns:a', quantity: 3n }, { id: 'ns:b', quantity: 1n }], { 'ns:a': small, 'ns:b': small }, undefined) === 100_000n, 'each mosaic adds its own fee');
for (const xem of [1n, 9_999n, 10_000n, 50_000n, 1_000_000n]) {
  const micro = xem * 1_000_000n;
  ok(nemMosaicTransferFee(TESTNET, [{ id: NEM_XEM_MOSAIC_ID, quantity: micro }], {}, undefined) === nemTransferFee(micro, undefined), `XEM as a mosaic costs what a plain transfer of ${xem} XEM costs`);
}
ok(nemSendFee(TESTNET, [{ id: NEM_XEM_MOSAIC_ID, quantity: 2_000_000n }], {}, undefined) === nemTransferFee(2_000_000n, undefined), 'nemSendFee: XEM only = plain formula');
throws(() => nemMosaicTransferFee(TESTNET, [{ id: 'ns:unknown', quantity: 1n }], {}, undefined), 'a mosaic with no definition cannot be priced');

// --- the signed transaction
const lines = [{ id: 'ns.sub:token', quantity: 12_345n }, { id: NEM_XEM_MOSAIC_ID, quantity: 2_500_000n }];
const infos = { 'ns.sub:token': { supply: 1_000_000n, divisibility: 2 } };
const fee = nemMosaicTransferFee(TESTNET, lines, infos, 'hello');
const body = JSON.parse(signNemTransfer(priv, { publicKey: pub, networkByte: TESTNET, recipient, amount: 0n, mosaics: lines, message: 'hello', fee }));
const bytes = Uint8Array.from((body.data as string).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
const tx = models.NonVerifiableTransferTransactionV2.deserialize(bytes);
ok(tx.version === 2 && tx.network === models.NetworkType.TESTNET, 'version 2 transfer on the test network', [tx.version, tx.network]);
ok(tx.fee.value === fee, 'the fee in the transaction is the one computed', tx.fee.value);
ok(tx.amount.value === 1_000_000n, 'multiplier is x1');
ok(tx.mosaics.length === 2, 'both mosaics are attached', tx.mosaics.length);
const dec = new TextDecoder();
const got = tx.mosaics.map((m) => `${dec.decode(m.mosaic.mosaicId.namespaceId.name)}:${dec.decode(m.mosaic.mosaicId.name)}=${m.mosaic.amount.value}`);
ok(got[0] === 'ns.sub:token=12345' && got[1] === 'nem:xem=2500000', 'ids and atomic quantities survive', got);
ok(dec.decode(tx.message!.message) === 'hello', 'message kept');
// a deserialized NEM address is the ASCII bytes of the base32 text
ok(dec.decode(Uint8Array.from(tx.recipientAddress.toString().match(/.{2}/g)!.map((h) => parseInt(h, 16)))) === recipient, 'recipient kept');
ok(typeof body.signature === 'string' && body.signature.length === 128, 'signed');

// a plain XEM transfer still goes out as version 1
const plain = JSON.parse(signNemTransfer(priv, { publicKey: pub, networkByte: TESTNET, recipient, amount: 3_000_000n, fee: nemTransferFee(3_000_000n, undefined) }));
const plainTx = models.NonVerifiableTransferTransactionV1.deserialize(Uint8Array.from((plain.data as string).match(/.{2}/g)!.map((h) => parseInt(h, 16))));
ok(plainTx.version === 1 && plainTx.amount.value === 3_000_000n, 'XEM-only transfer is unchanged (version 1)');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
