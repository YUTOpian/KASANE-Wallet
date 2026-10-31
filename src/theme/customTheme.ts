// カスタムテーマ：ひな形の CSS をダウンロード → 編集 → アップロードで、好きな見た目にする。
//
// 安全のため、アップロードした CSS を「そのまま」ページに入れることはしない。読み込むのは、下の VAR_SPECS に
// ある `--kasane-*` という変数だけ（色・角の丸み・フォント）。値は1つずつ検証して、決まった形に直してから保存する。
// セレクタ・@import・url(...)・ほかのプロパティなどは読み飛ばし、読み飛ばしたことを画面に出す。
// 画像（ロゴ・サイドバーのアイコン・背景・残高カード）だけは、url("data:image/png;base64,...") の形（png / jpeg / webp）を、
// `--kasane-image-*` の変数で受け付ける。外のサイトの画像（http:）や、SVG は受け付けない。画面側で、読み込んだ画像を
// canvas で描き直して（imageProcessing.ts）から保存するので、元のファイルの中身はそのまま使われない。
// （ウォレットの画面は、見た目を変えるだけの CSS でも、ボタンの位置や文字を入れ替えれば、利用者を騙すのに使えてしまうため。）
//
// 書き方：
//   :root { --kasane-bg: #101010; ... }                       … すべてのチェーンの画面
//   :root[data-chain='nem'] { --kasane-accent: #7ED1C0; }      … NEM の画面だけ上書き（symbol / nem / mijin / base）
// base は、スタート画面・プロファイル選択など、チェーンに属さない画面。

export type CustomMode = 'dark' | 'light';

/** カスタムテーマで変えられる値（ひな形の `--kasane-xxx` と1対1）。 */
export interface LookValues {
  mode: CustomMode; // ベースの明るさ。MUI の標準の色（入力欄・文字・影など）がこれで決まる
  bg: string;
  glow: string;
  paper: string;
  text: string;
  textSoft: string;
  accent: string;
  primary: string;
  wordmark: string;
  gradientStart: string;
  gradientMid: string;
  gradientEnd: string;
  onGradient: string;
  heroStart: string;
  heroMid: string;
  heroEnd: string;
  heroText: string;
  menuTop: string;
  menuBottom: string;
  menuText: string;
  line: string;
  error: string;
  success: string;
  warning: string;
  info: string;
  radius: number;
  buttonRadius: number;
  font: string;
  backgroundDim: number; // 0-1: how much the background colour covers a background image
  heroDim: number; // 0-1: how dark the overlay on a balance card image is
}

export type CustomValues = Partial<LookValues>;

export const CUSTOM_CHAIN_KEYS = ['symbol', 'nem', 'mijin', 'base'] as const;
export type CustomChainKey = (typeof CUSTOM_CHAIN_KEYS)[number];

/** 保存する形。root はすべてのチェーン、chains はチェーンごとの上書き。値は検証・正規化済み。 */
export interface CustomThemeData {
  name: string;
  root: CustomValues;
  chains: Partial<Record<CustomChainKey, CustomValues>>;
  images?: CustomImages; // 画像は、すべてのチェーンで共通
}

/** 保存してあるカスタムテーマ。id は、保存してあるものの中で決まる（選ぶ・消す・置き換えるときの目印）。 */
export interface SavedCustomTheme extends CustomThemeData {
  id: string;
}

/** 保存できるカスタムテーマの数。 */
export const MAX_CUSTOM_THEMES = 10;

export type ImageKey =
  | 'logoMark' | 'logoWordmark' | 'background' | 'hero'
  | 'navHome' | 'navAccount' | 'navAddressbook' | 'navMosaic' | 'navNamespace' | 'navMetadata' | 'navMultisig' | 'navHarvest' | 'navAggregate' | 'navService' | 'navLinks' | 'navSettings';
/** 画像は data:image/(png|jpeg|webp);base64,... の文字列。 */
export type CustomImages = Partial<Record<ImageKey, string>>;

type VarType = 'mode' | 'color' | 'px' | 'font' | 'ratio';

interface VarSpec {
  key: keyof LookValues;
  css: string;
  type: VarType;
  max?: number; // px の上限
  ja: string;
  en: string;
}

