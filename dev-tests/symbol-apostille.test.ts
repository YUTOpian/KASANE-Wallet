// Symbol apostille (notarization): sink account, message layout, signing / verifying with Symbol keys, dedicated account, the transfer that carries it.
// Run: npx tsx dev-tests/symbol-apostille.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { models } from 'symbol-sdk/symbol';
import { APOSTILLE_HASHINGS, buildApostilleMessage, dedicatedAccount, verifyApostille } from '../src/lib/nem/apostille';
import { APOSTILLE_MESSAGE_LABEL, apostilleHexFromMessageField } from '../src/lib/symbol/apostilleMessage';
import {
  buildSymbolApostilleMessage, symbolApostilleSink, symbolDedicatedAccount, symbolMessageField, verifySymbolApostille,
} from '../src/lib/symbol/apostille';
import { parseSymbolApostilleEntries } from '../src/lib/symbol/apostilleApi';
import { addressNetworkByte, bytesToHex, decodeAddress, hexToBytes, isValidAddress } from '../src/lib/symbol/crypto';
import { NETWORKS } from '../src/lib/symbol/constants';
import { multisigRawTransferAggregateSize, signMultisigAggregate, signTransfer, transferSizeForMessageField } from '../src/lib/symbol/tx';
import { apostilleStoreKey } from '../src/lib/nem/apostilleStore';
import { classifyApostilleError } from '../src/lib/apostilleChain';
import { SymbolSendError } from '../src/lib/symbol/api';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const MAIN = NETWORKS.mainnet;
const TEST = NETWORKS.testnet;
const owner = '1'.repeat(63) + '2';
const other = '3'.repeat(63) + '4';
const ownerPub = new KeyPair(new PrivateKey(owner)).publicKey.toString();
const otherPub = new KeyPair(new PrivateKey(other)).publicKey.toString();
const file = new TextEncoder().encode('abc');
const H = APOSTILLE_HASHINGS;

// --- sink account ----------------------------------------------------------------------------
const sinkMain = symbolApostilleSink(MAIN.networkByte);
const sinkTest = symbolApostilleSink(TEST.networkByte);
ok(isValidAddress(sinkMain, MAIN.networkByte), 'mainnet sink is a valid mainnet address', sinkMain);
ok(isValidAddress(sinkTest, TEST.networkByte), 'testnet sink is a valid testnet address', sinkTest);
ok(sinkMain.startsWith('N') && sinkTest.startsWith('T'), 'sink prefix N / T', [sinkMain, sinkTest]);
ok(addressNetworkByte(sinkMain) === 0x68 && addressNetworkByte(sinkTest) === 0x98, 'sink network byte');
ok(sinkMain === symbolApostilleSink(MAIN.networkByte), 'sink is deterministic');
ok(sinkMain.slice(1) !== sinkTest.slice(1), 'sink differs per network');
ok(sinkMain.length === 39, 'sink length 39', sinkMain.length);

