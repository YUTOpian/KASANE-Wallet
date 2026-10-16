// カスタムテーマ（theme/customTheme.ts と kasaneTheme.ts の 'custom'）。
// ・ひな形の CSS が、そのまま読み込めて、元の見た目に戻ること（4つのテーマ × 4つのチェーン）
// ・危ない CSS（@import・url()・ほかのプロパティ・変なフォント・巨大なファイル）が、値として入らないこと
// ・チェーンごとの上書き、保存データの再検証、テーマへの反映
// 実行: npx tsx dev-tests/custom-theme.test.ts（通信なし）
import { IMAGE_SLOTS, MAX_ALL_IMAGE_CHARS, MAX_CUSTOM_THEMES, MAX_TOTAL_IMAGE_CHARS, VAR_SPECS, buildTemplateCss, buildThemeCss, imageCharsOf, sanitizeSavedThemes, decodeCssBytes, normalizeColor, normalizeFont, parseCustomThemeCss, resolveCustomValues, sanitizeCustomTheme } from '../src/theme/customTheme';
import { fitInside, fitsTotal, totalImageChars } from '../src/theme/imageProcessing';
import { createKasaneTheme } from '../src/theme/kasaneTheme';
import type { ThemeMode } from '../src/store/appStore';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}
const codes = (css: string) => parseCustomThemeCss(css).warnings.map((w) => w.code);

// --- 1. ひな形 → 読み込み → 同じ見た目 --------------------------------------------------------
const modes: ThemeMode[] = ['dark', 'light', 'business', 'blossom'];
const chains = ['symbol', 'nem', 'mijin', 'base'] as const;
for (const mode of modes) {
  for (const chain of chains) {
    const look = createKasaneTheme(mode, chain).kasane.look;
    const css = buildTemplateCss(look, `${mode}/${chain}`);
    const parsed = parseCustomThemeCss(css);
    check(`template ${mode}/${chain}: every variable is read, no warnings`, parsed.applied === VAR_SPECS.length && parsed.warnings.length === 0, JSON.stringify(parsed.warnings.slice(0, 3)));
    const again = createKasaneTheme('custom', chain, parsed.theme).kasane.look;
    const same = VAR_SPECS.every((spec) => {
      const a = look[spec.key];
      const b = again[spec.key];
      if (spec.type === 'color') return normalizeColor(String(a)) === normalizeColor(String(b));
      if (spec.type === 'font') return normalizeFont(String(a)) === normalizeFont(String(b));
      return a === b;
    });
    check(`template ${mode}/${chain}: the look comes back the same`, same, JSON.stringify(VAR_SPECS.filter((s) => String(look[s.key]) !== String(again[s.key])).map((s) => [s.key, look[s.key], again[s.key]])).slice(0, 300));
  }
}

// --- 2. 色の書き方 ---------------------------------------------------------------------------------
check('#rgb', normalizeColor('#f0a') === '#ff00aa');
check('#rrggbbaa', normalizeColor('#00000080') === 'rgba(0, 0, 0, 0.502)');
check('rgb() comma', normalizeColor('rgb(255, 0, 128)') === '#ff0080');
check('rgb() space + slash alpha', normalizeColor('rgb(255 0 128 / 50%)') === 'rgba(255, 0, 128, 0.5)');
check('rgb() percent', normalizeColor('rgb(100%, 0%, 0%)') === '#ff0000');
check('hsl()', normalizeColor('hsl(120, 100%, 50%)') === '#00ff00');
check('hsla()', normalizeColor('hsla(0, 100%, 50%, 0.25)') === 'rgba(255, 0, 0, 0.25)');
check('white / black', normalizeColor('White') === '#ffffff' && normalizeColor('black') === '#000000');
check('out-of-range channels are clamped', normalizeColor('rgb(300, -5, 0)') === '#ff0000');
for (const bad of ['red', 'url(http://x/a.png)', '#12', '#12345', 'rgb(1,2)', 'rgb(a,b,c)', 'var(--x)', 'calc(1+1)', 'rgb(1,2,3);', 'expression(alert(1))', '#fff url(x)', 'linear-gradient(red, blue)']) {
  check(`bad colour rejected: ${bad}`, normalizeColor(bad) === null);
}

