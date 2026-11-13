// Symbol 署名付きメッセージ: SDK での署名と検証。Run: npx tsx dev-tests/symbol-signed-message-sign.test.ts （symbol-sdk が必要）
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex, hexToBytes, keyPairFromPrivateKey, signData, verifySignature } from '../src/lib/symbol/crypto';
import { isSymbolSignatureHex, parseSymbolSignedMessage, buildSymbolSignedMessage, symbolMessageBytes } from '../src/lib/symbol/signedMessage';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- RFC 8032（標準の Ed25519 / SHA-512）の既知の答え。Symbol の署名はこれと同じ ---------------------------------
// TEST 2: 秘密鍵 4ccd…a6fb、メッセージ 0x72（= 文字 "r" の UTF-8）。
const rfcPriv = '4CCD089B28FF96DA9DB6C346EC114E0F5B8A319F35ABA624DA8CF6ED4FB8A6FB';
const rfcPub = '3D4017C3E843895A92B70AA74D1B7EBC9C982CCF2EC4968CC0CD55F12AF4660C';
const rfcSig = '92A009A9F0D4CAB8720E820B5F642540A2B27B5416503F8FB3762223EBDB69DA085AC1E43E15996E458F3613D0F11D8C387B2EAEB4302AEEB00D291612BB0C00';
ok(keyPairFromPrivateKey(rfcPriv).publicKey === rfcPub, 'the SDK gives the RFC 8032 public key');
ok(bytesToHex(signData(rfcPriv, symbolMessageBytes('r'))) === rfcSig, 'the signature of "r" is the RFC 8032 one');
ok(verifySignature(rfcPub, symbolMessageBytes('r'), hexToBytes(rfcSig)), 'the RFC 8032 signature verifies');

// --- 日本語・改行を含む文章（標準の Ed25519 実装で別に作った値と照合）-----------------------------------------------
const priv = '0000000000000000000000000000000000000000000000000000000000000001';
const pub = '4CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA29';
const message = 'こんにちは\nSymbol';
const expected = 'C28972134BF8A0001BB2F08B6E67C4CB17B673F94A08A848553831AB85B6AA161E592472C50F3A80354CB46A049A14BB25D717FC3495BB822ACF9E6862ED8800';
ok(keyPairFromPrivateKey(priv).publicKey === pub, 'public key of private key 1');
const sig = signData(priv, symbolMessageBytes(message));
ok(bytesToHex(sig) === expected, 'the signature of a Japanese multi-line text matches an independent Ed25519', bytesToHex(sig));
ok(isSymbolSignatureHex(bytesToHex(sig)) && bytesToHex(sig) === bytesToHex(sig).toUpperCase(), '128 hex, upper case');
ok(verifySignature(pub, symbolMessageBytes(message), sig), 'verifies');
ok(!verifySignature(pub, symbolMessageBytes(message + ' '), sig), 'a trailing space breaks it');
ok(!verifySignature(pub, symbolMessageBytes('x'), sig), 'another message fails');
const other = new KeyPair(new PrivateKey('00000000000000000000000000000000000000000000000000000000000000AA')).publicKey.toString();
ok(!verifySignature(other, symbolMessageBytes(message), sig), 'another public key fails');
ok(bytesToHex(signData(priv, symbolMessageBytes(message))) === bytesToHex(sig), 'Ed25519 is deterministic');

// --- 共有 JSON を通しても検証できる ---------------------------------------------------------------------------
const shared = buildSymbolSignedMessage({ message, publicKey: pub, signature: bytesToHex(sig) });
const parsed = parseSymbolSignedMessage(shared);
ok(parsed !== null && verifySignature(parsed.publicKey, symbolMessageBytes(parsed.message), hexToBytes(parsed.signature)), 'shared JSON -> parse -> verifies');

// --- アドレスは、使うネットワークの公開鍵のアドレス -------------------------------------------------------------
ok(addressFromPublicKey(pub, 0x68).startsWith('N') && addressFromPublicKey(pub, 0x98).startsWith('T'), 'N… on mainnet, T… on testnet');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
