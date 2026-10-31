// ビルド後の index.html に入れる Content-Security-Policy を作る。vite.config.ts のプラグインから使う。
//
// このビルドは JS / CSS を1つの HTML にインライン化する（vite-plugin-singlefile）。ビルドのたびにインライン
// script の中身が変わるので、script の許可は 'unsafe-inline' ではなく、完成した HTML の中の各 <script> の
// sha256 ハッシュで出す。ハッシュに合わない script（XSS で差し込まれたもの、拡張機能が足したもの）は動かない。
//
// - 'unsafe-eval' は付けない（ビルド済みのコードに eval / new Function は無い）。
// - 'wasm-unsafe-eval' は付ける: ビルドに Emscripten 製の WebAssembly を読み込むコードが含まれる。JS の eval は
//   許可せず、WebAssembly のコンパイルだけを許可する。
// - media-src は 'self' data: blob:（効果音が data: URI で入るため。無いと default-src にフォールバックして音が鳴らない）。
// - style-src の 'unsafe-inline' は残す（MUI / emotion がインラインの style を差し込む）。
// - connect-src は https / http / wss / ws のまま。ノードの URL を利用者が自由に指定できる仕様のため、通信先の
//   ドメインは絞れない（http は HTTP ノード対応のため。絞るかどうかは別途検討）。
// - frame-ancestors は <meta> の CSP では無効（仕様）なので書かない。埋め込みの防止は src/lib/frameGuard.ts が行う。
import { createHash } from 'node:crypto';

const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const CSP_META = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;

/** HTML の中の、src を持たない <script> の中身から sha256 ハッシュ（CSP の書式）を作る。 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    if (m[1].trim().length === 0) continue;
    hashes.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

export function buildCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // 効果音（ding / ding2）。単一HTMLビルドは音声ファイルも data: URI としてインライン化するので、data: を許可する。
    // これが無いと default-src 'self' にフォールバックして data: の音声がブロックされ、効果音が鳴らなくなる。
    "media-src 'self' data: blob:",
    "connect-src 'self' https: http: wss: ws:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ') + ';';
}

/** 完成した HTML の CSP を、ハッシュ方式のものに差し替える（meta が無ければ <head> の先頭に足す）。 */
export function applyCsp(html: string): string {
  const hashes = inlineScriptHashes(html);
  if (hashes.length === 0) {
    throw new Error('kasane-csp: インラインの <script> が見つかりません（単一HTMLビルドになっていますか）。CSPは変更しませんでした。');
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(hashes)}" />`;
  if (CSP_META.test(html)) {
    return html.replace(CSP_META, () => meta);
  }
  return html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${meta}`);
}
