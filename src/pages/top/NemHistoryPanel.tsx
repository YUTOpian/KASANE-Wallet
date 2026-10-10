import { useEffect, useState } from 'react';
import { Box, Card, CardActionArea, Typography, CircularProgress, Divider, IconButton } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTransactions } from '../../hooks/useTransactions';
import type { TransactionWrapper } from '../../lib/transactionWrapper';
import { useAppStore } from '../../store/appStore';
import { WalletsHelper } from '../../lib/storage';
import { chainExplorerAccountUrl } from '../../lib/chainApi';
import emptyImage from '../../assets/image_empty1_large.png';
import iconReceiveGreen from '../../assets/icon_transaction_receive_green.png';
import iconReceiveRed from '../../assets/icon_transaction_receive_red.png';
import iconCheck from '../../assets/icon_transaction_check.png';
import iconUnconfirmed from '../../assets/icon_transaction_unconfirmed.png';

/** NEM history, shown inside Home's 取引履歴 section (it used to be a page of its own, /transaction/list). */
export default function NemHistoryPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { fetchTransactions } = useTransactions();
  const setTransaction = useAppStore((s) => s.setTransaction);
  const transactionListCache = useAppStore((s) => s.transactionListCache);
  const setTransactionListCache = useAppStore((s) => s.setTransactionListCache);

  // Seed from the cached result of the previous visit (if any) so returning to this screen
  // shows the last-known list instantly instead of a blank spinner. A background refetch
  // below (which runs every time regardless of whether a cache existed) then replaces both
  // this state and the store cache once fresh data arrives, so anything that changed on-chain
  // since the last visit still shows up "in real time" - just without the loading flash.
  const [loading, setLoading] = useState(transactionListCache == null);
  const [grouped, setGrouped] = useState<Record<string, TransactionWrapper[]>>(transactionListCache?.grouped ?? {});
  const [walletAddress, setWalletAddress] = useState('');
  const network = useAppStore((st) => st.network);

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActive();
      setWalletAddress(wallet?.address ?? '');
    })();
  }, [network]);

  // "View my transactions on a block explorer" - opens the address page in the system browser.
  const openExplorer = () => {
    if (walletAddress) window.open(chainExplorerAccountUrl(walletAddress), '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    (async () => {
      // Only show the spinner when there's nothing cached to display yet - if we already
      // have a previous result on screen (from transactionListCache), this fetch happens
      // quietly in the background and simply swaps the list once it resolves, rather than
      // hiding the existing content behind a spinner every time this screen is opened.
      if (transactionListCache == null) {
        setLoading(true);
      }
      await fetchTransactions(100, true, async (confirmed, unconfirmed) => {
        const all = [...unconfirmed, ...confirmed];
        const next: Record<string, TransactionWrapper[]> = {};
        for (const transaction of all) {
          const key = transaction.dateString;
          (next[key] ??= []).push(transaction);
        }
        setGrouped(next);
        setLoading(false);


        // Save this fetch's result so the next time this screen is opened (without a full
        // reload) it can render immediately from cache while a fresh fetch runs underneath.
        setTransactionListCache({ grouped: next });
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToDetail = (transaction: TransactionWrapper) => {
    setTransaction(transaction);
    navigate('/transaction/detail');
  };

  const dateKeys = Object.keys(grouped).slice().reverse();

  return (
    <Box sx={{ pb: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, pt: 0.5 }}>
        <IconButton onClick={openExplorer} aria-label={t('common.view_on_explorer')} color="primary">
          <OpenInNewIcon />
        </IconButton>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>



        {loading ? (
          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}>
            <CircularProgress color="primary" />
          </Box>
        ) : dateKeys.length === 0 ? (
          <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Box component="img" src={emptyImage} sx={{ width: '50%' }} />
            <Typography sx={{ fontSize: 'large', color: 'text.secondary' }}>{t('transaction.no_transaction_title')}</Typography>
            <Typography sx={{ color: 'text.secondary' }}>
              {(t('transaction.no_transaction_message', { returnObjects: true }) as string[]).map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </Typography>
          </Box>
        ) : (
          dateKeys.map((dateKey) => (
            <Box key={dateKey}>
              <Divider />
              <Typography sx={{ mt: 1, px: 2 }}>{grouped[dateKey][0].dateString}</Typography>
              <Divider />
              {grouped[dateKey].map((transaction, index) => (
                <Box key={index}>
                  <Card sx={{ m: 1 }} elevation={0}>
                    <CardActionArea onClick={() => goToDetail(transaction)}>
                      <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <Box component="img" src={transaction.isReception ? iconReceiveGreen : iconReceiveRed} sx={{ width: 16, height: 16 }} />
                          <Box sx={{ display: 'flex', alignItems: 'center', ml: 1, flexGrow: 1 }}>
                            <Typography component="span" sx={{ fontSize: 'large', color: transaction.isReception ? 'primary.main' : 'nemOrange', fontWeight: 'bold' }}>
                              {transaction.isReception ? '+' : '-'}
                            </Typography>
                            <Typography component="span" sx={{ fontSize: 'large', ml: 0.5 }}>
                              {transaction.amount} {transaction.currencySymbol}{transaction.extraMosaicCount > 0 ? ` (+${transaction.extraMosaicCount})` : ''}
                            </Typography>
                            <Box sx={{ flexGrow: 1 }} />
                            <Box component="img" src={transaction.isConfirmed ? iconCheck : iconUnconfirmed} sx={{ width: 16, height: 16 }} />
                          </Box>
                        </Box>
                        <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary', wordBreak: 'break-all' }}>
                          {t('transaction.from_label')}: {transaction.senderAddress}
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>
                          {t('transaction.to_label')}: {transaction.receiverAddress}
                        </Typography>
                      </Box>
                    </CardActionArea>
                  </Card>
                  {index < grouped[dateKey].length - 1 && <Divider />}
                </Box>
              ))}
            </Box>
          ))
        )}
      </Box>


    </Box>
  );
}