export const VAR_SPECS: VarSpec[] = [
  { key: 'mode', css: '--kasane-mode', type: 'mode', ja: 'ベースの明るさ。dark か light（文字・入力欄・影などの標準の色が切り替わります）', en: 'Base brightness: dark or light (switches the standard colours of text, fields and shadows)' },
  { key: 'bg', css: '--kasane-bg', type: 'color', ja: 'ページの背景色', en: 'Page background colour' },
  { key: 'glow', css: '--kasane-glow', type: 'color', ja: '背景の中央の明るい部分の色（背景色へなだらかに変わります）', en: 'Colour of the bright centre of the background (fades into the background colour)' },
  { key: 'paper', css: '--kasane-paper', type: 'color', ja: 'カード・ダイアログの背景色', en: 'Background of cards and dialogs' },
  { key: 'text', css: '--kasane-text', type: 'color', ja: '文字の色', en: 'Text colour' },
  { key: 'textSoft', css: '--kasane-text-soft', type: 'color', ja: '補助の文字の色（説明文など）', en: 'Secondary text colour (captions)' },
  { key: 'accent', css: '--kasane-accent', type: 'color', ja: 'アクセント色（選択中の枠・影・アイコンの背景など）', en: 'Accent colour (selected borders, glows, icon backgrounds)' },
  { key: 'primary', css: '--kasane-primary', type: 'color', ja: 'リンク・アイコン・文字ボタン・外枠ボタンの色', en: 'Colour of links, icons, text buttons and outlined buttons' },
  { key: 'wordmark', css: '--kasane-wordmark', type: 'color', ja: 'タイトルの細い文字・ロゴの文字の色', en: 'Colour of the thin titles and the wordmark' },
  { key: 'gradientStart', css: '--kasane-gradient-start', type: 'color', ja: 'ボタン・タブ・ピルのグラデーション（左端）', en: 'Button / tab / pill gradient (left end)' },
  { key: 'gradientMid', css: '--kasane-gradient-mid', type: 'color', ja: 'ボタン・タブ・ピルのグラデーション（中央）', en: 'Button / tab / pill gradient (middle)' },
  { key: 'gradientEnd', css: '--kasane-gradient-end', type: 'color', ja: 'ボタン・タブ・ピルのグラデーション（右端）', en: 'Button / tab / pill gradient (right end)' },
  { key: 'onGradient', css: '--kasane-on-gradient', type: 'color', ja: 'グラデーションの上の文字・アイコンの色', en: 'Colour of text and icons on top of the gradient' },
  { key: 'heroStart', css: '--kasane-hero-start', type: 'color', ja: '残高カードのグラデーション（左上）', en: 'Balance card gradient (top left)' },
  { key: 'heroMid', css: '--kasane-hero-mid', type: 'color', ja: '残高カードのグラデーション（中央）', en: 'Balance card gradient (middle)' },
  { key: 'heroEnd', css: '--kasane-hero-end', type: 'color', ja: '残高カードのグラデーション（右下）', en: 'Balance card gradient (bottom right)' },
  { key: 'heroText', css: '--kasane-hero-text', type: 'color', ja: '残高カードの文字の色', en: 'Text colour on the balance card' },
  { key: 'menuTop', css: '--kasane-menu-top', type: 'color', ja: 'サイドメニューの背景（上）', en: 'Side menu background (top)' },
  { key: 'menuBottom', css: '--kasane-menu-bottom', type: 'color', ja: 'サイドメニューの背景（下）', en: 'Side menu background (bottom)' },
  { key: 'menuText', css: '--kasane-menu-text', type: 'color', ja: 'サイドメニューの文字・アイコンの色', en: 'Text and icon colour of the side menu' },
  { key: 'line', css: '--kasane-line', type: 'color', ja: '枠線・区切り線の色', en: 'Colour of borders and dividers' },
  { key: 'error', css: '--kasane-error', type: 'color', ja: 'エラーの色', en: 'Error colour' },
  { key: 'success', css: '--kasane-success', type: 'color', ja: '成功の色', en: 'Success colour' },
  { key: 'warning', css: '--kasane-warning', type: 'color', ja: '警告の色', en: 'Warning colour' },
  { key: 'info', css: '--kasane-info', type: 'color', ja: '情報の色', en: 'Info colour' },
  { key: 'radius', css: '--kasane-radius', type: 'px', max: 48, ja: 'カードの角の丸み（0〜48）', en: 'Corner radius of cards (0-48)' },
  { key: 'buttonRadius', css: '--kasane-button-radius', type: 'px', max: 999, ja: 'ボタンの角の丸み（0〜999。999 で完全な丸）', en: 'Corner radius of buttons (0-999; 999 = fully round)' },
  { key: 'font', css: '--kasane-font', type: 'font', ja: 'フォント（カンマ区切り。最後は serif / sans-serif などにしてください）', en: 'Font family list (comma separated; end with serif / sans-serif)' },
  { key: 'backgroundDim', css: '--kasane-background-dim', type: 'ratio', ja: '背景の画像の上に重ねる、背景色のこさ（0〜1。大きいほど画像がうすくなります）', en: 'How much the background colour covers the background image (0-1; higher = fainter image)' },
  { key: 'heroDim', css: '--kasane-hero-dim', type: 'ratio', ja: '残高カードの画像の上に重ねる、黒のこさ（0〜1。文字を読みやすくします）', en: 'How dark the overlay on the balance card image is (0-1; keeps the text readable)' },
];