// --- 3. フォント -----------------------------------------------------------------------------------
check('font list is normalised', normalizeFont("Inter, 'Hiragino Sans', sans-serif") === '"Inter", "Hiragino Sans", sans-serif');
check('Japanese font names', normalizeFont('"游ゴシック", serif') === '"游ゴシック", serif');
for (const bad of ['url(http://x)', 'a; b', 'a } body { x', '"unterminated', 'a\\b', '<script>', 'a(b)', '', 'x'.repeat(400), Array.from({ length: 30 }, (_, i) => `f${i}`).join(',')]) {
  check(`bad font rejected: ${bad.slice(0, 24)}`, normalizeFont(bad) === null);
}

// --- 4. 危ない CSS は入らない -------------------------------------------------------------------------
check('@import is refused', codes("@import url('http://evil/x.css'); :root { --kasane-bg: #000; }").includes('at_rule'));
check('@media block is refused', codes('@media (min-width: 1px) { :root { --kasane-bg: #000; } }').includes('at_rule'));
{
  const r = parseCustomThemeCss("body { background: url(http://evil/x.png); position: fixed } .x::before { content: 'Send to abcd' }");
  check('arbitrary selectors are refused, nothing applied', r.theme === null && r.applied === 0 && r.warnings.filter((w) => w.code === 'selector').length === 2);
}
{
  const r = parseCustomThemeCss(':root { background: url(http://evil/x.png); --kasane-bg: url(http://evil/y.png); --kasane-unknown: #fff; --my-var: 1 }');
  check('plain properties / url() / unknown variables are refused', r.theme === null && r.warnings.map((w) => w.code).filter((c) => c !== 'empty').sort().join() === 'bad_value,not_variable,unknown_var,unknown_var', JSON.stringify(r.warnings));
  check('... and "empty" is reported', r.warnings.some((w) => w.code === 'empty'));
}
{
  const r = parseCustomThemeCss(':root { --kasane-font: "a"; } body { x: y }');
  check('font cannot escape into another rule', r.theme !== null && r.theme.root.font === '"a"', JSON.stringify(r.theme));
}
{
  const r = parseCustomThemeCss('/* :root { --kasane-bg: #fff } */ :root { --kasane-accent: #123456 }');
  check('commented-out settings are ignored', r.applied === 1 && r.theme?.root.bg === undefined && r.theme?.root.accent === '#123456');
}
check('unterminated comment drops the rest', parseCustomThemeCss(':root { --kasane-accent: #123456 } /* :root { --kasane-bg: #fff }').theme?.root.bg === undefined);
check('unterminated block does not crash', parseCustomThemeCss(':root { --kasane-accent: #123456').theme?.root.accent === '#123456');
check('garbage does not crash', parseCustomThemeCss('}{;;}}{{ :root { ').theme === null);
check('a 200 KB file is accepted now (images are inside)', !codes(':root{}' + ' '.repeat(200 * 1024)).includes('too_large'));
check('huge file is refused', codes(':root{}' + ' '.repeat(3.1 * 1024 * 1024)).join() === 'too_large');
check('!important is accepted', parseCustomThemeCss(':root { --kasane-accent: #123456 !important }').theme?.root.accent === '#123456');
check('radius / button radius limits', (() => {
  const r = parseCustomThemeCss(':root { --kasane-radius: 49px; --kasane-button-radius: 1000px }');
  return r.theme === null && r.warnings.filter((w) => w.code === 'bad_value').length === 2;
})());
check('radius accepts px and plain numbers', (() => {
  const r = parseCustomThemeCss(':root { --kasane-radius: 12px; --kasane-button-radius: 999 }');
  return r.theme?.root.radius === 12 && r.theme?.root.buttonRadius === 999;
})());
check('mode must be dark or light', codes(':root { --kasane-mode: blue }').includes('bad_value'));
check('warnings carry the line number', parseCustomThemeCss(':root {\n  --kasane-accent: #123456;\n  --kasane-bg: nope;\n}').warnings.find((w) => w.code === 'bad_value')?.line === 3);

