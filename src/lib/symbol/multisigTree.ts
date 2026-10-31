// マルチレベルマルチシグ（連署者がさらにマルチシグ）: the cosigner hierarchy of a multisig account, and what it takes to approve.
//
// In Symbol only ordinary (non-multisig) accounts can sign. A multisig account that is itself a cosigner is "approved"
// when enough of ITS cosigners have signed, and so on down the tree. So the signatures an aggregate really carries
// always come from the leaves of the tree. Everything here is pure (no network): the graph is fetched by
// `fetchCosignerGraph` / `fetchCosignedAccounts` in multisigApi.ts.
import { normalizeAddress } from './crypto';
import type { MultisigInfo } from './multisigApi';

/** The network allows multisig accounts to be nested this deep (maxMultisigDepth); the live value is read when possible. */
export const MAX_MULTISIG_DEPTH = 3;

export type MultisigNodeInfo = Pick<MultisigInfo, 'address' | 'minApproval' | 'minRemoval' | 'cosignatories' | 'isMultisig'>;
/** Every account looked at, by (normalized) address. An account that is not a multisig account is a leaf. */
export type MultisigGraph = ReadonlyMap<string, MultisigNodeInfo>;

const isNode = (graph: MultisigGraph, address: string) => graph.get(address)?.isMultisig === true;

/**
 * The fewest further signatures needed to approve `root`, given the leaf accounts that have already signed
 * (`signed`). 0 = approved. A multisig account needs `minApproval` of its cosigners approved, and the cheapest
 * ones are picked. A leaf costs 1 (0 when it has signed). Infinity = it cannot be approved (a loop, or fewer
 * cosigners than the threshold).
 *
 * An account that appears under two branches is counted in both, so with shared accounts the result can be larger
 * than the true minimum. That is the safe side for a fee.
 */
export function missingSignatures(graph: MultisigGraph, root: string, signed: ReadonlySet<string> = new Set()): number {
  const walk = (address: string, path: Set<string>): number => {
    const node = graph.get(address);
    if (!node || !node.isMultisig) return signed.has(address) ? 0 : 1;
    if (path.has(address)) return Infinity;
    path.add(address);
    const costs = node.cosignatories.map((c) => walk(c, path)).sort((a, b) => a - b);
    path.delete(address);
    if (node.minApproval > costs.length) return Infinity;
    return costs.slice(0, Math.max(node.minApproval, 0)).reduce((sum, n) => sum + n, 0);
  };
  return walk(root, new Set());
}

/** Whether `address` is a cosigner of `root` at any depth (a multisig account in between counts too). */
export function isCosignerAtAnyDepth(graph: MultisigGraph, root: string, address: string): boolean {
  const seen = new Set<string>();
  const walk = (a: string): boolean => {
    if (seen.has(a)) return false;
    seen.add(a);
    const node = graph.get(a);
    if (!node || !node.isMultisig) return false;
    return node.cosignatories.some((c) => c === address || walk(c));
  };
  return walk(root);
}

export interface ApprovalPlan {
  /** The wallet can sign for the account: an ordinary account that cosigns it, directly or through other multisig accounts. */
  eligible: boolean;
  /** The wallet's signature alone approves the account, so the aggregate can be a complete one. */
  selfSufficient: boolean;
  /** Signatures still to be collected from other accounts (the wallet, as the aggregate's signer, is not counted). */
  others: number;
}

/** What it takes for `wallet` to get a transaction of the multisig account `root` approved. */
export function planApproval(graph: MultisigGraph, rootAddress: string, walletAddress: string): ApprovalPlan {
  const root = normalizeAddress(rootAddress);
  const wallet = normalizeAddress(walletAddress);
  const eligible = wallet !== root && !isNode(graph, wallet) && isCosignerAtAnyDepth(graph, root, wallet);
  const others = missingSignatures(graph, root, eligible ? new Set([wallet]) : new Set());
  return { eligible, selfSufficient: eligible && others === 0, others };
}

/**
 * Signatures to leave room for in the fee of an aggregate that must be signed for `root` and (for a multisig
 * modification) by each of the cosigners being added. Added cosigners have to opt in, and a multisig one does so
 * through its own cosigners. `root` is null when the account being converted is the wallet itself.
 */
export function modificationCosignatures(graph: MultisigGraph, root: string | null, added: string[], walletAddress: string): number {
  const signed = new Set([normalizeAddress(walletAddress)]);
  let total = root === null ? 0 : missingSignatures(graph, normalizeAddress(root), signed);
  for (const a of added) total += missingSignatures(graph, normalizeAddress(a), signed);
  return total;
}

/** Number of multisig levels at and below `address`: 0 for an ordinary account, 1 for a multisig account of ordinary ones, … */
export function levelsBelow(graph: MultisigGraph, address: string): number {
  const walk = (a: string, path: Set<string>): number => {
    const node = graph.get(a);
    if (!node || !node.isMultisig || path.has(a)) return 0;
    path.add(a);
    const deepest = Math.max(0, ...node.cosignatories.map((c) => walk(c, path)));
    path.delete(a);
    return 1 + deepest;
  };
  return walk(address, new Set());
}

/**
 * How deep the multisig chain gets once `target` has `cosigners` (everything that will cosign it).
 * `levelsAbove` = how many multisig accounts sit above `target` (the accounts it cosigns for, transitively).
 */
export function depthAfterChange(graph: MultisigGraph, cosigners: string[], levelsAbove: number): number {
  return levelsAbove + 1 + Math.max(0, ...cosigners.map((c) => levelsBelow(graph, c)));
}

/** Merges several graphs (the first one wins for an account that is in more than one). */
export function mergeGraphs(...graphs: MultisigGraph[]): MultisigGraph {
  const out = new Map<string, MultisigNodeInfo>();
  for (const g of graphs) for (const [k, v] of g) if (!out.has(k)) out.set(k, v);
  return out;
}

/** The cosigner tree as indented rows, for display: each row has its depth and, for a multisig account, its threshold. */
export interface TreeRow {
  address: string;
  depth: number;
  multisig: boolean;
  minApproval: number;
  cosignerCount: number;
  /** An account that already appeared higher up (a loop or a shared account): not expanded again. */
  repeated: boolean;
}

export function treeRows(graph: MultisigGraph, root: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (address: string, depth: number, path: Set<string>) => {
    const node = graph.get(address);
    const multisig = node?.isMultisig === true;
    const repeated = path.has(address);
    rows.push({
      address,
      depth,
      multisig,
      minApproval: multisig ? node!.minApproval : 0,
      cosignerCount: multisig ? node!.cosignatories.length : 0,
      repeated,
    });
    if (!multisig || repeated) return;
    path.add(address);
    for (const c of node!.cosignatories) walk(c, depth + 1, path);
    path.delete(address);
  };
  const node = graph.get(root);
  if (node?.isMultisig) {
    const path = new Set([root]);
    for (const c of node.cosignatories) walk(c, 0, path);
  }
  return rows;
}
