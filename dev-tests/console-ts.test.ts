// コンソールの TypeScript モード（lib/console/tsStrip.ts と、interpreter.run(code, 'ts')、repl.isIncomplete(code, 'ts')）。通信なし。
// 実行: npx tsx dev-tests/console-ts.test.ts
import { Interpreter } from '../src/lib/console/interpreter';
import { isIncomplete } from '../src/lib/console/repl';
import { isConsoleLang, prepareCode, stripTypes } from '../src/lib/console/tsStrip';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(Object.is(a, b) || JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), what, `${String(a)} != ${String(b)}`);

async function val(code: string, lang: 'js' | 'ts'): Promise<unknown> {
  const i = new Interpreter();
  i.defineGlobal('console', { log: () => undefined });
  for (const [k, v] of Object.entries({ Math, JSON, Array, Promise, Object, Number, String, BigInt, Map, Set, Error })) i.defineGlobal(k, v);
  return (await i.run(code, lang)).value;
}
async function err(code: string, lang: 'js' | 'ts'): Promise<string> {
  try { await val(code, lang); return '(no error)'; } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
}

// --- 型を取り除いて動く ---
eq(await val('const a: bigint = 1_000000n; a * 2n', 'ts'), 2000000n, 'type annotation on const');
eq(await val('function f(x: number, y?: number): string { return String(x + (y ?? 0)); } f(1, 2)', 'ts'), '3', 'param / return types');
eq(await val('interface Foo { a: string }\ntype Bar = Foo | null;\nconst o: Foo = { a: "x" };\no.a', 'ts'), 'x', 'interface and type alias');
eq(await val('const n = ("5" as unknown as number); n', 'ts'), '5', 'as expression');
eq(await val('const m = new Map<string, number>(); m.set("a", 1); m.get("a")!', 'ts'), 1, 'generics and non-null');
eq(await val('const id = <T,>(x: T): T => x; id<number>(7)', 'ts'), 7, 'generic arrow');
eq(await val('enum E { A, B = 5 }\n[E.A, E.B, E[5]]', 'ts'), [0, 5, 'B'], 'enum');
eq(await val('class P { constructor(private x: number, public y = 2) {} sum(): number { return this.x + this.y; } }\nnew P(1).sum()', 'ts'), 3, 'class with parameter properties');
eq(await val('abstract class Q { abstract f(): number; g(): number { return this.f() + 1; } }\nclass R extends Q { f(): number { return 1; } }\nnew R().g()', 'ts'), 2, 'abstract class');
eq(await val('declare const zzz: number;\nlet v: number = 3;\nv', 'ts'), 3, 'declare is dropped');
eq(await val('let x = ({ a: 1 }) satisfies { a: number }; x.a', 'ts'), 1, 'satisfies');
eq(await val('const f = async (x: number): Promise<number> => x * 2; await f(4)', 'ts'), 8, 'async with Promise<number>');
eq(await val('import type { Foo } from "symbol-sdk"; const k: Foo | undefined = undefined; k === undefined', 'ts'), true, 'import type is dropped');

// --- JavaScript のコードは TypeScript モードでも同じに動く ---
eq(await val('const a = [1, 2, 3].map((x) => x * 2); a', 'ts'), [2, 4, 6], 'plain JS in ts mode');
eq(await val('2n ** 64n', 'ts'), 18446744073709551616n, 'bigint in ts mode');

// --- JavaScript モード（既定）は、いままでどおり。型は構文エラー ---
eq((await err('const a: number = 1;', 'js')).startsWith('SyntaxError'), true, 'type annotation is a syntax error in js mode');
eq(await val('1 + 2', 'js'), 3, 'js mode still works');
{
  const i = new Interpreter();
  eq((await i.run('40 + 2')).value, 42, 'run() without lang defaults to js');
  let threw = false;
  try { await i.run('const q: number = 1;'); } catch (e) { threw = e instanceof SyntaxError; }
  ok(threw, 'run() without lang does not strip types');
}