// --- 5. チェーンごとの上書き --------------------------------------------------------------------------
{
  const r = parseCustomThemeCss(`:root { --kasane-mode: light; --kasane-accent: #ff0000 }
    :root[data-chain="nem"] { --kasane-accent: #00ff00; --kasane-mode: dark }
    :root[data-chain='weird'] { --kasane-accent: #0000ff }`);
  check('a chain block overrides only that chain', resolveCustomValues(r.theme!, 'nem').accent === '#00ff00' && resolveCustomValues(r.theme!, 'symbol').accent === '#ff0000');
  check('mode is read in :root only', resolveCustomValues(r.theme!, 'nem').mode === 'light' && r.warnings.some((w) => w.code === 'mode_root_only'));
  check('unknown chain selector is refused', r.warnings.some((w) => w.code === 'selector'));
  check('the chain override reaches the theme', createKasaneTheme('custom', 'nem', r.theme).kasane.accent === '#00ff00' && createKasaneTheme('custom', 'symbol', r.theme).kasane.accent === '#ff0000');
}

// --- 6. 保存データの再検証 --------------------------------------------------------------------------------
{
  const s = sanitizeCustomTheme({ name: 'x', root: { bg: 'url(http://x)', accent: '#FFF', radius: 9999, mode: 'neon', font: 'a;b' }, chains: { nem: { glow: 'red', line: 'rgb(1,2,3)' }, evil: { bg: '#000' } } });
  check('tampered saved values are dropped', s !== null && s.root.bg === undefined && s.root.accent === '#ffffff' && s.root.radius === undefined && s.root.mode === undefined && s.root.font === undefined);
  check('tampered chain values are dropped', s?.chains.nem?.glow === undefined && s?.chains.nem?.line === '#010203' && !('evil' in (s?.chains ?? {})));
  check('nothing valid -> null', sanitizeCustomTheme({ root: { bg: 'url(x)' } }) === null && sanitizeCustomTheme(null) === null && sanitizeCustomTheme('x') === null);
}

// --- 7. テーマへの反映 ----------------------------------------------------------------------------------------
{
  const dark = createKasaneTheme('dark', 'symbol');
  const none = createKasaneTheme('custom', 'symbol', null);
  check("'custom' without data is the dark theme", none.kasane.bg === dark.kasane.bg && none.palette.mode === 'dark');
  const r = parseCustomThemeCss(`:root { --kasane-mode: light; --kasane-bg: #112233; --kasane-text: #010203; --kasane-radius: 4px;
    --kasane-button-radius: 2px; --kasane-font: "Georgia", serif; --kasane-gradient-start: #ff0000; --kasane-gradient-end: #0000ff;
    --kasane-menu-top: #101010; --kasane-menu-text: #eeeeee; --kasane-hero-start: #333333; --kasane-error: #aa0000 }`);
  const th = createKasaneTheme('custom', 'symbol', r.theme);
  check('mode light', th.palette.mode === 'light');
  check('background / text', th.palette.background.default === '#112233' && th.palette.text.primary === '#010203');
  check('card radius and shape', th.kasane.cardRadius === 4 && th.shape.borderRadius === 3);
  check('font', th.typography.fontFamily === '"Georgia", serif');
  check('gradient uses the new ends', th.kasane.gradient.includes('#ff0000') && th.kasane.gradient.includes('#0000ff'));
  check('menu', th.kasane.menu.panel.includes('#101010') && th.kasane.menu.text === '#eeeeee');
  check('hero', th.kasane.hero.includes('#333333'));
  check('error colour', th.palette.error.main === '#aa0000');
  check('button radius', JSON.stringify(th.components?.MuiButton?.styleOverrides ?? {}).includes('"borderRadius":2'));
  check('look reports what was set', th.kasane.look.bg === '#112233' && th.kasane.look.radius === 4 && th.kasane.look.menuTop === '#101010');
  const sparse = createKasaneTheme('custom', 'symbol', parseCustomThemeCss(':root { --kasane-accent: #abcdef }').theme);
  check('an unset variable keeps the standard of the base brightness', sparse.kasane.bg === dark.kasane.bg && sparse.kasane.accent === '#abcdef');
}

// --- 8. 文字コード --------------------------------------------------------------------------------------------
{
  const css = ':root { --kasane-accent: #123456 }';
  check('a BOM at the start is ignored', parseCustomThemeCss('\uFEFF' + css).theme?.root.accent === '#123456');
  const utf8 = new TextEncoder().encode('/* 日本語のコメント */ ' + css);
  check('UTF-8 bytes are decoded', decodeCssBytes(utf8).startsWith('/* 日本語のコメント */'));
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  check('UTF-8 with BOM: the BOM is dropped by the decoder', decodeCssBytes(withBom).startsWith('/*'));
  check('Shift_JIS bytes are decoded', decodeCssBytes(new Uint8Array([0x82, 0xa0, 0x82, 0xa2])) === 'あい');
  const tpl = buildTemplateCss(createKasaneTheme('dark', 'symbol').kasane.look, 'x');
  check('the template says it is UTF-8', tpl.includes('UTF-8'));
  check('a Shift_JIS-saved template still reads', parseCustomThemeCss(decodeCssBytes(new Uint8Array([...new TextEncoder().encode(':root { --kasane-accent: #123456 } /* '), 0x82, 0xa0, ...new TextEncoder().encode(' */')]))).theme?.root.accent === '#123456');
}

