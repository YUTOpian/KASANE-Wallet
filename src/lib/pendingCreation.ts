// The profile being created on the "ウォレットの作成" screen: name, password and the freshly generated recovery
// phrase live in memory only. Nothing is written to the device until the person passes the recovery phrase test
// (WalletCreationMnemonic); going back to the name screen keeps what was typed, and a reload throws it all away.
import type { ChainKey } from './chain';

export interface PendingCreation {
  chain: ChainKey;
  name: string;
  indexZeroName: string;
  password: string;
  phrase: string;
}

let pending: PendingCreation | null = null;

export function setPendingCreation(next: PendingCreation): void {
  pending = next;
}

export function getPendingCreation(): PendingCreation | null {
  return pending;
}

export function clearPendingCreation(): void {
  pending = null;
}
