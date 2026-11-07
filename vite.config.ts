import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyCsp } from './vite-csp.ts'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// A single build target that works both ways:
//
// 1. Double-clicked directly as a local file (file://index.html): normal Vite output uses
//    `<script type="module" src="...">`, which Chrome (and others) block from loading over
//    file:// due to CORS. vite-plugin-singlefile avoids that entirely by inlining every
//    JS/CSS/image/font into one self-contained index.html with no external references at
//    all — nothing to be blocked from fetching.
// 2. Hosted on GitHub Pages (or any static host, at any subpath): `base: './'` makes every
//    reference relative, and react-router-dom's HashRouter (see src/router.tsx) keeps all
//    routing state in the URL fragment, so no server-side rewrite rules are needed.
//
// The trade-off is no code-splitting — everything ships in one ~3MB file rather than
// small per-route chunks — but that's an acceptable cost for a wallet app of this size to
// stay usable both ways from a single build.
// 出来上がった dist/index.html の CSP を、インライン script のハッシュ方式に差し替える（vite-csp.ts）。
// 全プラグインが HTML を書き終えたあと（closeBundle）に、ファイルを読み直して書き換える。
// `vite` の開発サーバーでは動かない（HMR に インライン script が要るため、開発中は index.html のゆるい CSP のまま）。
function kasaneCspHash(): Plugin {
  let outDir = ''
  return {
    name: 'kasane-csp-hash',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const file = resolve(outDir, 'index.html')
      writeFileSync(file, applyCsp(readFileSync(file, 'utf8')))
    },
  }
}

// スタブの場所は、ファイルシステム上の絶対パスで書く。'/src/shims/…' のようなルート相対の書き方は、本番ビルドでは通るが、
// 開発サーバーの依存関係の事前処理（node_modules の中の import）では、ファイルシステムの /src/… として探されて見つからず、起動に失敗する。
const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url))

export default defineConfig({
  base: './',
  // Nothing in index.html references files from public/ anymore (the favicon is inlined
  // as a data URI below), so skip copying it — dist/ ends up containing exactly one file.
  publicDir: false,
  resolve: {
    alias: {
      // 'crypto' is stubbed rather than polyfilled: polyfilling it properly
      // (crypto-browserify) previously crashed the app at startup, because its own top-level
      // module code assumes further Node builtins exist. See src/shims/crypto-stub.ts.
      crypto: shim('crypto-stub.ts'),
      // Node-only WebAssembly backend of symbol-sdk; the SDK falls back to pure JS (see define below).
      // Only used by the SDK's Bip32 class, which this app does not use (see lib/symbol/hd.ts).
      'bitcore-mnemonic': shim('bitcore-mnemonic-stub.ts'),
      'symbol-crypto-wasm-node': shim('symbol-crypto-wasm-stub.ts'),
    },
  },
  define: {
    // Forces symbol-sdk's pure-JS Ed25519 (no WebAssembly) in the browser.
    'process.env.SYMBOL_SDK_NO_WASM': JSON.stringify('1'),
  },
  plugins: [
    react(),
    // 'buffer' and 'process' are simple, self-contained polyfills (ethers and a few
    // dependencies expect these globals) with no further Node builtin dependencies.
    nodePolyfills({ include: ['buffer', 'process'] }),
    viteSingleFile({ removeViteModuleLoader: true }),
    kasaneCspHash(),
  ],
  // コンソールの Worker（src/lib/console/consoleWorker.ts）。`?worker&inline` で単一HTMLに Blob として埋め込む。
  // Worker のビルドには、本体のプラグインが適用されない。symbol-sdk が期待する buffer / process は、ここで別に入れる。
  worker: {
    format: 'es',
    plugins: () => [nodePolyfills({ include: ['buffer', 'process'] })],
  },
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
})