// --- 9. 画像 ---------------------------------------------------------------------------------------------------
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const imgCss = (decl: string) => `:root { ${decl} }`;
{
  const r = parseCustomThemeCss(imgCss(`--kasane-image-nav-home: url("${PNG}"); --kasane-accent: #123456`));
  check('data URI with ";base64" is not cut at the semicolon', r.theme?.images?.navHome === PNG && r.theme?.root.accent === '#123456' && r.warnings.length === 0, JSON.stringify(r.warnings));
  check('image counts as applied', r.applied === 2);
}
check('single quotes / no quotes / spaces / !important are all read', ['url(\'' + PNG + '\')', 'url(' + PNG + ')', 'url( "' + PNG + '" ) !important'].every((v) => parseCustomThemeCss(imgCss(`--kasane-image-logo-mark: ${v}`)).theme?.images?.logoMark === PNG));
check('a bare data: value (not valid CSS) is cut at its ";" and refused', parseCustomThemeCss(imgCss(`--kasane-image-logo-mark: ${PNG}`)).theme?.images === undefined);
check('jpeg is accepted for the background', parseCustomThemeCss(imgCss(`--kasane-image-background: url("${JPG}")`)).theme?.images?.background === JPG);
for (const bad of ['url(http://evil.example/a.png)', 'url("https://evil.example/a.png")', 'url(//evil.example/a.png)', 'url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")', 'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")', 'url("data:text/html;base64,PHNjcmlwdD4=")', 'url("data:image/png;base64,AAA!!!")', 'url("data:image/png;base64,AAA" ; background: red)', 'url("javascript:alert(1)")', 'url("blob:x")', 'url(file:///etc/passwd)', 'image-set(x)', '"x"']) {
  const r = parseCustomThemeCss(imgCss(`--kasane-image-logo-mark: ${bad}`));
  check(`bad image rejected: ${bad.slice(0, 34)}`, r.theme === null || r.theme.images === undefined, JSON.stringify(r.theme?.images));
}
{
  const long = 'data:image/png;base64,' + 'A'.repeat(70_000);
  check('an icon over its size limit is rejected', parseCustomThemeCss(imgCss(`--kasane-image-nav-home: url("${long}")`)).warnings.some((w) => w.code === 'bad_value'));
  check('the same size is fine for a logo', parseCustomThemeCss(imgCss(`--kasane-image-logo-mark: url("${long}")`)).theme?.images?.logoMark === long);
}
{
  const r = parseCustomThemeCss(imgCss(`--kasane-image-nav-home: none; --kasane-image-logo-mark: url("${PNG}")`));
  check('none clears an image', r.clearedImages.join() === 'navHome' && r.theme?.images?.navHome === undefined && r.theme?.images?.logoMark === PNG);
  check('writing none then an image keeps the image', parseCustomThemeCss(imgCss(`--kasane-image-hero: none; --kasane-image-hero: url("${PNG}")`)).clearedImages.length === 0);
}
check('images in a chain block are refused', parseCustomThemeCss(`:root[data-chain='nem'] { --kasane-image-hero: url("${PNG}"); --kasane-accent: #123456 }`).warnings.some((w) => w.code === 'image_root_only'));
check('an images-only file is a theme', parseCustomThemeCss(imgCss(`--kasane-image-hero: url("${PNG}")`)).theme?.images?.hero === PNG);
check('background-dim / hero-dim accept 0-1 and percent', (() => {
  const r = parseCustomThemeCss(':root { --kasane-background-dim: 0.5; --kasane-hero-dim: 40% }');
  return r.theme?.root.backgroundDim === 0.5 && r.theme?.root.heroDim === 0.4;
})());
check('background-dim over 1 is refused', parseCustomThemeCss(':root { --kasane-background-dim: 1.2 }').warnings.some((w) => w.code === 'bad_value'));