export type ImageKind = 'logo' | 'wordmark' | 'background' | 'hero' | 'icon';

export interface ImageSlot {
  key: ImageKey;
  css: string;
  kind: ImageKind;
  maxW: number; // 保存するときの大きさの上限（px）。これより大きい画像は、縦横比を保って縮める
  maxH: number;
  maxChars: number; // 保存する文字列（data:...）の長さの上限
  ja: string;
  en: string;
}

const icon = (key: ImageKey, css: string, ja: string, en: string): ImageSlot => ({ key, css, kind: 'icon', maxW: 96, maxH: 96, maxChars: 60_000, ja: `サイドバーのアイコン：${ja}`, en: `Side menu icon: ${en}` });

export const IMAGE_SLOTS: ImageSlot[] = [
  { key: 'logoMark', css: '--kasane-image-logo-mark', kind: 'logo', maxW: 640, maxH: 560, maxChars: 300_000, ja: 'ロゴ（六角形のマーク）：スタート画面・ダイアログ', en: 'Logo mark (the hexagon): start screen, dialogs' },
  { key: 'logoWordmark', css: '--kasane-image-logo-wordmark', kind: 'wordmark', maxW: 1200, maxH: 300, maxChars: 300_000, ja: 'ロゴ（KASANE の文字）：スタート画面・サイドメニュー', en: 'Logo wordmark (the KASANE letters): start screen, side menu' },
  { key: 'background', css: '--kasane-image-background', kind: 'background', maxW: 1600, maxH: 1600, maxChars: 700_000, ja: '背景の画像', en: 'Background image' },
  { key: 'hero', css: '--kasane-image-hero', kind: 'hero', maxW: 1200, maxH: 900, maxChars: 500_000, ja: '残高カードの画像', en: 'Balance card image' },
  icon('navHome', '--kasane-image-nav-home', 'ホーム', 'Home'),
  icon('navAccount', '--kasane-image-nav-account', 'アカウント', 'Account'),
  icon('navAddressbook', '--kasane-image-nav-addressbook', 'アドレス帳', 'Address book'),
  icon('navMosaic', '--kasane-image-nav-mosaic', 'モザイク', 'Mosaic'),
  icon('navNamespace', '--kasane-image-nav-namespace', 'ネームスペース', 'Namespace'),
  icon('navMetadata', '--kasane-image-nav-metadata', 'メタデータ', 'Metadata'),
  icon('navMultisig', '--kasane-image-nav-multisig', 'マルチシグ', 'Multisig'),
  icon('navHarvest', '--kasane-image-nav-harvest', 'ハーベスト', 'Harvest'),
  icon('navAggregate', '--kasane-image-nav-aggregate', 'アグリゲート', 'Aggregate'),
  icon('navService', '--kasane-image-nav-service', 'サービス', 'Services'),
  icon('navLinks', '--kasane-image-nav-links', 'リンク集', 'Links'),
  icon('navSettings', '--kasane-image-nav-settings', '設定', 'Settings'),
];

const SLOT_BY_CSS = new Map(IMAGE_SLOTS.map((s) => [s.css, s]));
// v212 までの名前（「このアプリについて」だった頃）。保存してあるテーマやCSSがそのまま使えるように、読むときだけ新しい名前として扱う。
const LEGACY_IMAGE_KEYS: Record<string, ImageKey> = { navAbout: 'navLinks' };
const LEGACY_IMAGE_CSS: Record<string, string> = { '--kasane-image-nav-about': '--kasane-image-nav-links' };
const legacyKeyOf = (key: ImageKey): string | undefined => Object.keys(LEGACY_IMAGE_KEYS).find((k) => LEGACY_IMAGE_KEYS[k] === key);
const SLOT_BY_KEY = new Map(IMAGE_SLOTS.map((s) => [s.key, s]));
export const slotOf = (key: ImageKey): ImageSlot => SLOT_BY_KEY.get(key)!;

/** 1つのテーマの画像の文字数の合計の上限。全部の枠（IMAGE_SLOTS の maxChars の合計）に画像を入れられる大きさ。 */
export const MAX_TOTAL_IMAGE_CHARS = 2_600_000;
/** すべてのカスタムテーマの画像を合わせた文字数の上限（画像は IndexedDB に置くので、localStorage の 5MB には縛られない。端末の空き容量に余裕を持たせた値）。 */
export const MAX_ALL_IMAGE_CHARS = 20_000_000;

