// NEM 署名付きメッセージ: 共有用 JSON の組み立てと読み取り、形式の検査（SDK なし）。
// Run: npx tsx dev-tests/nem-signed-message.test.ts
import {
  buildNanoWalletSignedMessage, buildNemSignedMessage, isNemPublicKeyHex, isNemSignatureHex, nemBytesToHex, nemHexToText, nemMessageBytes, nemNanoMessageBytes, parseNemSignedMessage,
} from '../src/lib/nem/signedMessage';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
function throws(fn: () => unknown, what: string) { let t = false; try { fn(); } catch { t = true; } ok(t, what); }

const pub = 'ab'.repeat(32);
const sig = 'cd'.repeat(64);
ok(isNemPublicKeyHex(pub) && isNemPublicKeyHex(` ${pub.toUpperCase()}\n`), 'public key: 64 hex, spaces around are fine');
ok(!isNemPublicKeyHex(pub.slice(2)) && !isNemPublicKeyHex('zz'.repeat(32)), 'public key: wrong length / not hex');
ok(isNemSignatureHex(sig) && !isNemSignatureHex(sig + '00') && !isNemSignatureHex(''), 'signature: 128 hex');

ok(new TextDecoder().decode(nemMessageBytes('こんにちは\n  ')) === 'こんにちは\n  ', 'the bytes keep line breaks and spaces');
ok(nemMessageBytes('あ').length === 3, 'UTF-8');

const message = '私は、この文章に署名しました。\n2026-10-13\n  indented  ';
const text = buildNemSignedMessage({ message, publicKey: pub, signature: sig });
const back = parseNemSignedMessage(text);
ok(back !== null && back.message === message, 'round trip keeps the message exactly (line breaks, spaces)', back);
ok(back?.publicKey === pub.toUpperCase() && back.signature === sig.toUpperCase(), 'hex is upper-cased');
ok(JSON.parse(text).kind === 'nem_signed_message', 'kind');

const bare = parseNemSignedMessage(JSON.stringify({ message: 'hi', publicKey: pub, signature: sig }));
ok(bare !== null && bare.message === 'hi', 'a bare {message, publicKey, signature} is read');
ok(parseNemSignedMessage(JSON.stringify({ message: 'hi', publicKey: 'AA', signature: sig })) === null, 'a bad public key is refused');
ok(parseNemSignedMessage(JSON.stringify({ message: 'hi', publicKey: pub, signature: 'AA' })) === null, 'a bad signature is refused');
ok(parseNemSignedMessage(JSON.stringify({ message: 5, publicKey: pub, signature: sig })) === null, 'a message that is not text is refused');
ok(parseNemSignedMessage(JSON.stringify({ kasane: 1, kind: 'nem_signed', data: { message: 'x', publicKey: pub, signature: sig } })) === null, 'another KASANE kind is not a signed message');
ok(parseNemSignedMessage('not json') === null && parseNemSignedMessage('') === null && parseNemSignedMessage('[1]') === null, 'garbage');
throws(() => buildNemSignedMessage({ message: 'x', publicKey: 'AA', signature: sig }), 'cannot build with a bad key');

// --- NanoWallet（NEM Wallet）との互換 ---------------------------------------------------------------------
// 16 進は nem-sdk の utf8ToHex の実際の出力（NanoWallet が署名・共有する message）。
const nanoHex = (m: string) => nemBytesToHex(nemNanoMessageBytes(m));
ok(nanoHex('hello 123\n abc') === '68656c6c6f203132330a20616263', 'Nano encoding: ASCII');
ok(nanoHex('こんにちは NEM\n  日本語 é') === 'e38193e38293e381abe381a1e381af204e454d0a2020e697a5e69cace8aa9e20c3a9', 'Nano encoding: Japanese / accents = real UTF-8');
ok(nanoHex('with emoji 😀') === '7769746820656d6f6a6920eda0bdedb880', 'Nano encoding: an emoji is two 3-byte units (not 4-byte UTF-8)');
ok(nemBytesToHex(nemMessageBytes('😀')) === 'f09f9880', 'KASANE (real UTF-8) keeps the emoji as 4 bytes');
ok(nemBytesToHex(nemNanoMessageBytes('こんにちは')) === nemBytesToHex(nemMessageBytes('こんにちは')), 'BMP text: both encodings are the same bytes');

ok(nemHexToText('e38193e38293e381abe381a1e381af204e454d0a2020e697a5e69cace8aa9e20c3a9') === 'こんにちは NEM\n  日本語 é', 'hex -> text (UTF-8)');
ok(nemHexToText('7769746820656d6f6a6920eda0bdedb880') === 'with emoji 😀', 'hex -> text (NanoWallet-style emoji)');
ok(nemHexToText('f09f9880') === '😀', 'hex -> text (real 4-byte UTF-8 emoji)');
ok(nemHexToText('zz') === null && nemHexToText('abc') === null && nemHexToText('') === null && nemHexToText('ff') === null, 'hex -> text: refuses non-hex, odd length, empty, invalid bytes');

const nanoJson = JSON.stringify({ message: '68656c6c6f', signer: pub, signature: sig });
const fromNano = parseNemSignedMessage(nanoJson);
ok(fromNano !== null && fromNano.message === 'hello' && fromNano.from === 'nanowallet', 'a NanoWallet JSON is read (hex message -> text)', fromNano);
ok(fromNano?.publicKey === pub.toUpperCase() && fromNano.signature === sig.toUpperCase(), 'NanoWallet JSON: signer is the public key');
const nanoEmoji = parseNemSignedMessage(JSON.stringify({ message: '7769746820656d6f6a6920eda0bdedb880', signer: pub, signature: sig }));
ok(nanoEmoji?.message === 'with emoji 😀', 'NanoWallet JSON with an emoji is read back as the emoji', nanoEmoji);
const signerText = parseNemSignedMessage(JSON.stringify({ message: 'plain text!', signer: pub, signature: sig }));
ok(signerText?.message === 'plain text!' && signerText.from === 'plain', 'a message that is not hex stays text even with "signer"');
ok(parseNemSignedMessage(JSON.stringify({ message: '68656c6c6f', publicKey: pub, signature: sig }))?.message === '68656c6c6f', 'with "publicKey" a hex-looking message stays text');
ok(parseNemSignedMessage(JSON.stringify({ message: 'hi', signer: 'AA', signature: sig })) === null, 'NanoWallet JSON: a bad signer is refused');
ok(parseNemSignedMessage(text)?.from === 'kasane' && bare?.from === 'plain', 'the origin is reported');

const nanoOut = JSON.parse(buildNanoWalletSignedMessage({ publicKey: pub.toUpperCase(), signature: sig.toUpperCase() }, nemMessageBytes('hello')));
ok(Object.keys(nanoOut).join() === 'message,signer,signature', 'NanoWallet JSON keys and order');
ok(nanoOut.message === '68656c6c6f' && nanoOut.signer === pub && nanoOut.signature === sig, 'NanoWallet JSON: hex message, lower-case key and signature', nanoOut);
const rt = parseNemSignedMessage(buildNanoWalletSignedMessage({ publicKey: pub, signature: sig }, nemMessageBytes('こんにちは\n 😀')));
ok(rt?.message === 'こんにちは\n 😀', 'KASANE -> NanoWallet JSON -> KASANE keeps the text (even with an emoji)', rt);
throws(() => buildNanoWalletSignedMessage({ publicKey: 'AA', signature: sig }, nemMessageBytes('x')), 'cannot build a NanoWallet JSON with a bad key');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
