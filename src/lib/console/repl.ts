// コンソールの対話（REPL）まわりの小さな部品。通信なし。
//   - isIncomplete: 入力が「まだ途中」か（括弧やテンプレートリテラルが閉じていない等）。途中なら Enter は実行ではなく改行にする。
//     ブラウザの開発者ツールのコンソールと同じ動き。本物の構文エラー（綴りの間違いなど）は途中扱いにしない（実行してエラーを見せる）。
//   - pushHistory / stepHistory: ↑ ↓ で前の入力を呼び出す履歴。
import { parse } from 'acorn';
import { stripTypes } from './tsStrip';
import type { ConsoleLang } from './tsStrip';

export function isIncomplete(code: string, lang: ConsoleLang = 'js'): boolean {
  if (code.trim() === '') return false;
  try {
    // TypeScript のときは、型を取り除いてから見る（取り除く段階の構文エラーも「途中か」の判定に使う）
    const js = lang === 'ts' ? stripTypes(code) : code;
    parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });
    return false;
  } catch (e) {
    const err = e as { message?: unknown; pos?: unknown };
    const msg = typeof err.message === 'string' ? err.message : '';
    if (/Unterminated (template|comment)/i.test(msg)) return true;
    // 構文エラーの場所が入力の終わり（空白を除く）なら、続きがあれば成立するかもしれない
    return typeof err.pos === 'number' && err.pos >= code.trimEnd().length;
  }
}

export const MAX_HISTORY = 100;

/** 履歴に足す。直前と同じものは重ねない。 */
export function pushHistory(history: string[], code: string): string[] {
  const text = code.replace(/\s+$/, '');
  if (text === '' || history[history.length - 1] === text) return history;
  return [...history, text].slice(-MAX_HISTORY);
}

/**
 * 履歴の中の位置を動かす。index は history.length のとき「いま書いている途中の入力」。
 * 戻り値の index が history.length なら、呼び出し側が取っておいた書きかけを戻す。
 */
export function stepHistory(history: string[], index: number, dir: -1 | 1): number {
  return Math.min(history.length, Math.max(0, index + dir));
}
