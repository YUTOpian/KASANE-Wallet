// コンソールのインタープリタ（lib/console/interpreter.ts）と出力の整形（format.ts）。通信なし。
// 実行: npx tsx dev-tests/console-interpreter.test.ts
import { Interpreter, StopSignal, blockingFunction, protect } from '../src/lib/console/interpreter';
import { formatValue } from '../src/lib/console/format';
import { isIncomplete, pushHistory, stepHistory } from '../src/lib/console/repl';
import { CONSOLE_SAMPLES } from '../src/lib/console/samples';
import { parse } from 'acorn';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(Object.is(a, b) || JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), what, `${String(a)} != ${String(b)}`);

async function val(code: string, setup?: (i: Interpreter) => void): Promise<unknown> {
  const i = new Interpreter();
  i.defineGlobal('console', { log: () => undefined });
  for (const [k, v] of Object.entries({ Math, JSON, Array, Promise, Object, Number, String, BigInt, Uint8Array, TextEncoder, Map, Set, Error, TypeError, Date, RegExp, Symbol })) i.defineGlobal(k, v);
  setup?.(i);
  const r = await i.run(code);
  return r.value;
}
async function err(code: string, setup?: (i: Interpreter) => void): Promise<string> {
  try { await val(code, setup); return '(no error)'; } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
}

// --- 基本 ---
eq(await val('1 + 2 * 3'), 7, 'arithmetic');
eq(await val('2n ** 64n'), 18446744073709551616n, 'bigint pow');
eq(await val('1_000_000n + 1n'), 1000001n, 'bigint with separators');
eq(await val('`a${1 + 1}b${"c"}`'), 'a2bc', 'template literal');
eq(await val('const a = [1,2,3]; a.map(x => x * 2)'), [2, 4, 6], 'native map with interpreted callback (sync)');
eq(await val('[3,1,2].sort((a, b) => a - b)'), [1, 2, 3], 'sort comparator');
eq(await val('[1,2,3,4].filter(x => x % 2 === 0).reduce((s, x) => s + x, 0)'), 6, 'filter+reduce');
eq(await val('const {a, b: {c = 5}, ...rest} = {a: 1, b: {}, d: 4, e: 5}; [a, c, rest]'), [1, 5, { d: 4, e: 5 }], 'destructuring');
eq(await val('const [x, , y = 9, ...z] = [1, 2, undefined, 4, 5]; [x, y, z]'), [1, 9, [4, 5]], 'array destructuring');
eq(await val('let a = 1, b = 2; [a, b] = [b, a]; [a, b]'), [2, 1], 'swap');
eq(await val('const o = {a: 1, ...{b: 2}, ["c" + 1]: 3, m() { return this.a; }}; [o.a, o.b, o.c1, o.m()]'), [1, 2, 3, 1], 'object literal');
eq(await val('const o = {get x() { return 7; }}; o.x'), 7, 'getter');
eq(await val('null?.a ?? "d"'), 'd', 'optional chaining + nullish');
eq(await val('const o = {f: () => 3}; [o?.f?.(), o.g?.(), o.h?.i.j.k]'), [3, undefined, undefined], 'optional call / short circuit');
eq(await val('typeof nope'), 'undefined', 'typeof undeclared');
eq(await val('let x = 5; x += 2; x **= 2; x'), 49, 'compound assignment');
eq(await val('let x = null; x ??= 4; x ||= 9; x &&= 6; x'), 6, 'logical assignment');
eq(await val('let i = 0; const r = []; while (true) { if (++i > 5) break; if (i % 2) continue; r.push(i); } r'), [2, 4], 'while/break/continue');
eq(await val('let s = 0; for (let i = 0; i < 4; i++) { s += i; } s'), 6, 'for loop');
eq(await val('const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); fs.map(f => f())'), [0, 1, 2], 'per-iteration let binding');
eq(await val('const r = []; for (const k in {a: 1, b: 2}) r.push(k); r'), ['a', 'b'], 'for in');
eq(await val('const r = []; for (const [k, v] of Object.entries({a: 1, b: 2})) r.push(k + v); r'), ['a1', 'b2'], 'for of + entries');
eq(await val('outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; if (i === 2) break outer; } } "done"'), 'done', 'labels');
eq(await val('switch (2) { case 1: "a"; break; case 2: var r = "b"; case 3: r += "c"; break; default: r = "d"; } r'), 'bc', 'switch fallthrough');
eq(await val('let m; try { throw new Error("x"); } catch (e) { m = e.message } finally { m += "!"; } m'), 'x!', 'try / catch / finally');
eq(await val('let r = ""; try { try { throw 1; } finally { r += "f"; } } catch (e) { r += "c" + e; } r'), 'fc1', 'finally then outer catch');
eq(await val('function f() { try { return "t"; } finally { } } f()'), 't', 'return in try');
eq(await val('function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(15)'), 610, 'recursion + hoisting');
eq(await val('hoisted(); function hoisted() { return 1; } var v = typeof later; var later = 1; v'), 'undefined', 'var hoisting');
eq(await val('const add = (a, b = 10, ...rest) => a + b + rest.length; [add(1), add(1, 2, 3, 4)]'), [11, 5], 'defaults and rest params');
eq(await val('function f() { return arguments.length; } f(1, 2, 3)'), 3, 'arguments');
eq(await val('const o = {n: 1, inc() { this.n++; return this; }}; o.inc().inc().n'), 3, 'this in methods');
eq(await val('const f = function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }; f(5)'), 120, 'named function expression');
eq(await val('function Pt(x) { this.x = x; } const p = new Pt(4); p.x'), 4, 'new on an interpreted function');
eq(await val('new Date(0).getTime()'), 0, 'new on native');
eq(await val('const t = (s, ...v) => s.raw.join("|") + v.join(","); t`a${1}b${2}c`'), 'a|b|c1,2', 'tagged template');
eq(await val('/a(b+)/.exec("xabbb")[1]'), 'bbb', 'regex literal');
eq(await val('"b" in {b: 1}'), true, 'in operator');
eq(await val('[1, [2, 3]].flat().length + [...new Set([1, 1, 2])].length'), 5, 'spread of native iterables');

