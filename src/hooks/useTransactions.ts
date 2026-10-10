import { useState, useCallback } from 'react';
import { TransactionWrapper } from '../lib/transactionWrapper';
import { WalletsHelper } from '../lib/storage';
import { fetchChainTransfers } from '../lib/chainApi';

// History comes straight from the Symbol REST gateway (confirmed + unconfirmed transfers,
// including transfers embedded in aggregate transactions).
export function useTransactions() {
  const [confirmedTransactions, setConfirmedTransactions] = useState<TransactionWrapper[]>([]);
  const [unconfirmedTransactions, setUnconfirmedTransactions] = useState<TransactionWrapper[]>([]);

  const fetchTransactions = useCallback(async (
    count: number = 10,
    withUnconfirmedTransactions: boolean = true,
    onFetched: (confirmed: TransactionWrapper[], unconfirmed: TransactionWrapper[]) => void = () => {},
  ) => {
    const activeWallet = await WalletsHelper.getActive();
    if (activeWallet == null) {
      setConfirmedTransactions([]);
      setUnconfirmedTransactions([]);
      onFetched([], []);
      return;
    }
    const transfers = await fetchChainTransfers(activeWallet.address, count, withUnconfirmedTransactions);
    const wrapped = transfers.map((t) => ({
      confirmed: t.isConfirmed,
      tx: new TransactionWrapper({
        hash: t.hash,
        timestamp: new Date(t.timestampMs),
        isReception: t.isReception,
        isConfirmed: t.isConfirmed,
        senderAddress: t.senderAddress,
        receiverAddress: t.receiverAddress,
        mosaics: t.mosaics,
        message: t.message,
        encryptedMessage: t.encryptedMessage,
        feeAmount: t.fee,
      }),
    }));
    const confirmed = wrapped.filter((w) => w.confirmed).map((w) => w.tx);
    const unconfirmed = wrapped.filter((w) => !w.confirmed).map((w) => w.tx);
    setConfirmedTransactions(confirmed);
    setUnconfirmedTransactions(unconfirmed);
    onFetched(confirmed, unconfirmed);
  }, []);

  return { confirmedTransactions, unconfirmedTransactions, fetchTransactions };
}