// 受け付ける画像：data:image/png|jpeg|webp;base64,... だけ。外のサイトの画像・SVG・gif は不可。
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** `url("data:...")` / `url(data:...)` / data:... / none を調べる。none は 'none'、使えない値は null。 */
export function normalizeImageValue(input: string, slot: ImageSlot): string | null {
  const v = input.replace(/\s*!important\s*$/i, '').trim();
  if (v.toLowerCase() === 'none') return 'none';
  const fn = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)$/i.exec(v);
  const uri = (fn ? (fn[1] ?? fn[2] ?? fn[3] ?? '') : v).trim();
  return uri.length <= slot.maxChars && DATA_IMAGE.test(uri) ? uri : null;
}

/** 保存してあった画像の文字列を調べる（形式・長さ）。使えなければ null。 */
export function checkStoredImage(value: unknown, slot: ImageSlot): string | null {
  return typeof value === 'string' && value.length <= slot.maxChars && DATA_IMAGE.test(value) ? value : null;
}

const SPEC_BY_CSS = new Map(VAR_SPECS.map((s) => [s.css, s]));

export const MAX_CSS_BYTES = 4 * 1024 * 1024; // 画像（data:）を含むので、大きめ
const MAX_FONT_LENGTH = 300;
const MAX_FONT_FAMILIES = 16;

// ---------------------------------------------------------------------------------------------
// 値の検証・正規化（色は #rrggbb か rgba(r, g, b, a) に直す。ほかの形は受け付けない）
// ---------------------------------------------------------------------------------------------
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

function colorOut(r: number, g: number, b: number, a: number): string {
  const alpha = clamp(a, 0, 1);
  if (alpha >= 0.9995) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${Math.round(clamp(r, 0, 255))}, ${Math.round(clamp(g, 0, 255))}, ${Math.round(clamp(b, 0, 255))}, ${Math.round(alpha * 1000) / 1000})`;
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function channel(token: string): number | null {
  if (token.endsWith('%')) {
    const n = token.slice(0, -1);
    return NUM.test(n) ? (Number(n) / 100) * 255 : null;
  }
  return NUM.test(token) ? Number(token) : null;
}

function alphaOf(token: string | undefined): number | null {
  if (token === undefined) return 1;
  if (token.endsWith('%')) {
    const n = token.slice(0, -1);
    return NUM.test(n) ? Number(n) / 100 : null;
  }
  return NUM.test(token) ? Number(token) : null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  if (ss === 0) return [ll * 255, ll * 255, ll * 255];
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/** 色を #rrggbb / rgba(...) に直す。#hex・rgb()/rgba()・hsl()/hsla()・white / black / transparent だけ。それ以外は null。 */
export function normalizeColor(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v === 'white') return '#ffffff';
  if (v === 'black') return '#000000';
  if (v === 'transparent') return 'rgba(0, 0, 0, 0)';
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return colorOut(r, g, b, a);
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const tokens = fn[2].split(/[\s,/]+/).filter((t) => t !== '');
  if (tokens.length !== 3 && tokens.length !== 4) return null;
  const a = alphaOf(tokens[3]);
  if (a === null) return null;
  if (fn[1].startsWith('rgb')) {
    const rgb = tokens.slice(0, 3).map(channel);
    if (rgb.some((c) => c === null)) return null;
    return colorOut(rgb[0]!, rgb[1]!, rgb[2]!, a);
  }
  const hue = tokens[0].replace(/deg$/, '');
  if (!NUM.test(hue) || !tokens[1].endsWith('%') || !tokens[2].endsWith('%')) return null;
  const s = tokens[1].slice(0, -1);
  const l = tokens[2].slice(0, -1);
  if (!NUM.test(s) || !NUM.test(l)) return null;
  const [r, g, b] = hslToRgb(Number(hue), Number(s) / 100, Number(l) / 100);
  return colorOut(r, g, b, a);
}

function normalizePx(input: string, max: number): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(px)?$/.exec(input.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

/** フォントの一覧を、安全な形（"名前", "名前", generic）に直す。使える文字は、文字・数字・空白・- _ . だけ。 */
export function normalizeFont(input: string): string | null {
  const v = input.trim();
  if (v === '' || v.length > MAX_FONT_LENGTH) return null;
  // 引用符の外のカンマで分ける（引用符の中に、カンマ・括弧・;・{} は許さないので、単純に分けてよい）。
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of v) {
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quote) return null; // 閉じていない引用符
  parts.push(cur);
  if (parts.length > MAX_FONT_FAMILIES) return null;
  const out: string[] = [];
  for (const raw of parts) {
    let name = raw.trim();
    if (name === '') return null;
    const quoted = /^(["'])(.*)\1$/s.exec(name);
    if (quoted) name = quoted[2].trim();
    else if (/["']/.test(name)) return null;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)) return null;
    out.push(!quoted && GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`);
  }
  return out.join(', ');
}

