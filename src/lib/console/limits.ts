// コンソールのコードが、1回の操作でメモリや時間を使い切るのを防ぐ上限。
//
// インタープリタは2000ステップごとに処理を譲るので、ふつうのループは「停止」で止まる。止まらないのは、ネイティブの関数が
// 1回の呼び出しの中で大きな仕事をするとき（'x'.repeat(1e9)、new Array(1e9).fill(0)、2n ** 100000000n など）。
// そういうものは、実行する前に大きさを見て、上限を超えるなら RangeError にする。
//
// 注意: これは「よくある巨大な確保」を止めるもので、完全な防御ではない（正規表現の総当たりなどは止められない）。
// 完全に止めるには、Worker に入れて強制終了できるようにする必要がある。

export const MAX_STRING_LENGTH = 1 << 25;   // 文字列の長さ（約3,300万文字）
export const MAX_ELEMENTS = 1 << 24;        // 配列の長さ（約1,670万）
export const MAX_BYTES = 1 << 26;           // ArrayBuffer / 型付き配列のバイト数（64MB）
export const MAX_BIGINT_BITS = 1 << 22;     // BigInt のビット数（約420万ビット = 512KB）

const tooBig = (what: string): RangeError => new RangeError(`[console] ${what} is too large (the console limits a single operation's size)`);

const isNum = (v: unknown): v is number => typeof v === 'number';

/** `a + b`: 文字列が上限を超えるなら投げる。 */
export function checkConcat(a: unknown, b: unknown): void {
  const la = typeof a === 'string' ? a.length : 0;
  const lb = typeof b === 'string' ? b.length : 0;
  if (la + lb > MAX_STRING_LENGTH) throw tooBig('the string');
}

const bitLength = (n: bigint): number => (n < 0n ? -n : n).toString(2).length;

/** BigInt の `**` と `<<`: 結果が上限を超えるなら、計算する前に投げる。 */
export function checkBigIntOp(op: string, a: unknown, b: unknown): void {
  if (typeof a !== 'bigint' || typeof b !== 'bigint' || b <= 0n) return;
  if (op === '**') {
    if (a === 0n || a === 1n || a === -1n) return;
    if (b > BigInt(MAX_BIGINT_BITS) || bitLength(a) * Number(b) > MAX_BIGINT_BITS) throw tooBig('the BigInt result');
  } else if (op === '<<') {
    if (a === 0n) return;
    if (b > BigInt(MAX_BIGINT_BITS) || bitLength(a) + Number(b) > MAX_BIGINT_BITS) throw tooBig('the BigInt result');
  }
}

const lengthOf = (v: unknown): number => {
  if (v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function')) return 0;
  const n = Number((v as { length?: unknown }).length);
  return Number.isFinite(n) ? n : 0;
};

type CallCheck = (thisArg: unknown, args: unknown[]) => void;
const callChecks = new Map<unknown, CallCheck>();
const add = (fn: unknown, check: CallCheck) => { if (typeof fn === 'function') callChecks.set(fn, check); };

add(String.prototype.repeat, (t, a) => {
  const n = Number(a[0]);
  if (Number.isFinite(n) && n > 0 && n * String(t).length > MAX_STRING_LENGTH) throw tooBig('the string');
});
const pad: CallCheck = (_t, a) => { if (Number(a[0]) > MAX_STRING_LENGTH) throw tooBig('the string'); };
add(String.prototype.padStart, pad);
add(String.prototype.padEnd, pad);
add(Array.prototype.fill, (t) => { if (lengthOf(t) > MAX_ELEMENTS) throw tooBig('the array'); });
add(Array.prototype.copyWithin, (t) => { if (lengthOf(t) > MAX_ELEMENTS) throw tooBig('the array'); });
// Array(n)（new なしの呼び出し）、Array.from({ length: n })、Array.of は、要素数で見る。
add(Array, (_t, a) => { if (a.length === 1 && isNum(a[0]) && a[0] > MAX_ELEMENTS) throw tooBig('the array'); });
add(Array.from, (_t, a) => { if (lengthOf(a[0]) > MAX_ELEMENTS) throw tooBig('the array'); });

type TypedCtor = { BYTES_PER_ELEMENT?: number };
const typedCtors: unknown[] = [Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigUint64Array, BigInt64Array];
for (const C of typedCtors) add((C as { from?: unknown }).from, (_t, a) => { if (lengthOf(a[0]) > MAX_ELEMENTS) throw tooBig('the typed array'); });

/** `new C(...args)`: 配列・ArrayBuffer・型付き配列の大きさが上限を超えるなら、作る前に投げる。 */
export function checkConstruct(C: unknown, args: unknown[]): void {
  if (C === Array) {
    if (args.length === 1 && isNum(args[0]) && args[0] > MAX_ELEMENTS) throw tooBig('the array');
    return;
  }
  if (C === ArrayBuffer) {
    if (isNum(args[0]) && args[0] > MAX_BYTES) throw tooBig('the ArrayBuffer');
    return;
  }
  if (typedCtors.includes(C) && isNum(args[0])) {
    const per = (C as TypedCtor).BYTES_PER_ELEMENT ?? 1;
    if (args[0] * per > MAX_BYTES) throw tooBig('the typed array');
  }
}

/** ネイティブの関数を呼ぶ前の確認（インタープリタの call から使う）。 */
export function checkNativeCall(fn: unknown, thisArg: unknown, args: unknown[]): void {
  const check = callChecks.get(fn);
  if (check !== undefined) check(thisArg, args);
  else if (fn === ArrayBuffer || typedCtors.includes(fn)) checkConstruct(fn, args);
}

/** 配列への `length = n` や `a[n] = v`（巨大な穴あき配列を作る書き方）。 */
export function checkArrayWrite(obj: unknown, key: PropertyKey, value: unknown): void {
  if (!Array.isArray(obj)) return;
  if (key === 'length') {
    if (Number(value) > MAX_ELEMENTS) throw tooBig('the array');
    return;
  }
  const index = typeof key === 'number' ? key : typeof key === 'string' && /^\d{1,10}$/.test(key) ? Number(key) : -1;
  if (index >= MAX_ELEMENTS) throw tooBig('the array index');
}
