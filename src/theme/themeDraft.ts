// カスタムテーマの「編集中のテーマ」（まだ保存していないもの）。
// 色・フォント・角の丸み・画像は、ひとつの編集中のテーマにまとまっていて、保存のときに「1つのテーマ」になる。
//   ・かんたん（CSS の知識がいらない）: 色の選択・丸みのスライダー・画像の選択で、編集中のテーマを変える
//   ・CSS（上級）: 編集中のテーマを CSS にして書き出し → エディタで磨く → アップロードで編集中のテーマに戻す
// どちらで作っても同じテーマなので、行き来できる。

import type { CustomImages, CustomThemeData, CustomValues, ImageKey, LookValues, ThemeParseResult } from './customTheme';

export interface EditorTheme {
  id: string | null; // 保存してあるテーマを編集しているときの id。新しいテーマは null
  name: string;
  root: CustomValues;
  chains: CustomThemeData['chains'];
  images: CustomImages;
}

export const emptyEditor = (): EditorTheme => ({ id: null, name: '', root: {}, chains: {}, images: {} });

export const editorFromSaved = (theme: CustomThemeData & { id: string }): EditorTheme => ({
  id: theme.id,
  name: theme.name,
  root: { ...theme.root },
  chains: Object.fromEntries(Object.entries(theme.chains).map(([k, v]) => [k, { ...v }])) as CustomThemeData['chains'],
  images: { ...(theme.images ?? {}) },
});

/** 保存する形にする（名前が空なら fallbackName）。 */
export function editorToTheme(ed: EditorTheme, fallbackName: string): CustomThemeData {
  const theme: CustomThemeData = { name: ed.name.trim().slice(0, 40) || fallbackName, root: ed.root, chains: ed.chains };
  if (Object.keys(ed.images).length > 0) theme.images = ed.images;
  return theme;
}

/** 保存する内容があるか（色・チェーンごとの上書き・画像のどれか）。 */
export function editorHasContent(ed: EditorTheme): boolean {
  return Object.keys(ed.root).length > 0 || Object.values(ed.chains).some((v) => v && Object.keys(v).length > 0) || Object.keys(ed.images).length > 0;
}

/**
 * アップロードした CSS を、編集中のテーマに入れる。色・フォント・角の丸み（チェーンごとの上書きも）は CSS の内容に置き換わる
 * （CSS から消した項目は、標準の色に戻る）。画像は、CSS に書いてあるものだけを入れ替え、none と書いたものは外す。
 */
export function applyCssToEditor(ed: EditorTheme, parsed: ThemeParseResult): EditorTheme {
  if (!parsed.theme) return ed;
  const images: CustomImages = { ...ed.images, ...(parsed.theme.images ?? {}) };
  for (const key of parsed.clearedImages) delete images[key];
  return { ...ed, name: ed.name.trim() !== '' ? ed.name : parsed.theme.name, root: parsed.theme.root, chains: parsed.theme.chains, images };
}

export function setImage(ed: EditorTheme, key: ImageKey, uri: string | null): EditorTheme {
  const images = { ...ed.images };
  if (uri === null) delete images[key];
  else images[key] = uri;
  return { ...ed, images };
}

export function setValues(ed: EditorTheme, values: CustomValues, clear: (keyof LookValues)[] = []): EditorTheme {
  const root: CustomValues = { ...ed.root, ...values };
  for (const key of clear) delete root[key];
  return { ...ed, root };
}

// ---------------------------------------------------------------------------------------------
// かんたん：色の選択
// ---------------------------------------------------------------------------------------------

/** 色の選択の1行。keys は、その行が決める値（先頭の値を見せ、選んだ色を全部に入れる）。on は、その上に載る文字の色の値（自動で白か黒）。 */
export interface ColorItem {
  id: string;
  keys: (keyof LookValues)[];
  on?: keyof LookValues;
}

export const COLOR_ITEMS: ColorItem[] = [
  { id: 'bg', keys: ['bg'] },
  { id: 'glow', keys: ['glow'] },
  { id: 'paper', keys: ['paper'] },
  { id: 'text', keys: ['text'] },
  { id: 'textSoft', keys: ['textSoft'] },
  { id: 'accent', keys: ['accent'] },
  { id: 'primary', keys: ['primary'] },
  { id: 'button', keys: ['gradientStart', 'gradientMid', 'gradientEnd'], on: 'onGradient' },
  { id: 'hero', keys: ['heroStart', 'heroMid', 'heroEnd'], on: 'heroText' },
  { id: 'menu', keys: ['menuTop', 'menuBottom'], on: 'menuText' },
];

/** `#rrggbb`（色の選択が使える形）にする。#rgb・#rrggbbaa・rgb()/rgba() を読む。読めなければ '#000000'。 */
export function hexOf(color: string | number | undefined): string {
  const v = String(color ?? '').trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return `#${h.slice(0, 6)}`;
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}

/** この色の上に載せる文字・アイコンの色（明るい色なら黒っぽく、暗い色なら白）。 */
export function contrastOn(color: string): string {
  const h = hexOf(color);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#101010' : '#ffffff';
}

/** 色の選択で選んだ色を、その行の値すべてに入れる（on があれば、読みやすい文字の色も自動で入れる）。 */
export function setColor(ed: EditorTheme, item: ColorItem, color: string): EditorTheme {
  const hex = hexOf(color);
  const values: CustomValues = {};
  for (const key of item.keys) (values as Record<string, string>)[key] = hex;
  if (item.on) (values as Record<string, string>)[item.on] = contrastOn(hex);
  return setValues(ed, values);
}

/** その行を標準の色に戻す。 */
export function resetColor(ed: EditorTheme, item: ColorItem): EditorTheme {
  return setValues(ed, {}, item.on ? [...item.keys, item.on] : item.keys);
}

/** その行の値を、いまの色で見せる（設定してあればそれ、なければ標準の色）。 */
export function colorOfItem(ed: EditorTheme, item: ColorItem, defaults: LookValues): string {
  return hexOf(ed.root[item.keys[0]] ?? defaults[item.keys[0]]);
}

export const isItemSet = (ed: EditorTheme, item: ColorItem): boolean => item.keys.some((k) => ed.root[k] !== undefined);
