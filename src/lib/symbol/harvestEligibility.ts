// 開始前の資格チェック: whether an account (balance, importance) and a node can be used to start delegated harvesting.
// Pure: the figures come from fetchHarvestStatus / checkHarvestNode in api.ts. An item is
//   ok      - fine
//   warn    - something to know about, but harvesting can still be started
//   ng      - it will not work: starting is blocked
//   unknown - could not be checked
import type { HarvestNodeCheck } from './api';

export type CheckState = 'ok' | 'warn' | 'ng' | 'unknown';
export interface CheckItem {
  id: string;
  state: CheckState;
  /** Numbers for the message (formatted by the caller where they are amounts). */
  blocks?: number;
}

/** A node more than this many blocks behind is called out. */
export const NODE_BEHIND_WARN_BLOCKS = 100;

/** The account's side: enough XYM (not too much), and an importance. */
export function planAccountChecks(input: { balance: bigint; min: bigint; max: bigint; importance: bigint }): CheckItem[] {
  return [
    { id: 'balance_min', state: input.balance >= input.min ? 'ok' : 'ng' },
    { id: 'balance_max', state: input.balance <= input.max ? 'ok' : 'ng' },
    // Importance is worked out by the network every set number of blocks: a new account has none yet, and the
    // links can already be made, so this only warns.
    { id: 'importance', state: input.importance > 0n ? 'ok' : 'warn' },
  ];
}

/** The node's side. Only what could be read is listed; `check` null (nothing chosen yet) lists nothing. */
export function planNodeChecks(check: HarvestNodeCheck | null): CheckItem[] {
  if (check === null) return [];
  const items: CheckItem[] = [];
  if (check.reachable === null) items.push({ id: 'reachable', state: 'unknown' });
  else if (!check.reachable) items.push({ id: 'reachable', state: 'warn' });
  else items.push({ id: 'reachable', state: 'ok' });
  if (check.networkMatches !== null) items.push({ id: 'network', state: check.networkMatches ? 'ok' : 'ng' });
  if (check.isPeer !== null) items.push({ id: 'peer', state: check.isPeer ? 'ok' : 'ng' });
  if (check.keyMatches !== null) items.push({ id: 'key', state: check.keyMatches ? 'ok' : 'warn' });
  if (check.behindBlocks !== null) items.push({ id: 'synced', state: check.behindBlocks > NODE_BEHIND_WARN_BLOCKS ? 'warn' : 'ok', blocks: check.behindBlocks });
  if (check.healthy !== null) items.push({ id: 'health', state: check.healthy ? 'ok' : 'warn' });
  // Whether the node accepts delegated harvesters is a setting of the node and cannot be read from outside.
  items.push({ id: 'delegation', state: 'unknown' });
  return items;
}

/** Starting is blocked while any item is ng. */
export const hasBlocking = (items: CheckItem[]): boolean => items.some((i) => i.state === 'ng');
