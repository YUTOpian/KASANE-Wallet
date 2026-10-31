// コンソールのサンプルの、変数の型を割り出して src/lib/console/samplesTypes.generated.ts を作る。
// symbol-sdk の型（node_modules の .d.ts）を TypeScript のコンパイラ API で読んで、各変数の型を取る。サンプルを足した・変えたときに、もう一度動かす。
// 実行: npx tsx dev-tools/gen-sample-types.ts
// 前のサンプルで作った変数は、あとのサンプルでも使うので、順に動かしたものとして、型を引き継ぐ。
// 最後に、型を付けたコードに noImplicitAny で型の検査をかけて、足りない型（仮引数など）を知らせる。
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { consoleSamplesFor } from '../src/lib/console/samples';
import { FN_PARAMS, TYPE_OVERRIDES, annotateAssignments, normalizeType } from '../src/lib/console/samplesTsRules';

const root = path.resolve(import.meta.dirname, '..');
const virt = path.join(root, '__sample__.ts');
const opts: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], skipLibCheck: true, noEmit: true, strict: false, types: [],
};
// プロパティ名・オブジェクトのキーなど、変数の参照ではない識別子
function isNonReference(n: ts.Identifier): boolean {
  const p = n.parent;
  return (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isShorthandPropertyAssignment(p) && false)
    || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p);
}
const globalNames: Record<string, true> = {};

const SYM_HEAD = `import * as sdkCore from 'symbol-sdk';
import * as sdkSymbol from 'symbol-sdk/symbol';
import * as sdkNem from 'symbol-sdk/nem';
declare const sdk: typeof sdkCore;
declare const facade: sdkSymbol.SymbolFacade;
declare const NODE: string; declare const networkType: number; declare const identifier: string;
declare const alice: sdkSymbol.SymbolAccount; declare const wallet: sdkSymbol.SymbolAccount;
declare function clog(tx: unknown): void;
`;
const NEM_HEAD = SYM_HEAD.replace('sdkSymbol.SymbolFacade', 'sdkNem.NemFacade').replace(/sdkSymbol\.SymbolAccount/g, 'sdkNem.NemAccount');

function program(text: string, noImplicitAny: boolean): ts.Program {
  const o = { ...opts, noImplicitAny };
  const host = ts.createCompilerHost(o);
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, l, ...r) => (f === virt ? ts.createSourceFile(f, text, l) : get(f, l, ...r));
  const read = host.readFile.bind(host);
  host.readFile = (f) => (f === virt ? text : read(f));
  const exists = host.fileExists.bind(host);
  host.fileExists = (f) => f === virt || exists(f);
  return ts.createProgram([virt], o, host);
}

const table: Record<string, Record<string, string>> = {};
// 関数を入れる変数も含めた、割り出した型（あとのサンプルの検査で、前のサンプルの変数として宣言するのに使う。書き出しには入れない）
const allTypes: Record<string, Record<string, string>> = {};
// ループや関数の中で初めて代入している変数（宣言なしの代入）の、サンプルごとの型。先頭で `let` 宣言する。
const hoistedTable: Record<string, Record<string, string>> = {};
const problems: string[] = [];
for (const chain of ['symbol', 'nem'] as const) {
  const head = chain === 'nem' ? NEM_HEAD : SYM_HEAD;
  const seenIds = new Set<string>();
  const carried = new Map<string, string>();
  for (const s of consoleSamplesFor(chain)) {
    if (seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    const key = `${chain}:${s.id}`;
    // 1) 型を付けずに let にして、コンパイラに型を割り出させる
    const plain = annotateAssignments(s.code, () => undefined);
    let h = head;
    for (const [n, t] of carried) if (!plain.names.includes(n)) h += `declare let ${n}: ${t};\n`;
    const text = `${h}${plain.code}\nexport {};\n`;
    const p = program(text, false);
    const checker = p.getTypeChecker();
    const sf = p.getSourceFile(virt)!;
    const inferred: Record<string, string> = {};
    sf.forEachChild((n) => {
      if (!ts.isVariableStatement(n) || n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return;
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        inferred[d.name.text] = checker.typeToString(checker.getTypeAtLocation(d.name), sf, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
      }
    });
    // 宣言のない名前への代入（行頭以外）を探す。最初の出現が代入のものだけ、先頭で宣言する（最初が読み出しなら、前のサンプルの変数）。
    const firstUse = new Map<string, { pos: number; assign: ts.Expression | null }>();
    const visitUse = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === undefined && !isNonReference(n)) {
        const parent = n.parent;
        const assign = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === n ? parent.right : null;
        const cur = firstUse.get(n.text);
        if (cur === undefined || n.getStart() < cur.pos) firstUse.set(n.text, { pos: n.getStart(), assign });
      }
      ts.forEachChild(n, visitUse);
    };
    sf.forEachChild((n) => { if (n.pos >= h.length - 1) visitUse(n); });
    const hoisted: Record<string, string> = {};
    for (const [name, u] of [...firstUse].sort((a, b) => a[1].pos - b[1].pos)) {
      if (u.assign === null || name in globalNames) continue;
      const t = checker.typeToString(checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(u.assign)), sf, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
      hoisted[name] = TYPE_OVERRIDES[name] ?? (t === 'undefined' || t === 'null' ? 'any' : normalizeType(t));
    }
    hoistedTable[key] = hoisted;
    const types: Record<string, string> = {};
    for (const name of plain.names) {
      if (name in FN_PARAMS) continue;
      const t = inferred[name];
      if (t === undefined) { problems.push(`${key}: ${name} の型を割り出せませんでした`); continue; }
      types[name] = TYPE_OVERRIDES[name] ?? normalizeType(t);
    }
    table[key] = types;
    const everything: Record<string, string> = {};
    for (const name of plain.names) { const t = inferred[name]; if (t !== undefined) everything[name] = TYPE_OVERRIDES[name] ?? normalizeType(t); }
    for (const [n, t] of Object.entries(hoisted)) everything[n] = t;
    allTypes[key] = everything;
    for (const [n, t] of Object.entries(everything)) carried.set(n, t);
  }
}

