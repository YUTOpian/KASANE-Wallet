// 送金額の文字列パース（parseDecimal）への境界値・fuzzテスト。人が入力欄に打ち込む/貼り付ける/
// QRや集約取引のインポートで渡ってくる「金額の文字列」が入り口なので、ここでは意図的に壊れた・
// 極端な入力を大量に投げて、例外で落ちないか・異常に遅くならないか・往復（format→parse）で
// 値が保たれるかを確認する。symbol-sdk等への依存が一切ないため、このファイルはそのまま実行できる。
// Run: npx tsx dev-tests/amount-fuzz.test.ts
import { formatAtomic, parseDecimal } from '../src/lib/symbol/amount';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- 境界値：小数桁数ちょうど / 1つ超過 ------------------------------------------------------
ok(parseDecimal('1.123456', 6) === 1123456n, 'exactly at divisibility: accepted');
ok(parseDecimal('1.1234567', 6) === null, 'one decimal over divisibility: rejected');
ok(parseDecimal('0.000001', 6) === 1n, 'smallest unit at divisibility 6');
ok(parseDecimal('1', 0) === 1n, 'divisibility 0: whole number accepted');
ok(parseDecimal('1.0', 0) === null, 'divisibility 0: any decimal point rejected, even ".0"');
ok(parseDecimal('1.', 6) === 1000000n, 'trailing dot with no fraction: treated as whole');
ok(parseDecimal('.5', 6) === 500000n, 'leading dot with no whole part: treated as 0.5');

// --- 不正な形式 -------------------------------------------------------------------------------
for (const bad of ['', '.', '-1', '-1.5', '1-5', '1.2.3', '1..2', '1,000', '1_000', '1e10', '1e-10',
  'NaN', 'Infinity', '０１２', '١٢٣', '  ', '1 2', '+1', '1.5f', '0x10', '১২৩']) {
  ok(parseDecimal(bad, 6) === null, `rejects malformed input: ${JSON.stringify(bad)}`);
}

// --- 空白の扱い -------------------------------------------------------------------------------
ok(parseDecimal('  1.5  ', 6) === 1500000n, 'surrounding whitespace is trimmed');
ok(parseDecimal('1 .5', 6) === null, 'internal whitespace is NOT tolerated');

// --- 巨大な値／DoS耐性 -------------------------------------------------------------------------
// 修正前は上限が無く、BigInt(文字列) の変換コストが線形を大きく超えて伸びるため、QRや外部入力で
// 極端に長い桁の文字列を渡されるとUIスレッドが長時間固まる恐れがあった（実測: 100万桁で約150ms、
// 500万桁で約1.2秒）。MAX_DECIMAL_TEXT_LENGTH による早期rejectで、どれだけ長い文字列を渡されても
// 一定時間内に処理が返ることを確認する。
for (const n of [50, 1000, 100000, 5000000]) {
  const huge = '9'.repeat(n);
  const t0 = Date.now();
  const result = parseDecimal(huge, 6);
  const elapsed = Date.now() - t0;
  ok(elapsed < 50, `huge input (${n} digits) rejected/handled within 50ms (took ${elapsed}ms)`, { n, elapsed });
  if (n > 40) ok(result === null, `${n}-digit input exceeds the length cap and is rejected`, result);
}
// ちょうど上限ぎりぎりの妥当な入力は、通常通り処理できること（偽陽性でrejectしていないか）。
ok(parseDecimal('9'.repeat(10), 6) !== null, '10-digit whole number (realistic max supply) still parses');
ok(parseDecimal(`${'9'.repeat(10)}.${'9'.repeat(6)}`, 6) !== null, 'realistic max amount with full divisibility still parses');

// --- 負の bigint を divisibility に渡した場合（型は number だが壊れた呼び出し元を想定） -------
ok(parseDecimal('1.5', -1) === null || (() => { try { parseDecimal('1.5', -1); return false; } catch { return true; } })(),
  'negative divisibility does not silently produce a wrong positive result (either null or a clean throw)');

// --- formatAtomic ↔ parseDecimal の往復 --------------------------------------------------------
const roundTripCases: Array<[bigint, number]> = [
  [0n, 6], [1n, 6], [1000000n, 6], [123456789012345n, 6], [0n, 0], [42n, 0],
  [-1n, 6], [-123456n, 6], // formatAtomic supports negatives even though parseDecimal (send amounts) rejects them
];
for (const [atomic, divisibility] of roundTripCases) {
  const text = formatAtomic(atomic, divisibility);
  if (atomic < 0n) {
    // parseDecimal自体は符号を受け付けない仕様（送金額に負数は無意味）なので、ここでは
    // formatAtomicが例外を投げずに一貫した文字列を返すことだけを確認する。
    ok(text.startsWith('-'), `formatAtomic keeps the sign for negative amounts: ${atomic}`, text);
    continue;
  }
  const back = parseDecimal(text, divisibility);
  ok(back === atomic, `round-trip formatAtomic -> parseDecimal preserves the value: ${atomic} @div${divisibility}`, { text, back });
}

// --- ランダムfuzzing：ランダムな文字列を大量に投げてクラッシュしないことだけを確認 ---------------
const CHARSET = '0123456789.-+eE naNIfy_,　１２３'; // 全角数字や紛らわしい文字も混ぜる
function randomString(maxLen: number): string {
  const len = Math.floor(Math.random() * maxLen);
  let s = '';
  for (let i = 0; i < len; i += 1) s += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  return s;
}
let crashed = 0;
for (let i = 0; i < 20000; i += 1) {
  const input = randomString(60);
  const div = [0, 1, 6, 8][i % 4];
  try {
    parseDecimal(input, div);
  } catch (e) {
    crashed += 1;
    if (crashed <= 5) console.log('CRASH on input:', JSON.stringify(input), 'div', div, '->', e);
  }
}
ok(crashed === 0, `20000 random fuzz inputs: no uncaught exceptions (${crashed} crashed)`);

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