// --- class ---
eq(await val('class A { constructor(x) { this.x = x; } get double() { return this.x * 2; } add(n) { return this.x + n; } } const a = new A(3); [a.x, a.double, a.add(4), a instanceof A]'), [3, 6, 7, true], 'class basics');
eq(await val('class A { static make() { return new A(); } static n = 5; v = 1; } [A.make().v, A.n]'), [1, 5], 'static method, static and instance fields');
eq(await val('class A { hi() { return "A"; } } class B extends A { hi() { return super.hi() + "B"; } } new B().hi()'), 'AB', 'extends and super.method()');
eq(await val('class A { constructor(x) { this.x = x; } } class B extends A { constructor(x) { super(x + 1); this.y = 2; } } const b = new B(1); [b.x, b.y, b instanceof A]'), [2, 2, true], 'super() in a derived constructor');
eq(await val('class A { constructor() { this.k = "a"; } } class B extends A {} new B().k'), 'a', 'default derived constructor');
eq(await val('class A { f = 1; constructor() { this.g = this.f + 1; } } new A().g'), 2, 'fields are set before the constructor body');
eq(await val('class A { f = 1; } class B extends A { g = this.f + 1; } new B().g'), 2, 'fields of a derived class run after super()');
eq(await val('class C { #n = 1; inc() { return ++this.#n; } #hidden() { return "h"; } call() { return this.#hidden(); } } const c = new C(); [c.inc(), c.inc(), c.call(), Object.keys(c)]'), [2, 3, 'h', []], 'private fields and methods');
eq(await val('class E extends Error { constructor(m) { super(m); this.name = "E"; } } try { throw new E("boom"); } catch (e) { [e.name, e.message, e instanceof Error, e instanceof E] }'), undefined, 'catch block has no completion value');
eq(await val('class E extends Error { constructor(m) { super(m); this.name = "E"; } } let r; try { throw new E("boom"); } catch (e) { r = [e.name, e.message, e instanceof Error, e instanceof E]; } r'), ['E', 'boom', true, true], 'extending Error');
eq(await val('class P extends Array { sum() { return this.reduce((a, b) => a + b, 0); } } const p = new P(); p.push(1, 2, 3); p.sum()'), 6, 'extending Array');
eq(await val('const K = class Named { who() { return Named.name; } }; new K().who()'), 'Named', 'class expression');
eq(await val('class A { static get v() { return 9; } set w(x) { this._w = x; } get w() { return this._w; } } const a = new A(); a.w = 4; [A.v, a.w]'), [9, 4], 'static getter, getter / setter pair');
eq(await val('class A { async load() { await null; return 7; } } await new A().load()'), 7, 'async method');
eq(await val('class A { constructor() { this.f = () => this.v; this.v = 3; } } new A().f()'), 3, 'arrow function keeps this');
ok((await err('class A {} A()')).includes('without \'new\''), 'calling a class without new');
ok((await err('class A extends B {}')).includes('B is not defined'), 'unknown parent class');
ok((await err('class A extends Object { constructor() { this.x = 1; } } new A()')).includes('super constructor'), 'this before super()');
ok((await err('class A { m() { return this.constructor; } } new A().m()')).includes('not allowed'), 'constructor stays blocked in classes');
{
  const i = new Interpreter();
  await i.run('class Acc { constructor(n) { this.n = n; } get() { return this.n; } }');
  eq((await i.run('new Acc(5).get()')).value, 5, 'classes persist between runs');
}

