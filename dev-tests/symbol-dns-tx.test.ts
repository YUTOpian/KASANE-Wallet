// Symbol DNS（SDK を使う部分）: ポインタアカウントのアドレス、DNS レコードを運ぶ送金、マルチシグ名義のアグリゲート、サイズの見積もり。
// Run: npx tsx dev-tests/symbol-dns-tx.test.ts
// 通信のいらない部分（名前、メッセージの読み取り、履歴からの検索）は dev-tests/symbol-dns.test.ts。
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/symbol';
import { buildNemDnsMessage, emptyNemDnsRecord } from '../src/lib/nem/dns';
import {
  SYMBOL_DNS_MAX_MESSAGE_BYTES, findSymbolDnsRecord, plainTextOfMessageField, symbolDnsPointerPrivateKey,
} from '../src/lib/symbol/dns';
import { symbolDnsPointer } from '../src/lib/symbol/dnsApi';
import { symbolMessageField } from '../src/lib/symbol/apostille';
import { addressFromPublicKey, bytesToHex, decodeAddress, hexToBytes, isValidAddress } from '../src/lib/symbol/crypto';
import { NETWORKS } from '../src/lib/symbol/constants';
import { MAX_MESSAGE_BYTES, multisigRawTransferAggregateSize, signMultisigAggregate, signTransfer, transferSizeForMessageField } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const MAIN = NETWORKS.mainnet;
const TEST = NETWORKS.testnet;
const owner = '1'.repeat(63) + '2';
const other = '3'.repeat(63) + '4';
const ownerPub = new KeyPair(new PrivateKey(owner)).publicKey.toString();
const otherPub = new KeyPair(new PrivateKey(other)).publicKey.toString();

// --- the limit is the transfer's own
ok(SYMBOL_DNS_MAX_MESSAGE_BYTES === MAX_MESSAGE_BYTES, 'the DNS message limit is the transfer\'s message limit', [SYMBOL_DNS_MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES]);

// --- the pointer account
const main = symbolDnsPointer('kasane', MAIN.networkByte);
const test = symbolDnsPointer('kasane', TEST.networkByte);
const expectedPub = new KeyPair(new PrivateKey(symbolDnsPointerPrivateKey('kasane'))).publicKey.toString().toUpperCase();
ok(main.publicKey.toUpperCase() === expectedPub, 'the pointer\'s public key comes from the pointer private key (Symbol key pair)', main.publicKey);
ok(main.publicKey === test.publicKey, 'the same name has the same key on every network');
ok(main.address !== test.address, 'but not the same address');
ok(main.address.startsWith('N') && isValidAddress(main.address, MAIN.networkByte), 'mainnet pointer address', main.address);
ok(test.address.startsWith('T') && isValidAddress(test.address, TEST.networkByte), 'testnet pointer address', test.address);
ok(main.address === addressFromPublicKey(main.publicKey, MAIN.networkByte), 'the address is the address of the public key');
ok(symbolDnsPointer('kasane', MAIN.networkByte).address === main.address, 'deterministic');
ok(symbolDnsPointer('kasane2', MAIN.networkByte).address !== main.address, 'another name, another pointer');
ok(symbolDnsPointer('alice.bob', MAIN.networkByte).namespace === 'alice.bob', 'a sub-namespace has its own pointer');

// --- a transfer that carries a record, and the record read back the way the node would hand it over
const record = { ...emptyNemDnsRecord(), ip1: 'example.com', organization: 'KASANE', email: 'info@example.com', other: '日本語のメモ' };
const text = buildNemDnsMessage(record);
const bytes = new TextEncoder().encode(text);
const field = symbolMessageField(bytes);
const tx = signTransfer(owner, TEST.generationHash, {
  signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: test.address, mosaics: [], allowNoMosaics: true,
  rawMessage: field, maxFee: 12345n, deadline: 100000n,
});
const parsed = models.TransactionFactory.deserialize(hexToBytes(tx.payload)) as InstanceType<typeof models.TransferTransactionV1>;
ok(parsed.mosaics.length === 0, 'no mosaic: only the fee is spent');
ok(bytesToHex(Uint8Array.from(parsed.recipientAddress.bytes)).toUpperCase() === bytesToHex(decodeAddress(test.address) ?? new Uint8Array()).toUpperCase(), 'sent to the pointer account');
ok(bytesToHex(parsed.message ?? new Uint8Array()) === bytesToHex(field), 'the message field is the type byte 00 and the DNS JSON');
ok((parsed.message ?? new Uint8Array())[0] === 0x00, 'a plain message');
ok(parsed.size === transferSizeForMessageField(field.length), 'size matches the estimate (the fee is quoted from it)', [parsed.size, transferSizeForMessageField(field.length)]);

