import type { CustomThemeData } from './customTheme';

// ブラウザのタブの見た目（ロゴ = ファビコンと、表示名）。カスタムテーマに設定があればそれ、なければ index.html にある標準のもの。
// 標準のロゴ・表示名は、最初に呼ばれたときに（まだ何も差し替える前の）ページから控えておく。
// ロゴは data:image/(png|jpeg|webp) の文字列（customTheme.ts で検証済み）、表示名は検証済みの文字（document.title に入れるだけで、HTML としては扱われない）。

let defaults: { title: string; icon: string | null } | null = null;

export function applyTabIdentity(custom: Pick<CustomThemeData, 'tabTitle' | 'images'> | null): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  defaults ??= { title: document.title, icon: link?.getAttribute('href') ?? null };
  document.title = custom?.tabTitle ?? defaults.title;
  const href = custom?.images?.tabIcon ?? defaults.icon;
  if (!href) return;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}