// --- import 文 ---
{
  const mod = { PrivateKey: 'PK', Hash256: 'H', default: 'DEF' };
  const withMod = (i: Interpreter) => { i.importHandler = async (spec) => { if (spec === 'symbol-sdk') return mod; throw new Error(`blocked ${spec}`); }; };
  eq(await val('import { PrivateKey, Hash256 as H2 } from "symbol-sdk"; [PrivateKey, H2]', withMod), ['PK', 'H'], 'named imports');
  eq(await val('import * as sdk from "symbol-sdk"; sdk.PrivateKey', withMod), 'PK', 'namespace import');
  eq(await val('import D from "symbol-sdk"; D', withMod), 'DEF', 'default import');
  eq(await val('const before = typeof PrivateKey; import { PrivateKey } from "symbol-sdk"; before', withMod), 'string', 'imports are hoisted');
  ok((await err('import { Nope } from "symbol-sdk"', withMod)).includes("does not provide an export named 'Nope'"), 'unknown export name');
  ok((await err('import x from "https://evil.example/x.js"', withMod)).includes('blocked'), 'other modules go through the handler (and are refused)');
  ok((await err('import x from "symbol-sdk"')).includes('not available'), 'import without a handler');
  eq(await val('var o = 1; o + 1'), 2, 'plain scripts still parse as scripts');
}

// --- ジェネレータ ---
eq(await val('function* g() { yield 1; yield 2; return 3; } [...g()]'), [1, 2], 'spread of a generator');
eq(await val('function* g() { yield 1; yield 2; return 3; } const it = g(); [it.next(), it.next(), it.next(), it.next()]'), [{ value: 1, done: false }, { value: 2, done: false }, { value: 3, done: true }, { value: undefined, done: true }], 'next() results, including the return value');
eq(await val('function* g() { const a = yield 1; const b = yield a * 2; return a + b; } const it = g(); it.next(); [it.next(10).value, it.next(5).value]'), [20, 15], 'values sent into yield');
eq(await val('function* g() { let i = 0; while (true) yield i++; } const r = []; for (const x of g()) { if (x > 3) break; r.push(x); } r'), [0, 1, 2, 3], 'for-of over an endless generator with break');
eq(await val('function* inner() { yield "a"; return "r"; } function* outer() { const v = yield* inner(); yield v; yield* [1, 2]; } [...outer()]'), ['a', 'r', 1, 2], 'yield* (generator, return value, array)');
eq(await val('function* g() { try { yield 1; yield 2; } finally { log.push("cleanup"); } } var log = []; for (const x of g()) { break; } log'), ['cleanup'], 'finally runs when the loop leaves early (return())');
eq(await val('function* g() { try { yield 1; } catch (e) { yield "caught " + e; } } const it = g(); it.next(); it.throw("x").value'), 'caught x', 'throw() is caught inside the generator');
eq(await val('function* g() { yield 1; } const it = g(); [it.return(9), it.next()]'), [{ value: 9, done: true }, { value: undefined, done: true }], 'return() before the first next()');
eq(await val('const o = { *g() { yield 1; yield 2; } }; [...o.g()]'), [1, 2], 'generator method in an object');
eq(await val('class A { *items() { yield "x"; yield "y"; } static *s() { yield 1; } [Symbol.iterator]() { return this.items(); } } [[...new A()], [...A.s()]]'), [['x', 'y'], [1]], 'generator methods in a class, custom iterable');
eq(await val('function* g() { yield 1; yield 2; yield 3; } const [a, , c] = g(); [a, c]'), [1, 3], 'destructuring a generator');
ok((await err('function* g() { sign("x"); yield 1; } [...g()]', (i) => i.defineGlobal('sign', blockingFunction('sign', async () => 1)))).includes('synchronous generator'), 'waiting inside a sync generator is refused');
eq(await val('async function* g() { await null; yield 1; yield Promise.resolve(2); } const r = []; for await (const x of g()) r.push(x); r'), [1, 2], 'async generator with for await (yield awaits promises)');
eq(await val('async function* g() { yield 1; yield 2; } const it = g(); const a = it.next(); const b = it.next(); const c = it.next(); [(await a).value, (await b).value, (await c).done]'), [1, 2, true], 'concurrent next() calls are queued');
eq(await val('async function* inner() { yield "a"; yield "b"; } async function* outer() { yield* inner(); yield "c"; } const r = []; for await (const x of outer()) r.push(x); r'), ['a', 'b', 'c'], 'yield* in an async generator');
eq(await val('async function* g() { try { yield 1; yield 2; } finally { log.push("done"); } } var log = []; for await (const x of g()) { break; } log'), ['done'], 'async generator cleanup on break');
eq(await val('async function* g() { throw new Error("boom"); } let m; try { for await (const x of g()) {} } catch (e) { m = e.message; } m'), 'boom', 'error from an async generator');
{
  const sign = blockingFunction('sign', (_t, args) => new Promise((r) => setTimeout(() => r(`signed:${String(args[0])}`), 5)));
  eq(await val('async function* g() { yield sign("a"); yield sign("b"); } const r = []; for await (const x of g()) r.push(x); r', (i) => i.defineGlobal('sign', sign)), ['signed:a', 'signed:b'], 'signing inside an async generator');
}
eq(await val('function* ids() { let n = 0; while (true) { const reset = yield n++; if (reset) n = 0; } } const it = ids(); [it.next().value, it.next().value, it.next(true).value, it.next().value]'), [0, 1, 0, 1], 'generator keeps its own state');

