// コンソールのサンプルのコメントを、設定言語に合わせる処理（lib/console/sampleComments.ts）。通信なし。
// 実行: npx tsx dev-tests/console-sample-comments.test.ts
// コメントに加えて、コード中の日本語の文字列（console.log に出す文など）も対象。
// 確かめること: ① ja はサンプルそのまま ② 日本語のコメントすべてに、en / zh / ko / ru の訳がある
//   ③ 置き換えたあとは、コメント以外（コード）が、サンプルとまったく同じ ④ 訳に日本語（かな・漢字）が残っていない（zh は、漢字だけなので除く）
//   ⑤ 置き換えたあとも、インタープリタが読める構文のまま ⑥ TypeScript モードでも、コメントが言語に合う ⑦ 表に、使われていない訳が無い
import { parse } from 'acorn';
import { consoleSamplesFor } from '../src/lib/console/samples';
import { COMMENT_RE, SAMPLE_COMMENTS, SAMPLE_STRINGS, localizeSampleComments } from '../src/lib/console/sampleComments';
import { sampleCodeFor } from '../src/lib/console/samplesTs';
import { stripTypes } from '../src/lib/console/tsStrip';
import { toAppLanguage } from '../src/i18n/languages';
import type { AppLanguage } from '../src/i18n/languages';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const JA = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const KANA = /[\u3040-\u30ff]/;
const parses = (code: string): boolean => {
  const o = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true } as const;
  try { parse(code, { ...o, sourceType: 'script' }); return true; } catch (e) {
    if (e instanceof SyntaxError && /sourceType/.test(e.message)) { try { parse(code, { ...o, sourceType: 'module' }); return true; } catch { return false; } }
    return false;
  }
};
const stripComment = (line: string): string => { const m = COMMENT_RE.exec(line); const head = m === null ? line : line.slice(0, m.index + m[1].length); return head.replace(/"[^"\n]*"/g, '""'); };
const codePart = (line: string): string => { const m = COMMENT_RE.exec(line); return m === null ? line : line.slice(0, m.index + m[1].length); };
const others: AppLanguage[] = ['en', 'zh', 'ko', 'ru'];

// ② ⑦ 日本語のコメントの一覧と、表の突き合わせ
const used = new Set<string>();
for (const chain of ['symbol', 'nem'] as const) for (const s of consoleSamplesFor(chain)) for (const line of s.code.split('\n')) {
  const m = COMMENT_RE.exec(line);
  if (m === null || !JA.test(m[2])) continue;
  const key = m[2].trim();
  used.add(key);
  ok(SAMPLE_COMMENTS[key] !== undefined, `${chain}:${s.id}: no translation for the comment`, key);
}
// コード中の日本語の文字列
const usedStr = new Set<string>();
for (const chain of ['symbol', 'nem'] as const) for (const s of consoleSamplesFor(chain)) for (const line of s.code.split('\n')) {
  for (const m of codePart(line).matchAll(/"([^"\n]*)"/g)) {
    if (!JA.test(m[1])) continue;
    usedStr.add(m[1]);
    ok(SAMPLE_STRINGS[m[1]] !== undefined, `${chain}:${s.id}: no translation for the string`, m[1]);
  }
  if (JA.test(codePart(line).replace(/"[^"\n]*"/g, ''))) ok(false, `${chain}:${s.id}: Japanese in code outside a "string"`, line);
}
for (const key of Object.keys(SAMPLE_STRINGS)) ok(usedStr.has(key), 'unused entry in SAMPLE_STRINGS', key);
for (const [key, tr] of Object.entries(SAMPLE_STRINGS)) ok(tr.length === 4 && tr.every((x) => x.trim() !== '') && !tr.some((x) => KANA.test(x)), 'string translations are complete', key);
for (const key of Object.keys(SAMPLE_COMMENTS)) ok(used.has(key), 'unused entry in SAMPLE_COMMENTS', key);
for (const [key, tr] of Object.entries(SAMPLE_COMMENTS)) {
  ok(tr.length === 4 && tr.every((x) => x.trim() !== ''), 'every language has a non-empty translation', key);
  ok(!tr.some((x) => KANA.test(x)), 'no kana left in a translation', key);
}

for (const chain of ['symbol', 'nem'] as const) {
  const seen = new Set<string>();
  for (const s of consoleSamplesFor(chain)) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const key = `${chain}:${s.id}`;
    // ① ja は、そのまま
    ok(localizeSampleComments(s.code, 'ja') === s.code, `${key}: ja is unchanged`);
    ok(sampleCodeFor(chain, s, 'js') === s.code && sampleCodeFor(chain, s, 'js', 'ja') === s.code, `${key}: js + ja is the sample as is`);
    const orig = s.code.split('\n');
    for (const lang of others) {
      const out = localizeSampleComments(s.code, lang);
      const lines = out.split('\n');
      ok(lines.length === orig.length, `${key}/${lang}: same number of lines`);
      // ③ コメント以外は、同じ
      let same = true;
      for (let i = 0; i < orig.length; i++) if (stripComment(orig[i]) !== stripComment(lines[i] ?? '')) { same = false; ok(false, `${key}/${lang}: code part changed at line ${i + 1}`, orig[i]); break; }
      ok(same, `${key}/${lang}: code is untouched`);
      // コメントに日本語が残っていない（ログに出す文字列などのコード側は、対象外）
      for (const l of lines) { const m = COMMENT_RE.exec(l); if (m !== null) ok(!KANA.test(m[2]), `${key}/${lang}: kana left in a comment`, l); ok(!KANA.test(codePart(l)), `${key}/${lang}: kana left in code`, l); }
      // ⑤ 構文は、そのまま読める
      ok(parses(out) === parses(s.code), `${key}/${lang}: parses like the original`);
      // ⑥ TypeScript モード
      const ts = sampleCodeFor(chain, s, 'ts', lang);
      let stripped = '';
      try { stripped = stripTypes(ts); } catch (e) { ok(false, `${key}/${lang}: ts can be stripped`, (e as Error).message); continue; }
      ok(!stripped.split('\n').some((l) => { const m = COMMENT_RE.exec(l); return m !== null && KANA.test(m[2]); }), `${key}/${lang}: ts comments are localized`);
    }
  }
}

// 言語コードの正規化
ok(toAppLanguage('ja') === 'ja' && toAppLanguage('ja-JP') === 'ja' && toAppLanguage('zh-CN') === 'zh' && toAppLanguage('ko') === 'ko' && toAppLanguage('ru-RU') === 'ru', 'toAppLanguage: known');
ok(toAppLanguage('fr') === 'en' && toAppLanguage('') === 'en' && toAppLanguage(undefined) === 'en', 'toAppLanguage: unknown falls back to en');

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails === 0 ? 0 : 1);
