// What the chain knows about a typed NEM recipient (the NEM counterpart of fetchRecipientInfo / fetchTransfersWith in
// lib/symbol/api.ts), shown by the send form under the address field. NIS1 has no "unknown address" answer: an address that
// was never used simply reads as an empty account, so "unused" means no balance, no public key and no transfers.
import { formatAtomic } from '../symbol/amount';
import type { MosaicBalance, RecipientInfo, SymbolTransfer } from '../symbol/api';
import { NEM_CURRENCY_DIVISIBILITY } from './constants';
import { fetchNemBalances, fetchNemOwnedNamespaces, fetchNemTransfers, nodeRequest } from './api';
import { normalizeNemAddress } from './crypto';

export async function fetchNemRecipientInfo(address: string, recentCount = 6): Promise<RecipientInfo> {
  const addr = normalizeNemAddress(address);
  const account = await nodeRequest<{ account?: { balance?: number; publicKey?: string | null } }>(`/account/get?address=${addr}`);
  const balance = BigInt(account.account?.balance ?? 0);
  const publicKey = account.account?.publicKey ? account.account.publicKey.toUpperCase() : null;

  const [balances, owned, recent] = await Promise.all([
    fetchNemBalances(addr).catch(() => [] as MosaicBalance[]),
    fetchNemOwnedNamespaces(addr).catch(() => []),
    fetchNemTransfers(addr, recentCount, false).catch(() => [] as SymbolTransfer[]),
  ]);
  const exists = balance > 0n || publicKey !== null || recent.length > 0;
  if (!exists) return { exists, publicKey, mosaics: [], xym: '0', namespaces: [], recent: [] };
  return {
    exists,
    publicKey,
    mosaics: balances.filter((b) => b.amount > 0n),
    xym: formatAtomic(balance, NEM_CURRENCY_DIVISIBILITY), // XEM (the field keeps the Symbol name)
    namespaces: owned.filter((n) => !n.expired).map((n) => n.name),
    recent,
  };
}

/** Transfers between this wallet and `counterparty` (newest first), looked for in the wallet's latest 100 transfers. */
export async function fetchNemTransfersWith(myAddress: string, counterparty: string, limit = 20): Promise<SymbolTransfer[]> {
  const other = normalizeNemAddress(counterparty);
  const all = await fetchNemTransfers(myAddress, 100, true);
  return all
    .filter((t) => normalizeNemAddress(t.senderAddress) === other || normalizeNemAddress(t.receiverAddress) === other)
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit);
}
