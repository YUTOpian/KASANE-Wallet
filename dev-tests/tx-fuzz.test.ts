// 取引構築部分（src/lib/symbol/tx.ts）への境界値・fuzzテスト：不正なアドレス、公開鍵、モザイクID、
// 巨大/負のbigintなどを与えて、例外で落ちる場合は「クラッシュ」ではなく明確なエラーで失敗すること、
// また正しい入力では壊れないことを確認する。
//
// このファイルは symbol-sdk に依存しているため、サンドボックス環境（依存パッケージをインストール
// できないオフライン環境）では実行できなかった。アサーションは tx.ts / crypto.ts のソースを実際に
// 読んだ上で書いているが、「本当にその通りに動くか」はこちらで検証できていない。
//   npm install してから: npx tsx dev-tests/tx-fuzz.test.ts
// で実行し、FAILが出た場合は教えてほしい（想定と実際のSDKの挙動がズレている箇所がある可能性がある）。
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { encodeMessage, messageByteLength, parseTransferPayload, serializeUnsignedTransfer } from '../src/lib/symbol/tx';
import type { TransferParams } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
function throws(fn: () => unknown, what: string) {
  checks++;
  try {
    fn();
    fails++;
    console.log('FAIL (did not throw):', what);
  } catch {
    // expected
  }
}
function doesNotHang(fn: () => unknown, what: string, maxMs = 500) {
  checks++;
  const t0 = Date.now();
  try { fn(); } catch { /* either outcome is fine here, we only care about timing */ }
  const elapsed = Date.now() - t0;
  if (elapsed > maxMs) { fails++; console.log('FAIL (too slow):', what, `${elapsed}ms`); }
}

const MAINNET = 0x68;
const kp = new KeyPair(PrivateKey.random());
const validPublicKey = kp.publicKey.toString();
const validAddress = addressFromPublicKey(validPublicKey, MAINNET);
const validMosaicId = '6BED913FA20223F8'; // XYM mainnet mosaic id, well-formed 16 hex chars

const baseParams: TransferParams = {
  signerPublicKey: validPublicKey,
  networkByte: MAINNET,
  recipient: validAddress,
  mosaics: [{ id: validMosaicId, amount: 1000000n }],
  maxFee: 1000n,
  deadline: 1000n,
};

// --- 正常系：まず壊れていないことの確認 ----------------------------------------------------------
ok((() => { try { serializeUnsignedTransfer(baseParams); return true; } catch (e) { console.log('unexpected throw', e); return false; } })(),
  'well-formed params do not throw');

// --- 不正なアドレス（recipient） -----------------------------------------------------------------
for (const bad of ['', 'A'.repeat(39), 'not-an-address', validAddress.slice(0, -1), `${validAddress}X`, '0'.repeat(39),
  validAddress.toLowerCase(), '  ', '\u0000'.repeat(39), 'N'.repeat(39)]) {
  throws(() => serializeUnsignedTransfer({ ...baseParams, recipient: bad }), `invalid recipient is rejected: ${JSON.stringify(bad.slice(0, 20))}`);
}
// 他ネットワーク（testnet）宛の正しいアドレス形式でも、チェックサムが合わないランダム文字列は弾かれる
throws(() => serializeUnsignedTransfer({ ...baseParams, recipient: `T${'A'.repeat(38)}` }), 'wrong-network-shaped but invalid-checksum address is rejected');

// --- 不正な signerPublicKey --------------------------------------------------------------------
for (const bad of ['', 'not-hex-at-all-00000000000000000000000000000000000000000000', validPublicKey.slice(0, -1),
  `${validPublicKey}0`, validPublicKey.replace('A', 'g'), '  ']) {
  throws(() => serializeUnsignedTransfer({ ...baseParams, signerPublicKey: bad }), `invalid signerPublicKey is rejected: ${JSON.stringify(bad.slice(0, 20))}`);
}
// 全ゼロ公開鍵（インボイスQRが意図的に使うプレースホルダ）は "形式としては" 正当なので弾かれない
ok((() => { try { serializeUnsignedTransfer({ ...baseParams, signerPublicKey: '0'.repeat(64) }); return true; } catch (e) { console.log(e); return false; } })(),
  'all-zero placeholder public key (used by invoice QR) is still accepted - format-valid');

// --- 不正なモザイクID / 金額 ---------------------------------------------------------------------
throws(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: 'XYZ', amount: 1n }] }), 'non-hex mosaic id is rejected');
throws(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: '123', amount: 1n }] }), 'too-short mosaic id is rejected');
throws(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: validMosaicId, amount: -1n }] }), 'negative mosaic amount is rejected');
throws(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [] }), 'empty mosaics array is rejected');
ok((() => { try { serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: validMosaicId, amount: 0n }] }); return true; } catch (e) { console.log(e); return false; } })(),
  'a single mosaic entry with amount 0 (message-only transfer) is still accepted');
