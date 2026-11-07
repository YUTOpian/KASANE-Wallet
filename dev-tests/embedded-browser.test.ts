// Run: npx tsx dev-tests/embedded-browser.test.ts
// Checks lib/embeddedBrowser.ts: AIコーディングツールの内蔵ブラウザ・自動操作のブラウザを見つけ、ふつうのブラウザは通す。
import { detectEmbeddedBrowser, addressForOtherBrowser } from '../src/lib/embeddedBrowser';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/130.0.0.0`;
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const XCODE = `${IOS} Xcode/16.0`;
const CLAUDEBOT = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';

// ふつうのブラウザは通す
check('Chrome', !detectEmbeddedBrowser({ userAgent: CHROME }).embedded);
check('Edge', !detectEmbeddedBrowser({ userAgent: EDGE }).embedded);
check('Safari', !detectEmbeddedBrowser({ userAgent: SAFARI }).embedded);
check('Firefox', !detectEmbeddedBrowser({ userAgent: FIREFOX }).embedded);
check('iOS Safari', !detectEmbeddedBrowser({ userAgent: IOS }).embedded);
check('"Xcode/" は VS Code ("Code/") と間違えない', !detectEmbeddedBrowser({ userAgent: XCODE }).embedded);
check('"ClaudeBot/" は Claude のアプリと間違えない', !detectEmbeddedBrowser({ userAgent: CLAUDEBOT }).embedded);
check('webdriver が false / 未指定', !detectEmbeddedBrowser({ userAgent: CHROME, webdriver: false }).embedded);
check('electronVersion が null / 空', !detectEmbeddedBrowser({ userAgent: CHROME, electronVersion: null }).embedded && !detectEmbeddedBrowser({ userAgent: CHROME, electronVersion: '' }).embedded);

// 内蔵ブラウザ・AIアプリ
const ELECTRON = `${CHROME} Electron/33.2.0`;
check('Electron', detectEmbeddedBrowser({ userAgent: ELECTRON }).kinds.includes('electron'));
const VSCODE = `${CHROME} Code/1.96.0 Electron/32.2.6`;
const vs = detectEmbeddedBrowser({ userAgent: VSCODE });
check('VS Code は electron と editor の両方', vs.embedded && vs.kinds.includes('electron') && vs.kinds.includes('editor'));
check('Cursor', detectEmbeddedBrowser({ userAgent: `${CHROME} Cursor/0.45.1 Electron/32.2.6` }).kinds.includes('editor'));
check('Windsurf', detectEmbeddedBrowser({ userAgent: `${CHROME} Windsurf/1.2.0 Electron/32.2.6` }).kinds.includes('editor'));
check('Claude Desktop', detectEmbeddedBrowser({ userAgent: `${CHROME} Claude/0.14.0 Electron/33.4.0` }).kinds.includes('ai-app'));
check('Codex', detectEmbeddedBrowser({ userAgent: `${CHROME} Codex/1.0.0 Electron/33.4.0` }).kinds.includes('ai-app'));
check('JetBrains の JCEF', detectEmbeddedBrowser({ userAgent: `${CHROME} JCEF/122.1.9` }).kinds.includes('jetbrains'));

// UA が書き換えられていても、window.process.versions.electron で見つける
const stripped = detectEmbeddedBrowser({ userAgent: CHROME, electronVersion: '33.2.0' });
check('UA から Electron の名前が消されていても electronVersion で見つける', stripped.embedded && stripped.kinds.includes('electron'));

// 自動操作されているブラウザ
check('navigator.webdriver = true', detectEmbeddedBrowser({ userAgent: CHROME, webdriver: true }).kinds.includes('automation'));
check('HeadlessChrome', detectEmbeddedBrowser({ userAgent: CHROME.replace('Chrome/', 'HeadlessChrome/') }).kinds.includes('automation'));

// 重複しない
const dup = detectEmbeddedBrowser({ userAgent: ELECTRON, electronVersion: '33.2.0' });
check('electron が二重に数えられない', dup.kinds.filter((k) => k === 'electron').length === 1);

// 別のブラウザに貼るアドレス
check('# 以降のルートは外す', addressForOtherBrowser('https://example.com/kasane/index.html#/wallet/select') === 'https://example.com/kasane/index.html');
check('# が無ければそのまま', addressForOtherBrowser('file:///Users/me/kasane/index.html') === 'file:///Users/me/kasane/index.html');

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
