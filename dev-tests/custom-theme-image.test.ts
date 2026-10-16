// カスタムテーマの画像の描き直し（theme/imageProcessing.ts の processImage）の流れ。
// ブラウザの Image と canvas を、決まった大きさの文字列を返す偽物に差し替えて、縮小・品質の段階・エラーを確かめる。
// （本物の画像の読み込み・描画は、ブラウザでの確認が要る。）
// 実行: npx tsx dev-tests/custom-theme-image.test.ts
import { ImageError, processImage } from '../src/theme/imageProcessing';
import { slotOf } from '../src/theme/customTheme';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

let srcW = 2000;
let srcH = 1000;
let decodeFails = false;
let sizeOf: (w: number, h: number, type: string, q?: number) => number = () => 100;
let outType: string | null = null; // 偽物が返す形式を変える
const calls: { w: number; h: number; type: string; q?: number }[] = [];

(globalThis as any).Image = class {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = srcW;
  naturalHeight = srcH;
  set src(_v: string) {
    setTimeout(() => (decodeFails ? this.onerror?.() : this.onload?.()), 0);
  }
};
(globalThis as any).document = {
  createElement: () => {
    const canvas: any = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v: string) {}, set imageSmoothingQuality(_v: string) {} }),
      toDataURL(type: string, q?: number) {
        calls.push({ w: canvas.width, h: canvas.height, type, q });
        const kind = outType ?? (type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
        return `data:${kind};base64,${'A'.repeat(sizeOf(canvas.width, canvas.height, type, q))}`;
      },
    };
    return canvas;
  },
};

const reset = (w = 2000, h = 1000) => { srcW = w; srcH = h; decodeFails = false; outType = null; calls.length = 0; sizeOf = () => 100; };
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return e instanceof ImageError ? e.code : `other:${String(e)}`; } };
const DATA = 'data:image/png;base64,AAAA';

{ // アイコン：96px に収まるよう縮む。縦横比は保つ
  reset();
  const out = await processImage(DATA, slotOf('navHome'));
  check('icon: shrunk to fit 96x96, ratio kept', calls.length === 1 && calls[0].w === 96 && calls[0].h === 48 && calls[0].type === 'image/png' && out.startsWith('data:image/png;base64,'), JSON.stringify(calls));
}
{ // 小さい画像は大きくしない
  reset(40, 30);
  await processImage(DATA, slotOf('navHome'));
  check('icon: a small image is not enlarged', calls[0].w === 40 && calls[0].h === 30);
}
{ // ロゴ：大きすぎる出力は、0.8 倍ずつ小さくして描き直す
  reset(2000, 1000);
  sizeOf = (w, h) => w * h * 2; // 640x320 -> 409,600 (> 300,000)
  const out = await processImage(DATA, slotOf('logoMark'));
  check('logo: redrawn smaller until it fits', calls.length >= 2 && calls[calls.length - 1].w < calls[0].w && out.length <= 300_000, JSON.stringify(calls));
}
{ // 背景：JPEG。まず品質を下げ、それでも大きければ縮める
  reset(4000, 3000);
  sizeOf = (w, h, _t, q) => Math.round(w * h * (q ?? 1) * 0.5);
  const out = await processImage(DATA, slotOf('background'));
  check('background: jpeg, quality lowered before shrinking', calls[0].type === 'image/jpeg' && calls[0].q === 0.82 && calls.length > 1 && out.length <= 700_000, JSON.stringify(calls.slice(0, 5)));
  check('background: starts from 1600px at most', calls[0].w <= 1600 && calls[0].h <= 1600);
}
{ // どうしても入らない
  reset();
  sizeOf = () => 5_000_000;
  check('too big even when shrunk: too_big', (await code(() => processImage(DATA, slotOf('navHome')))) === 'too_big');
}
{ // 読み込めない
  reset();
  decodeFails = true;
  check('undecodable image: decode', (await code(() => processImage(DATA, slotOf('hero')))) === 'decode');
}
{ // ブラウザが png / jpeg 以外で返したら使わない
  reset();
  outType = 'image/gif';
  check('unexpected output type is refused', (await code(() => processImage(DATA, slotOf('hero')))) === 'decode');
}
{ // ファイルが大きすぎる
  reset();
  check('file over 12 MB: too_large_file', (await code(() => processImage({ size: 13 * 1024 * 1024 } as Blob, slotOf('hero')))) === 'too_large_file');
}
{ // 画素数が多すぎる
  reset(20000, 20000);
  check('too many pixels: too_large_file', (await code(() => processImage(DATA, slotOf('hero')))) === 'too_large_file');
}
{ // 大きさを持たない SVG
  reset(0, 0);
  const out = await processImage(DATA, slotOf('navHome'));
  check('an image without a size is treated as 512x512', calls[0].w === 96 && calls[0].h === 96 && out.length > 0);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
