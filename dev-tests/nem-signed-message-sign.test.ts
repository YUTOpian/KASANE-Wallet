// NEM 署名付きメッセージ: SDK での署名と検証。Run: npx tsx dev-tests/nem-signed-message-sign.test.ts （symbol-sdk が必要）
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import { signNemData, verifyNemSignature, verifyNemText } from '../src/lib/nem/crypto';
import { isNemSignatureHex, nemHexToText, nemMessageBytes, parseNemSignedMessage } from '../src/lib/nem/signedMessage';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

const priv = '0000000000000000000000000000000000000000000000000000000000000001';
const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString().toUpperCase();
const message = 'こんにちは\nNEM';
const sig = signNemData(priv, nemMessageBytes(message));
ok(isNemSignatureHex(sig) && sig === sig.toUpperCase(), '128 hex, upper case', sig);
ok(verifyNemSignature(pub, nemMessageBytes(message), hexToBytes(sig)), 'verifies');
ok(!verifyNemSignature(pub, nemMessageBytes(message + ' '), hexToBytes(sig)), 'a trailing space breaks it');
ok(!verifyNemSignature(pub, nemMessageBytes('x'), hexToBytes(sig)), 'another message fails');
const other = new KeyPair(new PrivateKey('00000000000000000000000000000000000000000000000000000000000000AA')).publicKey.toString();
ok(!verifyNemSignature(other, nemMessageBytes(message), hexToBytes(sig)), 'another public key fails');
ok(signNemData(priv, nemMessageBytes(message)) === sig, 'Ed25519 is deterministic');

// --- NanoWallet（nem-sdk 1.6）が実際に出した署名との互換 ----------------------------------------------------
// 秘密鍵 '1'×63 + '7'。署名は nem-sdk の keyPair.sign(utf8ToHex(message)) の出力（NanoWallet の署名付きメッセージと同じ呼び出し）。
const nanoPriv = '1'.repeat(63) + '7';
const nanoPub = '1ee8f3b349ec693899d6601b63723017d88a8e0ea901002ceb7859a9780c11da';
ok(new KeyPair(new PrivateKey(nanoPriv)).publicKey.toString().toLowerCase() === nanoPub, 'the same private key gives the same public key as nem-sdk');
const bmp = 'こんにちは NEM\n  日本語 é';
const bmpNanoSig = 'c2996cdc849866d7d8c85f24b08f5009d1c8bd4aaed5ffcc3f457497421e3d750c6bf4f36a04117c7f3bbef8098924b483ee0027d093921aa632db87c2c46500';
ok(verifyNemText(nanoPub, bmp, bmpNanoSig) === 'utf8', 'NanoWallet signature (Japanese text) verifies in KASANE');
ok(signNemData(nanoPriv, nemMessageBytes(bmp)).toLowerCase() === bmpNanoSig, 'KASANE makes the very same signature as NanoWallet (Japanese text)');
ok(verifyNemText(nanoPub, bmp + ' ', bmpNanoSig) === null, 'a changed text fails');

const emoji = 'with emoji 😀';
const emojiNanoSig = '328daee8dabc2d7a0996f8cb381f85a98ae0e2375dee95b01e1fc3349614ce7670ae19d063025fa27025fddf30fcb762e6aeef6bf7abb1159fac7fd1fb2d4300';
ok(verifyNemText(nanoPub, emoji, emojiNanoSig) === 'nanowallet', 'NanoWallet signature with an emoji verifies in KASANE (NanoWallet encoding)');
ok(signNemData(nanoPriv, nemMessageBytes(emoji)).toLowerCase() !== emojiNanoSig, 'with an emoji the two make different signatures (4-byte UTF-8 vs 3+3 bytes)');
const kasaneEmojiSig = signNemData(nanoPriv, nemMessageBytes(emoji));
ok(verifyNemText(nanoPub, emoji, kasaneEmojiSig) === 'utf8', 'KASANE signature with an emoji verifies as UTF-8');
// NanoWallet verifies the hex of the signed bytes directly, so a KASANE NanoWallet-JSON is accepted there as well.
const pasted = parseNemSignedMessage(JSON.stringify({ message: '7769746820656d6f6a6920eda0bdedb880', signer: nanoPub, signature: emojiNanoSig }));
ok(pasted !== null && verifyNemText(pasted.publicKey, pasted.message, pasted.signature) === 'nanowallet', 'pasted NanoWallet JSON (emoji) -> text -> verifies');
const pastedBmp = parseNemSignedMessage(JSON.stringify({ message: 'e38193e38293e381abe381a1e381af204e454d0a2020e697a5e69cace8aa9e20c3a9', signer: nanoPub, signature: bmpNanoSig }));
ok(pastedBmp !== null && pastedBmp.message === bmp && verifyNemText(pastedBmp.publicKey, pastedBmp.message, pastedBmp.signature) === 'utf8', 'pasted NanoWallet JSON (Japanese) -> text -> verifies');
ok(nemHexToText('f09f9880') === '😀', 'sanity');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
