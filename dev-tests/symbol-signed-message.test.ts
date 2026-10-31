// Symbol 署名付きメッセージ: 形式・共有 JSON・NEM との見分け（SDK なし）。Run: npx tsx dev-tests/symbol-signed-message.test.ts
import {
  SYMBOL_SIGNED_MESSAGE_KIND, SYMBOL_SIGNED_MESSAGE_MAX_BYTES, buildSymbolSignedMessage, detectOtherChainSignedMessage, isSymbolPublicKeyHex, isSymbolSignatureHex,
  parseSymbolSignedMessage, symbolMessageBytes,
} from '../src/lib/symbol/signedMessage';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const pub = '3D4017C3E843895A92B70AA74D1B7EBC9C982CCF2EC4968CC0CD55F12AF4660C';
const sig = '92A009A9F0D4CAB8720E820B5F642540A2B27B5416503F8FB3762223EBDB69DA085AC1E43E15996E458F3613D0F11D8C387B2EAEB4302AEEB00D291612BB0C00';

// --- 署名の対象 = UTF-8 のバイト列 -----------------------------------------------------------------------
ok(symbolMessageBytes('r').length === 1 && symbolMessageBytes('r')[0] === 0x72, 'ASCII is one byte');
ok(symbolMessageBytes('あ').length === 3, 'a Japanese character is 3 bytes (UTF-8)');
ok(symbolMessageBytes('😀').length === 4, 'an emoji is 4 bytes (correct UTF-8, no NanoWallet-style 3+3)');
ok(symbolMessageBytes('a\nb ').length === 4, 'line break and trailing space count');
ok(symbolMessageBytes('x').length !== symbolMessageBytes('x ').length, 'a trailing space changes the bytes');
ok(SYMBOL_SIGNED_MESSAGE_MAX_BYTES === 4096, 'same limit as NEM');

// --- 形式の検査 ------------------------------------------------------------------------------------------
ok(isSymbolPublicKeyHex(pub) && isSymbolPublicKeyHex(pub.toLowerCase()), '64 hex public key (either case)');
ok(!isSymbolPublicKeyHex(pub.slice(1)) && !isSymbolPublicKeyHex(pub + '0') && !isSymbolPublicKeyHex('G' + pub.slice(1)), 'bad public keys');
ok(isSymbolSignatureHex(sig) && !isSymbolSignatureHex(sig.slice(2)) && !isSymbolSignatureHex(pub), 'signature is 128 hex');

// --- 共有 JSON: 作る → 読む --------------------------------------------------------------------------------
const message = 'こんにちは\nSymbol 😀';
const shared = buildSymbolSignedMessage({ message, publicKey: pub.toLowerCase(), signature: sig.toLowerCase() });
const env = JSON.parse(shared);
ok(env.kasane === 1 && env.kind === SYMBOL_SIGNED_MESSAGE_KIND && env.kind === 'symbol_signed_message', 'envelope', shared);
ok(env.data.publicKey === pub && env.data.signature === sig, 'hex is upper-cased in the envelope');
const back = parseSymbolSignedMessage(shared);
ok(back !== null && back.message === message && back.publicKey === pub && back.signature === sig && back.from === 'kasane', 'round trip', back);
ok(parseSymbolSignedMessage('  \n' + shared + '\n ')?.message === message, 'surrounding whitespace is fine');
let threw = false;
try { buildSymbolSignedMessage({ message: 'x', publicKey: 'zz', signature: sig }); } catch { threw = true; }
ok(threw, 'build refuses a bad key');
threw = false;
try { buildSymbolSignedMessage({ message: 'x', publicKey: pub, signature: sig.slice(2) }); } catch { threw = true; }
ok(threw, 'build refuses a bad signature');

// --- 読み取り: 素の JSON と、読めないもの -------------------------------------------------------------------
const plain = parseSymbolSignedMessage(JSON.stringify({ message: 'r', publicKey: pub.toLowerCase(), signature: sig.toLowerCase() }));
ok(plain !== null && plain.from === 'plain' && plain.message === 'r' && plain.publicKey === pub && plain.signature === sig, 'plain JSON', plain);
// A hex-looking message in a plain JSON stays text on this side (there is no NanoWallet hex format for Symbol).
ok(parseSymbolSignedMessage(JSON.stringify({ message: '72', publicKey: pub, signature: sig }))?.message === '72', 'a hex-looking message stays as typed');
ok(parseSymbolSignedMessage('not json') === null, 'not JSON');
ok(parseSymbolSignedMessage('[]') === null && parseSymbolSignedMessage('{') === null && parseSymbolSignedMessage('null') === null, 'not an object');
ok(parseSymbolSignedMessage(JSON.stringify({ message: 'r', publicKey: pub })) === null, 'no signature');
ok(parseSymbolSignedMessage(JSON.stringify({ message: 'r', publicKey: pub.slice(2), signature: sig })) === null, 'short public key');
ok(parseSymbolSignedMessage(JSON.stringify({ message: 'r', publicKey: pub, signature: sig.slice(2) })) === null, 'short signature');
ok(parseSymbolSignedMessage(JSON.stringify({ message: 5, publicKey: pub, signature: sig })) === null, 'message must be a string');
ok(parseSymbolSignedMessage(JSON.stringify({ kasane: 2, kind: SYMBOL_SIGNED_MESSAGE_KIND, data: { message: 'r', publicKey: pub, signature: sig } })) === null, 'other envelope version');
ok(parseSymbolSignedMessage(JSON.stringify({ kasane: 1, kind: 'something_else', data: { message: 'r', publicKey: pub, signature: sig } })) === null, 'other envelope kind');
ok(parseSymbolSignedMessage(JSON.stringify({ kasane: 1, kind: SYMBOL_SIGNED_MESSAGE_KIND, data: null })) === null, 'envelope without data');

// --- NEM のものを取り違えない ------------------------------------------------------------------------------
const nemEnvelope = JSON.stringify({ kasane: 1, kind: 'nem_signed_message', data: { message: 'r', publicKey: pub, signature: sig } });
ok(parseSymbolSignedMessage(nemEnvelope) === null, 'a NEM envelope is not read as Symbol');
ok(detectOtherChainSignedMessage(nemEnvelope) === 'nem', 'a NEM envelope is recognised');
const nanoWallet = JSON.stringify({ message: '72', signer: pub.toLowerCase(), signature: sig.toLowerCase() });
ok(parseSymbolSignedMessage(nanoWallet) === null, 'a NanoWallet JSON is not read as Symbol');
ok(detectOtherChainSignedMessage(nanoWallet) === 'nem', 'a NanoWallet JSON is recognised as NEM');
ok(detectOtherChainSignedMessage(shared) === null, 'a Symbol envelope is not "other"');
ok(detectOtherChainSignedMessage(JSON.stringify({ message: 'r', publicKey: pub, signature: sig })) === null, 'plain JSON with publicKey is not "other"');
ok(detectOtherChainSignedMessage('hello') === null && detectOtherChainSignedMessage('{') === null && detectOtherChainSignedMessage('{"a":1}') === null, 'unrelated text');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
