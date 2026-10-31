// カスタムテーマの画像：選んだファイル（または CSS に書かれた data:）を、決まった大きさ・形式に「描き直して」から保存する。
//
// 元のファイルの中身は保存しない。ブラウザが画像として読めたものを canvas に描き、PNG（透過あり）か JPEG で出し直すので、
//   ・SVG に仕込まれたスクリプトや外部の読み込み（<img> として読むだけなので、動かない。canvas に描いた結果は、ただの画素）
//   ・画像のふりをしたファイル・メタデータ（EXIF の撮影場所など）・アニメーション
// は残らない。大きさと文字数の上限は、スロットごと（customTheme.ts の IMAGE_SLOTS）。

import type { ImageSlot } from './customTheme';

export const MAX_SOURCE_BYTES = 12 * 1024 * 1024; // 選べるファイルの大きさ
const MAX_SOURCE_PIXELS = 64_000_000; // 読み込んだ画像の画素数（大きすぎるとメモリを食う）

export type ImageErrorCode = 'too_large_file' | 'decode' | 'too_big' | 'total';
export class ImageError extends Error {
  code: ImageErrorCode;
  constructor(code: ImageErrorCode) {
    super(code);
    this.code = code;
  }
}

/** 縦横比を保ったまま、maxW × maxH に収まる大きさ。小さい画像は大きくしない。 */
export function fitInside(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageError('decode'));
    img.src = url;
  });
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ImageError('decode'));
    reader.readAsDataURL(blob);
  });

/**
 * 画像（ファイル、または data: の文字列）を、スロットの大きさ・文字数に収まる data:image/png|jpeg;base64,... にする。
 * 背景・残高カードは JPEG（小さくなる）、ロゴ・アイコンは透過を残すので PNG。
 */
export async function processImage(source: Blob | string, slot: ImageSlot): Promise<string> {
  if (typeof source !== 'string' && source.size > MAX_SOURCE_BYTES) throw new ImageError('too_large_file');
  // SVG は <img> として読むだけにしたいので、ファイルは data: にしてから読む（blob: URL でも動くが、後始末が要らない）。
  const url = typeof source === 'string' ? source : await blobToDataUrl(source);
  const img = await loadImage(url);
  const sw = img.naturalWidth || 512; // 大きさを持たない SVG
  const sh = img.naturalHeight || 512;
  if (sw * sh > MAX_SOURCE_PIXELS) throw new ImageError('too_large_file');

  const jpeg = slot.kind === 'background' || slot.kind === 'hero';
  let { w, h } = fitInside(sw, sh, slot.maxW, slot.maxH);
  const qualities = jpeg ? [0.82, 0.7, 0.58, 0.46] : [1];
  for (let round = 0; round < 8; round += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageError('decode');
    if (jpeg) {
      ctx.fillStyle = '#ffffff'; // JPEG には透明がないので、透過 PNG は白の上に描く
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of qualities) {
      const out = jpeg ? canvas.toDataURL('image/jpeg', q) : canvas.toDataURL('image/png');
      if (!/^data:image\/(png|jpeg);base64,/.test(out)) throw new ImageError('decode');
      if (out.length <= slot.maxChars) return out;
    }
    w = Math.max(16, Math.round(w * 0.8)); // まだ大きいので、小さくして描き直す
    h = Math.max(16, Math.round(h * 0.8));
  }
  throw new ImageError('too_big');
}

