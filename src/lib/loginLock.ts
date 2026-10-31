// プロファイルごとの「ログイン（アプリを開く）のたびにパスワード入力を求める」設定。
// 既定は「求めない」。設定は localStorage の kasane.loginPassword.<profileKey> に '1' で保存する（無ければ求めない）。
// 入力済みかどうかはメモリ上だけで持つ。ページを読み込み直す（=アプリを開き直す）と、また求める。
const KEY_PREFIX = 'kasane.loginPassword.';

const unlocked = new Set<string>();

export function isLoginPasswordRequired(profileKey: string): boolean {
  try {
    return localStorage.getItem(KEY_PREFIX + profileKey) === '1';
  } catch {
    return false;
  }
}

export function setLoginPasswordRequired(profileKey: string, required: boolean): void {
  try {
    if (required) {
      localStorage.setItem(KEY_PREFIX + profileKey, '1');
    } else {
      localStorage.removeItem(KEY_PREFIX + profileKey);
    }
  } catch {
    // localStorage が使えない環境では保存できない（常に「求めない」になる）。
  }
  // 設定を変えた直後に、同じ画面で急に聞き直されないよう、入力済みとして扱う。
  unlocked.add(profileKey);
}

export function isLoginUnlocked(profileKey: string): boolean {
  return unlocked.has(profileKey);
}

export function markLoginUnlocked(profileKey: string): void {
  unlocked.add(profileKey);
}

export const LOGIN_PASSWORD_KEY_PREFIX = KEY_PREFIX;
