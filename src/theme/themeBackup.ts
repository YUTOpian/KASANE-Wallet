import { MAX_ALL_IMAGE_CHARS, MAX_CUSTOM_THEMES, buildThemeCss, imageCharsOf, parseCustomThemeCss, sanitizeCustomTheme } from './customTheme';
import type { CustomThemeData, SavedCustomTheme } from './customTheme';

// カスタムテーマのバックアップ（機種変更などで、別の端末へ移すためのファイル）。
// テーマごとに、名前と CSS（色・フォント・チェーンごとの上書き・画像を含む。「CSSをダウンロード」と同じ中身）が入る。
// 読み込むときは、CSS をアップロードしたときと同じ検証をする。v1（CSS ではなく値そのものを書いたもの）も読める。

export const THEME_BACKUP_APP = 'kasane-wallet';
export const THEME_BACKUP_KIND = 'custom-themes';
export const THEME_BACKUP_VERSION = 2;
/** 読み込むファイルの大きさの上限（画像の上限 MAX_ALL_IMAGE_CHARS に、色などの分と余裕を足したもの）。 */
export const MAX_THEME_BACKUP_BYTES = 32 * 1024 * 1024;

/** 保存してあるテーマを、バックアップ用の JSON 文字列にする（id は入れない: 読み込むときに付け直す）。 */
export function buildThemeBackup(themes: SavedCustomTheme[]): string {
  const list = themes.map((theme) => {
    const { id: _id, ...data } = theme;
    void _id;
    // CSS の先頭のコメントに名前を書くので、コメントを閉じてしまう文字列だけは避ける。
    return { name: data.name, css: buildThemeCss(data, data.name.replace(/\*\//g, '* /')) };
  });
  return JSON.stringify({ app: THEME_BACKUP_APP, kind: THEME_BACKUP_KIND, version: THEME_BACKUP_VERSION, exportedAt: new Date().toISOString(), themes: list }, null, 2);
}

export type ThemeBackupParse =
  | { ok: true; themes: CustomThemeData[]; invalid: number }
  | { ok: false; reason: 'too_large' | 'not_json' | 'not_backup' | 'empty' };

/** バックアップのファイルを読む。1つずつ検証し直す（壊れた値・想定外の値・合わない画像は捨てる）。CSS はアップロードと同じ読み方。 */
export function parseThemeBackup(text: string): ThemeBackupParse {
  if (text.length > MAX_THEME_BACKUP_BYTES) return { ok: false, reason: 'too_large' };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { ok: false, reason: 'not_json' }; }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not_backup' };
  const o = raw as Record<string, unknown>;
  if (o.kind !== THEME_BACKUP_KIND || !Array.isArray(o.themes)) return { ok: false, reason: 'not_backup' };
  const themes: CustomThemeData[] = [];
  let invalid = 0;
  for (const item of o.themes) {
    // v2: CSS の文章（名前つき）。v1: 値そのもの。どちらも 1つずつ検証し直す。
    const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
    const clean = entry && typeof entry.css === 'string'
      ? parseCustomThemeCss(entry.css, typeof entry.name === 'string' ? entry.name : '').theme
      : sanitizeCustomTheme(item);
    if (clean) themes.push(clean); else invalid += 1;
  }
  if (themes.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, themes, invalid };
}

/**
 * 読み込んだテーマを、いま保存してあるものに足せる分だけ選ぶ（10個まで・画像の合計の上限まで）。
 * 入らなかった分は skipped に数える。画像が入らないだけのテーマは、画像を外さずに skipped にする（半端な見た目にしないため）。
 */
export function planThemeImport(current: SavedCustomTheme[], incoming: CustomThemeData[]): { add: CustomThemeData[]; skipped: number } {
  let count = current.length;
  let chars = current.reduce((sum, th) => sum + imageCharsOf(th), 0);
  const add: CustomThemeData[] = [];
  let skipped = 0;
  for (const theme of incoming) {
    const size = imageCharsOf(theme);
    if (count >= MAX_CUSTOM_THEMES || chars + size > MAX_ALL_IMAGE_CHARS) { skipped += 1; continue; }
    add.push(theme);
    count += 1;
    chars += size;
  }
  return { add, skipped };
}