// --- 型のチェックはしない ---
eq(await val('const s: number = "not a number" as any; s', 'ts'), 'not a number', 'types are not checked');

// --- エラー ---
eq((await err('const x: number = ;', 'ts')).startsWith('SyntaxError'), true, 'syntax error in ts mode is a SyntaxError');
eq((await err('namespace N { export const a = 1; }\nN.a', 'ts')).includes('namespace'), true, 'namespace with values is rejected with a clear error');
eq((await err('declare namespace N { const a: number }\n1', 'ts')), '(no error)', 'declare namespace is fine');

// --- 行番号は保たれる（実行時エラーの行が合う） ---
{
  const code = 'interface A {\n  x: number;\n}\nconst a: A = { x: 1 };\nconsole.log(a.x);';
  eq(stripTypes(code).split('\n').length, code.split('\n').length, 'line count is kept');
  const i = new Interpreter();
  i.defineGlobal('console', { log: () => undefined });
  try { await i.run('interface A {\n  x: number;\n}\nconst a: A = { x: 1 };\nconsole.log(a.x);\nundefinedVar;', 'ts'); } catch { /* 期待どおり */ }
  eq(i.line, 6, 'runtime error line matches the input');
}

// --- isIncomplete ---
eq(isIncomplete('function f(a: number) {', 'ts'), true, 'ts: open brace is incomplete');
eq(isIncomplete('const x: number = ', 'ts'), true, 'ts: dangling assignment is incomplete');
eq(isIncomplete('const t = `abc', 'ts'), true, 'ts: open template is incomplete');
eq(isIncomplete('const x: number = 1;', 'ts'), false, 'ts: complete statement');
eq(isIncomplete('interface A { a: string }', 'ts'), false, 'ts: complete interface');
eq(isIncomplete('const x: number = 1;', 'js'), false, 'js: type error in the middle is a real error, not incomplete');
eq(isIncomplete('const x: number = ;', 'ts'), false, 'ts: a real syntax error is not incomplete');
eq(isIncomplete('function f() {'), true, 'default is js');

// --- 小さな部品 ---
eq(prepareCode('const a: number = 1;', 'js'), 'const a: number = 1;', 'prepareCode js returns as is');
eq(prepareCode('const a: number = 1;', 'ts').includes(': number'), false, 'prepareCode ts strips');
eq([isConsoleLang('js'), isConsoleLang('ts'), isConsoleLang('py'), isConsoleLang(undefined)], [true, true, false, false], 'isConsoleLang');

// --- 設定の保存（壊れた値は js に戻る） ---
{
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); },
  };
  mem.set('kasane-console-settings', JSON.stringify({ state: { limitNetwork: true, lang: 'ts' }, version: 3 }));
  const { useConsoleSettingsStore } = await import('../src/store/consoleSettingsStore');
  await useConsoleSettingsStore.persist.rehydrate();
  eq(useConsoleSettingsStore.getState().lang, 'ts', 'saved lang ts is restored');
  mem.set('kasane-console-settings', JSON.stringify({ state: { limitNetwork: true, lang: 'python' }, version: 3 }));
  await useConsoleSettingsStore.persist.rehydrate();
  eq(useConsoleSettingsStore.getState().lang, 'js', 'broken lang falls back to js');
  mem.set('kasane-console-settings', JSON.stringify({ state: { limitNetwork: false }, version: 2 }));
  await useConsoleSettingsStore.persist.rehydrate();
  eq(useConsoleSettingsStore.getState().lang, 'js', 'old save without lang defaults to js');
  eq(useConsoleSettingsStore.getState().limitNetwork, false, 'old save keeps other settings');
  useConsoleSettingsStore.getState().setLang('ts');
  eq(JSON.parse(mem.get('kasane-console-settings') ?? '{}').state?.lang, 'ts', 'setLang persists');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