// --- class の static ブロック ---
eq(await val('class A { static x = 1; static y; static { A.y = A.x + 1; this.z = 10; } } [A.x, A.y, A.z]'), [1, 2, 10], 'static block runs in order with static fields');
eq(await val('class A { static #n = 0; static { A.#n = 5; } static get n() { return A.#n; } } A.n'), 5, 'static block and a private static');
eq(await val('class A { static { var t = 3; this.v = t * 2; } } A.v'), 6, 'var in a static block stays inside it');

// --- export 文 ---
eq(await val('export const a = 1; export function f() { return a + 1; } export class K { v() { return 7; } } [a, f(), new K().v()]'), [1, 2, 7], 'export declarations run as normal ones');
eq(await val('const x = 5; export { x as y }; y'), 5, 'export { x as y } makes y available');
eq(await val('export default function () { return 1; } 1'), 1, 'anonymous default export is accepted');
eq(await val('export default 40 + 2; 3'), 3, 'default export of an expression is accepted');
eq(await val('export default class { } 4'), 4, 'anonymous default class is accepted');
{
  const mod = { A: 1, B: 2 };
  const withMod = (i: Interpreter) => { i.importHandler = async () => mod; };
  eq(await val('export { A as Z } from "symbol-sdk"; Z', withMod), 1, 'export { } from a module');
  eq(await val('export * from "symbol-sdk"; [A, B]', withMod), [1, 2], 'export * from a module');
  eq(await val('export * as ns from "symbol-sdk"; ns.B', withMod), 2, 'export * as ns');
  ok((await err('export { Nope } from "symbol-sdk"', withMod)).includes('does not provide'), 'export of an unknown name');
  ok((await err('export { missing };')).includes('not defined'), 'export of an unknown local');
}

// --- コールバックを取るネイティブ関数は、ふつうのJSと同じ結果になる ---
eq(await val('[1, 2, 3].map((x, i, a) => x * 10 + i + a.length)'), [1, 2, 3].map((x, i, a) => x * 10 + i + a.length), 'map args');
eq(await val('const a = [1, , 3]; const seen = []; a.forEach((x, i) => seen.push(i)); seen'), [0, 2], 'forEach skips holes');
eq(await val('[1, 2, 3, 4].reduce((a, b) => a + b)'), 10, 'reduce without an initial value');
eq(await val('[1, 2, 3].reduceRight((a, b) => a + "-" + b)'), '3-2-1', 'reduceRight');
ok((await err('[].reduce((a, b) => a)')).includes('Reduce of empty array'), 'reduce of an empty array');
eq(await val('[1, 2, 3].findLast(x => x < 3) + [1, 2, 3].findLastIndex(x => x < 3)'), 3, 'findLast / findLastIndex');
eq(await val('[5, 6].map(function (x) { return x + this.k; }, { k: 1 })'), [6, 7], 'thisArg');
eq(await val('Array.prototype.map.call("ab", c => c + c)'), ['aa', 'bb'], 'map on an array-like via call (native path)');
ok((await err('[1].map(x => { throw new TypeError("in cb"); })')).includes('in cb'), 'error from a callback propagates');
eq(await val('const out = []; try { [1, 2].forEach(x => { if (x === 2) throw new Error("stop"); out.push(x); }); } catch (e) { out.push(e.message); } out'), [1, 'stop'], 'throwing out of forEach stops it');
eq(await val('[3, 1, 2].map(x => x * 2).filter(x => x > 2).sort((a, b) => a - b)'), [4, 6], 'chained callbacks');
eq(await val('["1", "2"].map(Number)'), [1, 2], 'a native function as the callback still works');
eq(await val('[[1, 2], [3]].flatMap(a => a.map(x => x * 2))'), [2, 4, 6], 'nested callbacks');
eq(await val('const f = async x => x; await Promise.all([1, 2].map(f))'), [1, 2], 'async callbacks still give promises');

