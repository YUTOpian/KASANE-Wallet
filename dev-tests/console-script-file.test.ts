// コンソールの「ファイルを開く / コードを保存」と、エラーの整形（lib/console/scriptFile.ts）。通信なし。
// 実行: npx tsx dev-tests/console-script-file.test.ts
import { Interpreter, StopSignal } from '../src/lib/console/interpreter';
import { MAX_SCRIPT_BYTES, blocksInPastedText, checkScriptFile, combineBlocks, describeConsoleError, extractCodeBlocks, hintFor, isMarkdownName, precheckScriptFile, scriptFileName, scriptLangFromName, scriptMimeType } from '../src/lib/console/scriptFile';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const eq = (a: unknown, b: unknown, what: string) => ok(Object.is(a, b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

async function runErr(code: string, lang: 'js' | 'ts', fileName?: string): Promise<string> {
  const i = new Interpreter();
  i.defineGlobal('console', { log: () => undefined });
  i.defineGlobal('TypeError', TypeError);
  i.defineGlobal('Error', Error);
  try { await i.run(code, lang); return '(no error)'; } catch (e) { return describeConsoleError(e, { source: code, fileName, line: i.line }); }
}

// --- 拡張子から言語 ---
eq(scriptLangFromName('a.ts'), 'ts', '.ts');
eq(scriptLangFromName('A.MTS'), 'ts', '.MTS (case-insensitive)');
eq(scriptLangFromName('a.cts'), 'ts', '.cts');
eq(scriptLangFromName('a.js'), 'js', '.js');
eq(scriptLangFromName('a.mjs'), 'js', '.mjs');
eq(scriptLangFromName('a.cjs'), 'js', '.cjs');
eq(scriptLangFromName('notes.txt'), null, '.txt keeps the current language');
eq(scriptLangFromName('a.d.ts'), 'ts', '.d.ts is ts by extension (rejected by check)');

// --- 読み込みの検査 ---
const good = checkScriptFile('send.ts', 30, 'const a: number = 1;\nconsole.log(a);\n');
ok(good.ok, 'valid ts file');
if (good.ok) { eq(good.lang, 'ts', 'lang ts'); eq(good.lines, 2, 'line count ignores the trailing newline'); }
const bom = checkScriptFile('a.js', 20, '\uFEFFconsole.log(1);\r\nconsole.log(2);\r\n');
ok(bom.ok, 'BOM + CRLF file');
if (bom.ok) { eq(bom.text, 'console.log(1);\nconsole.log(2);\n', 'BOM stripped and CRLF normalised'); eq(bom.lines, 2, 'lines with CRLF'); }
const txt = checkScriptFile('memo.txt', 5, 'hello');
ok(txt.ok && txt.lang === null, '.txt allowed, language undecided');
eq((checkScriptFile('a.js', 3, '   \n\t\n') as { problem?: string }).problem, 'empty', 'blank file');
eq((checkScriptFile('a.js', 3, 'ab\u0000cd') as { problem?: string }).problem, 'binary', 'NUL byte');
eq((checkScriptFile('types.d.ts', 10, 'declare const x: number;') as { problem?: string }).problem, 'dts', '.d.ts');
eq((checkScriptFile('App.tsx', 10, 'x') as { problem?: string }).problem, 'jsx', '.tsx');
eq((checkScriptFile('App.jsx', 10, 'x') as { problem?: string }).problem, 'jsx', '.jsx');
eq((checkScriptFile('data.json', 10, '{}') as { problem?: string }).problem, 'ext', '.json');
eq((checkScriptFile('run.py', 10, 'print(1)') as { problem?: string }).problem, 'ext', '.py');
eq((checkScriptFile('noext', 10, 'x') as { problem?: string }).problem, 'ext', 'no extension');
eq(precheckScriptFile('big.js', MAX_SCRIPT_BYTES + 1), 'too_big', 'precheck: too big (without reading it)');
eq(precheckScriptFile('big.js', MAX_SCRIPT_BYTES), null, 'precheck: exactly the limit is fine');
eq((checkScriptFile('big.js', MAX_SCRIPT_BYTES + 1, 'x') as { problem?: string }).problem, 'too_big', 'too big');

// --- 保存名・MIME ---
eq(scriptFileName('ts', new Date(2026, 9, 31, 9, 5, 7)), 'kasane-console-20261031-090507.ts', 'save name (ts)');
eq(scriptFileName('js', new Date(2026, 0, 2, 13, 14, 15)), 'kasane-console-20260102-131415.js', 'save name (js)');
eq(scriptMimeType('ts'), 'text/plain', 'ts mime is text/plain');
eq(scriptMimeType('js'), 'text/javascript', 'js mime');

// --- エラーの整形: 構文エラーは行・桁・その行・^ ---
{
  const m = await runErr('let x = 1;\nlet y = (2 +;', 'js');
  ok(m.startsWith('SyntaxError: Unexpected token (2:12)'), 'js syntax error head', m);
  ok(m.includes('  2 | let y = (2 +;'), 'js syntax error shows the line', m);
  ok(m.endsWith('\n    |             ^'), 'caret under the column (col 12)', m);
  ok(!m.includes('  at '), 'no "at" without a file name', m);
}
{
  const m = await runErr('const a: number = 1;\nconst b: = 3;', 'ts', 'send.ts');
  ok(m.includes('SyntaxError:'), 'ts syntax error head', m);
  ok(m.includes('\n  at send.ts:2:11\n'), 'file:line:column (column is 1-based)', m);
  ok(m.includes('  2 | const b: = 3;'), 'ts syntax error shows the original line', m);
}
{
  // タブを含む行でも、^ の位置がずれない
  const m = await runErr('\tlet z = ;', 'js');
  const [, srcLine, caretLine] = m.split('\n');
  ok(caretLine.indexOf('^') === srcLine.indexOf(';'), 'caret lines up with a tab line', m);
}
{
  // 長い行は、桁の近くだけ見せる
  const long = `let a = "${'x'.repeat(300)}" +;`;
  const m = await runErr(long, 'js');
  ok(m.includes('…'), 'long line is elided', m.slice(0, 200));
  ok(m.split('\n').every((l) => l.length < 200), 'elided lines stay short');
}

// --- 実行時のエラー: 種類・メッセージ・行（ファイル名があれば at name:行） ---
{
  const m = await runErr('const a = 1;\nconst b = 2;\nthrow new TypeError("bad value");', 'js', 'run.js');
  ok(m.startsWith('TypeError: bad value (3)'), 'runtime error with line', m);
  ok(m.endsWith('\n  at run.js:3'), 'runtime error with file position', m);
}
{
  const m = await runErr('null.x', 'js');
  ok(/^TypeError: .* \(1\)$/.test(m), 'runtime error without file', m);
}
eq(describeConsoleError(new StopSignal()), '停止しました (stopped)', 'StopSignal');
eq(describeConsoleError('plain', { line: 4 }), 'Uncaught plain (4)', 'non-Error throw');

// --- Node.js 用の書き方のヒント ---
{
  const i = new Interpreter();
  let caught: unknown;
  try { await i.run('const fs = require("fs");', 'js'); } catch (e) { caught = e; }
  eq(hintFor(caught), 'node', 'require → node hint');
  for (const name of ['module', 'process', '__dirname', 'Buffer']) {
    let c: unknown;
    try { await new Interpreter().run(`${name}.x`, 'js'); } catch (e) { c = e; }
    eq(hintFor(c), 'node', `${name} → node hint`);
  }
  eq(hintFor(new Error('x is not defined')), null, 'other ReferenceError: no hint');
  eq(hintFor('string'), null, 'non-Error: no hint');
}

// --- 読み込んだファイルを、そのまま動かせる（ts → 型を取り除いて動く。import は同梱 SDK） ---
{
  const file = checkScriptFile('t.ts', 100, "import { Thing } from 'symbol-sdk';\ninterface P { n: number }\nconst p: P = { n: 2 };\nconst t = new Thing(p.n);\nt.n * 21;\n");
  ok(file.ok, 'sample file passes the check');
  if (file.ok) {
    const i = new Interpreter();
    i.importHandler = async () => ({ Thing: class { n: number; constructor(n: number) { this.n = n; } } });
    const r = await i.run(file.text, file.lang ?? 'js');
    eq(r.value, 42, 'loaded .ts file runs (types stripped, import resolved)');
  }
}


// --- Markdown（Obsidian のノート）---
{
  eq(isMarkdownName('note.md'), true, '.md is markdown');
  eq(isMarkdownName('Note.MARKDOWN'), true, '.MARKDOWN is markdown');
  eq(isMarkdownName('a.ts'), false, '.ts is not markdown');
  const md = checkScriptFile('メモ.md', 50, '# t\n```js\n1\n```\n');
  ok(md.ok && md.markdown && md.lang === null, '.md passes the check (language undecided)');
  eq((checkScriptFile('a.js', 3, 'x') as { markdown?: boolean }).markdown, false, 'script is not markdown');

  const note = [
    '---', 'tags: [symbol]', '---', '# 送金メモ', '',
    '```js', "console.log('a');", '```',            // block 1: 行 6 から（コードは 7 行目）
    '', '```json', '{"x": 1}', '```',               // block 2: json → 対象外（番号は数える）
    '', '```typescript title="send.ts"', 'const n: number = 1;', '', 'console.log(n);', '```', // block 3
    '', '~~~ts', 'let t: string = "~";', '```', 'still inside', '~~~',                           // block 4: ~~~ の中の ``` は閉じない
    '', '> [!note] callout', '> ```js', '> const q = 1;', '> ```',                              // block 5: 引用の中
    '', '- 手順', '  ```mjs', '  const l = 2;', '  ```',                                        // block 6: 箇条書きの中
    '', '```', 'no language', '```',                                                          // block 7: 言語なし → 対象外
    '', '```js', '', '```',                                                                   // block 8: 空 → 対象外
    '', '```js', 'unclosed();',                                                               // block 9: 閉じていない → 最後まで
  ].join('\n');
  const bs = extractCodeBlocks(note);
  eq(bs.map((b) => b.index).join(','), '1,3,4,5,6,9', 'extracted block numbers (non-js/ts, unlabeled and empty skipped)');
  eq(bs.map((b) => b.lang).join(','), 'js,ts,ts,js,js,js', 'languages (typescript→ts, mjs→js)');
  eq(bs[0].code, "console.log('a');", 'block 1 code');
  eq(bs[0].startLine, 7, 'block 1 starts at note line 7');
  eq(bs[1].code, 'const n: number = 1;\n\nconsole.log(n);', 'block 3 keeps blank lines; info with title is ok');
  eq(bs[2].code, 'let t: string = "~";\n```\nstill inside', '~~~ block: a ``` inside does not close it');
  eq(bs[3].code, 'const q = 1;', 'blockquote markers are stripped');
  eq(bs[4].code, 'const l = 2;', 'list indentation is stripped');
  eq(bs[5].code, 'unclosed();', 'unclosed fence runs to the end');
  eq(bs[1].lines, 3, 'line count');
  eq(extractCodeBlocks('```js\r\nlet a = 1;\r\n```\r\n')[0]?.code, 'let a = 1;', 'CRLF note');
  eq(extractCodeBlocks('文章だけ\n`インラインの ```js` コード').length, 0, 'inline code is not a block');
  eq(extractCodeBlocks('````js\n```\nnested\n```\n````')[0]?.code, '```\nnested\n```', 'longer fence can contain ```');
  eq(extractCodeBlocks('# no code').length, 0, 'no blocks');

  const both = combineBlocks([bs[0], bs[1]]);
  eq(both.lang, 'ts', 'js + ts → ts');
  eq(both.code, "console.log('a');\n\nconst n: number = 1;\n\nconsole.log(n);", 'blocks joined by a blank line');
  eq(combineBlocks([bs[0], bs[3]]).lang, 'js', 'js + js → js');

  // 取り出したブロックが、そのまま動く
  const i = new Interpreter();
  let out = '';
  i.defineGlobal('console', { log: (v: unknown) => { out += String(v); } });
  await i.run(both.code, both.lang);
  eq(out, 'a1', 'combined blocks run');

  // 行番号が、ノートの行に合う（ブロックの 2 行目で例外 → ノートでは 5 行目）
  const blk = extractCodeBlocks('# n\n\n```js\nlet a = 1;\nthrow new Error("boom");\n```\n')[0];
  const i2 = new Interpreter();
  i2.defineGlobal('Error', Error);
  let m1 = '';
  try { await i2.run(blk.code, blk.lang); } catch (e) { m1 = describeConsoleError(e, { source: blk.code, fileName: 'n.md #1', line: i2.line, lineOffset: blk.startLine - 1 }); }
  ok(m1.startsWith('Error: boom (5)') && m1.endsWith('\n  at n.md #1:5'), 'runtime error line = note line', m1);
  const bad = extractCodeBlocks('# n\n\n```ts\nconst a: number = 1;\nconst b: = 3;\n```\n')[0];
  let m2 = '';
  try { await new Interpreter().run(bad.code, bad.lang); } catch (e) { m2 = describeConsoleError(e, { source: bad.code, fileName: 'n.md #1', lineOffset: bad.startLine - 1 }); }
  ok(/^SyntaxError: .*\(5:\d+\)\n  at n\.md #1:5:\d+\n  5 \| const b: = 3;\n    \| +\^$/.test(m2), 'syntax error line = note line (message, at, frame)', m2);
}


// --- 貼り付け: ノートなら確認を出す / ふつうのコードは、何もしない ---
{
  eq(blocksInPastedText('# メモ\n```ts\nlet a = 1;\n```\n').length, 1, 'pasted note with a ts block is detected');
  eq(blocksInPastedText('# メモ\n```ts\nlet a = 1;\n```\n```js\nlet b = 2;\n```').length, 2, 'two blocks');
  eq(blocksInPastedText("const a = 1;\nconsole.log(a);\nawait facade.sign(tx);").length, 0, 'plain code is not a note');
  eq(blocksInPastedText('const s = `a`;\nconst t = `\n```js\nx\n```\n`;').length, 1, 'known limit: a fence at the start of a line inside a template literal is treated as a block');
  eq(blocksInPastedText('# メモだけ\n```json\n{}\n```').length, 0, 'note without js/ts blocks: paste as usual');
  eq(blocksInPastedText('').length, 0, 'empty');
  eq(blocksInPastedText('# n\n```js\n' + 'x'.repeat(MAX_SCRIPT_BYTES) + '\n```').length, 0, 'too large: paste as usual');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails > 0) process.exit(1);
