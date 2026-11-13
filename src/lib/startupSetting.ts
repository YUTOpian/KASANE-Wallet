// 「アプリを起動したときに、どの画面から始めるか」の設定。アプリ全体で1つ（プロファイルごとではない）。
// 既定は 'welcome'（スタート画面から始める。これまでと同じ）。localStorage の kasane.startup に保存する。
//   - 'welcome': スタート画面（/welcome）から始める
//   - 'select' : スタート画面を飛ばして、プロファイル選択画面（/wallet/select）へ
//   - 'last'   : スタート画面を飛ばして、プロファイルのホーム画面（/top）へ。チェーンは前回使っていたもの
// どの設定でも、プロファイルが1件も無いとき（はじめて開くとき）は、必ずスタート画面から始める。
export type StartupTarget = 'welcome' | 'select' | 'last';

export const STARTUP_TARGETS: StartupTarget[] = ['welcome', 'select', 'last'];

const KEY = 'kasane.startup';

export function getStartupTarget(): StartupTarget {
  try {
    const v = localStorage.getItem(KEY);
    return (STARTUP_TARGETS as string[]).includes(v ?? '') ? (v as StartupTarget) : 'welcome';
  } catch {
    return 'welcome';
  }
}

export function setStartupTarget(target: StartupTarget): void {
  try {
    if (target === 'welcome') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, target);
  } catch {
    // localStorage が使えない環境では保存できない（常にスタート画面から始まる）。
  }
}
