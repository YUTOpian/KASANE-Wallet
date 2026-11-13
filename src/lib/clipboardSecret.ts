// 秘密（ニーモニックなど）をクリップボードに入れ、あとで自動的に消す。
// ブラウザのしくみ上できること／できないこと:
//  - 消せる: 一定時間後（このアプリが開いていて、画面が前面にあるとき）、およびこのアプリの中で貼り付けが起きたとき。
//  - 消せない: 他のアプリ（メモ帳など）への貼り付けは検知できない。タブを閉じた後・画面が裏にある間は書き換えもできない
//    （戻ってきた時点で、時間が過ぎていればすぐ消す）。
// 秘密そのものはここに保持しない（消す予定かどうかの印だけ持つ）。クリップボードを読むこともしない。

export const SECRET_CLIPBOARD_CLEAR_MS = 60_000;

let armed = false;
let deadline = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

async function clearNow(): Promise<void> {
  if (!armed) return;
  try {
    await navigator.clipboard.writeText('');
    armed = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  } catch {
    // 画面が前面にないなど。armed のまま残し、戻ってきたとき（focus / visible）にもう一度試す。
  }
}

function onReturn() {
  if (armed && Date.now() >= deadline && document.visibilityState === 'visible') void clearNow();
}

function onPaste() {
  // 貼り付けのデータを読み終えてから消す。
  if (armed) setTimeout(() => { void clearNow(); }, 0);
}

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('paste', onPaste, true);
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);
}

export async function copySecretToClipboard(text: string, clearAfterMs: number = SECRET_CLIPBOARD_CLEAR_MS): Promise<void> {
  await navigator.clipboard.writeText(text);
  armed = true;
  deadline = Date.now() + clearAfterMs;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => { void clearNow(); }, clearAfterMs);
  listen();
}
