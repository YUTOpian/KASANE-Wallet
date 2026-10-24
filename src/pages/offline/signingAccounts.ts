import { useEffect, useState } from 'react';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import type { ChainKey } from '../../lib/chain';

// The accounts the offline screens can sign with: every account of the chain (Symbol by default) that has a key (a view-only profile cannot
// sign), not only the active one. Nothing here talks to a node.

/** How an account is named in the picker: the same way the account screens name it. */
export function accountLabel(w: Wallet, importedLabel: string): string {
  if (w.accountIndex === null) return `${w.name} · ${w.accountName || importedLabel}`;
  return w.accountName ? `${w.name} · ${w.accountName}` : `${w.name} #${w.accountIndex}`;
}

/**
 * `noLedger`: leave out Ledger accounts even on Symbol. For screens that sign raw bytes (a signed message): the Symbol Ledger app
 * signs transactions, not arbitrary data.
 */
export function useSigningAccounts(chain: ChainKey = 'symbol', opts: { noLedger?: boolean } = {}) {
  const noLedger = opts.noLedger === true;
  const [accounts, setAccounts] = useState<Wallet[]>([]);
  const [signerId, setSignerId] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [all, active] = await Promise.all([WalletsHelper.gets(), WalletsHelper.getActive(chain)]);
      if (cancelled) return;
      const list = all
        .filter((w) => w.chain === chain && !w.watchOnly && w.publicKey !== '' && ((chain === 'symbol' && !noLedger) || !w.ledger) && (!w.hidden || w.id === active?.id))
        .sort((a, b) => a.name.localeCompare(b.name) || (a.accountIndex ?? Number.MAX_SAFE_INTEGER) - (b.accountIndex ?? Number.MAX_SAFE_INTEGER));
      setAccounts(list);
      setSignerId((cur) => cur || (active && list.some((w) => w.id === active.id) ? active.id : list[0]?.id ?? ''));
    })().catch((e) => console.error('Failed to load the accounts', e));
    return () => { cancelled = true; };
  }, [chain, noLedger]);
  const signer = accounts.find((w) => w.id === signerId) ?? null;
  return { accounts, signerId, setSignerId, signer };
}
