// コンソール用の JavaScript インタープリタ（サンドボックス）。
//
// なぜ自前で動かすのか: このウォレットの CSP は 'unsafe-eval' を許さない（vite-csp.ts）。ユーザーが打ち込んだコードを
// eval / new Function で動かすには CSP を緩める必要があり、鍵を扱うアプリ全体の守りが弱くなる。そこで、コードを
// acorn で構文木にし、この木歩きインタープリタで動かす。eval は使わない。
//
// 副産物として、コードから触れるのは「こちらが渡した変数だけ」になる（window / document / localStorage /
// IndexedDB は見えない）。ネットで拾ったコードを貼って動かす使い方でも、保存された鍵のファイルには届かない。
//   - constructor / __proto__ などへの参照は禁止（Function コンストラクタへ辿る経路を塞ぐ）。
//   - 渡した組み込みオブジェクト（Array.prototype や SDK のクラスなど）は `protect()` で書き込み禁止にする
//     （プロトタイプ汚染で、あとからウォレット本体が使う処理を差し替えられないように）。
//
// 作り: 評価はジェネレータ（`yield` は「このPromiseを待って」の合図）。`await` と、署名の確認待ち
// （`blockingFunction`）はこの合図で止まる。ネイティブの関数（Array.map など）から呼ばれるコールバックは同期で
// 最後まで走らせる（普通のJSと同じ動き）。同期のコールバックの中で待つ必要が出たらエラーにする。
//
// 対応: let / const / var、関数（アロー・async 含む）、分割代入・スプレッド・既定値、テンプレートリテラル、
//       オプショナルチェーン、BigInt、try / catch / finally、switch、各種ループ（for await 含む）、ラベル、
//       class（extends / super / static / static ブロック / getter・setter / フィールド / #private）、
//       ジェネレータ（function* / async function* / yield / yield*）、export 文（宣言はそのまま動かし、名前は公開用のグローバルに）、
//       with 文、コールバック（Array.map など）の中での署名待ち、
//       トップレベル await、await import('…symbol-sdk…')、import 文（import { A } from 'symbol-sdk' など）。
// 未対応: なし（署名・await を待てないのは、コンストラクタと同期ジェネレータの本体だけ。普通のJSでも同じ制約）。
import { parse } from 'acorn';
import { prepareCode } from './tsStrip';
import type { ConsoleLang } from './tsStrip';
import { checkArrayWrite, checkBigIntOp, checkConcat, checkConstruct, checkNativeCall, MAX_STRING_LENGTH } from './limits';

// ESTree のノード。acorn の型は緩いので、ここでは any で受ける。
// oxlint-disable-next-line typescript/no-explicit-any
type N = any;

/** ジェネレータの `yield` の合図は `isYield`、`await` や署名待ちの合図は `promise`。 */
interface Suspend { promise?: PromiseLike<unknown>; isYield?: boolean; yielded?: unknown }
type Gen<T> = Generator<Suspend, T, unknown>;

type DeclKind = 'var' | 'let' | 'const';
interface Binding { value: unknown; kind: DeclKind }
interface Completion { kind: 'break' | 'continue' | 'return'; label?: string; value?: unknown }
interface FnInfo { node: N; scope: Scope; isAsync: boolean; isArrow: boolean; isGenerator: boolean; /** メソッドのとき、super の参照先を引くための「ホーム」オブジェクト */ home?: object }
interface FieldDef { key: PropertyKey; node: N | null }
interface StaticItem { field?: FieldDef; block?: N[] }
interface GenState { g: Gen<unknown>; started: boolean; done: boolean; running: boolean; queue: Promise<unknown> }
interface ClassInfo { ctor: N | null; derived: boolean; fields: FieldDef[]; scope: Scope; proto: object }
type ClassFn = (...args: unknown[]) => unknown;

export interface RunResult { value: unknown; hasValue: boolean }

/** ジェネレータの return(v) を、本体の中へ伝える合図（try / finally は動かすが、catch では捕まえない）。 */
class GenReturn {
  readonly value: unknown;
  constructor(value: unknown) { this.value = value; }
}

/** 「停止」ボタンで投げる。スクリプトの try / catch では捕まえられない。 */
export class StopSignal {
  readonly message = 'Execution stopped';
}

// --- 守り -----------------------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(['constructor', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'callee']);

function checkKey(key: PropertyKey): void {
  if (typeof key === 'string' && FORBIDDEN_KEYS.has(key)) {
    throw new TypeError(`[console] access to the property "${key}" is not allowed`);
  }
}

const protectedObjects = new WeakSet<object>();

/** 渡した組み込みオブジェクトを書き込み禁止にする（コードからは読むだけ）。プロトタイプの鎖も含める。 */
export function protect(value: unknown, depth = 2, seen: WeakSet<object> = new WeakSet()): void {
  if (!((typeof value === 'object' && value !== null) || typeof value === 'function')) return;
  const obj = value as object;
  if (seen.has(obj)) return;
  seen.add(obj);
  protectedObjects.add(obj);
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== null) protect(proto, 0, seen);
  if (typeof value === 'function') {
    const p = (value as { prototype?: unknown }).prototype;
    if (p !== undefined) protect(p, 0, seen);
  }
  if (depth <= 0) return;
  for (const key of Reflect.ownKeys(obj)) {
    let v: unknown;
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (d === undefined || !('value' in d)) continue; // getter は呼ばない
      v = d.value;
    } catch { continue; }
    protect(v, depth - 1, seen);
  }
}

export function isProtected(value: unknown): boolean {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function') && protectedObjects.has(value as object);
}

function checkWritable(target: unknown): void {
  if (isProtected(target)) throw new TypeError('[console] this built-in object is read-only');
}

// --- 署名の確認待ちのような「コードからは普通の関数に見えるが、実際は待つ」関数 ----------------------------------

type BlockingImpl = (thisArg: unknown, args: unknown[]) => PromiseLike<unknown>;
const blockingImpls = new WeakMap<object, BlockingImpl>();

/**
 * コードからは普通の（同期の）関数として呼べるが、インタープリタが結果の Promise を待ってから続ける関数を作る。
 * `facade.signTransaction(keyPair, tx)` が、確認ダイアログの返事を待って署名を返すのに使う。
 * ネイティブのコード（SDK の内部など）から直接呼ばれたときは、間違った値を返さずエラーにする。
 */
export function blockingFunction(name: string, impl: BlockingImpl): (...args: unknown[]) => never {
  const f = function (): never {
    throw new Error(`[console] ${name}() can only be called directly from the code you typed`);
  };
  Object.defineProperty(f, 'name', { value: name });
  blockingImpls.set(f, impl);
  return f;
}

// --- インタープリタが投げた（または通した）エラーの目印 -----------------------------------------------------------

const interpreterErrors = new WeakSet<object>();
function tagError(e: unknown): void {
  if ((typeof e === 'object' && e !== null) || typeof e === 'function') interpreterErrors.add(e as object);
}
/** コンソールのコードの中で起きたエラーか（コールバックから漏れたものを画面に出すために使う）。 */
export function isInterpreterError(e: unknown): boolean {
  return ((typeof e === 'object' && e !== null) || typeof e === 'function') && interpreterErrors.has(e as object);
}

// --- スコープ -------------------------------------------------------------------------------------

/** `with (obj) { … }` の中で、名前を obj のプロパティとして読み書きするための束縛。 */
function withBinding(obj: object, name: string): Binding {
  return {
    get value(): unknown { return (obj as Record<string, unknown>)[name]; },
    set value(v: unknown) { checkWritable(obj); (obj as Record<string, unknown>)[name] = v; },
    kind: 'var',
  };
}

export class Scope {
  readonly vars = new Map<string, Binding>();
  readonly parent: Scope | null;
  readonly isFunction: boolean;
  /** with 文の対象（このスコープの名前探しで、先にこのオブジェクトのプロパティを見る） */
  withObj: object | undefined = undefined;
  constructor(parent: Scope | null, isFunction = false) {
    this.parent = parent;
    this.isFunction = isFunction;
  }
  find(name: string): Binding | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      // constructor などの禁止された名前と、内部用の名前（%…・this）は、with のオブジェクトからは引かない
      if (s.withObj !== undefined && !name.startsWith('%') && name !== 'this' && !FORBIDDEN_KEYS.has(name) && name in s.withObj) return withBinding(s.withObj, name);
      const b = s.vars.get(name);
      if (b !== undefined) return b;
    }
    return undefined;
  }
  functionScope(): Scope {
    let s: Scope = this;
    while (!s.isFunction && s.parent !== null) s = s.parent;
    return s;
  }
}

