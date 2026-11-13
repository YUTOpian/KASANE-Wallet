// カスタムテーマのタブ設定（ブラウザのタブのロゴ・表示名）。
// ・--kasane-tab-title が読める／危ない文字は入らない／:root 以外は不可
// ・保存データの再検証・CSS の書き出しと読み込み（往復）・バックアップ・編集中のテーマ
// ・タブのロゴ（--kasane-image-tab-icon）の枠
// ・タブへの反映（標準に戻る）
// 実行: npx tsx dev-tests/custom-theme-tab.test.ts（通信なし）
import { IMAGE_SLOTS, MAX_TAB_TITLE_LENGTH, MAX_TOTAL_IMAGE_CHARS, buildThemeCss, normalizeTabTitle, parseCustomThemeCss, sanitizeCustomTheme, sanitizeSavedThemes } from '../src/theme/customTheme';
import { applyTabIdentity } from '../src/theme/tabIdentity';
import { applyCssToEditor, editorFromSaved, editorHasContent, editorToTheme, emptyEditor, setTabTitle } from '../src/theme/themeDraft';
import { buildThemeBackup, parseThemeBackup } from '../src/theme/themeBackup';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// --- 1. 表示名の検証 ----------------------------------------------------------------------------
check('plain title', normalizeTabTitle('My Wallet') === 'My Wallet');
check('japanese title', normalizeTabTitle('かさねウォレット') === 'かさねウォレット');
check('spaces collapsed and trimmed', normalizeTabTitle('  A   B  ') === 'A B');
check('apostrophe is fine', normalizeTabTitle("Ryo's Wallet") === "Ryo's Wallet");
check('empty rejected', normalizeTabTitle('   ') === null);
check('40 chars ok', normalizeTabTitle('a'.repeat(MAX_TAB_TITLE_LENGTH)) !== null);
check('41 chars rejected', normalizeTabTitle('a'.repeat(MAX_TAB_TITLE_LENGTH + 1)) === null);
check('40 emoji (code points) ok', normalizeTabTitle('😀'.repeat(MAX_TAB_TITLE_LENGTH)) !== null);
for (const bad of ['a"b', 'a\\b', 'a;b', 'a{b', 'a}b', 'a<b', 'a>b', 'a/*b', 'a*/b', 'a‮b', 'a​b', 'a\u0000b', '<script>']) {
  check(`rejected: ${JSON.stringify(bad)}`, normalizeTabTitle(bad) === null);
}
check('fromCss strips double quotes', normalizeTabTitle('"My Wallet"', true) === 'My Wallet');
check('fromCss strips single quotes', normalizeTabTitle("'My Wallet' !important", true) === 'My Wallet');
check('not from css: quotes are kept', normalizeTabTitle("'Hi'") === "'Hi'");
check('stored title survives re-validation', normalizeTabTitle(normalizeTabTitle("'Hi'")!) === "'Hi'");

// --- 2. CSS の読み込み ----------------------------------------------------------------------------
const ok = parseCustomThemeCss(`:root { --kasane-tab-title: "Ryo Wallet"; }`);
check('title alone is a theme', ok.theme?.tabTitle === 'Ryo Wallet' && ok.applied === 1 && ok.warnings.length === 0);
check('bare value works', parseCustomThemeCss(`:root { --kasane-tab-title: My Wallet; }`).theme?.tabTitle === 'My Wallet');
const nonRoot = parseCustomThemeCss(`:root { --kasane-bg: #101010; } :root[data-chain='nem'] { --kasane-tab-title: "X"; }`);
check('chain block: warning, not applied', nonRoot.theme?.tabTitle === undefined && nonRoot.warnings.some((w) => w.code === 'tab_title_root_only'));
const badTitle = parseCustomThemeCss(`:root { --kasane-bg: #101010; --kasane-tab-title: "a<b"; }`);
check('bad title: warning, rest applied', badTitle.theme?.tabTitle === undefined && badTitle.warnings.some((w) => w.code === 'bad_value') && badTitle.theme?.root.bg === '#101010');
const semi = parseCustomThemeCss(`:root { --kasane-tab-title: "a;b"; --kasane-bg: #101010; }`);
check('semicolon inside quotes does not break the next declaration', semi.theme?.root.bg === '#101010' && semi.theme?.tabTitle === undefined);
check('no tab title -> undefined', parseCustomThemeCss(`:root { --kasane-bg: #101010; }`).theme?.tabTitle === undefined);

// --- 3. 往復（書き出し → 読み込み） -----------------------------------------------------------------
const theme = { name: 'T', root: { bg: '#101010' as const }, chains: {}, tabTitle: "Ryo's Wallet", images: { tabIcon: PNG } };
const css = buildThemeCss(theme, 'T');
const back = parseCustomThemeCss(css, 'T');
check('round trip: title', back.theme?.tabTitle === "Ryo's Wallet");
check('round trip: tab icon', back.theme?.images?.tabIcon === PNG);
check('template mentions the variable when unset', buildThemeCss({ name: 'x', root: { bg: '#101010' }, chains: {} }, 'x').includes('--kasane-tab-title'));
check('unset title is not written as a value', parseCustomThemeCss(buildThemeCss({ name: 'x', root: { bg: '#101010' }, chains: {} }, 'x')).theme?.tabTitle === undefined);
const hostile = buildThemeCss({ name: 'x', root: { bg: '#101010' }, chains: {}, tabTitle: 'a"}; :root{--kasane-bg:red' }, 'x');
check('hostile title never reaches the CSS', !hostile.includes('--kasane-bg:red'));