function normalizeRatio(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%)?$/.exec(input.trim());
  if (!m) return null;
  const n = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  return n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : null;
}

function normalizeValue(spec: VarSpec, raw: string): string | number | null {
  const value = raw.replace(/\s*!important\s*$/i, '').trim();
  if (value === '') return null;
  switch (spec.type) {
    case 'mode': {
      const v = value.toLowerCase();
      return v === 'dark' || v === 'light' ? v : null;
    }
    case 'color': return normalizeColor(value);
    case 'px': return normalizePx(value, spec.max ?? 999);
    case 'font': return normalizeFont(value);
    case 'ratio': return normalizeRatio(value);
    default: return null;
  }
}

function setValue(target: CustomValues, key: keyof LookValues, value: string | number) {
  (target as Record<string, string | number>)[key] = value;
}

// ---------------------------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------------------------
export type ThemeWarningCode =
  | 'too_large' | 'at_rule' | 'selector' | 'not_variable' | 'unknown_var' | 'bad_value' | 'mode_root_only' | 'image_root_only' | 'bad_image' | 'broken' | 'empty';

export interface ThemeWarning {
  code: ThemeWarningCode;
  line?: number;
  detail?: string;
}

export interface ThemeParseResult {
  theme: CustomThemeData | null;
  applied: number;
  warnings: ThemeWarning[];
  /** `--kasane-image-xxx: none` と書かれた画像（いま保存してある画像を消す指定）。 */
  clearedImages: ImageKey[];
}

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/** コメントを空白に置き換える（改行は残すので、行番号が変わらない）。閉じていないコメントは、最後まで消す。 */
function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += css[i];
      i += 1;
    }
  }
  return out;
}

