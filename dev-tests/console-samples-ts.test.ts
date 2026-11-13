// コンソールのサンプルの TypeScript 版（lib/console/samplesTs.ts / samplesTsRules.ts / samplesTypes.generated.ts）。通信なし。
// 実行: npx tsx dev-tests/console-samples-ts.test.ts
// 確かめること: ① JavaScript はサンプルそのまま ② TypeScript 版は、型を取り除くと、型を付けただけの JavaScript と同じコードになる
//   ③ 取り除いたあとも、インタープリタが読める構文のまま ④ 型を付けるはずの変数に、型が付いている ⑤ 表が、いまのサンプルと合っている
import { parse } from 'acorn';
import { consoleSamplesFor } from '../src/lib/console/samples';
import { sampleCodeFor } from '../src/lib/console/samplesTs';
import { FN_PARAMS } from '../src/lib/console/samplesTsRules';
import { SAMPLE_HOISTED, SAMPLE_TYPES } from '../src/lib/console/samplesTypes.generated';
import { stripTypes } from '../src/lib/console/tsStrip';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const squash = (s: string) => s.replace(/\s+/g, '');
const parses = (code: string): boolean => {
  const o = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true } as const;
  try { parse(code, { ...o, sourceType: 'script' }); return true; } catch (e) {
    if (e instanceof SyntaxError && /sourceType/.test(e.message)) { try { parse(code, { ...o, sourceType: 'module' }); return true; } catch { return false; } }
    return false;
  }
};

let total = 0, annotated = 0;
for (const chain of ['symbol', 'nem'] as const) {
  const seen = new Set<string>();
  for (const s of consoleSamplesFor(chain)) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const key = `${chain}:${s.id}`;
    total++;
    // ① JavaScript は、そのまま
    ok(sampleCodeFor(chain, s, 'js') === s.code, `${key}: js returns the sample as is`);
    const ts = sampleCodeFor(chain, s, 'ts');
    // ② 型を取り除くと、型を付けただけの JavaScript と同じ（宣言のためだけの `let name;` の行は除く）
    let stripped = '';
    try { stripped = stripTypes(ts); } catch (e) { ok(false, `${key}: ts sample can be stripped`, (e as Error).message); continue; }
    const hoisted = SAMPLE_HOISTED[key] ?? {};
    const withoutDecls = stripped.split('\n').filter((l) => !(Object.keys(hoisted).some((n) => l.trim() === `let ${n};`))).join('\n');
    const firstSeen = new Set<string>();
    const plain = s.code.split('\n').map((l) => {
      const m = /^([A-Za-z_$][\w$]*) = /.exec(l);
      if (m === null || firstSeen.has(m[1])) return l;
      firstSeen.add(m[1]);
      return `let ${l}`;
    }).join('\n');
    ok(squash(withoutDecls) === squash(plain), `${key}: stripped ts == plain js (with let)`);
    // ③ 読める構文
    ok(parses(stripped), `${key}: stripped ts parses`);
    // ④ 型が付いている: 行頭の `let name = …` が残るのは、関数を入れる変数（仮引数に型を付ける）だけ
    const bare = ts.split('\n').map((l) => /^let ([A-Za-z_$][\w$]*) = /.exec(l)?.[1]).filter((n): n is string => n !== undefined && !(n in FN_PARAMS));
    ok(bare.length === 0, `${key}: every top-level variable has a type`, bare.join(','));
    for (const n of Object.keys(hoisted)) ok(ts.includes(`let ${n}: ${hoisted[n]};`), `${key}: hoisted ${n} is declared`);
    // 関数を入れる変数は、仮引数に型が付く
    for (const [n, sig] of Object.entries(FN_PARAMS)) {
      if (new RegExp(`^${n} = `, 'm').test(s.code)) ok(ts.includes(`let ${n} = ${sig} =>`), `${key}: ${n} params are typed`);
    }
    if (ts !== s.code) annotated++;
    // ⑤ 表に、サンプルに無い名前が入っていない
    for (const n of Object.keys(SAMPLE_TYPES[key] ?? {})) ok(new RegExp(`^${n} = `, 'm').test(s.code), `${key}: table name ${n} exists in the sample`);
  }
}
for (const key of [...Object.keys(SAMPLE_TYPES), ...Object.keys(SAMPLE_HOISTED)]) {
  const [chain, id] = key.split(':') as ['symbol' | 'nem', string];
  ok(consoleSamplesFor(chain).some((x) => x.id === id), `table key ${key} is a real sample`);
}
ok(total === 71, 'sample count (symbol 45 + nem 26)', total);
ok(annotated >= 60, 'almost every sample is changed in ts mode', annotated);

// 具体例
{
  const node = consoleSamplesFor('symbol').find((x) => x.id === 'account')!;
  const ts = sampleCodeFor('symbol', node, 'ts');
  ok(/^let \w+: [\w.<>[\]| ]+ = /m.test(ts) || !/^\w+ = /m.test(node.code), 'account sample: typed declarations');
  const l = consoleSamplesFor('symbol').find((x) => x.id === 'listener')!;
  const tl = sampleCodeFor('symbol', l, 'ts');
  ok(tl.includes('let data: any;') && tl.includes('let addCallback = (channel: string, callback: (data: any) => void) =>'), 'listener sample: hoisted and helper types');
}

console.log(fails === 0 ? `OK (${checks} checks, ${total} samples)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
