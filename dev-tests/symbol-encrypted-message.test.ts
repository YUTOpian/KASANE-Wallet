// Encrypted transfer messages (Symbol): encrypt -> sign -> read back from either side.
// Run: npx tsx dev-tests/symbol-encrypted-message.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex } from '../src/lib/symbol/crypto';
import {
  ENCRYPTED_MESSAGE_OVERHEAD, MAX_ENCRYPTED_MESSAGE_BYTES, decryptMessage, encryptMessage, parseTransferPayload, signTransfer, transferSize,
} from '../src/lib/symbol/tx';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const alice = new KeyPair(PrivateKey.random());
const bob = new KeyPair(PrivateKey.random());
const eve = new KeyPair(PrivateKey.random());
const aliceSk = alice.privateKey.toString();
const bobSk = bob.privateKey.toString();
const eveSk = eve.privateKey.toString();
const alicePk = alice.publicKey.toString();
const bobPk = bob.publicKey.toString();

for (const text of ['hello', 'こんにちは、暗号化メッセージ 🔐', 'x'.repeat(MAX_ENCRYPTED_MESSAGE_BYTES)]) {
  const bytes = encryptMessage(aliceSk, bobPk, text);
  const hex = bytesToHex(bytes);
  ok(bytes[0] === 1, 'type byte is 1 (encrypted)');
  ok(bytes.length === 1 + ENCRYPTED_MESSAGE_OVERHEAD + new TextEncoder().encode(text).length, 'encrypted size = type byte + overhead + text bytes', bytes.length);
  ok(decryptMessage(bobSk, alicePk, hex) === text, 'the recipient reads it with the sender public key');
  ok(decryptMessage(aliceSk, bobPk, hex) === text, 'the sender reads it with the recipient public key');
  ok(decryptMessage(eveSk, alicePk, hex) === null, 'a third party cannot read it');
  ok(!hex.includes(bytesToHex(new TextEncoder().encode(text))) || text.length === 0, 'the text is not in the clear');
}

// too long
try { encryptMessage(aliceSk, bobPk, 'x'.repeat(MAX_ENCRYPTED_MESSAGE_BYTES + 1)); ok(false, 'too long must throw'); } catch { ok(true, 'too long throws'); }

// the real transaction size matches the fee estimate
{
  const text = 'size check メッセージ';
  const encryptedMessage = encryptMessage(aliceSk, bobPk, text);
  const signed = signTransfer(aliceSk, cfg.generationHash, {
    signerPublicKey: alicePk,
    networkByte: cfg.networkByte,
    recipient: addressFromPublicKey(bobPk, cfg.networkByte),
    mosaics: [{ id: '6BED913FA20223F8', amount: 1n }],
    encryptedMessage,
    maxFee: 1n,
    deadline: 1n,
  });
  ok(signed.payload.length / 2 === transferSize(1, text, true), 'serialized size equals transferSize(..., encrypted)', [signed.payload.length / 2, transferSize(1, text, true)]);
  const parsed = parseTransferPayload(signed.payload);
  ok(parsed?.encryptedMessage === true && parsed.message === '', 'parsed as an encrypted message');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
