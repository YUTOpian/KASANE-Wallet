import { create } from 'zustand';

// 送信の結果（「送信しました」）を知らせる小さな通知。以前は送信後に専用の「完了画面」へ遷移していたが、
// 画面は切り替えず、いまの画面の上にトースト（Snackbar）で出すだけにする。
// 送信後はフォームを作り直す（= 画面ごと再生成する）ので、通知は画面の外（ここ）に持つ。
export interface TxNotice {
  id: number;
  // 通知の本文（1行ずつ）。
  lines: string[];
  // エクスプローラで見るためのリンク（任意）。
  explorerUrl?: string;
  explorerLabel?: string;
}

interface TxNoticeState {
  notice: TxNotice | null;
  show: (notice: Omit<TxNotice, 'id'>) => void;
  clear: () => void;
}

let seq = 0;

export const useTxNoticeStore = create<TxNoticeState>((set) => ({
  notice: null,
  show: (notice) => set({ notice: { ...notice, id: ++seq } }),
  clear: () => set({ notice: null }),
}));

/** React の外（非コンポーネント）からも呼べる版。 */
export const showTxNotice = (notice: Omit<TxNotice, 'id'>) => useTxNoticeStore.getState().show(notice);