// 保存データ
{
  const s = sanitizeCustomTheme({ root: { accent: '#123456' }, images: { navHome: PNG, hero: 'url(http://evil/x.png)', logoMark: 'data:image/svg+xml;base64,AAAA', bogus: PNG, background: JPG } });
  check('saved images are checked again', s?.images?.navHome === PNG && s?.images?.background === JPG && s?.images?.hero === undefined && s?.images?.logoMark === undefined && !('bogus' in (s?.images ?? {})));
  check('an images-only saved theme survives', sanitizeCustomTheme({ images: { navHome: PNG } })?.images?.navHome === PNG);
  const big = 'data:image/png;base64,' + 'A'.repeat(299_000);
  const many = sanitizeCustomTheme({ images: { logoMark: big, logoWordmark: big, hero: big, background: big, navHome: PNG, navLinks: PNG } });
  const total = totalImageChars(many?.images);
  check('the total of saved images is capped', total <= MAX_TOTAL_IMAGE_CHARS && total > 0, String(total));
}

// v212 までの名前（navAbout / --kasane-image-nav-about）で保存してあったテーマ・CSS も、リンク集のアイコンとして読める
{
  const legacy = sanitizeCustomTheme({ images: { navAbout: PNG } });
  check('a theme saved with the old navAbout key still loads as navLinks', legacy?.images?.navLinks === PNG && !('navAbout' in (legacy?.images ?? {})));
  const css = parseCustomThemeCss(`:root { --kasane-image-nav-about: url("${PNG}") }`);
  check('old --kasane-image-nav-about CSS is read as the Links icon', css.theme.images?.navLinks === PNG && css.warnings.length === 0, JSON.stringify(css.warnings));
  const both = sanitizeCustomTheme({ images: { navLinks: JPG, navAbout: PNG } });
  check('the new key wins when both are present', both?.images?.navLinks === JPG);
  check('the template uses the new variable name only', !buildTemplateCss(createKasaneTheme('dark', 'symbol').kasane.look, 'x').includes('nav-about'));
}

// ひな形
{
  const look = createKasaneTheme('dark', 'symbol').kasane.look;
  const blank = buildTemplateCss(look, 'x');
  check('the template names every image slot (as comments)', IMAGE_SLOTS.every((slot) => blank.includes(slot.css)));
  check('the blank template sets no image', parseCustomThemeCss(blank).theme?.images === undefined);
  const withImages = buildTemplateCss(look, 'x', { navHome: PNG, hero: JPG });
  const back = parseCustomThemeCss(withImages);
  check('images survive a download and upload', back.theme?.images?.navHome === PNG && back.theme?.images?.hero === JPG && back.warnings.length === 0, JSON.stringify(back.warnings));
  check('the other variables still all read', back.applied === VAR_SPECS.length + 2);
}

// テーマへの反映
{
  const r = parseCustomThemeCss(imgCss(`--kasane-image-background: url("${JPG}"); --kasane-image-hero: url("${JPG}"); --kasane-image-nav-home: url("${PNG}"); --kasane-image-logo-mark: url("${PNG}"); --kasane-background-dim: 0.6; --kasane-hero-dim: 0.1`));
  const th = createKasaneTheme('custom', 'symbol', r.theme);
  check('the background image is in the page background', th.kasane.stageBg.includes(JPG) && th.kasane.stageBg.includes('0.6'));
  check('the balance card image is under the card text', th.kasane.hero.includes(JPG) && th.kasane.hero.includes('rgba(0,0,0,0.1)') && th.kasane.hero.includes('linear-gradient(135deg'));
  check('logo and icon images reach the tokens', th.kasane.images.navHome === PNG && th.kasane.images.logoMark === PNG);
  const plain = createKasaneTheme('dark', 'symbol', r.theme);
  check('images show only in the custom theme', Object.keys(plain.kasane.images).length === 0 && !plain.kasane.stageBg.includes('data:'));
  check('no custom image: the stage is the usual gradient', !createKasaneTheme('custom', 'symbol', parseCustomThemeCss(':root { --kasane-accent: #123456 }').theme).kasane.stageBg.includes('url('));
}

