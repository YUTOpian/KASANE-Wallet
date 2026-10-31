// コンソールの「サンプル」を、言語に合わせたコードにする。通信なし。
//   - JavaScript: サンプルそのまま。
//   - TypeScript: 変数に型を付けた書き方（samplesTsRules.ts / samplesTypes.generated.ts）。動かすときは、型を取り除いてから
//     JavaScript として動く（tsStrip.ts）。取り除くと、JavaScript のサンプルと同じ動きになる（dev-tests/console-samples-ts.test.ts で確かめている）。
//   - コメント: 設定言語（appLang）に合わせた言葉にする（sampleComments.ts）。日本語のときは、サンプルそのまま。コードの部分は、どの言語でも同じ。
import type { AppLanguage } from '../../i18n/languages';
import type { ConsoleSample } from './samples';
import { localizeSampleComments } from './sampleComments';
import { annotateAssignments } from './samplesTsRules';
import { SAMPLE_HOISTED, SAMPLE_TYPES } from './samplesTypes.generated';
import type { ConsoleLang } from './tsStrip';

export function sampleCodeFor(chain: 'symbol' | 'nem', sample: ConsoleSample, lang: ConsoleLang, appLang: AppLanguage = 'ja'): string {
  const code = localizeSampleComments(sample.code, appLang);
  if (lang !== 'ts') return code;
  const types = SAMPLE_TYPES[`${chain}:${sample.id}`] ?? {};
  return annotateAssignments(code, (name) => types[name], SAMPLE_HOISTED[`${chain}:${sample.id}`]).code;
}