// --- with 文 ---
eq(await val('const o = { a: 1, b: 2 }; let r; with (o) { r = a + b; } r'), 3, 'with reads properties');
eq(await val('const o = { a: 1 }; with (o) { a = 5; var z = 9; } [o.a, z]'), [5, 9], 'with writes properties; var outside the object');
eq(await val('const o = { a: 1 }; with (o) { b = 7; } [o.b, b]'), [undefined, 7], 'an assignment to an unknown name is a global');
eq(await val('const o = { n: 2 }; with (o) { var f = () => n * 2; } o.n = 5; f()'), 10, 'closures made inside with keep the object');
eq(await val('const o = { x: 1 }; with (o) { with ({ y: 2 }) { var s = x + y; } } s'), 3, 'nested with');
eq(await val('let r; with (Math) { r = max(1, 3) + PI > 6; } r'), true, 'with a builtin object');
ok((await err('with ({}) { constructor }')).includes('constructor is not defined'), 'with cannot reach constructor');
ok((await err('with ({}) { __proto__ }')).includes('__proto__ is not defined'), 'with cannot reach __proto__');
ok((await err('with (null) {}')).includes('Cannot convert'), 'with null');
{
  const setup = () => { protect(Array); };
  void setup;
}
{
  const withProt = (i: Interpreter) => { protect(Array); i.defineGlobal('Array', Array); };
  ok((await err('with (Array.prototype) { map = 1; }', withProt)).includes('read-only'), 'with cannot overwrite a protected builtin');
}

// --- async / await ---
eq(await val('await 5'), 5, 'top-level await');
eq(await val('const f = async (x) => { await null; return x * 2; }; await f(4)'), 8, 'async arrow');
eq(await val('const sleep = (ms) => new Promise(r => setTimeout(r, ms)); await sleep(5); "slept"', (i) => i.defineGlobal('setTimeout', setTimeout)), 'slept', 'promise executor + setTimeout');
eq(await val('await Promise.all([1, 2, 3].map(async x => x * 10))'), [10, 20, 30], 'map with async callback -> promises');
eq(await val('Promise.resolve(3).then(x => x + 1)').then((p) => p), 4, 'then with interpreted callback (value is a Promise)');
eq(await val('try { await Promise.reject(new Error("no")); } catch (e) { "caught " + e.message }'), undefined, 'catch has no completion value');
eq(await val('let r; try { await Promise.reject(new Error("no")); } catch (e) { r = "caught " + e.message } r'), 'caught no', 'await rejection caught by try');
eq(await val('const r = []; for await (const x of [Promise.resolve(1), 2]) r.push(x); r'), [1, 2], 'for await over sync iterable');
eq(await val('async function g() { throw new TypeError("bad"); } let m; try { await g(); } catch (e) { m = e.name; } m'), 'TypeError', 'async function throw');
eq(await val('await import("https://x/symbol-sdk@3/bundle.web.js")', (i) => { i.importHandler = async () => ({ ok: 1 }); }), { ok: 1 }, 'dynamic import goes through the handler');
ok((await err('await import("https://evil.example/x.js")')).includes('not available'), 'import is off without a handler');

// --- 署名待ちのような blocking 関数 ---
{
  const sign = blockingFunction('sign', (_t, args) => new Promise((r) => setTimeout(() => r(`signed:${String(args[0])}`), 5)));
  eq(await val('const a = sign("x"); const b = [1, 2].length; a + b', (i) => i.defineGlobal('sign', sign)), 'signed:x2', 'blocking call looks synchronous');
  eq(await val('function go() { return sign("y"); } go()', (i) => i.defineGlobal('sign', sign)), 'signed:y', 'blocking call inside a sync interpreted function');
  const withSign = (i: Interpreter) => i.defineGlobal('sign', sign);
  eq(await val('[1, 2].map(x => sign("m" + x))', withSign), ['signed:m1', 'signed:m2'], 'signing inside Array.map');
  eq(await val('const r = []; [1, 2].forEach((x, i) => { r.push(sign("f" + x) + i); }); r', withSign), ['signed:f10', 'signed:f21'], 'signing inside forEach');
  eq(await val('[1, 2, 3].filter(x => sign("q") === "signed:q" && x > 1)', withSign), [2, 3], 'signing inside filter');
  eq(await val('[1, 2, 3].reduce((acc, x) => acc + sign("r").length, 0)', withSign), 'signed:r'.length * 3, 'signing inside reduce');
  eq(await val('[1, 2, 3].find(x => sign("x") && x === 2)', withSign), 2, 'signing inside find');
  eq(await val('[1, 2].some(x => sign("s") && x === 2)', withSign), true, 'signing inside some');
  eq(await val('[1, 2].every(x => sign("e") && x < 5)', withSign), true, 'signing inside every');
  eq(await val('[1, 2].flatMap(x => [sign("a"), x])', withSign), ['signed:a', 1, 'signed:a', 2], 'signing inside flatMap');
  eq(await val('Array.from([1, 2], x => sign("v") + x)', withSign), ['signed:v1', 'signed:v2'], 'signing inside Array.from');
  eq(await val('const r = []; new Map([[1, "a"]]).forEach((v, k) => r.push(sign("M") + v + k)); new Set([5]).forEach(v => r.push(sign("S") + v)); r', withSign), ['signed:Ma1', 'signed:S5'], 'signing inside Map / Set forEach');
  eq(await val('Promise.resolve(1).then(x => sign("t" + x))', withSign).then((p) => p), 'signed:t1', 'signing inside a then() callback (the callback becomes async)');
  eq(await val('new Promise((resolve) => setTimeout(() => resolve(sign("timer")), 1))', (i) => { i.defineGlobal('sign', sign); i.defineGlobal('setTimeout', setTimeout); }).then((p) => p), 'signed:timer', 'signing inside a timer callback');
  ok((await err('class A { constructor() { sign("c"); } } new A()', withSign)).includes('synchronous callback'), 'a constructor cannot wait (refused clearly)');
  let native = '';
  try { (sign as (...a: unknown[]) => unknown)('n'); } catch (e) { native = (e as Error).message; }
  ok(native.includes('directly from the code you typed'), 'calling it natively throws', native);
}

