// TypeScript → JavaScript（型を取り除くだけ）。通信なし・eval なし。
//
// コンソールの「TypeScript」モードで、コードをインタープリタに渡す前に通す。
//   - 型注釈・interface・type・as・! ・ジェネレクス・implements・アクセス修飾子・enum などを JavaScript にする。
//   - 型のチェックはしない（型が合っていなくても動く）。エラーになるのは構文が正しくないときだけ。
//   - 改行は保つので、実行時エラーの行番号は、入力した行とほぼ合う。
//   - 取り除いた結果は、普通の JavaScript と同じく acorn → interpreter.ts の木歩きで動く（CSP は緩めない）。
import { transform } from 'sucrase';

export type ConsoleLang = 'js' | 'ts';

export const DEFAULT_CONSOLE_LANG: ConsoleLang = 'js';

export const isConsoleLang = (v: unknown): v is ConsoleLang => v === 'js' || v === 'ts';

// 値を持つ namespace は、sucrase が中身ごと消してしまう（黙って動かなくなる）ので、先にエラーにする。
// `declare namespace` と `namespace` を使わないコードは対象外。行頭の `namespace 名前 {` だけを見る。
const NAMESPACE_RE = /^[ \t]*(?:export[ \t]+)?namespace[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{/m;

/** 型を取り除く。構文が正しくないときは、位置（pos / loc）つきの SyntaxError を投げる。 */
export function stripTypes(code: string): string {
  if (NAMESPACE_RE.test(code)) {
    throw new SyntaxError('[console] "namespace" is not supported in TypeScript mode (use an object or a module instead)');
  }
  return transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;
}

/** 言語に合わせて、動かす前のコードにする。js のときはそのまま。 */
export function prepareCode(code: string, lang: ConsoleLang): string {
  return lang === 'ts' ? stripTypes(code) : code;
}
