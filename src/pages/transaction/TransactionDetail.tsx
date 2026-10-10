import { useEffect } from 'react';
import { Box, Card, Typography, Divider, Link as MuiLink } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppToolBar from '../../components/AppToolBar';
import { TransactionWrapper } from '../../lib/transactionWrapper';
import { chainExplorerTxUrl, currencySymbol, nativeIcon, prettyChainAddress } from '../../lib/chainApi';
import { chainMeta } from '../../lib/chain';
import { useAppStore } from '../../store/appStore';
import iconReceiveGreen from '../../assets/icon_transaction_receive_green.png';
import iconReceiveRed from '../../assets/icon_transaction_receive_red.png';
import iconCheck from '../../assets/icon_transaction_check.png';
import iconUnconfirmed from '../../assets/icon_transaction_unconfirmed.png';

export default function TransactionDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const transaction = useAppStore((s) => s.transaction);

  useEffect(() => {
    // Fail safe: land here directly (e.g. a stale bookmark) with no transaction selected.
    if (transaction === null || !(transaction instanceof TransactionWrapper)) {
      navigate('/top', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction]);

  if (transaction === null) {
    return null;
  }

  const explorerUrl = transaction.hash ? chainExplorerTxUrl(transaction.hash) : null;

  return (
    <Box>
      <AppToolBar back="/top" title={t('transaction.detail_title')} />
      <Card sx={{ m: 1 }} elevation={0}>
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Box component="img" src={nativeIcon()} sx={{ width: 16, height: 16, mr: 0.5, borderRadius: '50%' }} />
            <span>{transaction.dateString} {transaction.timeString}</span>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="body2" color="text.secondary">{chainMeta().name}</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
            <Box component="img" src={transaction.isReception ? iconReceiveGreen : iconReceiveRed} sx={{ width: 16, height: 16 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', ml: 1, flexGrow: 1 }}>
              <Typography component="span" sx={{ fontSize: 'large', color: transaction.isReception ? 'primary.main' : 'nemOrange', fontWeight: 'bold' }}>
                {transaction.isReception ? '+' : '-'}
              </Typography>
              <Typography component="span" sx={{ fontSize: 'large', ml: 0.5 }}>{transaction.amount} {transaction.currencySymbol}</Typography>
              <Box sx={{ flexGrow: 1 }} />
              <Box component="img" src={transaction.isConfirmed ? iconCheck : iconUnconfirmed} sx={{ width: 16, height: 16 }} />
            </Box>
          </Box>
        </Box>
      </Card>
      <Divider />

      <Card sx={{ m: 1 }} elevation={0}>
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
          <Typography variant="body2" color="text.secondary">{t('transaction.from_label')}</Typography>
          <Typography sx={{ color: 'primary.main', wordBreak: 'break-all' }}>{prettyChainAddress(transaction.senderAddress)}</Typography>
        </Box>
      </Card>
      <Divider />

      <Card sx={{ m: 1 }} elevation={0}>
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
          <Typography variant="body2" color="text.secondary">{t('transaction.to_label')}</Typography>
          <Typography sx={{ color: 'primary.main', wordBreak: 'break-all' }}>
            {transaction.receiverAddress.startsWith('@') ? transaction.receiverAddress : prettyChainAddress(transaction.receiverAddress)}
          </Typography>
        </Box>
      </Card>
      <Divider />

      <Card sx={{ m: 1 }} elevation={0}>
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
          <Typography variant="body2" color="text.secondary">{t('transaction.mosaics_label')}</Typography>
          {transaction.mosaics.map((m, i) => (
            <Typography key={`${m.id}-${i}`} sx={{ wordBreak: 'break-all' }}>{m.amount} {m.symbol}</Typography>
          ))}
          {transaction.feeAmount !== '' && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('common.fee')}: {transaction.feeAmount} {currencySymbol()}
            </Typography>
          )}
        </Box>
      </Card>
      <Divider />

      {(transaction.message || transaction.encryptedMessage) && (
        <>
          <Card sx={{ m: 1 }} elevation={0}>
            <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
              <Typography variant="body2" color="text.secondary">{t('common.message')}</Typography>
              <Typography sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {transaction.encryptedMessage ? t('transaction.message_is_encrypted') : transaction.message}
              </Typography>
            </Box>
          </Card>
          <Divider />
        </>
      )}

      <Card sx={{ m: 1 }} elevation={0}>
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
          <Typography variant="body2" color="text.secondary">Hash:</Typography>
          {explorerUrl ? (
            <MuiLink href={explorerUrl} target="_blank" rel="noopener" sx={{ wordBreak: 'break-all' }}>{transaction.hash}</MuiLink>
          ) : (
            <Typography sx={{ wordBreak: 'break-all' }}>{transaction.hash}</Typography>
          )}
        </Box>
      </Card>
      <Divider />
    </Box>
  );
}
