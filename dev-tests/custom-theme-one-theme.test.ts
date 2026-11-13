// カスタムテーマは、色・フォント・丸み・画像を「1つのテーマ」として保存する（components/CustomThemeDialog.tsx）。
// 編集中のテーマ（theme/themeDraft.ts）：かんたん（色の選択・画像）と CSS（上級）が同じテーマを編集すること、
// 保存・書き出し・読み込みで色と画像が1つのまま残ることを調べる。
// 実行: npx tsx dev-tests/custom-theme-one-theme.test.ts（通信なし）
import { buildTemplateCss, buildThemeCss, parseCustomThemeCss, sanitizeSavedThemes } from '../src/theme/customTheme';
import type { LookValues } from '../src/theme/customTheme';
import {
  COLOR_ITEMS, applyCssToEditor, colorOfItem, contrastOn, editorFromSaved, editorHasContent, editorToTheme, emptyEditor, hexOf, isItemSet, resetColor, setColor, setImage, setValues,
} from '../src/theme/themeDraft';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const item = (id: string) => COLOR_ITEMS.find((c) => c.id === id)!;

// 色の変換
check('hexOf: #rgb', hexOf('#f80') === '#ff8800');
check('hexOf: #rrggbbaa は色だけ', hexOf('#11223380') === '#112233');
check('hexOf: rgba()', hexOf('rgba(255, 136, 0, 0.5)') === '#ff8800');
check('hexOf: 読めなければ黒', hexOf('nonsense') === '#000000');
check('contrastOn: 明るい色には黒っぽい文字', contrastOn('#ffffff') === '#101010');
check('contrastOn: 暗い色には白い文字', contrastOn('#101010') === '#ffffff');

// 1. かんたん：色を選ぶ（ボタンは3つの値と、読みやすい文字の色が入る）
let ed = emptyEditor();
check('空のテーマは保存する内容なし', !editorHasContent(ed));
ed = setColor(ed, item('accent'), '#ff8800');
ed = setColor(ed, item('button'), '#ffee00');
check('アクセントが入る', ed.root.accent === '#ff8800');
check('ボタンは3つの値に入る', ed.root.gradientStart === '#ffee00' && ed.root.gradientMid === '#ffee00' && ed.root.gradientEnd === '#ffee00');
check('ボタンの上の文字は自動で黒っぽい', ed.root.onGradient === '#101010');
const defaults = { accent: '#123456', gradientStart: '#654321' } as unknown as LookValues;
check('設定してある色が見える', colorOfItem(ed, item('accent'), defaults) === '#ff8800');
check('設定がなければ標準の色が見える', colorOfItem(emptyEditor(), item('accent'), defaults) === '#123456');
check('設定してある行が分かる', isItemSet(ed, item('button')) && !isItemSet(ed, item('hero')));
const reset = resetColor(ed, item('button'));
check('標準に戻すと3つの値と文字の色が外れる', reset.root.gradientStart === undefined && reset.root.onGradient === undefined && reset.root.accent === '#ff8800');

// 2. かんたん：画像・丸み
ed = setImage(ed, 'logoMark', PNG);
ed = setValues(ed, { radius: 20, mode: 'light' });
check('画像と丸みが同じテーマに入る', ed.images.logoMark === PNG && ed.root.radius === 20 && ed.root.mode === 'light');
check('画像を外せる', setImage(ed, 'logoMark', null).images.logoMark === undefined);
check('画像だけでも保存する内容あり', editorHasContent(setImage(emptyEditor(), 'hero', PNG)));

// 3. 保存 → 読み戻しても1つのテーマ（色も画像も）
const saved = sanitizeSavedThemes([{ ...editorToTheme({ ...ed, name: 'マイテーマ' }, 'x'), id: 'a1' }]);
check('保存データを読み戻しても1つで、色も画像もある', saved.length === 1 && saved[0].name === 'マイテーマ' && saved[0].root.accent === '#ff8800' && saved[0].images?.logoMark === PNG);
check('名前が空なら代わりの名前', editorToTheme({ ...ed, name: '  ' }, 'カスタム 2').name === 'カスタム 2');

// 4. CSS（上級）：書き出し → 編集 → アップロードで、同じテーマに戻る
const look = { mode: 'light', bg: '#ffffff', accent: '#ff8800', radius: 20 } as unknown as LookValues;
const cssOut = buildTemplateCss({ ...look, ...ed.root }, 'マイテーマ', ed.images, ed.chains);
let polished = cssOut.replace('--kasane-accent: #ff8800;', '--kasane-accent: #00aa88;');
polished = polished.replace('}\n', `  --kasane-image-hero: url("${PNG2}");\n}\n`);
const parsed = parseCustomThemeCss(polished, 'polished');
const back = applyCssToEditor(editorFromSaved(saved[0]), parsed);
check('CSS で磨いた色が反映される', back.root.accent === '#00aa88');
check('CSS で足した画像が入り、もとの画像も残る', back.images.hero === PNG2 && back.images.logoMark === PNG);
check('名前は編集中のものを残す', back.name === 'マイテーマ' && back.id === 'a1');
const cleared = applyCssToEditor(back, parseCustomThemeCss(':root { --kasane-accent: #00aa88; --kasane-image-logo-mark: none; }', 'c'));
check('none の画像は外れる', cleared.images.logoMark === undefined && cleared.images.hero === PNG2);
check('CSS から消した色は標準に戻る', cleared.root.radius === undefined && cleared.root.accent === '#00aa88');
check('読めない CSS は編集中のテーマを変えない', applyCssToEditor(back, parseCustomThemeCss('body { color: red }', 'n')) === back);

// 5. 保存してあるテーマの CSS ダウンロード→アップロードも、色と画像が1つのまま
const again = parseCustomThemeCss(buildThemeCss(saved[0], 'マイテーマ'), 'again');
check('保存したテーマの CSS に色と画像が入る', again.theme?.root.accent === '#ff8800' && again.theme?.images?.logoMark === PNG);

// 6. 空は保存されない
check('空のテーマは保存データに残らない', sanitizeSavedThemes([{ ...editorToTheme(emptyEditor(), 'x'), id: 'c1' }]).length === 0);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
