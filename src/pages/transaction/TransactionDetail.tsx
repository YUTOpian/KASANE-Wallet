import { useEffect, useState } from 'react';
import { Box, Button, Card, Typography, Divider, Link as MuiLink } from '@mui/material';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppToolBar from '../../components/AppToolBar';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { useNoKey } from '../../hooks/useWatchOnly';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemAccountPublicKey } from '../../lib/nem/api';
import { normalizeNemAddress } from '../../lib/nem/crypto';
import { decryptNemMessage } from '../../lib/nem/message';
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
  const chain = useAppStore((s) => s.chain);
  // NEM: an encrypted message can be opened here. The text lives only in this component, never stored.
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [failed, setFailed] = useState('');
  // Watch-only and Ledger profiles have no private key to decrypt with.
  const noKey = useNoKey();

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
  const canDecrypt = chain === 'nem' && transaction.encryptedMessage && transaction.encryptedPayload !== '' && decrypted === null && !noKey;

  const onPassword = async (password: string) => {
    setPasswordOpen(false);
    try {
      const wallet = await WalletsHelper.getActive();
      const privateKey = wallet ? await WalletsHelper.decryptKey(wallet.id, password) : null;
      if (!wallet || privateKey == null) { setFailed(t('wallet.invalid_key')); return; }
      // The key is shared between the two sides: with the sender's public key we read what we received,
      // with the recipient's public key we read what we sent.
      const iAmSender = normalizeNemAddress(transaction.senderAddress) === normalizeNemAddress(wallet.address);
      const otherKey = iAmSender ? await fetchNemAccountPublicKey(transaction.receiverAddress) : transaction.signerPublicKey || null;
      const text = otherKey ? decryptNemMessage(privateKey, otherKey, transaction.encryptedPayload) : null;
      if (text === null) { setFailed(t('transaction.failed_to_decrypt')); return; }
      setDecrypted(text);
    } catch (e) {
      console.warn('Failed to decrypt the message', e);
      setFailed(t('transaction.failed_to_decrypt'));
    }
  };

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
              <Typography variant="body2" color="text.secondary">
                {decrypted !== null ? `${t('common.message')}（${t('transaction.message_decrypted_tag')}）` : t('common.message')}
              </Typography>
              <Typography sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {!transaction.encryptedMessage ? transaction.message : decrypted !== null ? decrypted : t('transaction.message_is_encrypted')}
              </Typography>
              {canDecrypt && (
                <Button size="small" variant="outlined" startIcon={<LockOpenOutlinedIcon />} onClick={() => setPasswordOpen(true)} sx={{ mt: 1, alignSelf: 'flex-start' }}>
                  {t('transaction.decrypt_button')}
                </Button>
              )}
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
      <PasswordDialog open={passwordOpen} mode="check" popup onClose={() => setPasswordOpen(false)} onPass={onPassword} />
      <ErrorSnackbar message={failed} onClose={() => setFailed('')} />
    </Box>
  );
}
