// コンソールに「.js / .ts のファイルを読み込む」「いまのコードをファイルに保存する」ための小さな部品と、エラーの整形。通信なし。
//   - checkScriptFile: 読み込む前の検査（拡張子・大きさ・空・バイナリ・.d.ts・JSX）。通らなければ、理由のコードを返す（文言は画面側で翻訳する）。
//   - scriptLangFromName: 拡張子から実行する言語（.ts / .mts / .cts → ts、.js / .mjs / .cjs → js）。
//   - scriptFileName: 保存するときのファイル名（kasane-console-20261031-120000.ts など）。
//   - describeConsoleError: エラーを、画面に出す文字にする。構文エラーは、行・桁と、その行の中身、桁の位置の ^ を付ける。
//     ファイル名があれば「name:行:桁」の形にする。Node.js 用の書き方（require など）で落ちたときは、ひとこと添える。
// 読み込んだコードは、ふつうの入力と同じく、いったん入力欄に入れてから動かす（自動では動かさない。署名は、いつもどおり確認が入る）。
import { StopSignal } from './interpreter';
import { formatValue } from './format';
import type { ConsoleLang } from './tsStrip';

/** ファイル選択で選べる拡張子（<input accept> に渡す）。 */
export const SCRIPT_ACCEPT = '.js,.mjs,.cjs,.ts,.mts,.cts,.txt,.md,.markdown';
/** 読み込める大きさの上限（バイト）。 */
export const MAX_SCRIPT_BYTES = 512 * 1024;

export type ScriptProblem = 'ext' | 'too_big' | 'empty' | 'binary' | 'dts' | 'jsx' | 'md_none';

export type ScriptCheck =
  | { ok: true; text: string; lang: ConsoleLang | null; lines: number; markdown: boolean }
  | { ok: false; problem: ScriptProblem };

const lowerName = (name: string): string => name.toLowerCase();

/** Markdown（Obsidian のノートなど）か。中のコードブロックを取り出して使う。 */
export const isMarkdownName = (name: string): boolean => /\.(md|markdown)$/.test(lowerName(name));

/** 拡張子から言語を決める。.txt など、決められないときは null（いまの設定のまま）。 */
export function scriptLangFromName(name: string): ConsoleLang | null {
  const n = lowerName(name);
  if (/\.(ts|mts|cts)$/.test(n)) return 'ts';
  if (/\.(js|mjs|cjs)$/.test(n)) return 'js';
  return null;
}

/** 中身を読む前の検査（名前と大きさだけ）。巨大なファイルや、対応しない種類のファイルを、読み込まずに断る。問題が無ければ null。 */
export function precheckScriptFile(name: string, byteLength: number): ScriptProblem | null {
  const n = lowerName(name);
  if (/\.d\.(ts|mts|cts)$/.test(n)) return 'dts';
  if (/\.(tsx|jsx)$/.test(n)) return 'jsx';
  if (!/\.(js|mjs|cjs|ts|mts|cts|txt|md|markdown)$/.test(n)) return 'ext';
  if (byteLength > MAX_SCRIPT_BYTES) return 'too_big';
  return null;
}

/**
 * 読み込んだファイルを検査する。byteLength は、ファイルの大きさ（File.size）。
 * 通ったら、先頭の BOM と改行（CRLF）を整えた text を返す。
 */
export function checkScriptFile(name: string, byteLength: number, raw: string): ScriptCheck {
  const early = precheckScriptFile(name, byteLength);
  if (early !== null) return { ok: false, problem: early };
  if (raw.includes('\u0000')) return { ok: false, problem: 'binary' };
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.trim() === '') return { ok: false, problem: 'empty' };
  return { ok: true, text, lang: scriptLangFromName(name), lines: text.replace(/\n+$/, '').split('\n').length, markdown: isMarkdownName(name) };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** 保存するときのファイル名。 */
export function scriptFileName(lang: ConsoleLang, now: Date = new Date()): string {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `kasane-console-${day}-${time}.${lang}`;
}

