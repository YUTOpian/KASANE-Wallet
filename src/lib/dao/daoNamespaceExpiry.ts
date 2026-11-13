// DAO のネームスペースの期限の判定（ネットワークに触れない部分）。画面の警告と、テストが使う。
// 期限の計算そのものは Symbol 側の更新画面と同じ（lib/symbol/namespaceRenew.ts）を使い、ここでは
// 「モザイクに紐付いている名前」から DAO が持つルートを探して、状態を決めるところだけを足す。
import type { OwnedNamespace } from '../symbol/api';
import { isExpiringSoon, isRenewableRoot, remainingDays } from '../symbol/namespaceRenew';

export type LinkedNamespaceState = 'none' | 'unknown' | 'ok' | 'soon' | 'expired';

export interface LinkedNamespaceStatus {
  state: LinkedNamespaceState;
  /** 期限を決めているルートの名前（"mydao.point" なら "mydao"）。 */
  rootName: string;
  /** 残りの日数（期限が近いときだけ）。 */
  days: number | null;
}

/** "mydao.point" → "mydao"。 */
export const rootNameOf = (fullName: string): string => fullName.split('.')[0] ?? '';

/**
 * モザイクに紐付いている名前の状態。期限は一番上のルートで決まる（サブネームスペースは親と一緒に切れる）。
 * - 紐付けなし: none
 * - DAO が持つルートが見つからない（他のアカウントのもの / 一覧を読めていない）: unknown（警告しない）
 * - 無期限・まだ余裕がある: ok / 1 か月以内: soon / 切れている: expired
 */
export function linkedNamespaceStatus(linkedName: string, owned: OwnedNamespace[] | null, nowMs: number): LinkedNamespaceStatus {
  const rootName = rootNameOf(linkedName);
  if (rootName === '') return { state: 'none', rootName, days: null };
  const root = owned?.find((n) => n.depth === 1 && n.name === rootName);
  if (!root) return { state: 'unknown', rootName, days: null };
  if (root.eternal) return { state: 'ok', rootName, days: null };
  if (root.expired) return { state: 'expired', rootName, days: null };
  if (isExpiringSoon(root, nowMs)) return { state: 'soon', rootName, days: remainingDays(root, nowMs) ?? 0 };
  return { state: 'ok', rootName, days: remainingDays(root, nowMs) };
}

/** 期限の状態（一覧の行の印）。サブネームスペースは親に従うので、親の行で見る。 */
export type NamespaceRowState = 'eternal' | 'ok' | 'soon' | 'expired';

export function namespaceRowState(n: OwnedNamespace, nowMs: number): NamespaceRowState {
  if (n.eternal) return 'eternal';
  if (n.expired) return 'expired';
  return isExpiringSoon(n, nowMs) ? 'soon' : 'ok';
}

/** 一覧の並び: ルートごとにまとめ（子は親のすぐ下）、ルートは期限が近い順（切れているものが先頭、無期限は最後）。 */
export function sortByRootExpiry(rows: OwnedNamespace[]): OwnedNamespace[] {
  const roots = rows.filter((r) => r.depth === 1);
  const key = (r: OwnedNamespace): number => (r.eternal || r.expiresAtMs === null ? Number.POSITIVE_INFINITY : r.expired ? Number.NEGATIVE_INFINITY : r.expiresAtMs);
  roots.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? a.name.localeCompare(b.name) : ka < kb ? -1 : 1;
  });
  const out: OwnedNamespace[] = [];
  for (const root of roots) {
    out.push(root);
    out.push(...rows.filter((r) => r.depth > 1 && rootNameOf(r.name) === root.name).sort((a, b) => a.name.localeCompare(b.name)));
  }
  // 親が一覧に無い子（まず無いが）も落とさない。
  const seen = new Set(out.map((r) => r.id));
  out.push(...rows.filter((r) => !seen.has(r.id)));
  return out;
}

/** 更新できる行か（ルートで無期限でないもの。期限切れも含む）。 */
export const canRenewRow = (n: OwnedNamespace): boolean => isRenewableRoot(n);