// 書き出し
const hoistedBody = Object.entries(hoistedTable)
  .filter(([, v]) => Object.keys(v).length > 0)
  .map(([k, v]) => `  ${JSON.stringify(k)}: {\n${Object.entries(v).map(([n, t]) => `    ${JSON.stringify(n)}: ${JSON.stringify(t)},`).join('\n')}\n  },`)
  .join('\n');
const body = Object.entries(table)
  .filter(([, v]) => Object.keys(v).length > 0)
  .map(([k, v]) => `  ${JSON.stringify(k)}: {\n${Object.entries(v).map(([n, t]) => `    ${JSON.stringify(n)}: ${JSON.stringify(t)},`).join('\n')}\n  },`)
  .join('\n');
fs.writeFileSync(
  path.join(root, 'src/lib/console/samplesTypes.generated.ts'),
  `// 自動で作ったファイル（手で直さない）。作り方: npx tsx dev-tools/gen-sample-types.ts\n// サンプルごとの、変数の型。キーは「チェーン:サンプルID」。TypeScript モードでサンプルを入れるときに使う（samplesTs.ts）。\n// oxlint-disable-next-line typescript/no-explicit-any\nexport const SAMPLE_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {\n${body}\n};\n\n// ループや関数の中で初めて代入している変数（JavaScript では宣言なしの代入）。TypeScript では、サンプルの先頭近くで let を使って宣言する。\nexport const SAMPLE_HOISTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {\n${hoistedBody}\n};\n`,
);

// 2) 型を付けたコードに、noImplicitAny で検査をかける（足りない型を探す）
let diagCount = 0;
for (const chain of ['symbol', 'nem'] as const) {
  const head = chain === 'nem' ? NEM_HEAD : SYM_HEAD;
  const seenIds = new Set<string>();
  const carried = new Map<string, string>();
  for (const s of consoleSamplesFor(chain)) {
    if (seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    const types = table[`${chain}:${s.id}`] ?? {};
    const ann = annotateAssignments(s.code, (n) => types[n], hoistedTable[`${chain}:${s.id}`]);
    let h = head;
    for (const [n, t] of carried) if (!ann.names.includes(n)) h += `declare let ${n}: ${t};\n`;
    const headLines = h.split('\n').length - 1;
    const p = program(`${h}${ann.code}\nexport {};\n`, true);
    for (const d of ts.getPreEmitDiagnostics(p).filter((x) => x.file?.fileName === virt)) {
      if (d.code === 2307 || d.code === 7016) continue; // https:// から読む import は、型が無い
      const line = d.start === undefined ? 0 : d.file!.getLineAndCharacterOfPosition(d.start).line + 1 - headLines;
      diagCount++;
      console.log(`${chain}:${s.id}:${line}  TS${d.code}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 140)}`);
    }
    for (const [n, t] of Object.entries(allTypes[`${chain}:${s.id}`] ?? {})) carried.set(n, t);
  }
}
for (const m of problems) console.log('PROBLEM:', m);
console.log(`samples: ${Object.keys(table).length}, typed variables: ${Object.values(table).reduce((a, v) => a + Object.keys(v).length, 0)}, diagnostics: ${diagCount}`);