// --- 守り ---
ok((await err('({}).constructor')).includes('not allowed'), 'constructor blocked');
ok((await err('[].map["const" + "ructor"]("return 1")')).includes('not allowed'), 'computed constructor blocked');
ok((await err('({}).__proto__')).includes('not allowed'), '__proto__ blocked');
ok((await err('const {constructor} = {}; constructor')).includes('not allowed'), 'constructor via destructuring blocked');
ok((await err('"x" in {}; "constructor" in {}')).includes('not allowed'), 'constructor via in blocked');
ok((await err('window')).includes('window is not defined'), 'no window');
ok((await err('document.cookie')).includes('document is not defined'), 'no document');
ok((await err('localStorage')).includes('localStorage is not defined'), 'no localStorage');
ok((await err('globalThis')).includes('globalThis is not defined'), 'no globalThis');
ok((await err('eval("1")')).includes('eval is not defined'), 'no eval');
ok((await err('Function("return 1")')).includes('Function is not defined'), 'no Function');
{
  const setup = (i: Interpreter) => { protect(Array); protect(Object); protect(JSON); };
  ok((await err('Array.prototype.map = () => 1', setup)).includes('read-only'), 'Array.prototype is read-only');
  ok((await err('Array.foo = 1', setup)).includes('read-only'), 'Array is read-only');
  ok((await err('JSON.parse = () => 1', setup)).includes('read-only'), 'JSON is read-only');
  ok((await err('delete Array.prototype.map', setup)).includes('read-only'), 'delete on a protected object');
  eq(await val('const a = [1]; a.push(2); a.x = 1; a', setup), [1, 2], 'instances stay writable');
  eq(await val('Object.keys(Array)', setup), [], 'protected objects are still readable');
}

// --- 1回の操作でメモリを使い切る書き方の上限（lib/console/limits.ts） ---
{
  const big = (c: string) => err(c, (i) => i.defineGlobal('ArrayBuffer', ArrayBuffer));
  ok((await big('"x".repeat(1e9)')).includes('too large'), 'repeat limit');
  ok((await big('"x".padEnd(1e10)')).includes('too large'), 'padEnd limit');
  ok((await big('new Array(1e9)')).includes('too large'), 'new Array(huge) limit');
  ok((await big('Array(1e9)')).includes('too large'), 'Array(huge) limit');
  ok((await big('new Array(1e9).fill(0)')).includes('too large'), 'huge Array.fill limit');
  ok((await big('Array.from({ length: 1e9 })')).includes('too large'), 'Array.from huge length limit');
  ok((await big('new Uint8Array(1e9)')).includes('too large'), 'typed array limit');
  ok((await big('new ArrayBuffer(1e10)')).includes('too large'), 'ArrayBuffer limit');
  ok((await big('class P extends Array {} new P(1e9)')).includes('too large'), 'extends Array limit');
  ok((await big('2n ** 100000000n')).includes('too large'), 'BigInt ** limit');
  ok((await big('1n << 100000000n')).includes('too large'), 'BigInt << limit');
  ok((await big('let s = "a"; for (let i = 0; i < 40; i++) s += s; s.length')).includes('too large'), 'string doubling by += limit');
  ok((await big('let s = "a"; for (let i = 0; i < 40; i++) s = `${s}${s}`; s.length')).includes('too large'), 'string doubling by template limit');
  ok((await big('const a = []; a.length = 1e9')).includes('too large'), 'array length assignment limit');
  ok((await big('const a = []; a[2e9] = 1')).includes('too large'), 'array far index limit');
  // ふつうの大きさは、これまでどおり
  eq(await val('"x".repeat(1000).length'), 1000, 'normal repeat still works');
  eq(await val('new Array(5).fill(0)'), [0, 0, 0, 0, 0], 'normal Array.fill still works');
  eq(await val('new Uint8Array(32).length'), 32, 'normal typed array still works');
  eq(await val('2n ** 200n > 0n && (1n << 100n) > 0n'), true, 'normal BigInt ** and << still work');
  eq(await val('1n ** 1000000000n'), 1n, '1n ** big is trivial and allowed');
  eq(await val('const a = []; a[5] = 1; a.length'), 6, 'normal index write still works');
  eq(await val('let s = "ab"; for (let i = 0; i < 10; i++) s += s; s.length'), 2048, 'normal string growth still works');
}