const pointerHex = bytesToHex(decodeAddress(test.address) ?? new Uint8Array()).toUpperCase();
const addressOf = (publicKey: string) => addressFromPublicKey(publicKey, TEST.networkByte);
const asNode = (signer: string) => ({
  meta: { hash: tx.hash, height: '10', index: 0, timestamp: '1000' },
  transaction: { type: 0x4154, signerPublicKey: signer, recipientAddress: pointerHex, message: bytesToHex(parsed.message ?? new Uint8Array()).toUpperCase() },
});
ok(plainTextOfMessageField(bytesToHex(parsed.message ?? new Uint8Array())) === text, 'the text is read back from the message field');
const found = findSymbolDnsRecord([asNode(ownerPub)], addressOf(ownerPub), pointerHex, addressOf);
ok(found !== null && found.record.ip1 === 'example.com' && found.record.other === '日本語のメモ' && found.record.email === 'info@example.com', 'the record is found when the owner sent it', found);
ok(findSymbolDnsRecord([asNode(otherPub)], addressOf(ownerPub), pointerHex, addressOf) === null, 'the same record sent by someone else is ignored');

// --- the size limit: 1023 bytes of text go, 1024 do not
function recordOfBytes(size: number) {
  const base = new TextEncoder().encode(buildNemDnsMessage({ ...emptyNemDnsRecord(), other: 'a' })).length;
  return { ...emptyNemDnsRecord(), other: 'a'.repeat(1 + size - base) };
}
const biggest = new TextEncoder().encode(buildNemDnsMessage(recordOfBytes(SYMBOL_DNS_MAX_MESSAGE_BYTES)));
ok(biggest.length === SYMBOL_DNS_MAX_MESSAGE_BYTES, 'a record of exactly 1023 bytes', biggest.length);
const bigField = symbolMessageField(biggest);
const bigTx = signTransfer(owner, TEST.generationHash, {
  signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: test.address, mosaics: [], allowNoMosaics: true, rawMessage: bigField, maxFee: 1n, deadline: 1n,
});
const bigParsed = models.TransactionFactory.deserialize(hexToBytes(bigTx.payload)) as InstanceType<typeof models.TransferTransactionV1>;
ok(bigParsed.size === transferSizeForMessageField(1024), 'the biggest record is a 1184-byte transfer', bigParsed.size);
let refused = false;
try {
  signTransfer(owner, TEST.generationHash, {
    signerPublicKey: ownerPub, networkByte: TEST.networkByte, recipient: test.address, mosaics: [], allowNoMosaics: true,
    rawMessage: symbolMessageField(new Uint8Array(SYMBOL_DNS_MAX_MESSAGE_BYTES + 1)), maxFee: 1n, deadline: 1n,
  });
} catch (e) { refused = (e as Error).message === 'message_too_long'; }
ok(refused, 'a record of 1024 bytes is refused');

// --- in the name of a multisig account: an aggregate whose inner transfer is signed by the multisig account
for (const f of [field, bigField]) {
  const agg = signMultisigAggregate(owner, MAIN.generationHash, {
    signerPublicKey: ownerPub, networkByte: MAIN.networkByte,
    inner: { kind: 'transfer', accountPublicKey: otherPub, recipient: main.address, mosaics: [], rawMessage: f },
    bonded: false, cosignatureCount: 0, feeMultiplier: 100, deadline: 1000n,
  });
  ok(agg.payload.length / 2 === multisigRawTransferAggregateSize(f.length), `aggregate size matches the estimate (message field ${f.length} bytes)`, [agg.payload.length / 2, multisigRawTransferAggregateSize(f.length)]);
  ok(agg.payload.toLowerCase().includes(bytesToHex(f).toLowerCase()), 'the DNS message is inside the aggregate');
  ok(agg.payload.toLowerCase().includes(otherPub.toLowerCase()), 'the inner transfer is signed by the multisig account (its public key is in the aggregate)');
}
const bonded = signMultisigAggregate(owner, MAIN.generationHash, {
  signerPublicKey: ownerPub, networkByte: MAIN.networkByte,
  inner: { kind: 'transfer', accountPublicKey: otherPub, recipient: main.address, mosaics: [], rawMessage: field },
  bonded: true, cosignatureCount: 2, feeMultiplier: 100, deadline: 1000n,
});
ok(bonded.fee === BigInt(bonded.payload.length / 2 + 2 * 104) * 100n, 'a bonded aggregate leaves room for the cosignatures in its fee', bonded.fee);

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
