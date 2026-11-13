// NEM: 暗号化メッセージ（NanoWallet 互換の AES-CBC 形式）の送信と復号。
// Run: npx tsx dev-tests/nem-encrypted-message.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, MessageEncoder, models } from 'symbol-sdk/nem';
import { nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import {
  NEM_MAX_ENCRYPTED_MESSAGE_BYTES, decryptNemMessage, encryptNemMessage, nemEncryptedPayloadLength,
} from '../src/lib/nem/message';
import { nemMosaicTransferFee, nemTransferFee, signNemTransfer } from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

const aPriv = '0000000000000000000000000000000000000000000000000000000000000001';
const bPriv = '00000000000000000000000000000000000000000000000000000000000000AA';
const cPriv = '00000000000000000000000000000000000000000000000000000000000000CC';
const keyOf = (priv: string) => new KeyPair(new PrivateKey(priv)).publicKey.toString();
const aPub = keyOf(aPriv), bPub = keyOf(bPriv), cPub = keyOf(cPriv);

// --- round trip, both sides can read it
const text = 'こんにちは NEM 🎌 secret';
const payload = encryptNemMessage(aPriv, bPub, text);
ok(decryptNemMessage(bPriv, aPub, hex(payload)) === text, 'the recipient reads it (with the sender public key)');
ok(decryptNemMessage(aPriv, bPub, hex(payload)) === text, 'the sender reads it back (with the recipient public key)');
ok(decryptNemMessage(cPriv, aPub, hex(payload)) === null, 'a third account cannot read it');
ok(decryptNemMessage(bPriv, cPub, hex(payload)) === null, 'the wrong counterparty key does not open it');
ok(decryptNemMessage(bPriv, aPub, hex(payload).slice(0, -2)) === null, 'a damaged payload is refused, not misread');
ok(hex(encryptNemMessage(aPriv, bPub, text)) !== hex(payload), 'every encryption uses a fresh salt / iv');

// --- NanoWallet's format: salt (32) + iv (16) + AES-CBC, not the SDK's newer AES-GCM layout
for (const n of [1, 15, 16, 17, 100, 975]) {
  const p = encryptNemMessage(aPriv, bPub, 'a'.repeat(n));
  ok(p.length === nemEncryptedPayloadLength(n), `payload length for ${n} bytes of text`, [p.length, nemEncryptedPayloadLength(n)]);
  ok((p.length - 48) % 16 === 0 && p.length >= 64, `CBC layout for ${n} bytes`, p.length);
}
ok(nemEncryptedPayloadLength(975) <= 1024 && nemEncryptedPayloadLength(976) > 1024, 'the longest text still fits in 1024 bytes of payload');
ok(NEM_MAX_ENCRYPTED_MESSAGE_BYTES === 975, 'limit is 975 bytes of text', NEM_MAX_ENCRYPTED_MESSAGE_BYTES);
let tooLong = false;
try { encryptNemMessage(aPriv, bPub, 'a'.repeat(976)); } catch { tooLong = true; }
ok(tooLong, 'text over the limit is refused');
// messages the SDK writes in the new (GCM) layout can still be read
const gcm = new MessageEncoder(new KeyPair(new PrivateKey(aPriv))).encode(new (await import('symbol-sdk')).PublicKey(bPub), new TextEncoder().encode('gcm'));
ok(decryptNemMessage(bPriv, aPub, hex(Uint8Array.from(gcm.message))) === 'gcm', 'a GCM-format message is also opened');

// --- fee follows the encrypted size
ok(nemTransferFee(0n, 'a'.repeat(10), true) === 50_000n * (1n + BigInt(Math.floor(nemEncryptedPayloadLength(10) / 32) + 1)), 'encrypted message fee uses the payload size');
ok(nemTransferFee(0n, 'a'.repeat(10), true) > nemTransferFee(0n, 'a'.repeat(10), false), 'an encrypted message costs more than its plain text');
const small = { supply: 1000n, divisibility: 0 };
ok(nemMosaicTransferFee(0x98, [{ id: 'ns:a', quantity: 1n }], { 'ns:a': small }, 'a'.repeat(10), true) === 50_000n * (1n + BigInt(Math.floor(nemEncryptedPayloadLength(10) / 32) + 1)), 'the same for a mosaic transfer');

// --- the signed transaction carries a type 2 message that the recipient can open
const recipient = nemAddressFromPublicKey(bPub, 0x98);
const fee = nemTransferFee(1_000_000n, text, true);
const body = JSON.parse(signNemTransfer(aPriv, { publicKey: aPub, networkByte: 0x98, recipient, amount: 1_000_000n, encryptedMessage: payload, fee }));
const tx = models.NonVerifiableTransferTransactionV1.deserialize(unhex(body.data));
ok(tx.message?.messageType.value === 2, 'message type is 2 (encrypted)', tx.message?.messageType);
ok(hex(Uint8Array.from(tx.message!.message)) === hex(payload), 'payload is what was encrypted');
ok(decryptNemMessage(bPriv, aPub, hex(Uint8Array.from(tx.message!.message))) === text, 'and it opens');
// the plain path is unchanged
const plain = JSON.parse(signNemTransfer(aPriv, { publicKey: aPub, networkByte: 0x98, recipient, amount: 1_000_000n, message: 'hi', fee: 100_000n }));
const plainTx = models.NonVerifiableTransferTransactionV1.deserialize(unhex(plain.data));
ok(plainTx.message?.messageType.value === 1 && new TextDecoder().decode(plainTx.message.message) === 'hi', 'plain message stays type 1');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