// 画像の大きさ
check('fitInside shrinks, keeping the ratio', JSON.stringify(fitInside(2000, 1000, 1000, 1000)) === '{"w":1000,"h":500}');
check('fitInside does not enlarge', JSON.stringify(fitInside(50, 40, 96, 96)) === '{"w":50,"h":40}');
check('fitInside keeps at least 1px', fitInside(10000, 1, 96, 96).h === 1);
check('fitsTotal counts a replacement, not both', fitsTotal({ hero: 'x'.repeat(MAX_TOTAL_IMAGE_CHARS) }, 'hero', 'y'.repeat(100)) && !fitsTotal({ hero: 'x'.repeat(MAX_TOTAL_IMAGE_CHARS) }, 'navHome', 'y'.repeat(100)));

// --- 10. 複数のテーマ・書き出し ------------------------------------------------------------------------------------
{
  const mk = (n: number, extra: object = {}) => ({ name: `t${n}`, root: { accent: '#123456' }, chains: {}, ...extra });
  const many = sanitizeSavedThemes(Array.from({ length: 14 }, (_, i) => mk(i)));
  check('at most 10 themes are kept', many.length === MAX_CUSTOM_THEMES && MAX_CUSTOM_THEMES === 10);
  check('every theme gets an id, all different', many.every((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t.id)) && new Set(many.map((t) => t.id)).size === many.length);
  const dup = sanitizeSavedThemes([{ ...mk(1), id: 'same' }, { ...mk(2), id: 'same' }, { ...mk(3), id: 'bad id!' }]);
  check('duplicate / invalid ids are replaced', dup.length === 3 && dup[0].id === 'same' && dup[1].id !== 'same' && dup[2].id !== 'bad id!' && new Set(dup.map((t) => t.id)).size === 3);
  check('broken entries are dropped', sanitizeSavedThemes([null, 'x', { root: { bg: 'url(x)' } }, mk(1)]).length === 1 && sanitizeSavedThemes('x').length === 0 && sanitizeSavedThemes(undefined).length === 0);
  const big = 'data:image/png;base64,' + 'A'.repeat(299_000);
  const heavy = (n: number) => mk(n, { images: { logoMark: big, logoWordmark: big, hero: big, background: 'data:image/jpeg;base64,' + 'A'.repeat(600_000), navHome: PNG } });
  const capped = sanitizeSavedThemes([heavy(1), heavy(2), heavy(3), heavy(4)]);
  const sum = capped.reduce((a, t) => a + imageCharsOf(t), 0);
  check('the images of all themes together are capped', sum <= MAX_ALL_IMAGE_CHARS && capped.length === 4 && capped.some((t) => t.images === undefined) && capped[0].images !== undefined, `${sum} ${capped.map((t) => imageCharsOf(t))}`);
  check('a theme that loses its images keeps its colours', capped.filter((t) => t.images === undefined).every((t) => t.root.accent === '#123456'));
}
{
  // 保存したテーマの書き出し：設定した値だけ。読み込み直すと同じ
  const src = parseCustomThemeCss(`:root { --kasane-mode: light; --kasane-accent: #123456; --kasane-radius: 12px; --kasane-image-nav-home: url("${PNG}") }
    :root[data-chain='nem'] { --kasane-accent: #00ff00; --kasane-bg: #101010 }`, 'mine').theme!;
  const css = buildThemeCss(src, 'mine');
  const back = parseCustomThemeCss(css, 'mine');
  check('a saved theme is exported without warnings', back.warnings.length === 0, JSON.stringify(back.warnings));
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  check('exported and read again: the same theme', canon(back.theme) === canon(src), canon(back.theme).slice(0, 300));
  check('only the values that were set are written', !css.includes('--kasane-glow') && !css.includes('--kasane-font') && css.includes('--kasane-radius: 12px'));
  check('chain overrides are written as their own blocks', /:root\[data-chain='nem'\]\s*\{[^}]*--kasane-accent: #00ff00/.test(css) && !/:root\[data-chain='symbol'\]\s*\{/.test(css));
  check('an unset value is not frozen to one chain\'s default', resolveCustomValues(back.theme!, 'mijin').bg === undefined);
}
{
  const dark = createKasaneTheme('dark', 'symbol').kasane.look;
  const tpl = buildTemplateCss(dark, 'x');
  check('the template (dark) has no chain block and writes every variable', !/:root\[data-chain='\w+'\]\s*\{/.test(tpl.replace(/\/\*[\s\S]*?\*\//g, '')) && VAR_SPECS.every((s) => tpl.includes(s.css + ':')));
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
