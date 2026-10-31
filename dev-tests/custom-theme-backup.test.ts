// カスタムテーマのバックアップ（theme/themeBackup.ts）: 画像ごとの書き出し → 読み込みで、同じテーマに戻ること。
// 壊れたファイル・別の種類のファイル・上限（10個・画像の容量）・危ない値の扱い。
// 実行: npx tsx dev-tests/custom-theme-backup.test.ts（通信なし）
import { IMAGE_SLOTS, MAX_ALL_IMAGE_CHARS, MAX_CUSTOM_THEMES, imageCharsOf } from '../src/theme/customTheme';
import type { CustomThemeData, SavedCustomTheme } from '../src/theme/customTheme';
import { MAX_THEME_BACKUP_BYTES, buildThemeBackup, parseThemeBackup, planThemeImport } from '../src/theme/themeBackup';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const png = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;
const jpg = (n: number) => `data:image/jpeg;base64,${'B'.repeat(n)}`;
const theme = (id: string, name: string, images?: SavedCustomTheme['images']): SavedCustomTheme => ({
  id, name, root: { mode: 'dark' }, chains: { symbol: {} }, ...(images ? { images } : {}),
});

// 1. 画像ごとの往復
const a = theme('a', 'さくら風', { background: jpg(5000), navHome: png(800), hero: png(1200) });
const b = theme('b', 'plain');
(b as CustomThemeData).root = { mode: 'light' };
const text = buildThemeBackup([a, b]);
const parsed = parseThemeBackup(text);
check('the file parses', parsed.ok);
if (parsed.ok) {
  check('both themes come back', parsed.themes.length === 2 && parsed.invalid === 0);
  check('the name is kept', parsed.themes[0].name === 'さくら風');
  check('every uploaded image is kept as it was', Object.entries(a.images ?? {}).every(([k, v]) => (parsed.themes[0].images as Record<string, string> | undefined)?.[k] === v) && Object.keys(parsed.themes[0].images ?? {}).length === 3);
  check('mode is kept', parsed.themes[1].root.mode === 'light');
}
check('ids are not written into the file', !text.includes('"id"'));
check('the file says what it is', text.includes('"kind": "custom-themes"'));

// 2. 使えないファイル
const bad = (s: string) => { const r = parseThemeBackup(s); return r.ok ? 'ok' : r.reason; };
check('not JSON', bad('hello') === 'not_json');
check('JSON of another kind', bad('{"a":1}') === 'not_backup');
check('an array is not a backup', bad('[]') === 'not_backup');
check('no themes', bad('{"kind":"custom-themes","themes":[]}') === 'empty');
check('a BOM in front is accepted', bad('\uFEFF' + text) === 'ok');
check('a huge file is refused before parsing', bad('x'.repeat(MAX_THEME_BACKUP_BYTES + 1)) === 'too_large');

// 3. 危ない値は、読み込み時に捨てる
const evil = JSON.stringify({
  kind: 'custom-themes',
  themes: [
    { name: 'evil', root: { mode: 'dark' }, chains: {}, images: { background: 'https://example.com/a.png', hero: 'data:image/svg+xml;base64,AAAA', navHome: png(100) } },
    { name: 'junk', root: 5 },
  ],
});
const ev = parseThemeBackup(evil);
check('remote / svg images are dropped, a good one stays', ev.ok && JSON.stringify(Object.keys(ev.themes[0].images ?? {})) === '["navHome"]');
check('a theme with nothing usable counts as invalid', ev.ok && ev.themes.length === 1 && ev.invalid === 1);

// 4. 足せる数
const many = Array.from({ length: 8 }, (_, i) => theme(`t${i}`, `t${i}`));
const incoming: CustomThemeData[] = Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, root: { mode: 'dark' }, chains: {} }));
const plan = planThemeImport(many, incoming);
check(`only up to ${MAX_CUSTOM_THEMES} in total`, plan.add.length === MAX_CUSTOM_THEMES - 8 && plan.skipped === 3);

const fullImages: Record<string, string> = {};
for (const slot of IMAGE_SLOTS) fullImages[slot.key] = 'data:image/png;base64,' + 'A'.repeat(slot.maxChars - 30);
const heavy = theme('h', 'heavy', fullImages as SavedCustomTheme['images']);
const perTheme = imageCharsOf(heavy);
const fits = Math.floor(MAX_ALL_IMAGE_CHARS / perTheme); // 画像いっぱいのテーマが、いくつ入るか
check('a theme full of images fits several times', fits >= 5, String(fits));
const cur = Array.from({ length: fits }, (_, i) => ({ ...heavy, id: `h${i}` }));
const p2 = planThemeImport(cur.slice(0, Math.min(fits, MAX_CUSTOM_THEMES - 1)), [{ name: 'big', root: { mode: 'dark' }, chains: {}, images: heavy.images }, { name: 'small', root: { mode: 'dark' }, chains: {} }]);
check('images over the room: that theme is skipped, one without images is added (when the count allows)', fits >= MAX_CUSTOM_THEMES - 1 ? p2.add.length >= 1 : p2.add.length === 1 && p2.add[0].name === 'small' && p2.skipped === 1, JSON.stringify([p2.add.length, p2.skipped]));

if (failed > 0) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log('\nALL PASS');