// 巨大な bigint（符号付き64bit上限を超える額）- SDKが受け入れるか、ここで明確に失敗するかのどちらか
// であるべきで、無限ループ/ハング/未捕捉例外での即死は起きないことを確認する。
doesNotHang(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: validMosaicId, amount: 2n ** 64n }] }), 'huge mosaic amount (2^64) does not hang');
doesNotHang(() => serializeUnsignedTransfer({ ...baseParams, mosaics: [{ id: validMosaicId, amount: 2n ** 256n }] }), 'absurd mosaic amount (2^256) does not hang');
// 同じモザイクIDを複数行に重複して渡した場合（プロトコル違反）。クラッシュせず、例外か、何らかの
// 一貫した結果のどちらかであればよい。
doesNotHang(() => serializeUnsignedTransfer({
  ...baseParams,
  mosaics: [{ id: validMosaicId, amount: 1n }, { id: validMosaicId, amount: 2n }],
}), 'duplicate mosaic ids do not hang (SDK or our own layer should reject or merge, not crash silently)');
// 大量のモザイク行（数千件）を渡した場合にハングしないこと。
doesNotHang(() => serializeUnsignedTransfer({
  ...baseParams,
  mosaics: Array.from({ length: 5000 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), amount: 1n })),
}), '5000 mosaic entries do not hang', 2000);

// --- 不正な maxFee / deadline -------------------------------------------------------------------
throws(() => serializeUnsignedTransfer({ ...baseParams, maxFee: -1n }), 'negative maxFee is rejected');
throws(() => serializeUnsignedTransfer({ ...baseParams, deadline: -1n }), 'negative deadline is rejected');
doesNotHang(() => serializeUnsignedTransfer({ ...baseParams, maxFee: 2n ** 64n }), 'huge maxFee does not hang');

// --- メッセージの境界値 -------------------------------------------------------------------------
ok(encodeMessage(undefined) === undefined, 'no message -> undefined, not an error');
ok(encodeMessage('')?.length === undefined, 'empty string message -> treated as no message (falsy)');
ok(encodeMessage('a'.repeat(1023))!.length === 1024, 'message at exactly the byte limit is accepted (+1 type byte)');
throws(() => encodeMessage('a'.repeat(1024)), 'message one byte over the limit throws message_too_long');
// マルチバイト文字（絵文字はサロゲートペア+結合文字で1文字が4バイト以上になりうる）での境界値：
// 文字数ではなくUTF-8バイト数で切られることを確認する。
const emoji = '🎉'; // 4 bytes in UTF-8
ok(messageByteLength(emoji) === 4, 'emoji is measured in UTF-8 bytes, not UTF-16 code units (2)');
const justUnderLimit = emoji.repeat(255); // 1020 bytes
const justOverLimit = emoji.repeat(256); // 1024 bytes
ok(messageByteLength(justUnderLimit) === 1020 && encodeMessage(justUnderLimit) !== undefined, 'multi-byte message just under the limit is accepted');
throws(() => encodeMessage(justOverLimit), 'multi-byte message just over the limit (counted in bytes) throws');

// --- parseTransferPayload: 壊れたペイロードは例外ではなく null -------------------------------------
for (const bad of ['', 'not-hex', '0'.repeat(1), '0'.repeat(3), 'ZZ', '  ', 'G'.repeat(400)]) {
  ok(parseTransferPayload(bad) === null, `malformed payload returns null, not a throw: ${JSON.stringify(bad.slice(0, 20))}`);
}
doesNotHang(() => parseTransferPayload('AB'.repeat(2_000_000)), 'a 2-million-byte garbage hex payload does not hang', 2000);
doesNotHang(() => parseTransferPayload('0'.repeat(5_000_000)), 'a 5-million-char all-zero hex payload does not hang', 2000);

// --- 往復（round-trip）：署名なしで組み立てたペイロードが、パースし直すと同じ値を返すこと -------------
const payload = serializeUnsignedTransfer(baseParams);
const parsed = parseTransferPayload(payload);
ok(parsed !== null, 'a well-formed unsigned transfer round-trips through parseTransferPayload without failing');
if (parsed) {
  ok(parsed.mosaics.length === 1 && parsed.mosaics[0].id.toUpperCase() === validMosaicId.toUpperCase() && parsed.mosaics[0].amount === 1000000n,
    'round-tripped mosaic id/amount match what was built', parsed.mosaics);
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