/** セレクタを見分ける。`:root` → 全体、`:root[data-chain='nem']` → そのチェーン。ほかは undefined。 */
function parseSelector(prelude: string): 'root' | CustomChainKey | undefined {
  const s = prelude.replace(/\s+/g, '').replace(/"/g, "'").toLowerCase();
  if (s === ':root' || s === 'html' || s === ':root,html') return 'root';
  const m = /^:root\[data-chain='(symbol|nem|mijin|base)'\]$/.exec(s);
  return m ? (m[1] as CustomChainKey) : undefined;
}

/** 宣言を ; で分ける。ただし ( ) と引用符の中の ; は分けない（data:image/png;base64,... の ; のため）。 */
function splitDeclarations(body: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      out.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  out.push({ text: body.slice(start), offset: start });
  return out;
}

/** アップロードされたファイルの中身を文字にする。UTF-8（BOM があってもなくても）が基本で、読めなければ Shift_JIS として読む。 */
export function decodeCssBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

export function parseCustomThemeCss(rawText: string, name = ''): ThemeParseResult {
  const warnings: ThemeWarning[] = [];
  const cssText = rawText.replace(/^\uFEFF/, ''); // a byte order mark at the start is not part of the CSS
  if (new Blob([cssText]).size > MAX_CSS_BYTES) {
    return { theme: null, applied: 0, warnings: [{ code: 'too_large' }], clearedImages: [] };
  }
  const css = stripComments(cssText);
  const lineAt = (offset: number) => css.slice(0, offset).split('\n').length;
  const root: CustomValues = {};
  const chains: Partial<Record<CustomChainKey, CustomValues>> = {};
  const images: CustomImages = {};
  const clearedImages: ImageKey[] = [];
  let applied = 0;

  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i += 1;
    if (i >= n) break;
    let j = i;
    while (j < n && css[j] !== '{' && css[j] !== ';') j += 1;
    const prelude = css.slice(i, j).trim();
    if (j >= n) {
      if (prelude !== '') warnings.push({ code: 'broken', line: lineAt(i), detail: short(prelude) });
      break;
    }
    if (css[j] === ';') {
      warnings.push({ code: prelude.startsWith('@') ? 'at_rule' : 'broken', line: lineAt(i), detail: short(prelude) });
      i = j + 1;
      continue;
    }
    // ブロック：対応する } まで（入れ子は深さを数えて飛ばす）
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      if (css[k] === '{') depth += 1;
      else if (css[k] === '}') depth -= 1;
      k += 1;
    }
    const bodyStart = j + 1;
    const body = css.slice(bodyStart, depth === 0 ? k - 1 : n);
    const blockLine = lineAt(i);
    i = k;
    if (prelude.startsWith('@')) {
      warnings.push({ code: 'at_rule', line: blockLine, detail: short(prelude) });
      continue;
    }
    const target = parseSelector(prelude);
    if (target === undefined) {
      warnings.push({ code: 'selector', line: blockLine, detail: short(prelude) });
      continue;
    }
    const dest: CustomValues = target === 'root' ? root : (chains[target] ??= {});

    for (const decl of splitDeclarations(body)) {
      const declOffset = bodyStart + decl.offset + (decl.text.length - decl.text.trimStart().length);
      const text = decl.text.trim();
      if (text === '') continue;
      const line = lineAt(declOffset);
      const colon = text.indexOf(':');
      if (colon === -1) {
        warnings.push({ code: 'broken', line, detail: short(text) });
        continue;
      }
      const prop = text.slice(0, colon).trim().toLowerCase();
      const value = text.slice(colon + 1);
      if (!prop.startsWith('--')) {
        warnings.push({ code: 'not_variable', line, detail: prop });
        continue;
      }
      const slot = SLOT_BY_CSS.get(prop) ?? SLOT_BY_CSS.get(LEGACY_IMAGE_CSS[prop] ?? '');
      if (slot) {
        if (target !== 'root') {
          warnings.push({ code: 'image_root_only', line, detail: prop });
          continue;
        }
        const image = normalizeImageValue(value, slot);
        if (image === null) {
          warnings.push({ code: 'bad_value', line, detail: `${prop}: ${short(value.trim(), 40)}` });
        } else if (image === 'none') {
          delete images[slot.key];
          if (!clearedImages.includes(slot.key)) clearedImages.push(slot.key);
          applied += 1;
        } else {
          images[slot.key] = image;
          clearedImages.splice(0, clearedImages.length, ...clearedImages.filter((k) => k !== slot.key));
          applied += 1;
        }
        continue;
      }
      const spec = SPEC_BY_CSS.get(prop);
      if (!spec) {
        warnings.push({ code: 'unknown_var', line, detail: prop });
        continue;
      }
      if (spec.key === 'mode' && target !== 'root') {
        warnings.push({ code: 'mode_root_only', line, detail: prop });
        continue;
      }
      const normalized = normalizeValue(spec, value);
      if (normalized === null) {
        warnings.push({ code: 'bad_value', line, detail: `${prop}: ${short(value.trim(), 40)}` });
        continue;
      }
      setValue(dest, spec.key, normalized);
      applied += 1;
    }
  }

  if (applied === 0) {
    warnings.push({ code: 'empty' });
    return { theme: null, applied: 0, warnings, clearedImages };
  }
  const cleanChains = Object.fromEntries(Object.entries(chains).filter(([, v]) => v && Object.keys(v).length > 0)) as CustomThemeData['chains'];
  const theme: CustomThemeData = { name: name.trim().slice(0, 40), root, chains: cleanChains };
  if (Object.keys(images).length > 0) theme.images = images;
  return { theme, applied, warnings, clearedImages };
}

/** 保存してあった画像（localStorage や IndexedDB から読んだもの）を、もう一度検証する。形式・長さの合わないものは捨てる。 */
export function sanitizeImages(raw: unknown): CustomImages {
  const images: CustomImages = {};
  if (typeof raw !== 'object' || raw === null) return images;
  const stored = raw as Record<string, unknown>;
  let total = 0;
  for (const slot of IMAGE_SLOTS) {
    const legacy = legacyKeyOf(slot.key);
    const value = checkStoredImage(stored[slot.key] ?? (legacy ? stored[legacy] : undefined), slot);
    if (value === null || total + value.length > MAX_TOTAL_IMAGE_CHARS) continue;
    images[slot.key] = value;
    total += value.length;
  }
  return images;
}