// --- 構文木の下調べ ------------------------------------------------------------------------------------

function patternNames(p: N, out: Set<string>): void {
  if (p === null || p === undefined) return;
  switch (p.type) {
    case 'Identifier': out.add(p.name); break;
    case 'ObjectPattern': for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) patternNames(el, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
    default: break;
  }
}

/** `var` で宣言される名前を集める（関数の中までは入らない）。巻き上げ用。 */
function collectVarNames(node: N, out: Set<string>): void {
  if (node === null || node === undefined) return;
  switch (node.type) {
    case 'VariableDeclaration': if (node.kind === 'var') for (const d of node.declarations) patternNames(d.id, out); break;
    case 'BlockStatement': for (const s of node.body) collectVarNames(s, out); break;
    case 'IfStatement': collectVarNames(node.consequent, out); collectVarNames(node.alternate, out); break;
    case 'ForStatement': collectVarNames(node.init, out); collectVarNames(node.body, out); break;
    case 'ForInStatement': case 'ForOfStatement': collectVarNames(node.left, out); collectVarNames(node.body, out); break;
    case 'WhileStatement': case 'DoWhileStatement': collectVarNames(node.body, out); break;
    case 'TryStatement': collectVarNames(node.block, out); collectVarNames(node.handler?.body, out); collectVarNames(node.finalizer, out); break;
    case 'SwitchStatement': for (const c of node.cases) for (const s of c.consequent) collectVarNames(s, out); break;
    case 'LabeledStatement': case 'WithStatement': collectVarNames(node.body, out); break;
    case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': collectVarNames(node.declaration, out); break;
    default: break;
  }
}

/** エラーメッセージ用に、呼び出す対象の見た目を作る（例: `facade.foo`）。 */
function describe(node: N): string {
  if (!node) return 'expression';
  switch (node.type) {
    case 'Identifier': return node.name;
    case 'ThisExpression': return 'this';
    case 'MemberExpression': {
      const base = describe(node.object);
      if (!node.computed) return `${base}.${node.property.name}`;
      return `${base}[...]`;
    }
    case 'CallExpression': return `${describe(node.callee)}(...)`;
    case 'ChainExpression': return describe(node.expression);
    default: return 'expression';
  }
}

function toKey(v: unknown): PropertyKey {
  return typeof v === 'symbol' ? v : typeof v === 'number' ? v : String(v);
}

const SHORT = Symbol('optional-chain-short-circuit');
/** 派生クラスで super() を呼ぶ前の `this`。 */
const UNINIT = Symbol('uninitialized-this');

function loopControl(c: Completion | undefined, labels: string[]): { done: boolean; out?: Completion } {
  if (c === undefined) return { done: false };
  if (c.kind === 'break') return c.label === undefined || labels.includes(c.label) ? { done: true } : { done: true, out: c };
  if (c.kind === 'continue') return c.label === undefined || labels.includes(c.label) ? { done: false } : { done: true, out: c };
  return { done: true, out: c };
}

/* oxlint-disable-next-line typescript/no-explicit-any */
function binop(op: string, a: any, b: any): unknown {
  if (op === '+') checkConcat(a, b);
  else if (op === '**' || op === '<<') checkBigIntOp(op, a, b);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '**': return a ** b;
    case '==': return a == b;
    case '!=': return a != b;
    case '===': return a === b;
    case '!==': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '>>>': return a >>> b;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    case 'in': {
      if (typeof b !== 'object' && typeof b !== 'function') throw new TypeError("Cannot use 'in' operator to search for a key in a non-object");
      checkKey(toKey(a));
      return a in b;
    }
    case 'instanceof': return a instanceof b;
    default: throw new SyntaxError(`Unsupported operator ${op}`);
  }
}

const SYNC_STEP_LIMIT = 5_000_000;
const YIELD_EVERY = 2000;

export class Interpreter {
  readonly global = new Scope(null, true);
  /** true にすると、次の区切りで StopSignal を投げて止まる。 */
  stopRequested = false;
  /** `await import('…')` の中身を返す。指定が無ければ import は使えない。 */
  importHandler: ((specifier: string) => Promise<unknown>) | null = null;
  /** 直前に動かした文の行（エラーに行番号を添えるため）。 */
  line = 0;

  private readonly fnInfos = new WeakMap<object, FnInfo>();
  private readonly classInfos = new WeakMap<object, ClassInfo>();
  private readonly genStates = new WeakMap<object, GenState>();
  /** Array.map などのコールバックを取るネイティブ関数。解釈中のコールバックのときは、こちらで代わりに動かす（待ちが通るように）。 */
  private readonly hofs = new Map<unknown, { idx: number; run: (thisVal: unknown, args: unknown[]) => Gen<unknown> }>();
  private readonly syncGenProto: object;
  private readonly asyncGenProto: object;
  private steps = 0;
  private syncDepth = 0;
  private syncSteps = 0;

  constructor() {
    this.global.vars.set('this', { value: undefined, kind: 'const' });
    this.global.vars.set('undefined', { value: undefined, kind: 'const' });
    this.global.vars.set('NaN', { value: NaN, kind: 'const' });
    this.global.vars.set('Infinity', { value: Infinity, kind: 'const' });
    this.syncGenProto = this.makeGenProto(false);
    this.asyncGenProto = this.makeGenProto(true);
    this.registerHofs();
  }

  // --- 公開 -------------------------------------------------------------------------------------

  defineGlobal(name: string, value: unknown, kind: DeclKind = 'var'): void {
    this.global.vars.set(name, { value, kind });
  }
  getGlobal(name: string): unknown {
    return this.global.vars.get(name)?.value;
  }
  hasGlobal(name: string): boolean {
    return this.global.vars.has(name);
  }
  globalNames(): string[] {
    return [...this.global.vars.keys()].filter((k) => k !== 'this');
  }

  /**
   * コードを動かす。構文エラーは acorn の SyntaxError（loc 付き）、実行時のエラーはそのまま投げる。
   * lang が 'ts' のときは、動かす前に型を取り除く（型のチェックはしない。tsStrip.ts）。省略すると 'js'（そのまま）。
   */
  async run(source: string, lang: ConsoleLang = 'js'): Promise<RunResult> {
    const code = prepareCode(source, lang);
    const opts = { ecmaVersion: 'latest', locations: true } as const;
    let program: N;
    try {
      program = parse(code, { ...opts, sourceType: 'script', allowAwaitOutsideFunction: true });
    } catch (e) {
      // import 文があるコードだけ、モジュールとして読み直す（ふだんは var の巻き上げなどが普通のスクリプトと同じ）
      if (e instanceof SyntaxError && /sourceType/.test(e.message)) program = parse(code, { ...opts, sourceType: 'module' });
      else throw e;
    }
    this.stopRequested = false;
    this.line = 0;
    return this.runAsync(this.runProgram(program));
  }

  // --- ドライバ ---------------------------------------------------------------------------------