/** 保存するときの MIME タイプ（.ts は、動画の MIME と取り違えられないよう text/plain にする）。 */
export const scriptMimeType = (lang: ConsoleLang): string => (lang === 'ts' ? 'text/plain' : 'text/javascript');

// --- Markdown（Obsidian のノート）から、コードブロックを取り出す -----------------------------------------

export interface CodeBlock {
  /** ノートの中で何番目のコードブロックか（js / ts 以外も数える。1 始まり）。 */
  index: number;
  lang: ConsoleLang;
  code: string;
  /** コードの最初の行が、ノートの何行目か（1 始まり）。エラーの行を、ノートの行に合わせるのに使う。 */
  startLine: number;
  lines: number;
}

// コードブロックの info（```js title="a" の js の部分）→ 言語。js / ts 以外（json・bash・jsx・tsx など）は、対象にしない。
const BLOCK_LANG: Record<string, ConsoleLang> = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  ts: 'ts', typescript: 'ts', mts: 'ts', cts: 'ts',
};

/**
 * Markdown から、js / ts のコードブロックを順に取り出す。
 *   - ``` と ~~~ の両方。閉じる柵は、開いた柵と同じ文字で、同じかそれ以上の長さ。閉じていなければ、最後まで（Obsidian の表示と同じ）。
 *   - 引用（> ）やインデントの中のブロック（Obsidian の callout・リストの中）も取り出す。引用の印とインデントは取り除く。
 *   - info は、最初の単語だけ見る（```ts title="send.ts" や ```js:send.js も ok）。言語のないブロックは、対象にしない。
 *   - 空のブロックは、対象にしない。
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: CodeBlock[] = [];
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^([ \t]*(?:>[ \t]?)*[ \t]*)(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(lines[i]);
    if (!open) continue;
    const [, prefix, fence, info] = open;
    // バッククォートの柵の info には、バッククォートを含められない（インラインのコードと見分けるための決まり）
    if (fence[0] === '`' && info.includes('`')) continue;
    index++;
    const lang = BLOCK_LANG[(info.trim().split(/[\s:{,]/)[0] ?? '').toLowerCase().replace(/^\./, '')];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const stripped = lines[j].startsWith(prefix) ? lines[j].slice(prefix.length) : lines[j].replace(/^[ \t]*(?:>[ \t]?)*/, '');
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(stripped);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      body.push(stripped);
    }
    if (lang !== undefined && body.some((l) => l.trim() !== '')) {
      const code = body.join('\n').replace(/\n+$/, '');
      out.push({ index, lang, code, startLine: i + 2, lines: code.split('\n').length });
    }
    i = j; // 閉じた柵の次から続ける（ブロックの中の ``` を、新しいブロックの始まりと取り違えない）
  }
  return out;
}

/**
 * 入力欄に貼り付けられたテキストが、js / ts のコードブロックを含む Markdown（Obsidian のノートなど）なら、そのブロックを返す。
 * そうでなければ（ふつうのコード・大きすぎるテキスト）空。画面側は、空でないときだけ「ノートとして読み込みますか？」と確認する。
 */
export function blocksInPastedText(text: string): CodeBlock[] {
  if (text.length > MAX_SCRIPT_BYTES) return [];
  return extractCodeBlocks(text);
}

/** 選んだブロックを、1 つのコードにつなぐ（空行で区切る）。js と ts が混ざるときは ts（TypeScript モードは、JavaScript もそのまま動かせる）。 */
export function combineBlocks(blocks: CodeBlock[]): { code: string; lang: ConsoleLang } {
  return { code: blocks.map((b) => b.code).join('\n\n'), lang: blocks.some((b) => b.lang === 'ts') ? 'ts' : 'js' };
}

// --- エラーの整形 ---------------------------------------------------------------------------------

interface Loc { line: number; column: number }

/** SyntaxError などから、位置（行は 1 始まり、桁は 0 始まり）を取り出す。無ければ null。 */
function locOf(e: unknown): Loc | null {
  const loc = (e as { loc?: { line?: unknown; column?: unknown } } | null)?.loc;
  if (loc && typeof loc.line === 'number' && typeof loc.column === 'number') return { line: loc.line, column: loc.column };
  return null;
}