/** 保存してあったデータを、もう一度検証して使える形にする（壊れた値・想定外の値は捨てる）。 */
export function sanitizeCustomTheme(data: unknown): CustomThemeData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const clean = (src: unknown, allowMode: boolean): CustomValues => {
    const out: CustomValues = {};
    if (typeof src !== 'object' || src === null) return out;
    for (const spec of VAR_SPECS) {
      if (spec.key === 'mode' && !allowMode) continue;
      const v = (src as Record<string, unknown>)[spec.key];
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const normalized = normalizeValue(spec, String(v));
      if (normalized !== null) setValue(out, spec.key, normalized);
    }
    return out;
  };
  const root = clean(d.root, true);
  const chains: CustomThemeData['chains'] = {};
  const rawChains = typeof d.chains === 'object' && d.chains !== null ? (d.chains as Record<string, unknown>) : {};
  for (const key of CUSTOM_CHAIN_KEYS) {
    const values = clean(rawChains[key], false);
    if (Object.keys(values).length > 0) chains[key] = values;
  }
  const images = sanitizeImages(d.images);
  const hasImages = Object.keys(images).length > 0;
  if (Object.keys(root).length === 0 && Object.keys(chains).length === 0 && !hasImages) return null;
  return { name: typeof d.name === 'string' ? d.name.slice(0, 40) : '', root, chains, ...(hasImages ? { images } : {}) };
}

const THEME_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 保存するテーマの目印。 */
export function newThemeId(): string {
  const uuid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.();
  return uuid ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * localStorage に書く形。画像を IndexedDB に置けているテーマ（inIdb に id がある）は、画像を外して目印 imagesInIdb を付ける。
 * まだ置けていないテーマ（IndexedDB が使えない端末を含む）は、これまでどおり画像ごと書く（画像を失わないため）。
 */
export function themesForLocalStorage(themes: SavedCustomTheme[], inIdb: ReadonlySet<string>): (SavedCustomTheme & { imagesInIdb?: true })[] {
  return themes.map((theme) => {
    if (!inIdb.has(theme.id)) return theme;
    const { images: _images, ...rest } = theme;
    void _images;
    return { ...rest, imagesInIdb: true as const };
  });
}

/** テーマの画像の文字数（合計）。 */
export function imageCharsOf(theme: { images?: CustomImages } | null | undefined): number {
  return Object.values(theme?.images ?? {}).reduce((sum, v) => sum + (v?.length ?? 0), 0);
}

/** 保存してあったカスタムテーマの一覧を、もう一度検証する。壊れたもの・10個を超えるもの・画像の合計を超える分は捨てる。id は重ならないようにする。 */
export function sanitizeSavedThemes(raw: unknown): SavedCustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedCustomTheme[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_THEMES) break;
    // 画像を IndexedDB に移したテーマは、localStorage には画像が無い（色などが無く画像だけのテーマは、目印 imagesInIdb で残す）。
    const marked = typeof item === 'object' && item !== null && (item as Record<string, unknown>).imagesInIdb === true;
    const theme = sanitizeCustomTheme(item) ?? (marked ? { name: typeof (item as Record<string, unknown>).name === 'string' ? ((item as Record<string, unknown>).name as string).slice(0, 40) : '', root: {}, chains: {} } : null);
    if (!theme) continue;
    const rawId = (item as Record<string, unknown>).id;
    let id = typeof rawId === 'string' && THEME_ID.test(rawId) && !used.has(rawId) ? rawId : newThemeId();
    while (used.has(id)) id = newThemeId();
    used.add(id);
    // 画像の合計が上限を超える分は、そのテーマの画像から外す（色などは残す）。
    if (theme.images && total + imageCharsOf(theme) > MAX_ALL_IMAGE_CHARS) delete theme.images;
    total += imageCharsOf(theme);
    out.push({ ...theme, id });
  }
  return out;
}

/** 画面ごとの値：全体の設定に、そのチェーンの上書きを重ねる。 */
export function resolveCustomValues(data: CustomThemeData, chain: string): CustomValues {
  const own = (CUSTOM_CHAIN_KEYS as readonly string[]).includes(chain) ? data.chains[chain as CustomChainKey] : undefined;
  return { ...data.root, ...own };
}

// ---------------------------------------------------------------------------------------------
// ひな形の CSS
// ---------------------------------------------------------------------------------------------
function cssValue(spec: VarSpec, v: string | number): string {
  return spec.type === 'px' ? `${v}px` : String(v);
}

const imageText = (slot: ImageSlot, lang: 'ja' | 'en') => slot[lang];

/** いまの値（LookValues）から、ひな形の CSS を作る。コメントに、各項目の説明（日本語・英語）を付ける。 */
export function buildTemplateCss(look: LookValues, title: string, images: CustomImages = {}, chains: CustomThemeData['chains'] = {}): string {
  return buildCss(look, title, images, chains);
}

/**
 * 保存してあるカスタムテーマの CSS。設定してある値だけを書く（書いていない項目は、標準の色のまま。チェーンごとの標準の色が、
 * 別のチェーンの色に変わってしまわないように、標準の値は書き出さない）。画像と、チェーンごとの上書きも含む。
 */
