import { useState, useCallback, useRef } from 'react';
import { WalletsHelper } from '../lib/storage';
import { fetchChainBalances } from '../lib/chainApi';
import { useAppStore } from '../store/appStore';

// XYM / XEM balance of the active wallet on the selected chain and network, for the Home balance card.
export function useSymbolBalance() {
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const [xymBalance, setXymBalance] = useState('0');
  const [mosaicCount, setMosaicCount] = useState(0);
  // Requests can overlap (an event burst, a network switch): a slow older answer must not overwrite a newer one.
  const latest = useRef(0);

  const fetchXymBalance = useCallback(async (): Promise<{ xym: string; mosaicCount: number } | null> => {
    const seq = (latest.current += 1);
    const activeWallet = await WalletsHelper.getActive();
    if (activeWallet == null) {
      setXymBalance('0');
      setMosaicCount(0);
      return { xym: '0', mosaicCount: 0 };
    }
    try {
      const balances = await fetchChainBalances(activeWallet.address);
      const xym = balances[0]?.balance ?? '0'; // the currency (XYM / XEM) is always listed first
      const others = balances.filter((b, i) => i > 0 && b.amount > 0n).length;
      if (seq === latest.current) {
        setXymBalance(xym);
        setMosaicCount(others);
      }
      return { xym, mosaicCount: others };
    } catch (e) {
      // Keep the previous values on a transient node failure rather than flashing to zero.
      console.error('Failed to fetch balances', e);
      return null;
    }
    // `network` gives this callback a new identity when the network changes, so effects keyed on
    // it (Home's `update`) refetch against the newly selected network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, chain]);

  const hydrateBalances = useCallback((entry: { xym: string; mosaicCount: number }) => {
    setXymBalance(entry.xym);
    setMosaicCount(entry.mosaicCount);
  }, []);

  return { xymBalance, mosaicCount, fetchXymBalance, hydrateBalances };
}
