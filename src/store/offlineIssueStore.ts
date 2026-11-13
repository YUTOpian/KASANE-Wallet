import { create } from 'zustand';

// オフラインで発行したトランザクション（署名済みで、まだ送っていないもの）。
// 送信しようとしたとき端末がオフラインだった場合、lib/offline/issue.ts がここに入れて、
// components/OfflineIssueDialog.tsx（アプリに1つ）がQRコードとして出す。メモリの中だけで、保存はしない。

export type IssueRole = 'tx' | 'lock' | 'bonded';

export type IssuePart =
  /** 署名済みの Symbol トランザクション（hex）。`lock` → `bonded` の順で送ると、ハッシュロックが確定してから bonded を流す。 */
  | { kind: 'symbol_tx'; role: IssueRole; payload: string; hash: string }
  /** 連署者の署名（親アグリゲートのハッシュへの署名）。 */
  | { kind: 'symbol_cosignature'; parentHash: string; signerPublicKey: string; signature: string; version: string }
  /** 署名済みの NIS1 トランザクション（/transaction/announce の本文）。 */
  | { kind: 'nem_tx'; data: string; signature: string };

export interface OfflineIssue {
  id: number;
  createdAt: number; // 端末の時計（ms）
  chain: 'symbol' | 'nem';
  networkLabel: string; // 「Symbol メインネット」などの表示用ではなく、ネットワーク名（mainnet / testnet）
  parts: IssuePart[]; // 送る順
  text: string; // QRコード（JSON）の中身
  /** 'offline' = 端末がオフライン、'unreachable' = オンラインのはずだがノードに届かなかった。 */
  reason: 'offline' | 'unreachable';
}

interface OfflineIssueState {
  issue: OfflineIssue | null;
  show: (issue: Omit<OfflineIssue, 'id'>) => OfflineIssue;
  clear: () => void;
}

let seq = 0;

export const useOfflineIssueStore = create<OfflineIssueState>((set) => ({
  issue: null,
  show: (issue) => {
    const next: OfflineIssue = { ...issue, id: ++seq };
    set({ issue: next });
    return next;
  },
  clear: () => set({ issue: null }),
}));