export function buildThemeCss(theme: CustomThemeData, title: string): string {
  return buildCss(theme.root, title, theme.images ?? {}, theme.chains);
}

function buildCss(values: CustomValues, title: string, images: CustomImages, chains: CustomThemeData['chains']): string {
  const lines: string[] = [];
  lines.push('/*');
  lines.push(`  KASANE Wallet カスタムテーマ / Custom theme — ${title}`);
  lines.push('');
  lines.push('  この CSS を編集して、ウォレットの 設定 > テーマ > カスタムテーマ からアップロードしてください。');
  lines.push('  このファイルは UTF-8 です。保存するときも UTF-8 にしてください（Shift_JIS でも読み込めます）。');
  lines.push('  Edit this file and upload it from Settings > Theme > Custom theme.');
  lines.push('  This file is UTF-8; please save it as UTF-8 (Shift_JIS is also accepted).');
  lines.push('');
  lines.push('  - 読み込まれるのは --kasane-* の変数だけです（色・角の丸み・フォント）。');
  lines.push('    ほかの CSS（セレクタ・@import・url() など）は無視されます。');
  lines.push('    Only the --kasane-* variables are read (colours, corner radius, font). Everything else is ignored.');
  lines.push('  - 色は #rrggbb / #rrggbbaa、rgb() / rgba()、hsl() / hsla() で書けます。');
  lines.push('    Colours: #rrggbb / #rrggbbaa, rgb() / rgba(), hsl() / hsla().');
  lines.push('  - 消した項目や書かなかった項目は、ベースの明るさ（dark / light）の標準の色になります。');
  lines.push('    A variable you remove falls back to the standard colour of the base brightness.');
  lines.push('*/');
  lines.push('');
  lines.push(':root {');
  for (const spec of VAR_SPECS) {
    const value = values[spec.key];
    if (value === undefined) continue;
    lines.push(`  /* ${spec.ja} | ${spec.en} */`);
    lines.push(`  ${spec.css}: ${cssValue(spec, value)};`);
  }
  // 画像：設定してあるものは変数として、ないものは、名前と説明だけをコメントで書く。
  lines.push('');
  lines.push('  /* ---- 画像 | Images ---- */');
  lines.push('  /* 画像は、ウォレットの「画像」の欄でファイルを選ぶのがかんたんです。この CSS に直接書くときは、');
  lines.push('     url("data:image/png;base64,...") の形（png / jpeg / webp）にします。外のサイトの画像（http:）と SVG は使えません。');
  lines.push('     アップロードしたとき、書いていない画像は、いま保存してある画像のままです。none と書くと、その画像を消します。');
  lines.push('     Easiest: pick the files in the wallet\'s "Images" section. In CSS, use url("data:image/png;base64,...") (png / jpeg / webp).');
  lines.push('     Images from other sites (http:) and SVG are not accepted. An image you do not list stays as it is; write none to remove it. */');
  for (const slot of IMAGE_SLOTS) {
    const image = images[slot.key];
    if (image) {
      lines.push(`  /* ${imageText(slot, 'ja')} | ${imageText(slot, 'en')} */`);
      lines.push(`  ${slot.css}: url("${image}");`);
    } else {
      lines.push(`  /* ${slot.css}  ${imageText(slot, 'ja')} | ${imageText(slot, 'en')}  (${slot.kind === 'icon' ? 'max 96px' : `max ${slot.maxW}x${slot.maxH}px`}) */`);
    }
  }
  lines.push('}');
  // このテーマが、チェーンごとに上書きしている値（ひな形では空）。
  for (const key of CUSTOM_CHAIN_KEYS) {
    const own = chains[key];
    const specs = own ? VAR_SPECS.filter((spec) => own[spec.key] !== undefined) : [];
    if (!own || specs.length === 0) continue;
    lines.push('');
    lines.push(`:root[data-chain='${key}'] {`);
    for (const spec of specs) lines.push(`  ${spec.css}: ${cssValue(spec, own[spec.key]!)};`);
    lines.push('}');
  }
  lines.push('');
  lines.push('/*');
  lines.push('  チェーンごとに変えたいときは、次のように書きます（symbol / nem / mijin / base。mode は :root だけ）。');
  lines.push('  base は、スタート画面・プロファイル選択など、チェーンに属さない画面です。');
  lines.push('  To change a chain only, add a block like this (symbol / nem / mijin / base; mode is read in :root only).');
  lines.push('  "base" is the start / profile screens that belong to no chain.');
  lines.push('');
  lines.push(":root[data-chain='nem'] {");
  lines.push('  --kasane-accent: #23917c;');
  lines.push('}');
  lines.push('*/');
  lines.push('');
  return lines.join('\n');
}
