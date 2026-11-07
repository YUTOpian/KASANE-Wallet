// 他のページの <iframe> に埋め込まれて開かれたら、ここで止める（クリックジャッキング対策）。
//
// index.html の CSP は <meta> で入れているため、frame-ancestors は効かない（仕様で、ヘッダーの CSP でしか
// 効かない）。GitHub Pages のようにヘッダーを設定できないホスティングでは、代わりにここで検出する。
// main.tsx の最初の import にして、アプリ本体（ストレージの読み込みなど）が動く前に止める。
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // 親が別オリジンで window.top を読めないときも、埋め込まれている。
    return true;
  }
}

if (isFramed()) {
  const box = document.createElement('div');
  box.style.cssText = 'font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:10vh auto;line-height:1.6';
  const title = document.createElement('p');
  title.style.fontWeight = '700';
  title.textContent = 'KASANE Wallet は他のページの中では開けません。 / KASANE Wallet cannot run inside another page.';
  const link = document.createElement('a');
  link.href = window.location.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '新しいタブで開く / Open in a new tab';
  box.append(title, link);
  document.body.replaceChildren(box);
  // アプリ本体の読み込みをここで中断する（以降の import は評価されない）。
  throw new Error('KASANE Wallet: blocked, running inside a frame');
}

export {};