// --- クラスのフィールド定義から、書き込み禁止の組み込みオブジェクトへ書けない ---
{
  const setup = (i: Interpreter) => { protect(Array); i.defineGlobal('Array', Array); };
  // 基底クラスのコンストラクタが組み込みオブジェクトを返し、派生クラスのフィールド定義がそこへ書き込む抜け道
  ok((await err('class A { constructor() { return Array.prototype; } } class B extends A { map = 1; } new B();', setup)).includes('read-only'),
    'class field cannot write into a protected object returned by the base constructor (default constructor)');
  ok((await err('class A { constructor() { return Array.prototype; } } class B extends A { constructor() { super(); } map = 1; } new B();', setup)).includes('read-only'),
    'class field cannot write into a protected object returned by the base constructor (explicit super())');
  ok((await err('class A { constructor() { return Array.prototype; } } class B extends A { #p = 1; } new B();', setup)).includes('read-only'),
    'private field cannot be added to a protected object');
  ok((await err('class A { constructor() { return Array; } } class B extends A { foo = 1; } new B();', setup)).includes('read-only'),
    'class field cannot write into a protected function');
  // 書き換えが起きていないこと
  eq(await val('class A { constructor() { return Array.prototype; } } class B extends A { map = 1; } try { new B(); } catch (e) { } typeof [].map', setup), 'function', 'Array.prototype.map is untouched');
  // 書き込み禁止でないオブジェクトを返す場合や、ふつうのクラスは今までどおり動く
  eq(await val('class A { constructor() { return {}; } } class B extends A { f = 3; } new B().f', setup), 3, 'a plain returned object still gets its fields');
  eq(await val('class A { x = 1; } class B extends A { y = 2; } const b = new B(); [b.x, b.y]', setup), [1, 2], 'ordinary field initialisation is unchanged');
}

// --- 変数の持ち越し・エラー ---
{
  const i = new Interpreter();
  await i.run('var a = 1; let b = 2; const c = 3; function f() { return a + b + c; } undeclared = 4;');
  const r = await i.run('a + b + c + undeclared + f()');
  eq(r.value, 16, 'variables and functions persist between runs');
  await i.run('const c = 30;');
  eq((await i.run('c')).value, 30, 'top-level const can be redeclared in a later run');
  let m = '';
  try { await i.run('const k = 1; k = 2;'); } catch (e) { m = (e as Error).message; }
  ok(m.includes('constant'), 'assignment to const', m);
  eq((await i.run('const q = 1')).hasValue, false, 'a declaration has no value');
  eq((await i.run('undefined')).hasValue, true, 'an expression has a value');
}
ok((await err('foo()')).includes('foo is not defined'), 'ReferenceError');
ok((await err('const o = {}; o.f()')).includes('o.f is not a function'), 'not a function message');
ok((await err('null.x')).includes('Cannot read properties of null'), 'null member access');
ok((await err('let x = ;')).startsWith('SyntaxError'), 'syntax error');

// --- 停止と、長い処理が固めないこと ---
{
  const i = new Interpreter();
  const p = i.run('let n = 0; while (true) { n++; }');
  setTimeout(() => { i.stopRequested = true; }, 20);
  let stopped = false;
  try { await p; } catch (e) { stopped = e instanceof StopSignal; }
  ok(stopped, 'an endless loop can be stopped');
  const t0 = Date.now();
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 1);
  await i.run('let s = 0; for (let k = 0; k < 20000; k++) { s += k; } s');
  ok(timerFired || Date.now() - t0 < 50, 'a long loop yields to the event loop');
}

// --- 同期コールバックの暴走 ---
{
  const s = await err('[2, 1].sort(() => { while (true) {} })');
  ok(s.includes('ran too long'), 'a runaway synchronous callback is cut off', s);
}

