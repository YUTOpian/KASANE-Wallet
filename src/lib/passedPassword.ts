// 「パスワードを入力したポップアップのある画面」から、次の画面へパスワードを一度だけ渡すための入れ物。
//
// 以前はルーターの state（navigate(url, { state: { pin } })）で渡していたが、state はブラウザの履歴エントリに
// 保存される。次の画面で消すまでの間は履歴に平文のパスワードが残り、ブラウザのセッション復元などにも残りうる。
// ここでは JS のモジュール内の変数に置く。ストレージにも履歴にも書かれず、ページを読み込み直せば消える。
//
// - 渡した直後の短い間（TTL）だけ有効。使われなかったパスワードがメモリに残り続けない。
// - 読むだけでは消さない: React の開発モード（StrictMode）は描画とエフェクトを2回走らせるので、読んだ瞬間に
//   消すと2回目が空になる。使い終わった側が clearHandedPassword() で消す。
const TTL_MS = 30 * 1000;

let held: { value: string; expiresAt: number } | null = null;

export function handOverPassword(password: string): void {
  held = { value: password, expiresAt: Date.now() + TTL_MS };
}

export function readHandedPassword(): string | undefined {
  if (held && Date.now() > held.expiresAt) {
    held = null;
  }
  return held?.value;
}

export function clearHandedPassword(): void {
  held = null;
}
