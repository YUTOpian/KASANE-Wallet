// Symbol の投票画面の文言の鍵。NEM の投票（nemvoting.*）と共通の文言はそのまま使い、XEM を書いてあるものだけ symbolvoting.* にする。
export function votingErrorKey(kind: string, part: 'title' | 'message'): string {
  return kind === 'insufficient_balance' ? `symbolvoting.error_insufficient_balance_${part}` : `nemvoting.error_${kind}_${part}`;
}
