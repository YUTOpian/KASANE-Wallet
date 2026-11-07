// 会員が多い DAO のための「分割して送る」仕組み。
// 1 つのアグリゲートに入れられる内側のトランザクションは 100 件まで（ネットワークの決まり）。配布・回収・投票トークンの配布は、
// 宛先を 100 件ずつに分け、アグリゲートを何回かに分けて送る。1 回の操作で扱える数の上限は MAX_DAO_ITEMS（1000 件）。
import { waitConfirmed } from '../symbol/multisigApi';
import type { KeylessSigner } from '../symbol/sssSign';
import { submitDao } from './daoTx';
import type { DaoSubmitInput, DaoSubmitResult } from './daoTx';
import type { CreateVotePlan, ResumeVotePlan } from './daoActions';

/** 1 回の操作（配布・回収・投票の作成）で扱える宛先・会員の数。分割して送るので、1 つのアグリゲートの 100 件より多くできる。 */
export const MAX_DAO_ITEMS = 1000;

/** items を size 件ずつに分ける（最後の 1 つは少なくなる）。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('invalid_chunk');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 何回目まで送れたか（done 回 / 全部で total 回）。 */
export type BatchProgress = (done: number, total: number) => void;

/**
 * 互いに関係のないアグリゲート（配布・回収）を、順に送る。それぞれ complete / bonded は `submitDao` が決める
 * （管理者の連署が要る形なら、1 回ごとにハッシュロックと連署が要る）。どこかで止まったら、そこで例外を投げる
 * （それまでに送った分は取り消せない。何回目まで送れたかは `onProgress` で分かる）。
 */
export async function submitDaoBatches(privateKey: string, inputs: DaoSubmitInput[], keyless?: KeylessSigner, onProgress?: BatchProgress): Promise<DaoSubmitResult> {
  if (inputs.length === 0) throw new Error('no_items');
  let bonded = false;
  let hash = '';
  onProgress?.(0, inputs.length);
  for (let i = 0; i < inputs.length; i += 1) {
    const result = await submitDao(privateKey, inputs[i], keyless);
    bonded = bonded || result.bonded;
    hash = result.hash;
    onProgress?.(i + 1, inputs.length);
  }
  return { hash, bonded };
}

// --- 途中で止まった投票の作成 -------------------------------------------------------------------------

/** 1 回目（投票トークンの発行）まで済んで、配布の途中で止まった投票。再開に必要な最小限だけを、この端末のブラウザに残す。 */
export interface PendingVote {
  tokenId: string; // 投票トークンのモザイク ID（16 hex）
  firstHash: string; // 1 回目のアグリゲートのハッシュ（DAO の索引に書く値）
  weighted: boolean;
  title: string;
}

const pendingKey = (daoId: string): string => `kasane.dao.pendingVote.${daoId.toUpperCase()}`;

export function loadPendingVote(daoId: string): PendingVote | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(pendingKey(daoId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingVote>;
    if (typeof v.tokenId !== 'string' || !/^[0-9A-F]{16}$/.test(v.tokenId)) return null;
    if (typeof v.firstHash !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(v.firstHash)) return null;
    return { tokenId: v.tokenId, firstHash: v.firstHash, weighted: v.weighted !== false, title: typeof v.title === 'string' ? v.title : '' };
  } catch {
    return null;
  }
}

export function savePendingVote(daoId: string, pending: PendingVote): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(pendingKey(daoId), JSON.stringify(pending));
  } catch {
    // 保存できなくても投票の作成そのものは続ける（再開ができなくなるだけ）。
  }
}

export function clearPendingVote(daoId: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(pendingKey(daoId));
  } catch {
    // 何もしない
  }
}

/**
 * 投票を作って送る。順番が大事:
 *  1. 1 回目（索引メッセージ・投票トークンの発行・最初の会員への配布）を送り、確定を待つ（以降の配布はこのトークンが要る）
 *  2. 残りの会員への配布を 100 人ずつ送る（ウォレットの署名だけで済む complete）
 *  3. 最後に DAO のメタデータへ索引を登録する（管理者の連署が要るなら bonded）
 * 索引の登録を最後にするので、途中で止まった投票は一覧に出ない。止まったら（1 の確定のあと）再開用の記録が残る。
 */
export async function submitCreateVote(
  privateKey: string,
  plan: CreateVotePlan,
  meta: { daoId: string; weighted: boolean; title: string },
  keyless?: KeylessSigner,
  onProgress?: BatchProgress,
): Promise<DaoSubmitResult> {
  const total = plan.batches.length + 1;
  onProgress?.(0, total);
  const first = await submitDao(privateKey, plan.batches[0].input, keyless);
  await waitConfirmed(first.hash);
  savePendingVote(meta.daoId, { tokenId: plan.voteTokenId, firstHash: first.hash, weighted: meta.weighted, title: meta.title });
  onProgress?.(1, total);
  for (let i = 1; i < plan.batches.length; i += 1) {
    await submitDao(privateKey, plan.batches[i].input, keyless);
    onProgress?.(i + 1, total);
  }
  const result = await submitDao(privateKey, plan.stage2(first.hash).input, keyless);
  clearPendingVote(meta.daoId);
  onProgress?.(total, total);
  return result;
}

/** 止まっていた投票の続き: まだ投票トークンを受け取っていない会員へ配り、最後に索引を登録する。 */
export async function submitResumeVote(
  privateKey: string,
  plan: ResumeVotePlan,
  pending: PendingVote,
  daoId: string,
  keyless?: KeylessSigner,
  onProgress?: BatchProgress,
): Promise<DaoSubmitResult> {
  const total = plan.batches.length + 1;
  onProgress?.(0, total);
  for (let i = 0; i < plan.batches.length; i += 1) {
    await submitDao(privateKey, plan.batches[i].input, keyless);
    onProgress?.(i + 1, total);
  }
  const result = await submitDao(privateKey, plan.stage2(pending.firstHash).input, keyless);
  clearPendingVote(daoId);
  onProgress?.(total, total);
  return result;
}