// --- 出力の整形 ---
eq(formatValue('plain'), 'plain', 'string at top level is raw');
eq(formatValue(['a', 1n, null, undefined]), "[ 'a', 1n, null, undefined ]", 'array of mixed values');
eq(formatValue({ a: 1, b: { c: [1, 2] } }), '{ a: 1, b: { c: [ 1, 2 ] } }', 'nested object');
eq(formatValue(new Uint8Array([1, 2, 3])), 'Uint8Array(3) [ 1, 2, 3 ]', 'Uint8Array');
eq(formatValue(new Map([[1, 'a']])), "Map(1) { 1 => 'a' }", 'Map');
eq(formatValue(new Error('boom')), 'Error: boom', 'error');
eq(formatValue(async function hello() {}), '[AsyncFunction: hello]', 'async function');
{ const c: Record<string, unknown> = {}; c.self = c; eq(formatValue(c), '{ self: [Circular] }', 'circular'); }
{ class Id { constructor(readonly v: string) {} toString() { return this.v; } } eq(formatValue(new Id('ABC')), 'Id(ABC)', 'class with toString'); }
ok(formatValue({ a: 'x'.repeat(100), b: 2 }).includes('\n'), 'long objects wrap');

// --- 対話（repl.ts）: Enter で実行してよいか / 履歴 ---
const incompleteCases: [string, boolean][] = [
  ['1 + 2', false], ['foo(', true], ['foo(1,\n', true], ['{', true], ['if (x) {', true], ['if (x) {\n  y\n}', false],
  ['`abc', true], ['`abc`', false], ['/* abc', true], ['let a = ', true], ['a.', true], ['x = {\n a: 1,\n', true],
  ['1 +* 2', false], ['foo bar', false], ['"abc', false], ['  ', false], ['', false],
  ['await fetch(x)\n.then((r) => r.json())\n.then((j) => {\n', true],
  ['await fetch(x)\n.then((r) => r.json())\n.then((j) => {\n  return j;\n});', false],
];
for (const [c, want] of incompleteCases) ok(isIncomplete(c) === want, `isIncomplete(${JSON.stringify(c)}) should be ${want}`);
eq(pushHistory(['a'], 'a  \n'), ['a'], 'history: same as the last one is not repeated');
eq(pushHistory(['a'], 'b'), ['a', 'b'], 'history: push');
eq(pushHistory(['a'], '  '), ['a'], 'history: blank is ignored');
eq([stepHistory(['a', 'b'], 2, -1), stepHistory(['a', 'b'], 0, -1), stepHistory(['a', 'b'], 2, 1)], [1, 0, 2], 'history: step stays in range');
eq(await val('x = 5; x * 2'), 10, 'assignment without a declaration (the 速習Symbol style) makes a global');
{
  const i = new Interpreter();
  i.defineGlobal('console', { log: () => undefined });
  await i.run('bob = 3');
  const r = await i.run('bob + 1');
  ok(r.hasValue && r.value === 4, 'variables stay between runs');
  const r2 = await i.run('console.log(1)');
  ok(r2.hasValue && r2.value === undefined, 'console.log gives an undefined result (shown as "< undefined")');
}

// --- wallet.messageEncoder()（ウォレットの鍵での暗号化・復号）: 確認待ちの関数をメソッドの連鎖で呼べる ---
{
  const i = new Interpreter();
  i.defineGlobal('Array', Array);
  i.defineGlobal('Uint8Array', Uint8Array);
  const asked: string[] = [];
  const enc = Object.freeze({
    encode: blockingFunction('encode', async (_t, args) => { asked.push('encrypt'); return Uint8Array.of(1, ...(args[1] as Uint8Array)); }),
    tryDecode: blockingFunction('tryDecode', async (_t, args) => { asked.push('decrypt'); return { isDecoded: true, message: (args[1] as Uint8Array).subarray(1) }; }),
  });
  i.defineGlobal('wallet', Object.freeze({ messageEncoder: () => enc }));
  const r = await i.run("c = wallet.messageEncoder().encode('pk', new Uint8Array([7, 8])); d = wallet.messageEncoder().tryDecode('pk', c); [Array.from(c), d.isDecoded, Array.from(d.message)]");
  eq(r.value, [[1, 7, 8], true, [7, 8]], 'wallet.messageEncoder().encode / tryDecode wait for the confirmation and return the result');
  eq(asked, ['encrypt', 'decrypt'], 'each encrypt / decrypt asks once');
}

// --- サンプル（samples.ts）: すべて構文として完結していて、速習Symbol の書き方（const なし・alice・sdkSymbol）になっている ---
for (const s of CONSOLE_SAMPLES) {
  try { parse(s.code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }); ok(!isIncomplete(s.code), `sample ${s.id} is complete`); }
  catch (e) { ok(false, `sample ${s.id} does not parse`, (e as Error).message); }
  ok(!/^\s*(const|let)\s/m.test(s.code), `sample ${s.id} has no const / let (as in the book)`);
  ok(!/walletKeyPair/.test(s.code), `sample ${s.id} uses alice, not walletKeyPair`);
}
eq(new Set(CONSOLE_SAMPLES.map((s) => s.id)).size, CONSOLE_SAMPLES.length, 'sample ids are unique');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