// タブは幅が決まらないので、ソースの行と ^ の行をそろえるため、どちらも空白 1 つ分にして並べる
const flat = (s: string): string => s.replace(/\t/g, ' ');

/** 「  3 | 中身」と「    | ^」の 2 行。長い行は、桁の近くだけを見せる。 */
function frame(source: string, loc: Loc, lineOffset = 0): string {
  const all = source.replace(/\r\n?/g, '\n').split('\n');
  const text = flat(all[loc.line - 1] ?? '');
  const MAX = 120;
  const start = loc.column > MAX - 20 ? loc.column - (MAX - 20) : 0;
  const shown = (start > 0 ? '…' : '') + text.slice(start, start + MAX) + (text.length > start + MAX ? '…' : '');
  const caretAt = Math.max(0, loc.column - start) + (start > 0 ? 1 : 0);
  const gutter = String(loc.line + lineOffset);
  return `  ${gutter} | ${shown}\n  ${' '.repeat(gutter.length)} | ${' '.repeat(caretAt)}^`;
}

// Node.js 用の書き方で落ちたときの、ひとこと（画面側で翻訳する）
export type ConsoleHint = 'node';
const NODE_ONLY = /\b(require|module|exports|process|__dirname|__filename|Buffer|global)\b is not defined/;

/** エラーに添えるヒントの種類（無ければ null）。 */
export function hintFor(e: unknown): ConsoleHint | null {
  const msg = e instanceof Error ? e.message : '';
  return NODE_ONLY.test(msg) ? 'node' : null;
}

export interface DescribeOptions {
  /** エラーになったコード（構文エラーの行を見せるのに使う）。 */
  source?: string;
  /** 読み込んだファイルの名前。あれば「name:行:桁」と出す。 */
  fileName?: string;
  /** 実行時のエラーが起きた行（interpreter.line）。 */
  line?: number;
  /** 表示する行番号に足す数。Markdown のブロックを読み込んだとき、ノートの行に合わせるのに使う。 */
  lineOffset?: number;
}

/**
 * エラーを、画面に出す文字にする。
 *   構文エラー: `SyntaxError: Unexpected token (2:12)` ＋ `  at name:2:13`（桁は 1 始まりで出す）＋ その行と ^
 *   実行時のエラー: `TypeError: … (行)` ＋ （ファイル名があれば）`  at name:行`
 */
export function describeConsoleError(e: unknown, opts: DescribeOptions = {}): string {
  if (e instanceof StopSignal) return '停止しました (stopped)';
  const { source, fileName, line: rawLine, lineOffset = 0 } = opts;
  const line = rawLine && rawLine > 0 ? rawLine + lineOffset : rawLine;
  if (!(e instanceof Error)) {
    const where = line && line > 0 ? ` (${line})` : '';
    return `Uncaught ${formatValue(e)}${where}`;
  }
  const loc = e instanceof SyntaxError ? locOf(e) : null;
  // 構文エラーのメッセージの終わりにある (行:桁) は、ブロックの中の位置なので、ノートの行に直す
  const message = loc && lineOffset !== 0 ? e.message.replace(/\((\d+):(\d+)\)$/, (_m, l: string, c: string) => `(${Number(l) + lineOffset}:${c})`) : e.message;
  const head = `${e.name}: ${message}`;
  if (loc) {
    const at = fileName ? `\n  at ${fileName}:${loc.line + lineOffset}:${loc.column + 1}` : '';
    return `${head}${at}${source !== undefined ? `\n${frame(source, loc, lineOffset)}` : ''}`;
  }
  const where = line && line > 0 && !(e instanceof SyntaxError) ? ` (${line})` : '';
  const at = fileName && line && line > 0 && !(e instanceof SyntaxError) ? `\n  at ${fileName}:${line}` : '';
  return `${head}${where}${at}`;
}