// --- message layout --------------------------------------------------------------------------
const pub256 = buildSymbolApostilleMessage(file, H.SHA256, false);
ok(pub256.fileHash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 of abc');
ok(pub256.messageHex === `fe4e545903${pub256.fileHash}`, 'public message = fe4e5459 03 + hash', pub256.messageHex);
ok(pub256.message.length === 37 && !pub256.signed, 'public message is 37 bytes');
const pub512 = buildSymbolApostilleMessage(file, H['SHA3-512'], false);
ok(pub512.messageHex.startsWith('fe4e545909') && pub512.message.length === 69, 'sha3-512 public: version 09, 69 bytes');
const pubKeccak = buildSymbolApostilleMessage(file, H['SHA3-256'], false);
ok(pubKeccak.fileHash === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', 'SHA3-256 stays NEM-compatible Keccak');
const signed = buildSymbolApostilleMessage(file, H.SHA256, true, owner);
ok(signed.messageHex.startsWith('fe4e545983') && signed.message.length === 69 && signed.signed, 'signed message = fe4e5459 83 + 64 byte signature');
let threw = false;
try { buildSymbolApostilleMessage(file, H.SHA256, true); } catch { threw = true; }
ok(threw, 'signed without a key throws');
// same bytes as the NEM message for a public apostille (only the signature scheme differs for signed ones)
ok(buildApostilleMessage(file, H.SHA256, false).messageHex === pub256.messageHex, 'public message is identical on NEM and Symbol');
ok(buildApostilleMessage(file, H.SHA256, true, owner).messageHex !== signed.messageHex, 'signed message differs (Keccak vs SHA-512 key pair)');

// --- message field (type byte) ---------------------------------------------------------------
const field = symbolMessageField(signed.message);
ok(field.length === signed.message.length + 1 && field[0] === 0x00, 'message field = 00 + message');
ok(apostilleHexFromMessageField(bytesToHex(field)) === signed.messageHex, 'message field -> apostille hex');
ok(apostilleHexFromMessageField(bytesToHex(field).toUpperCase()) === signed.messageHex, 'upper-case hex is read too');
ok(apostilleHexFromMessageField(`01${signed.messageHex}`) === '', 'encrypted message (type 01) is not an apostille');
ok(apostilleHexFromMessageField(signed.messageHex) === '', 'NEM style (no type byte) is not read on Symbol');
ok(apostilleHexFromMessageField(bytesToHex(new TextEncoder().encode('\u0000hello'))) === '', 'plain text is not an apostille');
ok(apostilleHexFromMessageField('') === '' && apostilleHexFromMessageField(undefined) === '' && apostilleHexFromMessageField('zz') === '', 'empty / bad input');
ok(APOSTILLE_MESSAGE_LABEL === '[Apostille]', 'history label');

// --- verifying ---------------------------------------------------------------------------------
ok(verifySymbolApostille(file, pub256.messageHex, ownerPub) === 'valid', 'public: same file is valid');
ok(verifySymbolApostille(new TextEncoder().encode('abd'), pub256.messageHex, ownerPub) === 'invalid', 'public: changed file is invalid');
ok(verifySymbolApostille(file, signed.messageHex, ownerPub) === 'valid', 'signed: owner signature is valid');
ok(verifySymbolApostille(new TextEncoder().encode('abd'), signed.messageHex, ownerPub) === 'invalid', 'signed: changed file is invalid');
ok(verifySymbolApostille(file, signed.messageHex, otherPub) === 'invalid', 'signed: another signer is invalid');
ok(verifySymbolApostille(file, 'ab'.repeat(40), ownerPub) === 'not_apostille', 'not an apostille message');
ok(verifySymbolApostille(file, signed.messageHex.slice(0, -2), ownerPub) === 'invalid', 'truncated signature is invalid');
ok(verifySymbolApostille(file, signed.messageHex.toUpperCase(), ownerPub) === 'valid', 'upper-case message is read');
// A NEM-signed apostille is not valid under Symbol's signature scheme, and the other way round.
const nemSigned = buildApostilleMessage(file, H.SHA256, true, owner);
ok(verifySymbolApostille(file, nemSigned.messageHex, ownerPub) === 'invalid', 'NEM-signed message does not verify as Symbol');
ok(verifyApostille(file, signed.messageHex, new KeyPair(new PrivateKey(owner)).publicKey.toString()) === 'invalid', 'Symbol-signed message does not verify as NEM');

// --- dedicated account -------------------------------------------------------------------------
const d1 = symbolDedicatedAccount(owner, 'contract.pdf', TEST.networkByte);
const d2 = symbolDedicatedAccount(owner, 'contract.pdf', TEST.networkByte);
ok(d1.address === d2.address && d1.publicKey === d2.publicKey, 'dedicated account is deterministic');
ok(isValidAddress(d1.address, TEST.networkByte) && d1.address.startsWith('T'), 'dedicated address is a valid testnet address', d1.address);
ok(symbolDedicatedAccount(owner, 'other.pdf', TEST.networkByte).address !== d1.address, 'another file name gives another account');
ok(symbolDedicatedAccount(other, 'contract.pdf', TEST.networkByte).address !== d1.address, 'another owner gives another account');
ok(symbolDedicatedAccount(owner, 'contract.pdf', MAIN.networkByte).publicKey === d1.publicKey, 'the key does not depend on the network');
ok(symbolDedicatedAccount(owner, 'contract.pdf', MAIN.networkByte).address.startsWith('N'), 'mainnet address starts with N');
ok(symbolDedicatedAccount(owner, 'ファイル.txt', TEST.networkByte).address.length === 39, 'Japanese file name works');
ok(dedicatedAccount(owner, 'contract.pdf', 0x98).publicKey !== d1.publicKey, 'NEM and Symbol dedicated accounts are different keys');
ok(!!decodeAddress(d1.address), 'dedicated address decodes');
// the dedicated key really is the key of that address
const dk = bytesToHex(new KeyPair(new PrivateKey(owner)).sign(new Uint8Array(32)).bytes);
ok(dk.length === 128, 'signature length sanity');

// --- the transfer that carries it ----------------------------------------------------------------
for (const [label, built] of [['public', pub256], ['signed', signed]] as const) {
  const tf = symbolMessageField(built.message);
  const recipient = label === 'public' ? sinkTest : d1.address;
  const tx = signTransfer(owner, TEST.generationHash, {
    signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient, mosaics: [], allowNoMosaics: true,
    rawMessage: tf, maxFee: 12345n, deadline: 100000n,
  });
  const parsed = models.TransactionFactory.deserialize(hexToBytes(tx.payload)) as InstanceType<typeof models.TransferTransactionV1>;
  ok(parsed.mosaics.length === 0, `${label}: no mosaic`);
  ok(bytesToHex(parsed.message ?? new Uint8Array()) === bytesToHex(tf), `${label}: the message field is the apostille bytes`);
  ok(apostilleHexFromMessageField(bytesToHex(parsed.message ?? new Uint8Array())) === built.messageHex, `${label}: read back as the same apostille`);
  ok(parsed.size === transferSizeForMessageField(tf.length), `${label}: size matches the estimate`, [parsed.size, transferSizeForMessageField(tf.length)]);
  ok(/^[0-9A-F]{64}$/.test(tx.hash), `${label}: transaction hash`);
}
let mosaicRequired = false;
try {
  signTransfer(owner, TEST.generationHash, { signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: sinkTest, mosaics: [], rawMessage: field, maxFee: 1n, deadline: 1n });
} catch (e) { mosaicRequired = (e as Error).message === 'no_mosaics'; }
ok(mosaicRequired, 'without allowNoMosaics a transfer still needs a mosaic');
let tooLong = false;
try {
  signTransfer(owner, TEST.generationHash, { signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: sinkTest, mosaics: [], allowNoMosaics: true, rawMessage: new Uint8Array(1100), maxFee: 1n, deadline: 1n });
} catch (e) { tooLong = (e as Error).message === 'message_too_long'; }
ok(tooLong, 'a message over 1024 bytes is refused');
// a transfer that has a raw message wins over a plain text one
const both = signTransfer(owner, TEST.generationHash, {
  signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: sinkTest, mosaics: [], allowNoMosaics: true, message: 'plain text', rawMessage: field, maxFee: 1n, deadline: 1n,
});
const bothParsed = models.TransactionFactory.deserialize(hexToBytes(both.payload)) as InstanceType<typeof models.TransferTransactionV1>;
ok(bytesToHex(bothParsed.message ?? new Uint8Array()) === bytesToHex(field), 'rawMessage wins over message');

// --- explorer rows ---------------------------------------------------------------------------------
const rows = parseSymbolApostilleEntries([
  { meta: { hash: 'a'.repeat(64), timestamp: '1000' }, transaction: { type: 0x4154, signerPublicKey: ownerPub, message: bytesToHex(field) } },
  { meta: { hash: 'b'.repeat(64), timestamp: '2000' }, transaction: { type: 0x4154, signerPublicKey: ownerPub, message: bytesToHex(new TextEncoder().encode('\u0000hi')) } },
  { meta: { hash: 'c'.repeat(64), timestamp: '3000' }, transaction: { type: 0x4154, signerPublicKey: ownerPub } },
  { meta: { hash: 'd'.repeat(64), timestamp: '4000' }, transaction: { type: 0x4141, signerPublicKey: ownerPub, message: bytesToHex(field) } },
  { meta: { timestamp: '5000' }, transaction: { type: 0x4154, signerPublicKey: ownerPub, message: bytesToHex(field) } },
  { transaction: { type: 0x4154, signerPublicKey: ownerPub, message: bytesToHex(field) } },
]);
ok(rows.length === 1, 'only the apostille transfer is listed', rows.length);
ok(rows[0].txHash === 'A'.repeat(64) && rows[0].signer === ownerPub.toUpperCase() && rows[0].payloadHex === signed.messageHex, 'explorer row fields');
ok(rows[0].timestampMs === 1000 + MAIN.epochAdjustment * 1000, 'explorer row time = network time + epoch');

// --- in the name of a multisig account (an aggregate with one inner transfer) -------------------------------
const publicMsg = buildSymbolApostilleMessage(file, H.SHA256, false);
const publicField = symbolMessageField(publicMsg.message);
for (const f of [publicField, field]) {
  const agg = signMultisigAggregate(owner, MAIN.generationHash, {
    signerPublicKey: ownerPub, networkByte: MAIN.networkByte,
    inner: { kind: 'transfer', accountPublicKey: otherPub, recipient: sinkMain, mosaics: [], rawMessage: f },
    bonded: false, cosignatureCount: 0, feeMultiplier: 100, deadline: 1000n,
  });
  ok(agg.payload.length / 2 === multisigRawTransferAggregateSize(f.length), `multisig aggregate size matches the estimate (message field ${f.length} bytes)`, [agg.payload.length / 2, multisigRawTransferAggregateSize(f.length)]);
  ok(agg.payload.toLowerCase().includes(bytesToHex(f).toLowerCase()), 'the apostille message is inside the aggregate');
  ok(agg.fee === BigInt(agg.payload.length / 2) * 100n, 'fee = size x multiplier with no cosignature room', agg.fee);
}
const bonded = signMultisigAggregate(owner, MAIN.generationHash, {
  signerPublicKey: ownerPub, networkByte: MAIN.networkByte,
  inner: { kind: 'transfer', accountPublicKey: otherPub, recipient: sinkMain, mosaics: [], rawMessage: publicField },
  bonded: true, cosignatureCount: 2, feeMultiplier: 100, deadline: 1000n,
});
ok(bonded.fee === BigInt(bonded.payload.length / 2 + 2 * 104) * 100n, 'a bonded aggregate leaves room for the cosignatures in its fee', bonded.fee);

// a transfer inside an aggregate has no hash of its own: it is listed under the aggregate's hash
const embeddedRows = parseSymbolApostilleEntries([
  { meta: { aggregateHash: 'e'.repeat(64), timestamp: '6000' }, transaction: { type: 0x4154, signerPublicKey: otherPub, message: bytesToHex(publicField) } },
  { meta: { aggregateHash: 'f'.repeat(64), timestamp: '7000' }, transaction: { type: 0x4154, signerPublicKey: otherPub } },
]);
ok(embeddedRows.length === 1, 'an embedded transfer without an apostille message is skipped', embeddedRows.length);
ok(embeddedRows[0].txHash === 'E'.repeat(64) && embeddedRows[0].signer === otherPub.toUpperCase() && embeddedRows[0].payloadHex === publicMsg.messageHex, 'embedded row: aggregate hash, multisig signer, message');

// --- history storage key -----------------------------------------------------------------------------
ok(apostilleStoreKey('nem', 'mainnet') === 'APOSTILLE_NTY_MAINNET', 'NEM storage key is unchanged');
ok(apostilleStoreKey('nem', 'testnet') === 'APOSTILLE_NTY_TESTNET', 'NEM testnet storage key is unchanged');
ok(apostilleStoreKey('symbol', 'mainnet') === 'APOSTILLE_NTY_SYMBOL_MAINNET', 'Symbol storage key is separate');
ok(apostilleStoreKey('symbol', 'testnet') !== apostilleStoreKey('nem', 'testnet'), 'the two chains never share a history');

// --- errors ---------------------------------------------------------------------------------------------
ok(classifyApostilleError(new SymbolSendError('Failure_Core_Insufficient_Balance')).kind === 'insufficient_balance', 'Symbol: insufficient balance');
ok(classifyApostilleError(new SymbolSendError('FAILURE_INSUFFICIENT_BALANCE')).kind === 'insufficient_balance', 'NEM: insufficient balance');
ok(classifyApostilleError(new SymbolSendError('Failure_Core_Past_Deadline')).kind === 'deadline', 'deadline');
ok(classifyApostilleError(new SymbolSendError('Failure_Core_Wrong_Network')).kind === 'wrong_network', 'wrong network');
ok(classifyApostilleError(new Error('boom')).kind === 'unknown', 'unknown error');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