// --- 4. タブのロゴの枠 ------------------------------------------------------------------------------
const slot = IMAGE_SLOTS.find((s) => s.key === 'tabIcon');
check('tabIcon slot exists', !!slot && slot.css === '--kasane-image-tab-icon' && slot.kind === 'tab' && slot.maxW <= 128);
check('tabIcon image is read from css', parseCustomThemeCss(`:root { --kasane-image-tab-icon: url("${PNG}"); }`).theme?.images?.tabIcon === PNG);
check('tabIcon: none clears', parseCustomThemeCss(`:root { --kasane-image-tab-icon: none; --kasane-bg:#101010; }`).clearedImages.includes('tabIcon'));
check('http image rejected', parseCustomThemeCss(`:root { --kasane-image-tab-icon: url("https://evil.example/x.png"); }`).theme === null);
check('slots fit in the per-theme limit', IMAGE_SLOTS.reduce((n, s) => n + s.maxChars, 0) <= MAX_TOTAL_IMAGE_CHARS);

// --- 5. 保存データ・バックアップ ----------------------------------------------------------------
check('sanitize keeps the title', sanitizeCustomTheme({ name: 'a', root: {}, chains: {}, tabTitle: 'Hello' })?.tabTitle === 'Hello');
check('sanitize: title only is a theme', sanitizeCustomTheme({ name: 'a', root: {}, chains: {}, tabTitle: 'Hello' }) !== null);
check('sanitize drops a bad title', sanitizeCustomTheme({ name: 'a', root: { bg: '#101010' }, chains: {}, tabTitle: 'a<b' })?.tabTitle === undefined);
check('sanitize drops a non-string title', sanitizeCustomTheme({ name: 'a', root: { bg: '#101010' }, chains: {}, tabTitle: 5 })?.tabTitle === undefined);
const saved = sanitizeSavedThemes([{ ...theme, id: 'abc' }, { name: 'idb', root: {}, chains: {}, imagesInIdb: true, tabTitle: 'Kept' }]);
check('saved themes keep the title (also when images live in IndexedDB)', saved[0]?.tabTitle === "Ryo's Wallet" && saved[1]?.tabTitle === 'Kept');
const parsedBackup = parseThemeBackup(buildThemeBackup([{ ...theme, id: 'abc' }]));
check('backup round trip', parsedBackup.ok && parsedBackup.themes[0].tabTitle === "Ryo's Wallet" && parsedBackup.themes[0].images?.tabIcon === PNG);

// --- 6. 編集中のテーマ ----------------------------------------------------------------------------
check('empty editor has no content', !editorHasContent(emptyEditor()));
check('title makes content', editorHasContent(setTabTitle(emptyEditor(), 'Hi')));
check('invalid title alone is not content', !editorHasContent(setTabTitle(emptyEditor(), 'a<b')));
check('editorToTheme saves a valid title', editorToTheme(setTabTitle(emptyEditor(), '  Hi  '), 'x').tabTitle === 'Hi');
check('editorToTheme drops an invalid title', editorToTheme({ ...setTabTitle(emptyEditor(), 'a<b'), root: { bg: '#101010' } }, 'x').tabTitle === undefined);
check('editorFromSaved loads the title', editorFromSaved({ ...theme, id: 'abc' }).tabTitle === "Ryo's Wallet");
check('editorFromSaved: no title -> empty string', editorFromSaved({ name: 'a', root: { bg: '#101010' }, chains: {}, id: 'abc' }).tabTitle === '');
const withCss = applyCssToEditor(setTabTitle(emptyEditor(), 'Old'), parseCustomThemeCss(`:root { --kasane-tab-title: "New"; }`));
check('uploading css replaces the title', withCss.tabTitle === 'New');
const cleared = applyCssToEditor(setTabTitle(emptyEditor(), 'Old'), parseCustomThemeCss(`:root { --kasane-bg: #101010; }`));
check('css without a title resets it', cleared.tabTitle === '');

// --- 7. タブへの反映（document の代わりの小さな模型） -----------------------------------------------
{
  const attrs: Record<string, string> = { href: 'data:image/png;base64,DEFAULT' };
  const link = { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
  const doc = { title: 'KASANE Wallet', querySelector: () => link, createElement: () => link, head: { appendChild: () => {} } };
  (globalThis as unknown as { document: unknown }).document = doc;
  applyTabIdentity({ tabTitle: 'Mine', images: { tabIcon: PNG } });
  check('applies the custom title and icon', doc.title === 'Mine' && attrs.href === PNG);
  applyTabIdentity({ tabTitle: 'Other' });
  check('icon falls back to the default when the theme has none', doc.title === 'Other' && attrs.href === 'data:image/png;base64,DEFAULT');
  applyTabIdentity(null);
  check('no custom theme: back to the standard title and icon', doc.title === 'KASANE Wallet' && attrs.href === 'data:image/png;base64,DEFAULT');
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
