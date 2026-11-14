// テスト用: `import url from './x.ogg'` のような画像・音声・フォントの import を、Node で読めるようにする。
// Vite ではファイルの URL（またはデータ URI）になるものを、ここでは文字列（ファイルの場所）にするだけ。
// 中身は使わないテストのためのもので、アプリのビルドには関係しない。
import { registerHooks } from 'node:module';

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|ogg|mp3|wav|woff2?|ttf)$/i;

if (typeof registerHooks === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      if (ASSET.test(url.split('?')[0])) {
        return { format: 'module', source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