  private runAsync<T>(g: Gen<T>, first?: IteratorResult<Suspend, T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const step = (advance: () => IteratorResult<Suspend, T>) => {
        let r: IteratorResult<Suspend, T>;
        try {
          r = advance();
        } catch (e) {
          tagError(e);
          reject(e);
          return;
        }
        if (r.done) {
          resolve(r.value);
          return;
        }
        if (r.value.isYield) {
          reject(new SyntaxError('[console] yield outside a generator'));
          return;
        }
        Promise.resolve(r.value.promise).then(
          (v) => step(() => g.next(v)),
          (e) => step(() => g.throw(e)),
        );
      };
      step(first !== undefined ? () => first : () => g.next());
    });
  }

  /**
   * ネイティブのコードから呼ばれた同期の関数の入口。ふつうは最後まで同期で走らせて値を返す。
   * 途中で待つこと（署名の確認など）が出たら、そこから非同期で続けて Promise を返す
   * （`.then(x => facade.signTransaction(…))` や、タイマー・イベントのコールバックで署名できるように）。
   */
  private runSyncOrPromise<T>(g: Gen<T>): T | Promise<T> {
    this.syncDepth++;
    let r: IteratorResult<Suspend, T>;
    try {
      r = g.next();
    } finally {
      this.syncDepth--;
      if (this.syncDepth === 0) this.syncSteps = 0;
    }
    if (r.done) return r.value;
    return this.runAsync(g, r);
  }

  private runSync<T>(g: Gen<T>): T {
    this.syncDepth++;
    try {
      const r = g.next();
      if (!r.done) {
        g.return(undefined as never);
        throw new Error('[console] cannot wait (await / signing) inside a synchronous callback; use an async function');
      }
      return r.value;
    } finally {
      this.syncDepth--;
      if (this.syncDepth === 0) this.syncSteps = 0;
    }
  }

  /** 長い処理が画面を固めないよう、一定の歩数ごとに他の処理へ譲る。停止の確認もここ。 */
  private *tick(node?: N): Gen<void> {
    if (this.stopRequested) throw new StopSignal();
    if (node?.loc) this.line = node.loc.start.line;
    if (this.syncDepth > 0) {
      if (++this.syncSteps > SYNC_STEP_LIMIT) throw new Error('[console] the callback ran too long');
      return;
    }
    if (++this.steps % YIELD_EVERY === 0) {
      yield { promise: new Promise<void>((r) => setTimeout(r, 0)) };
      if (this.stopRequested) throw new StopSignal();
    }
  }

  // --- プログラム・文 ----------------------------------------------------------------------------

  private *runProgram(program: N): Gen<RunResult> {
    const scope = this.global;
    for (const stmt of program.body) if (stmt.type === 'ImportDeclaration') yield* this.runImport(stmt);
    const names = new Set<string>();
    for (const s of program.body) collectVarNames(s, names);
    for (const n of names) if (!scope.vars.has(n)) scope.vars.set(n, { value: undefined, kind: 'var' });
    this.hoistFunctions(program.body, scope);
    let value: unknown;
    let hasValue = false;
    for (const stmt of program.body) {
      if (stmt.type === 'ImportDeclaration') continue; // 先頭でまとめて読み込み済み
      if (stmt.type === 'ExpressionStatement') {
        yield* this.tick(stmt);
        value = yield* this.ev(stmt.expression, scope);
        hasValue = true;
      } else {
        const c = yield* this.ex(stmt, scope, []);
        if (c !== undefined) break;
      }
    }
    return { value, hasValue };
  }

  private *loadModule(spec: string): Gen<Record<string, unknown>> {
    if (this.importHandler === null) throw new Error('[console] import is not available');
    return (yield { promise: this.importHandler(spec) }) as Record<string, unknown>;
  }

  private *runImport(node: N): Gen<void> {
    const spec = String(node.source.value);
    const mod = yield* this.loadModule(spec);
    for (const sp of node.specifiers) {
      let value: unknown;
      if (sp.type === 'ImportSpecifier') {
        const imported: string = sp.imported.type === 'Identifier' ? sp.imported.name : String(sp.imported.value);
        if (!(imported in mod)) throw new SyntaxError(`The module '${spec}' does not provide an export named '${imported}'`);
        value = mod[imported];
      } else if (sp.type === 'ImportDefaultSpecifier') {
        value = 'default' in mod ? mod.default : mod;
      } else {
        value = mod;
      }
      this.global.vars.set(sp.local.name, { value, kind: 'const' });
    }
  }

  private hoistFunctions(stmts: N[], scope: Scope): void {
    for (const s0 of stmts) {
      const s = (s0.type === 'ExportNamedDeclaration' || s0.type === 'ExportDefaultDeclaration') && s0.declaration ? s0.declaration : s0;
      if (s.type === 'FunctionDeclaration' && s.id) {
        scope.vars.set(s.id.name, { value: this.makeFunction(s, scope), kind: 'var' });
      }
    }
  }

  private *execList(stmts: N[], scope: Scope): Gen<Completion | undefined> {
    this.hoistFunctions(stmts, scope);
    for (const s of stmts) {
      const c = yield* this.ex(s, scope, []);
      if (c !== undefined) return c;
    }
    return undefined;
  }

  private *ex(node: N, scope: Scope, labels: string[]): Gen<Completion | undefined> {
    yield* this.tick(node);
    switch (node.type) {
      case 'ExpressionStatement':
        yield* this.ev(node.expression, scope);
        return undefined;
      case 'VariableDeclaration': {
        for (const d of node.declarations) {
          if (d.init === null) {
            if (node.kind === 'var') continue; // 巻き上げ済み。値は変えない
            yield* this.bind(d.id, undefined, scope, node.kind);
            continue;
          }
          const value = yield* this.evNamed(d.init, scope, d.id.type === 'Identifier' ? d.id.name : '');
          yield* this.bind(d.id, value, scope, node.kind);
        }
        return undefined;
      }
      case 'FunctionDeclaration': return undefined; // 巻き上げ済み
      case 'ClassDeclaration': {
        const C = yield* this.makeClass(node, scope);
        this.declare(scope, node.id.name, C, 'let');
        return undefined;
      }
      // export は、宣言をそのまま動かす（コンソールでは、どれもこの場でグローバルになる）。`export { a as b }` は別名 b も作る。
      case 'ExportNamedDeclaration': {
        if (node.declaration) return yield* this.ex(node.declaration, scope, []);
        const mod = node.source ? yield* this.loadModule(String(node.source.value)) : null;
        for (const sp of node.specifiers) {
          const local: string = sp.local.type === 'Identifier' ? sp.local.name : String(sp.local.value);
          const exported: string = sp.exported.type === 'Identifier' ? sp.exported.name : String(sp.exported.value);
          let value: unknown;
          if (mod !== null) {
            if (!(local in mod)) throw new SyntaxError(`The module '${String(node.source.value)}' does not provide an export named '${local}'`);
            value = mod[local];
          } else {
            const b = scope.find(local);
            if (b === undefined) throw new ReferenceError(`${local} is not defined`);
            value = b.value;
          }
          if (mod !== null || exported !== local) this.global.vars.set(exported, { value, kind: 'const' });
        }
        return undefined;
      }
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) return yield* this.ex(d, scope, []);
        if (d.type === 'FunctionDeclaration') this.makeFunction(d, scope);
        else if (d.type === 'ClassDeclaration') yield* this.makeClass(d, scope);
        else yield* this.ev(d, scope);
        return undefined;
      }
      case 'ExportAllDeclaration': {
        const mod = yield* this.loadModule(String(node.source.value));
        if (node.exported) {
          this.global.vars.set(node.exported.type === 'Identifier' ? node.exported.name : String(node.exported.value), { value: mod, kind: 'const' });
        } else {
          for (const k of Object.keys(mod)) if (k !== 'default') this.global.vars.set(k, { value: mod[k], kind: 'const' });
        }
        return undefined;
      }
      case 'ReturnStatement':
        return { kind: 'return', value: node.argument ? yield* this.ev(node.argument, scope) : undefined };
      case 'IfStatement':
        if (yield* this.ev(node.test, scope)) return yield* this.ex(node.consequent, scope, []);
        return node.alternate ? yield* this.ex(node.alternate, scope, []) : undefined;
      case 'BlockStatement':
        return yield* this.execList(node.body, new Scope(scope));
      case 'EmptyStatement': case 'DebuggerStatement': return undefined;
      case 'WithStatement': {
        const obj = yield* this.ev(node.object, scope);
        if (obj === null || obj === undefined) throw new TypeError('Cannot convert undefined or null to object');
        const ws = new Scope(scope);
        ws.withObj = Object(obj) as object;
        return yield* this.ex(node.body, ws, []);
      }
      case 'BreakStatement': return { kind: 'break', label: node.label?.name };
      case 'ContinueStatement': return { kind: 'continue', label: node.label?.name };
      case 'ThrowStatement': throw (yield* this.ev(node.argument, scope));
      case 'LabeledStatement': {
        const c = yield* this.ex(node.body, scope, [...labels, node.label.name]);
        if (c !== undefined && c.kind === 'break' && c.label === node.label.name) return undefined;
        return c;
      }
      case 'WhileStatement': {
        for (;;) {
          yield* this.tick(node);
          if (!(yield* this.ev(node.test, scope))) break;
          const r = loopControl(yield* this.ex(node.body, scope, []), labels);
          if (r.done) return r.out;
        }
        return undefined;
      }
      case 'DoWhileStatement': {
        do {
          yield* this.tick(node);
          const r = loopControl(yield* this.ex(node.body, scope, []), labels);
          if (r.done) return r.out;
        } while (yield* this.ev(node.test, scope));
        return undefined;
      }
      case 'ForStatement': {
        let cur = new Scope(scope);
        const perIteration = node.init?.type === 'VariableDeclaration' && node.init.kind !== 'var';
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') yield* this.ex(node.init, cur, []);
          else yield* this.ev(node.init, cur);
        }
        for (;;) {
          yield* this.tick(node);
          if (node.test && !(yield* this.ev(node.test, cur))) break;
          const r = loopControl(yield* this.ex(node.body, cur, []), labels);
          if (r.done) return r.out;
          if (perIteration) {
            // 反復ごとに新しい束縛にする（本体で作ったクロージャが、その回の値を持ち続けるように）
            const next = new Scope(scope);
            for (const [k, b] of cur.vars) next.vars.set(k, { value: b.value, kind: b.kind });
            cur = next;
          }
          if (node.update) yield* this.ev(node.update, cur);
        }
        return undefined;
      }
      case 'ForInStatement': {
        const obj = yield* this.ev(node.right, scope);
        const keys: string[] = [];
        if (obj !== null && obj !== undefined) for (const k in obj as object) keys.push(k);
        for (const key of keys) {
          yield* this.tick(node);
          const iter = new Scope(scope);
          yield* this.bindForTarget(node.left, key, iter);
          const r = loopControl(yield* this.ex(node.body, iter, []), labels);
          if (r.done) return r.out;
        }
        return undefined;
      }
      case 'ForOfStatement': return yield* this.execForOf(node, scope, labels);
      case 'SwitchStatement': {
        const disc = yield* this.ev(node.discriminant, scope);
        const inner = new Scope(scope);
        let start = -1;
        for (let i = 0; i < node.cases.length; i++) {
          const c = node.cases[i];
          if (c.test !== null && (yield* this.ev(c.test, inner)) === disc) { start = i; break; }
        }
        if (start < 0) start = node.cases.findIndex((c: N) => c.test === null);
        if (start < 0) return undefined;
        for (let i = start; i < node.cases.length; i++) {
          this.hoistFunctions(node.cases[i].consequent, inner);
          for (const s of node.cases[i].consequent) {
            const c = yield* this.ex(s, inner, []);
            if (c !== undefined) {
              if (c.kind === 'break' && c.label === undefined) return undefined;
              return c;
            }
          }
        }
        return undefined;
      }
      case 'TryStatement': {
        let comp: Completion | undefined;
        let thrown = false;
        let error: unknown;
        try {
          comp = yield* this.ex(node.block, scope, []);
        } catch (e) {
          if (e instanceof StopSignal) throw e;
          if (node.handler && !(e instanceof GenReturn)) {
            try {
              const cs = new Scope(scope);
              if (node.handler.param) yield* this.bind(node.handler.param, e, cs, 'let');
              comp = yield* this.execList(node.handler.body.body, cs);
            } catch (e2) {
              if (e2 instanceof StopSignal) throw e2;
              thrown = true;
              error = e2;
            }
          } else {
            thrown = true;
            error = e;
          }
        }
        if (node.finalizer) {
          const f = yield* this.ex(node.finalizer, scope, []);
          if (f !== undefined) return f; // finally の break / return は、投げられたエラーより優先される
        }
        if (thrown) throw error;
        return comp;
      }
      default:
        throw new SyntaxError(`[console] ${node.type} is not supported`);
    }
  }

  private *bindForTarget(left: N, value: unknown, scope: Scope): Gen<void> {
    if (left.type === 'VariableDeclaration') yield* this.bind(left.declarations[0].id, value, scope, left.kind);
    else yield* this.bind(left, value, scope, 'assign');
  }

  private *execForOf(node: N, scope: Scope, labels: string[]): Gen<Completion | undefined> {
    const iterable = yield* this.ev(node.right, scope);
    if (iterable === null || iterable === undefined) throw new TypeError(`${describe(node.right)} is not iterable`);
    const isAwait = node.await === true;
    const src = iterable as Record<PropertyKey, unknown>;
    let iterator: { next(): unknown; return?(): unknown };
    let asyncIter = false;
    if (isAwait && typeof src[Symbol.asyncIterator] === 'function') {
      iterator = (src[Symbol.asyncIterator] as () => typeof iterator).call(iterable);
      asyncIter = true;
    } else if (typeof src[Symbol.iterator] === 'function') {
      iterator = (src[Symbol.iterator] as () => typeof iterator).call(iterable);
    } else {
      throw new TypeError(`${describe(node.right)} is not iterable`);
    }
    try {
      for (;;) {
        yield* this.tick(node);
        let step = iterator.next() as { done?: boolean; value: unknown };
        if (asyncIter) step = (yield { promise: Promise.resolve(step) }) as typeof step;
        if (step.done) break;
        let value = step.value;
        if (isAwait && !asyncIter) value = yield { promise: Promise.resolve(value) };
        const iter = new Scope(scope);
        yield* this.bindForTarget(node.left, value, iter);
        const r = loopControl(yield* this.ex(node.body, iter, []), labels);
        if (r.done) {
          this.closeIterator(iterator);
          return r.out;
        }
      }
    } catch (e) {
      this.closeIterator(iterator);
      throw e;
    }
    return undefined;
  }

  private closeIterator(iterator: { return?(): unknown }): void {
    try { iterator.return?.(); } catch { /* 閉じるときのエラーは無視 */ }
  }

  // --- 束縛（宣言・代入・分割代入） --------------------------------------------------------------

  private declare(scope: Scope, name: string, value: unknown, kind: DeclKind): void {
    if (kind === 'var') {
      const fs = scope.functionScope();
      const existing = scope.find(name);
      if (existing !== undefined && existing.kind === 'var') existing.value = value;
      else fs.vars.set(name, { value, kind: 'var' });
      return;
    }
    scope.vars.set(name, { value, kind });
  }

  private assignVar(scope: Scope, name: string, value: unknown): void {
    const b = scope.find(name);
    if (b === undefined) {
      this.global.vars.set(name, { value, kind: 'var' }); // 宣言なしの代入は、グローバル変数になる（ブラウザのコンソールと同じ）
      return;
    }
    if (b.kind === 'const') throw new TypeError('Assignment to constant variable.');
    b.value = value;
  }

  private setProp(obj: unknown, key: PropertyKey, value: unknown): void {
    if (obj === null || obj === undefined) throw new TypeError(`Cannot set properties of ${obj} (setting '${String(key)}')`);
    checkKey(key);
    checkWritable(obj);
    checkArrayWrite(obj, key, value);
    (obj as Record<PropertyKey, unknown>)[key] = value;
  }

  private getProp(obj: unknown, key: PropertyKey): unknown {
    if (obj === null || obj === undefined) throw new TypeError(`Cannot read properties of ${obj} (reading '${String(key)}')`);
    checkKey(key);
    return (obj as Record<PropertyKey, unknown>)[key];
  }

  private *bind(pattern: N, value: unknown, scope: Scope, kind: DeclKind | 'assign'): Gen<void> {
    switch (pattern.type) {
      case 'Identifier':
        if (kind === 'assign') this.assignVar(scope, pattern.name, value);
        else this.declare(scope, pattern.name, value, kind);
        return;
      case 'MemberExpression': {
        if (kind !== 'assign') throw new SyntaxError('Invalid destructuring target');
        const obj = yield* this.ev(pattern.object, scope);
        const key = yield* this.memberKey(pattern, scope);
        this.setProp(obj, key, value);
        return;
      }
      case 'AssignmentPattern': {
        const v = value === undefined ? yield* this.evNamed(pattern.right, scope, pattern.left.type === 'Identifier' ? pattern.left.name : '') : value;
        yield* this.bind(pattern.left, v, scope, kind);
        return;
      }
      case 'ObjectPattern': {
        if (value === null || value === undefined) throw new TypeError(`Cannot destructure '${String(value)}' as it is ${value}.`);
        const used: PropertyKey[] = [];
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            const rest: Record<PropertyKey, unknown> = {};
            for (const k of Reflect.ownKeys(Object(value))) {
              if (used.includes(k)) continue;
              const d = Object.getOwnPropertyDescriptor(Object(value), k);
              if (d?.enumerable) Object.defineProperty(rest, k, { value: (value as Record<PropertyKey, unknown>)[k], writable: true, enumerable: true, configurable: true });
            }
            yield* this.bind(prop.argument, rest, scope, kind);
            continue;
          }
          const key = prop.computed ? toKey(yield* this.ev(prop.key, scope)) : prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
          used.push(key);
          yield* this.bind(prop.value, this.getProp(value, key), scope, kind);
        }
        return;
      }
      case 'ArrayPattern': {
        if (value === null || value === undefined || typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] !== 'function') {
          throw new TypeError(`${typeof value} is not iterable`);
        }
        const arr = Array.from(value as Iterable<unknown>);
        for (let i = 0; i < pattern.elements.length; i++) {
          const el = pattern.elements[i];
          if (el === null) continue;
          if (el.type === 'RestElement') yield* this.bind(el.argument, arr.slice(i), scope, kind);
          else yield* this.bind(el, arr[i], scope, kind);
        }
        return;
      }
      default:
        throw new SyntaxError(`[console] cannot assign to ${pattern.type}`);
    }
  }

  // --- 関数 ------------------------------------------------------------------------------------

  private makeFunction(node: N, scope: Scope, nameHint = '', home?: object): (...args: unknown[]) => unknown {
    const info: FnInfo = { node, scope, isAsync: node.async === true, isArrow: node.type === 'ArrowFunctionExpression', isGenerator: node.generator === true, home };
    const self = this;
    let fn: (...args: unknown[]) => unknown;
    if (info.isGenerator) {
      fn = function (this: unknown, ...args: unknown[]) { return self.makeGenerator(info, this, args); };
    } else if (info.isArrow) {
      fn = (...args: unknown[]) => self.invoke(info, undefined, args);
    } else {
      fn = function (this: unknown, ...args: unknown[]) { return self.invoke(info, this, args); };
    }
    const name: string = node.id?.name ?? nameHint;
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
    this.fnInfos.set(fn, info);
    return fn;
  }

  /** ネイティブのコードから呼ばれたとき（イベント・Array.map・Promise.then など）の入口。 */
  private invoke(info: FnInfo, thisArg: unknown, args: unknown[]): unknown {
    const g = this.callBody(info, thisArg, args);
    if (info.isAsync) return this.runAsync(g);
    try {
      return this.runSyncOrPromise(g);
    } catch (e) {
      tagError(e);
      throw e;
    }
  }

  private *callBody(info: FnInfo, thisArg: unknown, args: unknown[]): Gen<unknown> {
    const scope = new Scope(info.scope, true);
    if (!info.isArrow) {
      scope.vars.set('this', { value: thisArg, kind: 'var' });
      scope.vars.set('arguments', { value: args, kind: 'var' });
      if (info.home !== undefined) scope.vars.set('%home', { value: info.home, kind: 'const' });
      if (info.isGenerator && info.isAsync) scope.vars.set('%asyncgen', { value: true, kind: 'const' });
    }
    return yield* this.bindAndRun(info.node, scope, args);
  }

  /** 引数を束縛して本体を動かす（関数・メソッド・コンストラクタ共通）。return の値（無ければ undefined）を返す。 */
  private *bindAndRun(fnNode: N, scope: Scope, args: unknown[]): Gen<unknown> {
    const params: N[] = fnNode.params;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.type === 'RestElement') yield* this.bind(p.argument, args.slice(i), scope, 'let');
      else yield* this.bind(p, args[i], scope, 'let');
    }
    const body = fnNode.body;
    if (body.type !== 'BlockStatement') return yield* this.ev(body, scope);
    const names = new Set<string>();
    for (const s of body.body) collectVarNames(s, names);
    for (const n of names) if (!scope.vars.has(n)) scope.vars.set(n, { value: undefined, kind: 'var' });
    const c = yield* this.execList(body.body, scope);
    return c !== undefined && c.kind === 'return' ? c.value : undefined;
  }

  // --- コールバックを取るネイティブ関数（Array.map など） -------------------------------------------

  private registerHofs(): void {
    const self = this;
    const AP = Array.prototype as unknown as Record<string, unknown>;
    const arrayLike = (v: unknown): { o: Record<string, unknown>; len: number } => {
      if (v === null || v === undefined) throw new TypeError('Array.prototype method called on null or undefined');
      const o = Object(v) as Record<string, unknown>;
      return { o, len: (o.length as number) >>> 0 };
    };
    const cb = (f: unknown, thisArg: unknown, ...a: unknown[]): Gen<unknown> => self.call(f, thisArg, a, null);
    const reg = (target: Record<string, unknown>, name: string, idx: number, run: (t: unknown, a: unknown[]) => Gen<unknown>) => {
      const f = target[name];
      if (typeof f === 'function') this.hofs.set(f, { idx, run });
    };
    reg(AP, 'map', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      const out = new Array<unknown>(len);
      for (let i = 0; i < len; i++) if (i in o) out[i] = yield* cb(a[0], a[1], o[i], i, o);
      return out;
    });
    reg(AP, 'forEach', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      for (let i = 0; i < len; i++) if (i in o) yield* cb(a[0], a[1], o[i], i, o);
      return undefined;
    });
    reg(AP, 'filter', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) if (i in o && (yield* cb(a[0], a[1], o[i], i, o))) out.push(o[i]);
      return out;
    });
    reg(AP, 'flatMap', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) {
        if (!(i in o)) continue;
        const r = yield* cb(a[0], a[1], o[i], i, o);
        if (Array.isArray(r)) out.push(...r); else out.push(r);
      }
      return out;
    });
    reg(AP, 'some', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      for (let i = 0; i < len; i++) if (i in o && (yield* cb(a[0], a[1], o[i], i, o))) return true;
      return false;
    });
    reg(AP, 'every', 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      for (let i = 0; i < len; i++) if (i in o && !(yield* cb(a[0], a[1], o[i], i, o))) return false;
      return true;
    });
    const finder = (name: string, fromEnd: boolean, wantIndex: boolean) => reg(AP, name, 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      for (let n = 0; n < len; n++) {
        const i = fromEnd ? len - 1 - n : n;
        if (yield* cb(a[0], a[1], o[i], i, o)) return wantIndex ? i : o[i];
      }
      return wantIndex ? -1 : undefined;
    });
    finder('find', false, false);
    finder('findIndex', false, true);
    finder('findLast', true, false);
    finder('findLastIndex', true, true);
    const reducer = (name: string, fromEnd: boolean) => reg(AP, name, 0, function* (t, a) {
      const { o, len } = arrayLike(t);
      let n = 0;
      let acc: unknown;
      const at = (k: number) => (fromEnd ? len - 1 - k : k);
      if (a.length >= 2) {
        acc = a[1];
      } else {
        while (n < len && !(at(n) in o)) n++;
        if (n >= len) throw new TypeError('Reduce of empty array with no initial value');
        acc = o[at(n++)];
      }
      for (; n < len; n++) {
        const i = at(n);
        if (i in o) acc = yield* cb(a[0], undefined, acc, o[i], i, o);
      }
      return acc;
    });
    reducer('reduce', false);
    reducer('reduceRight', true);
    reg(Array as unknown as Record<string, unknown>, 'from', 1, function* (_t, a) {
      const list = Array.from(a[0] as ArrayLike<unknown>);
      const out: unknown[] = [];
      for (let i = 0; i < list.length; i++) out.push(yield* cb(a[1], a[2], list[i], i));
      return out;
    });
    reg(Map.prototype as unknown as Record<string, unknown>, 'forEach', 0, function* (t, a) {
      if (!(t instanceof Map)) throw new TypeError('Method Map.prototype.forEach called on incompatible receiver');
      for (const [k, v] of [...t]) yield* cb(a[0], a[1], v, k, t);
      return undefined;
    });
    reg(Set.prototype as unknown as Record<string, unknown>, 'forEach', 0, function* (t, a) {
      if (!(t instanceof Set)) throw new TypeError('Method Set.prototype.forEach called on incompatible receiver');
      for (const v of [...t]) yield* cb(a[0], a[1], v, v, t);
      return undefined;
    });
  }

  // --- ジェネレータ -------------------------------------------------------------------------------

  private makeGenProto(isAsync: boolean): object {
    const proto: Record<PropertyKey, unknown> = {};
    const self = this;
    const def = (key: PropertyKey, value: unknown) => Object.defineProperty(proto, key, { value, writable: true, configurable: true, enumerable: false });
    for (const mode of ['next', 'return', 'throw'] as const) {
      def(mode, function (this: unknown, v?: unknown) {
        return isAsync ? self.genStepAsync(this, mode, v) : self.genStep(this, mode, v);
      });
    }
    def(isAsync ? Symbol.asyncIterator : Symbol.iterator, function (this: unknown) { return this; });
    def(Symbol.toStringTag, isAsync ? 'AsyncGenerator' : 'Generator');
    protect(proto, 0);
    return proto;
  }

  private makeGenerator(info: FnInfo, thisArg: unknown, args: unknown[]): object {
    const obj = Object.create(info.isAsync ? this.asyncGenProto : this.syncGenProto) as object;
    this.genStates.set(obj, { g: this.callBody(info, thisArg, args), started: false, done: false, running: false, queue: Promise.resolve() });
    return obj;
  }

  private genState(obj: unknown): GenState {
    const st = typeof obj === 'object' && obj !== null ? this.genStates.get(obj) : undefined;
    if (st === undefined) throw new TypeError('next method called on incompatible receiver');
    return st;
  }

  /** 同期ジェネレータの next / return / throw。本体の中で待つこと（await・署名）はできない。 */
  private genStep(obj: unknown, mode: 'next' | 'return' | 'throw', val: unknown): IteratorResult<unknown> {
    const st = this.genState(obj);
    if (st.running) throw new TypeError('Generator is already running');
    if (st.done || (!st.started && mode !== 'next')) {
      st.done = true;
      if (mode === 'throw') throw val;
      return { value: mode === 'return' ? val : undefined, done: true };
    }
    st.started = true;
    st.running = true;
    this.syncDepth++;
    try {
      let r: IteratorResult<Suspend, unknown>;
      try {
        r = mode === 'next' ? st.g.next(val) : mode === 'throw' ? st.g.throw(val) : st.g.throw(new GenReturn(val));
      } catch (e) {
        st.done = true;
        if (e instanceof GenReturn) return { value: e.value, done: true };
        tagError(e);
        throw e;
      }
      if (r.done) {
        st.done = true;
        return { value: r.value, done: true };
      }
      if (r.value.isYield) return { value: r.value.yielded, done: false };
      st.done = true;
      st.g.return(undefined as never);
      throw new Error('[console] cannot wait (await / signing) inside a synchronous generator; use an async generator');
    } finally {
      st.running = false;
      this.syncDepth--;
      if (this.syncDepth === 0) this.syncSteps = 0;
    }
  }

  /** 非同期ジェネレータ。next() を続けて呼んでも、1つずつ順番に動かす。 */
  private genStepAsync(obj: unknown, mode: 'next' | 'return' | 'throw', val: unknown): Promise<IteratorResult<unknown>> {
    let st: GenState;
    try { st = this.genState(obj); } catch (e) { return Promise.reject(e); }
    const run = () => this.asyncGenRun(st, mode, val);
    const p = st.queue.then(run, run);
    st.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  private async asyncGenRun(st: GenState, mode: 'next' | 'return' | 'throw', val: unknown): Promise<IteratorResult<unknown>> {
    if (st.done || (!st.started && mode !== 'next')) {
      st.done = true;
      if (mode === 'throw') throw val;
      return { value: mode === 'return' ? await val : undefined, done: true };
    }
    st.started = true;
    let advance: () => IteratorResult<Suspend, unknown> =
      mode === 'next' ? () => st.g.next(val) : mode === 'throw' ? () => st.g.throw(val) : () => st.g.throw(new GenReturn(val));
    for (;;) {
      let r: IteratorResult<Suspend, unknown>;
      try {
        r = advance();
      } catch (e) {
        st.done = true;
        if (e instanceof GenReturn) return { value: e.value, done: true };
        tagError(e);
        throw e;
      }
      if (r.done) {
        st.done = true;
        return { value: r.value, done: true };
      }
      const s = r.value;
      if (s.isYield) return { value: s.yielded, done: false };
      try {
        const v = await s.promise;
        advance = () => st.g.next(v);
      } catch (e) {
        advance = () => st.g.throw(e);
      }
    }
  }

  /** `yield* iterable`: 中身を1つずつ外へ渡し、next / throw / return も中へ渡す。 */
  private *yieldDelegate(node: N, scope: Scope, isAsyncGen: boolean): Gen<unknown> {
    const iterable = yield* this.ev(node.argument, scope);
    if (iterable === null || iterable === undefined) throw new TypeError(`${describe(node.argument)} is not iterable`);
    const src = iterable as Record<PropertyKey, unknown>;
    type Iter = { next(v?: unknown): unknown; return?(v?: unknown): unknown; throw?(e?: unknown): unknown };
    let it: Iter;
    let asyncIter = false;
    if (isAsyncGen && typeof src[Symbol.asyncIterator] === 'function') {
      it = (src[Symbol.asyncIterator] as () => Iter).call(iterable);
      asyncIter = true;
    } else if (typeof src[Symbol.iterator] === 'function') {
      it = (src[Symbol.iterator] as () => Iter).call(iterable);
    } else {
      throw new TypeError(`${describe(node.argument)} is not iterable`);
    }
    let received: unknown;
    let mode: 'next' | 'throw' = 'next';
    for (;;) {
      let res: unknown;
      if (mode === 'next') {
        res = it.next(received);
      } else if (typeof it.throw === 'function') {
        res = it.throw(received);
      } else {
        throw received;
      }
      if (asyncIter) res = yield { promise: Promise.resolve(res) };
      const step = res as { done?: boolean; value: unknown };
      if (step.done) return step.value;
      try {
        received = yield { isYield: true, yielded: step.value };
        mode = 'next';
      } catch (e) {
        if (e instanceof GenReturn) {
          try { it.return?.(e.value); } catch { /* 閉じるときのエラーは無視 */ }
          throw e;
        }
        received = e;
        mode = 'throw';
      }
    }
  }

  // --- class ------------------------------------------------------------------------------------

  private thisOf(scope: Scope): unknown {
    const v = scope.find('this')?.value;
    if (v === UNINIT) throw new ReferenceError("Must call super constructor in derived class before accessing 'this'");
    return v;
  }

  /** `a.b` / `a[b]` / `a.#b` のキー。#b は、そのクラスの中だけで作られる Symbol（コードからは辿れない）。 */
  private *memberKey(node: N, scope: Scope): Gen<PropertyKey> {
    if (node.computed) return toKey(yield* this.ev(node.property, scope));
    if (node.property.type === 'PrivateIdentifier') return this.privateKey(scope, node.property.name);
    return node.property.name as string;
  }

  private privateKey(scope: Scope, name: string): symbol {
    const b = scope.find(`%priv:${name}`);
    if (b === undefined) throw new SyntaxError(`Private field '#${name}' must be declared in an enclosing class`);
    return b.value as symbol;
  }

  private *superGet(node: N, scope: Scope): Gen<unknown> {
    const home = scope.find('%home')?.value;
    if (home === undefined) throw new SyntaxError("'super' keyword unexpected here");
    const key = yield* this.memberKey(node, scope);
    checkKey(key);
    return Reflect.get(Object.getPrototypeOf(home as object) as object, key, this.thisOf(scope));
  }

  private *superCall(node: N, scope: Scope): Gen<unknown> {
    const C = scope.find('%class')?.value as ClassFn | undefined;
    const newTarget = scope.find('%newTarget')?.value;
    const thisBinding = scope.find('this');
    if (C === undefined || thisBinding === undefined) throw new SyntaxError("'super' keyword unexpected here");
    if (thisBinding.value !== UNINIT) throw new ReferenceError('Super constructor may only be called once');
    const parent: unknown = Object.getPrototypeOf(C);
    if (typeof parent !== 'function') throw new TypeError('Super constructor is not a constructor');
    const args = yield* this.evArgs(node.arguments, scope);
    checkConstruct(parent, args);
    const obj = Reflect.construct(parent, args, newTarget as new () => unknown) as object;
    thisBinding.value = obj;
    yield* this.initFields(C, obj);
    return obj;
  }

  private *initFields(C: ClassFn, obj: object): Gen<void> {
    const info = this.classInfos.get(C);
    if (info === undefined) return;
    // 基底クラスのコンストラクタが組み込みオブジェクト（Array.prototype など）を返すと、フィールド定義がそこへ直接書き込める。
    // 代入や delete と同じく、書き込み禁止のオブジェクトにはここで止める。
    if (info.fields.length > 0) checkWritable(obj);
    for (const f of info.fields) {
      const s = new Scope(info.scope, true);
      s.vars.set('this', { value: obj, kind: 'var' });
      s.vars.set('%home', { value: info.proto, kind: 'const' });
      const value = f.node === null ? undefined : yield* this.evNamed(f.node, s, typeof f.key === 'string' ? f.key : '');
      Object.defineProperty(obj, f.key, { value, writable: true, enumerable: typeof f.key === 'string', configurable: true });
    }
  }

  private *makeClass(node: N, scope: Scope): Gen<ClassFn> {
    const name: string = node.id?.name ?? '';
    const classScope = new Scope(scope);
    for (const m of node.body.body) {
      if ((m.type === 'MethodDefinition' || m.type === 'PropertyDefinition') && m.key.type === 'PrivateIdentifier') {
        const k = `%priv:${m.key.name}`;
        if (!classScope.vars.has(k)) classScope.vars.set(k, { value: Symbol(m.key.name), kind: 'const' });
      }
    }
    let parent: unknown;
    const derived = node.superClass !== null && node.superClass !== undefined;
    if (derived) {
      parent = yield* this.ev(node.superClass, scope);
      if (typeof parent !== 'function') throw new TypeError('Class extends value is not a constructor');
    }
    const ctorDef = node.body.body.find((m: N) => m.type === 'MethodDefinition' && m.kind === 'constructor');
    const self = this;
    const C = function (this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
      return self.construct(C, new.target, args);
    } as ClassFn;
    Object.defineProperty(C, 'name', { value: name, configurable: true });
    let protoParent: object | null = Object.prototype;
    if (derived) {
      const pp = (parent as { prototype?: unknown }).prototype;
      if (pp !== null && typeof pp !== 'object') throw new TypeError('Class extends value does not have a valid prototype property');
      protoParent = pp as object | null;
      Object.setPrototypeOf(C, parent as object);
    }
    const proto = Object.create(protoParent) as object;
    Object.defineProperty(C, 'prototype', { value: proto, writable: false });
    Object.defineProperty(proto, 'constructor', { value: C, writable: true, configurable: true, enumerable: false });
    if (name !== '') classScope.vars.set(name, { value: C, kind: 'const' });

    const fields: FieldDef[] = [];
    const statics: StaticItem[] = [];
    for (const m of node.body.body) {
      if (m.type === 'StaticBlock') { statics.push({ block: m.body }); continue; }
      if (m.type !== 'MethodDefinition' && m.type !== 'PropertyDefinition') continue;
      if (m.type === 'MethodDefinition' && m.kind === 'constructor') continue;
      const key: PropertyKey = m.computed
        ? toKey(yield* this.ev(m.key, classScope))
        : m.key.type === 'PrivateIdentifier' ? this.privateKey(classScope, m.key.name)
          : m.key.type === 'Identifier' ? m.key.name : toKey(m.key.value);
      if (m.type === 'PropertyDefinition') {
        if (m.static) statics.push({ field: { key, node: m.value ?? null } });
        else fields.push({ key, node: m.value ?? null });
        continue;
      }
      const target = m.static ? (C as object) : proto;
      const fn = this.makeFunction(m.value, classScope, typeof key === 'string' ? key : '', target);
      if (m.kind === 'get' || m.kind === 'set') {
        const existing = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { get: existing?.get, set: existing?.set, [m.kind]: fn, configurable: true, enumerable: false });
      } else {
        Object.defineProperty(target, key, { value: fn, writable: true, configurable: true, enumerable: false });
      }
    }
    this.classInfos.set(C, { ctor: ctorDef ? ctorDef.value : null, derived, fields, scope: classScope, proto });
    for (const item of statics) {
      const s = new Scope(classScope, true);
      s.vars.set('this', { value: C, kind: 'var' });
      s.vars.set('%home', { value: C, kind: 'const' });
      if (item.block !== undefined) {
        const names = new Set<string>();
        for (const st of item.block) collectVarNames(st, names);
        for (const n of names) s.vars.set(n, { value: undefined, kind: 'var' });
        yield* this.execList(item.block, s);
        continue;
      }
      const f = item.field as FieldDef;
      const value = f.node === null ? undefined : yield* this.evNamed(f.node, s, typeof f.key === 'string' ? f.key : '');
      Object.defineProperty(C, f.key, { value, writable: true, enumerable: typeof f.key === 'string', configurable: true });
    }
    return C;
  }

  private construct(C: ClassFn, newTarget: unknown, args: unknown[]): unknown {
    try {
      return this.runSync(this.constructGen(C, newTarget, args));
    } catch (e) {
      tagError(e);
      throw e;
    }
  }

  private *constructGen(C: ClassFn, newTarget: unknown, args: unknown[]): Gen<unknown> {
    const info = this.classInfos.get(C) as ClassInfo;
    const scope = new Scope(info.scope, true);
    let thisObj: unknown = UNINIT;
    if (!info.derived) {
      const proto = (newTarget as { prototype?: unknown }).prototype;
      thisObj = Object.create(typeof proto === 'object' ? proto : Object.prototype);
    }
    scope.vars.set('this', { value: thisObj, kind: 'var' });
    scope.vars.set('arguments', { value: args, kind: 'var' });
    scope.vars.set('%home', { value: info.proto, kind: 'const' });
    scope.vars.set('%class', { value: C, kind: 'const' });
    scope.vars.set('%newTarget', { value: newTarget, kind: 'const' });
    if (!info.derived) yield* this.initFields(C, thisObj as object);
    let result: unknown;
    if (info.ctor !== null) {
      result = yield* this.bindAndRun(info.ctor, scope, args);
    } else if (info.derived) {
      // 既定のコンストラクタ: constructor(...args) { super(...args); }
      checkConstruct(Object.getPrototypeOf(C), args);
      const obj = Reflect.construct(Object.getPrototypeOf(C) as new () => unknown, args, newTarget as new () => unknown) as object;
      (scope.vars.get('this') as Binding).value = obj;
      yield* this.initFields(C, obj);
    }
    if ((typeof result === 'object' && result !== null) || typeof result === 'function') return result;
    const t = (scope.vars.get('this') as Binding).value;
    if (t === UNINIT) throw new ReferenceError('Must call super constructor in derived class before returning from derived constructor');
    return t;
  }

  /** インタープリタの中からの呼び出し。解釈中の同期関数は同じジェネレータの鎖の中で動かす（待ちが外まで届くように）。 */
  private *call(fn: unknown, thisArg: unknown, args: unknown[], calleeNode: N): Gen<unknown> {
    if (typeof fn !== 'function') throw new TypeError(`${describe(calleeNode)} is not a function`);
    yield* this.tick();
    const blocking = blockingImpls.get(fn);
    if (blocking !== undefined) return yield { promise: blocking(thisArg, args) };
    const hof = this.hofs.get(fn);
    if (hof !== undefined) {
      const cb = args[hof.idx];
      const ci = typeof cb === 'function' ? this.fnInfos.get(cb) : undefined;
      if (ci !== undefined && !ci.isAsync && !ci.isGenerator) return yield* hof.run(thisArg, args);
    }
    const info = this.fnInfos.get(fn);
    if (info !== undefined && !info.isAsync && !info.isGenerator) return yield* this.callBody(info, thisArg, args);
    checkNativeCall(fn, thisArg, args);
    return (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
  }

  // --- 式 --------------------------------------------------------------------------------------

  private *evNamed(node: N, scope: Scope, name: string): Gen<unknown> {
    if (name !== '' && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && !node.id) {
      return this.makeFunction(node, scope, name);
    }
    return yield* this.ev(node, scope);
  }

  private *evArgs(list: N[], scope: Scope): Gen<unknown[]> {
    const out: unknown[] = [];
    for (const a of list) {
      if (a.type === 'SpreadElement') out.push(...this.iterate(yield* this.ev(a.argument, scope), a.argument));
      else out.push(yield* this.ev(a, scope));
    }
    return out;
  }

  private iterate(value: unknown, node: N): unknown[] {
    if (value === null || value === undefined || typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] !== 'function') {
      throw new TypeError(`${describe(node)} is not iterable`);
    }
    return [...(value as Iterable<unknown>)];
  }

  /** 代入・更新の左辺を、読み書きの組にする（オブジェクトとキーの式は1回だけ評価する）。 */
  private *evRef(node: N, scope: Scope): Gen<{ get(): unknown; set(v: unknown): void }> {
    if (node.type === 'Identifier') {
      return {
        get: () => {
          const b = scope.find(node.name);
          if (b === undefined) throw new ReferenceError(`${node.name} is not defined`);
          return b.value;
        },
        set: (v: unknown) => this.assignVar(scope, node.name, v),
      };
    }
    if (node.type === 'MemberExpression') {
      const obj = yield* this.ev(node.object, scope);
      const key = yield* this.memberKey(node, scope);
      return { get: () => this.getProp(obj, key), set: (v: unknown) => this.setProp(obj, key, v) };
    }
    throw new SyntaxError('Invalid left-hand side in assignment');
  }

  private *ev(node: N, scope: Scope): Gen<unknown> {
    switch (node.type) {
      case 'Literal': {
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        if (typeof node.bigint === 'string' && typeof node.value !== 'bigint') return BigInt(node.bigint.replace(/_/g, ''));
        return node.value;
      }
      case 'Identifier': {
        const b = scope.find(node.name);
        if (b === undefined) throw new ReferenceError(`${node.name} is not defined`);
        return b.value;
      }
      case 'ThisExpression': return this.thisOf(scope);
      case 'TemplateLiteral': {
        let s = node.quasis[0].value.cooked as string;
        for (let i = 0; i < node.expressions.length; i++) {
          s += String(yield* this.ev(node.expressions[i], scope));
          s += node.quasis[i + 1].value.cooked as string;
          if (s.length > MAX_STRING_LENGTH) throw new RangeError("[console] the string is too large (the console limits a single operation's size)");
        }
        return s;
      }
      case 'TaggedTemplateExpression': {
        const strings = node.quasi.quasis.map((q: N) => q.value.cooked) as string[];
        Object.defineProperty(strings, 'raw', { value: node.quasi.quasis.map((q: N) => q.value.raw) });
        const values: unknown[] = [];
        for (const e of node.quasi.expressions) values.push(yield* this.ev(e, scope));
        let thisVal: unknown;
        let fn: unknown;
        if (node.tag.type === 'MemberExpression') {
          thisVal = yield* this.ev(node.tag.object, scope);
          fn = this.getProp(thisVal, yield* this.memberKey(node.tag, scope));
        } else {
          fn = yield* this.ev(node.tag, scope);
        }
        return yield* this.call(fn, thisVal, [strings, ...values], node.tag);
      }
      case 'ArrayExpression': {
        const out: unknown[] = [];
        for (const el of node.elements) {
          if (el === null) out.length += 1; // 穴（[1, , 3]）は穴のまま
          else if (el.type === 'SpreadElement') out.push(...this.iterate(yield* this.ev(el.argument, scope), el.argument));
          else out.push(yield* this.ev(el, scope));
        }
        return out;
      }
      case 'ObjectExpression': {
        const obj: Record<PropertyKey, unknown> = {};
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            const src = yield* this.ev(p.argument, scope);
            if (src === null || src === undefined) continue;
            const o = Object(src) as Record<PropertyKey, unknown>;
            for (const k of Reflect.ownKeys(o)) {
              const d = Object.getOwnPropertyDescriptor(o, k);
              if (d?.enumerable) Object.defineProperty(obj, k, { value: o[k], writable: true, enumerable: true, configurable: true });
            }
            continue;
          }
          const key: PropertyKey = p.computed ? toKey(yield* this.ev(p.key, scope)) : p.key.type === 'Identifier' ? p.key.name : toKey(p.key.value);
          if (p.kind === 'get' || p.kind === 'set') {
            Object.defineProperty(obj, key, { [p.kind]: this.makeFunction(p.value, scope, String(key)), enumerable: true, configurable: true });
          } else {
            const value = yield* this.evNamed(p.value, scope, typeof key === 'string' ? key : '');
            Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
          }
        }
        return obj;
      }
      case 'FunctionExpression': {
        if (node.id) {
          const fs = new Scope(scope);
          const fn = this.makeFunction(node, fs);
          fs.vars.set(node.id.name, { value: fn, kind: 'const' });
          return fn;
        }
        return this.makeFunction(node, scope);
      }
      case 'ArrowFunctionExpression': return this.makeFunction(node, scope);
      case 'ClassExpression': return yield* this.makeClass(node, scope);
      case 'UnaryExpression': {
        if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
          const b = scope.find(node.argument.name);
          return b === undefined ? 'undefined' : typeof b.value;
        }
        if (node.operator === 'delete') {
          const a = node.argument;
          if (a.type !== 'MemberExpression') return true;
          const obj = yield* this.ev(a.object, scope);
          const key = yield* this.memberKey(a, scope);
          if (obj === null || obj === undefined) throw new TypeError(`Cannot convert undefined or null to object`);
          checkKey(key);
          checkWritable(obj);
          return Reflect.deleteProperty(Object(obj), key);
        }
        const v = (yield* this.ev(node.argument, scope)) as never;
        switch (node.operator) {
          case '!': return !v;
          case '-': return -v;
          case '+': return +v;
          case '~': return ~v;
          case 'typeof': return typeof v;
          case 'void': return undefined;
          default: throw new SyntaxError(`Unsupported operator ${node.operator}`);
        }
      }
      case 'UpdateExpression': {
        const ref = yield* this.evRef(node.argument, scope);
        const old = ref.get();
        const num = typeof old === 'bigint' ? old : Number(old);
        const next = typeof num === 'bigint' ? (node.operator === '++' ? num + 1n : num - 1n) : (node.operator === '++' ? num + 1 : num - 1);
        ref.set(next);
        return node.prefix ? next : num;
      }
      case 'BinaryExpression': {
        const a = yield* this.ev(node.left, scope);
        const b = yield* this.ev(node.right, scope);
        return binop(node.operator, a, b);
      }
      case 'LogicalExpression': {
        const a = yield* this.ev(node.left, scope);
        if (node.operator === '&&') return a ? yield* this.ev(node.right, scope) : a;
        if (node.operator === '||') return a ? a : yield* this.ev(node.right, scope);
        return a !== null && a !== undefined ? a : yield* this.ev(node.right, scope);
      }
      case 'ConditionalExpression':
        return (yield* this.ev(node.test, scope)) ? yield* this.ev(node.consequent, scope) : yield* this.ev(node.alternate, scope);
      case 'SequenceExpression': {
        let v: unknown;
        for (const e of node.expressions) v = yield* this.ev(e, scope);
        return v;
      }
      case 'AssignmentExpression': {
        const op: string = node.operator;
        if (op === '=') {
          if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
            const value = yield* this.ev(node.right, scope);
            yield* this.bind(node.left, value, scope, 'assign');
            return value;
          }
          const ref = yield* this.evRef(node.left, scope);
          const value = yield* this.evNamed(node.right, scope, node.left.type === 'Identifier' ? node.left.name : '');
          ref.set(value);
          return value;
        }
        const ref = yield* this.evRef(node.left, scope);
        const cur = ref.get();
        if (op === '&&=' || op === '||=' || op === '??=') {
          const doAssign = op === '&&=' ? !!cur : op === '||=' ? !cur : cur === null || cur === undefined;
          if (!doAssign) return cur;
          const value = yield* this.ev(node.right, scope);
          ref.set(value);
          return value;
        }
        const rhs = yield* this.ev(node.right, scope);
        const value = binop(op.slice(0, -1), cur, rhs);
        ref.set(value);
        return value;
      }
      case 'ChainExpression': {
        const v = yield* this.ev(node.expression, scope);
        return v === SHORT ? undefined : v;
      }
      case 'MemberExpression': {
        if (node.object.type === 'Super') return yield* this.superGet(node, scope);
        const obj = yield* this.ev(node.object, scope);
        if (obj === SHORT) return SHORT;
        if (node.optional && (obj === null || obj === undefined)) return SHORT;
        const key = yield* this.memberKey(node, scope);
        return this.getProp(obj, key);
      }
      case 'CallExpression': {
        let thisVal: unknown;
        let fn: unknown;
        const callee = node.callee;
        if (callee.type === 'Super') return yield* this.superCall(node, scope);
        if (callee.type === 'MemberExpression' && callee.object.type === 'Super') {
          thisVal = this.thisOf(scope);
          fn = yield* this.superGet(callee, scope);
        } else if (callee.type === 'MemberExpression') {
          thisVal = yield* this.ev(callee.object, scope);
          if (thisVal === SHORT) return SHORT;
          if (callee.optional && (thisVal === null || thisVal === undefined)) return SHORT;
          const key = yield* this.memberKey(callee, scope);
          fn = this.getProp(thisVal, key);
        } else {
          fn = yield* this.ev(callee, scope);
          if (fn === SHORT) return SHORT;
        }
        if (node.optional && (fn === null || fn === undefined)) return SHORT;
        const args = yield* this.evArgs(node.arguments, scope);
        return yield* this.call(fn, thisVal, args, callee);
      }
      case 'NewExpression': {
        const C = yield* this.ev(node.callee, scope);
        const args = yield* this.evArgs(node.arguments, scope);
        if (typeof C !== 'function' || blockingImpls.has(C)) throw new TypeError(`${describe(node.callee)} is not a constructor`);
        checkConstruct(C, args);
        return Reflect.construct(C, args);
      }
      case 'YieldExpression': {
        const isAsyncGen = scope.find('%asyncgen') !== undefined;
        if (node.delegate) return yield* this.yieldDelegate(node, scope, isAsyncGen);
        let v = node.argument ? yield* this.ev(node.argument, scope) : undefined;
        if (isAsyncGen) v = yield { promise: Promise.resolve(v) };
        return yield { isYield: true, yielded: v };
      }
      case 'AwaitExpression': {
        const v = yield* this.ev(node.argument, scope);
        return yield { promise: Promise.resolve(v) };
      }
      case 'ImportExpression': {
        const spec = String(yield* this.ev(node.source, scope));
        if (this.importHandler === null) return Promise.reject(new Error('[console] import() is not available'));
        return this.importHandler(spec);
      }
      case 'SpreadElement': throw new SyntaxError('Unexpected spread');
      default:
        throw new SyntaxError(`[console] ${node.type} is not supported`);
    }
  }
}
