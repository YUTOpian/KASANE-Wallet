// AIコーディングツールの「内蔵ブラウザ」や、AIが操作するブラウザの中で開かれているかを調べる。
//
// 背景: Codex・Claude Desktop・VS Code・Cursor・GitHub Copilot などの内蔵ブラウザは、AIが操作する前提で機能が
// 足されているぶん、ふだんのブラウザ（Chrome / Edge / Safari）より守りが弱いことがある、と報告されている
// （2026年10月）。ここで見つけた場合、main.tsx の EmbeddedBrowserGate が、アプリを開く前に警告を出す。
//
// ユーザーエージェントの文字列などから推測するだけなので、見つけられない場合も、誤って見つける場合もある。
// 「見つけたら止める」ための補助で、これだけで安全になるわけではない（docs/SECURITY-EMBEDDED-BROWSER.md）。
// 画面を持たない純粋な関数だけにして、dev-tests/embedded-browser.test.ts で動かせるようにしている。

export type EmbeddedKind =
  /** Electron 製のアプリの中（内蔵ブラウザは多くがこれ）。 */
  | 'electron'
  /** VS Code 系のエディタ（Code / Cursor / Windsurf など）の名前が出ている。 */
  | 'editor'
  /** Codex / Claude のデスクトップアプリの名前が出ている。 */
  | 'ai-app'
  /** JetBrains 系の IDE の内蔵ブラウザ（JCEF）。 */
  | 'jetbrains'
  /** 自動操作されているブラウザ（navigator.webdriver、ヘッドレス）。AIがブラウザを操作するときに立つ。 */
  | 'automation';

export interface EmbeddedSignals {
  userAgent: string;
  /** navigator.webdriver */
  webdriver?: boolean;
  /** window.process.versions.electron（読めたときだけ） */
  electronVersion?: string | null;
}

export interface EmbeddedResult {
  embedded: boolean;
  kinds: EmbeddedKind[];
}

// 名前のあとに「/数字」が続く形（例: "Cursor/1.2.3"）だけを見る。"Xcode" や "ClaudeBot/1.0" には当たらない。
const UA_RULES: ReadonlyArray<readonly [EmbeddedKind, RegExp]> = [
  ['electron', /\bElectron\/\d/],
  ['editor', /\b(?:Code|VSCodium|Cursor|Windsurf|Kiro|Trae|Antigravity)\/\d/],
  ['ai-app', /\b(?:Codex|Claude)\/\d/],
  ['jetbrains', /\bJCEF\b|\bJetBrains\b/],
  ['automation', /\bHeadlessChrome\b/],
];

export function detectEmbeddedBrowser(signals: EmbeddedSignals): EmbeddedResult {
  const kinds = new Set<EmbeddedKind>();
  for (const [kind, pattern] of UA_RULES) {
    if (pattern.test(signals.userAgent)) kinds.add(kind);
  }
  if (typeof signals.electronVersion === 'string' && signals.electronVersion.length > 0) kinds.add('electron');
  if (signals.webdriver === true) kinds.add('automation');
  return { embedded: kinds.size > 0, kinds: [...kinds] };
}

/** いまのブラウザから、見分けに使う値を読む。読めない値は無いものとして扱う。 */
export function readEmbeddedSignals(): EmbeddedSignals {
  let electronVersion: string | null = null;
  try {
    const proc = (window as unknown as { process?: { versions?: { electron?: unknown } } }).process;
    const v = proc?.versions?.electron;
    if (typeof v === 'string') electronVersion = v;
  } catch {
    // window.process が読めないブラウザ（ふつうのブラウザ）。
  }
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    webdriver: typeof navigator !== 'undefined' ? navigator.webdriver === true : false,
    electronVersion,
  };
}

/** 別のブラウザに貼るためのアドレス（# 以降のルートは除く）。 */
export function addressForOtherBrowser(href: string): string {
  const hash = href.indexOf('#');
  return hash === -1 ? href : href.slice(0, hash);
}
