import { useState, type ComponentType } from 'react';

/** 送信が済んだことを、包まれた画面から知らせるための props。 */
export interface SentProps {
  // 送信が成功したときに呼ぶ。画面を最初の入力状態（フォーム）に戻す。
  onSent: () => void;
}

/**
 * 「入力 → 確認（パスワード）→ 送信」の画面を包み、送信が成功したら画面の状態をまるごと作り直す。
 * 完了画面へは遷移せず、入力が空のフォームに戻る（結果は txNoticeStore のトーストで知らせる）。
 * 同じ内容をもう一度送ってしまわないよう、入力も初期値に戻す。
 */
export function withFormReset<P extends object>(Inner: ComponentType<P & SentProps>): ComponentType<P> {
  function WithFormReset(props: P) {
    const [generation, setGeneration] = useState(0);
    return <Inner key={generation} {...props} onSent={() => setGeneration((n) => n + 1)} />;
  }
  WithFormReset.displayName = `withFormReset(${Inner.displayName ?? Inner.name ?? 'Component'})`;
  return WithFormReset;
}
