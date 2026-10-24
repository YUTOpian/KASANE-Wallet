import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Divider, Link as MuiLink, Typography } from '@mui/material';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import AppToolBar from '../../components/AppToolBar';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import SignerTrustNotice from '../../components/SignerTrustNotice';
import { useNoKey } from '../../hooks/useWatchOnly';
import { WalletsHelper } from '../../lib/storage';
import { chainExplorerTxUrl, currencySymbol, prettyChainAddress } from '../../lib/chainApi';
import { fetchAccountPublicKey } from '../../lib/symbol/api';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { decryptMessage } from '../../lib/symbol/tx';
import { fetchHistoryDetailAny, isExpired } from '../../lib/symbol/history';
import type { DetailField, HistoryDetail, HistoryMosaic, HistoryStatus } from '../../lib/symbol/history';

const STATUSES: HistoryStatus[] = ['confirmed', 'unconfirmed', 'partial'];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ py: 0.75 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography component="div" sx={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{children}</Typography>
    </Box>
  );
}

function Fields({ fields }: { fields: DetailField[] }) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((f) => (
        <Row key={f.key} label={t(`history.field.${f.key}`, { defaultValue: f.key })}>{f.value}</Row>
      ))}
    </>
  );
}

interface TransferBodyProps {
  recipient: string;
  mosaics: HistoryMosaic[];
  message: string;
  encryptedMessage: boolean;
  encryptedPayload: string;
  signerAddress: string;
  signerPublicKey: string;
}

function TransferBody({ recipient, mosaics, message, encryptedMessage, encryptedPayload, signerAddress, signerPublicKey }: TransferBodyProps) {
  const { t } = useTranslation();
  // The decrypted text lives only in this component: it is never stored and is gone when the screen is left.
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [failed, setFailed] = useState('');
  // 閲覧用プロファイルには復号に使う秘密鍵が無い。
  const watchOnly = useNoKey();

  const onPassword = async (password: string) => {
    setPasswordOpen(false);
    try {
      const wallet = await WalletsHelper.getActive();
      const privateKey = wallet ? await WalletsHelper.decryptKey(wallet.id, password) : null;
      if (!wallet || privateKey == null) { setFailed(t('wallet.invalid_key')); return; }
      // The key is shared between the two sides: with the sender's public key we read what we received,
      // with the recipient's public key we read what we sent.
      const iAmSender = normalizeAddress(signerAddress) === normalizeAddress(wallet.address);
      let otherKey: string | null = signerPublicKey;
      if (iAmSender) otherKey = recipient.startsWith('@') ? null : (await fetchAccountPublicKey(recipient)).publicKey;
      const text = otherKey ? decryptMessage(privateKey, otherKey, encryptedPayload) : null;
      if (text === null) { setFailed(t('transaction.failed_to_decrypt')); return; }
      setDecrypted(text);
    } catch (e) {
      console.warn('Failed to decrypt the message', e);
      setFailed(t('transaction.failed_to_decrypt'));
    }
  };

  return (
    <>
      <Row label={t('transaction.to_label')}>{recipient.startsWith('@') ? recipient : prettyChainAddress(recipient)}</Row>
      <Row label={t('transaction.mosaics_label')}>
        {mosaics.length === 0 ? '-' : mosaics.map((m, i) => <div key={`${m.id}-${i}`}>{m.amount} {m.symbol}</div>)}
      </Row>
      {(message || encryptedMessage) && (
        <Row label={decrypted !== null ? `${t('common.message')}（${t('transaction.message_decrypted_tag')}）` : t('common.message')}>
          {!encryptedMessage ? message : decrypted !== null ? decrypted : t('transaction.message_is_encrypted')}
        </Row>
      )}
      {encryptedMessage && decrypted === null && encryptedPayload && !watchOnly && (
        <Button size="small" variant="outlined" startIcon={<LockOpenOutlinedIcon />} onClick={() => setPasswordOpen(true)} sx={{ mt: 0.5 }}>
          {t('transaction.decrypt_button')}
        </Button>
      )}
      <PasswordDialog open={passwordOpen} mode="check" popup onClose={() => setPasswordOpen(false)} onPass={onPassword} />
      <ErrorSnackbar message={failed} onClose={() => setFailed('')} />
    </>
  );
}

/** Detail of any Symbol transaction (looked up by hash), including the inner transactions and cosignatures of an aggregate. */
export default function SymbolTransactionDetail() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const hash = (params.get('hash') ?? '').toUpperCase();
  const statusParam = params.get('status') as HistoryStatus | null;
  const status: HistoryStatus = statusParam && STATUSES.includes(statusParam) ? statusParam : 'confirmed';

  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState(false);
  const loaded = useRef(false);
  // The node reported something for this account (the transaction may have just been confirmed).
  const liveTick = useAppStore((s) => s.liveTick);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!/^[0-9A-F]{64}$/.test(hash)) throw new Error('bad_hash');
        const wallet = await WalletsHelper.getActive();
        // It may have moved to another group since the link was made: look in all of them.
        const d = await fetchHistoryDetailAny(hash, status, wallet?.address ?? '');
        if (!cancelled) { loaded.current = true; setError(false); setDetail(d); }
      } catch (e) {
        console.warn('Failed to load transaction', e);
        // A failed background refresh keeps what is already shown.
        if (!cancelled && !loaded.current) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [hash, status, liveTick]);

  const explorerUrl = hash ? chainExplorerTxUrl(hash) : null;
  const item = detail?.item;
  const when = item ? (item.timestampMs ?? item.deadlineMs) : null;

  return (
    <Box sx={{ pb: 3 }}>
      <AppToolBar back="/top" title={t('transaction.detail_title')} />
      {error ? (
        <Alert severity="error" sx={{ m: 1.5 }}>{t('history.detail_failed')}</Alert>
      ) : !detail || !item ? (
        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}><CircularProgress color="primary" /></Box>
      ) : (
        <>
          <Card sx={{ m: 1, p: 1.5 }} elevation={0}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" sx={{ flexGrow: 1 }}>{t(`history.type.${item.category === 'transfer' ? (item.isReception ? 'transfer_received' : 'transfer_sent') : item.typeKey}`)}</Typography>
              {isExpired(item) && <Chip size="small" color="error" label={t('history.expired')} />}
              <Chip size="small" color={item.status === 'confirmed' ? 'success' : 'warning'} label={t(`history.status_${item.status}`)} />
            </Box>
            {when !== null && (
              <Row label={item.timestampMs !== null ? t('history.date') : t('history.deadline')}>{new Date(when).toLocaleString()}</Row>
            )}
            {item.height && <Row label={t('history.field.height')}>{item.height}</Row>}
            <Row label={t('history.signer')}>{prettyChainAddress(item.signerAddress)}</Row>
            <Row label={t('history.signer_public_key')}>{item.signerPublicKey}</Row>
            {item.fee !== '' && <Row label={t('common.fee')}>{item.fee} {currencySymbol()}</Row>}
          </Card>

          {/* 署名を求められている取引（署名待ち）：送ってきた相手がアドレス帳に無い／ブラックリストなら知らせる。 */}
          {item.status === 'partial' && !item.isOutgoing && <SignerTrustNotice address={item.signerAddress} sx={{ mx: 1, mt: 1 }} />}

          {isExpired(item) && (
            <Alert severity="error" sx={{ mx: 1, mt: 1 }}>{t(item.status === 'partial' ? 'history.expired_partial' : 'history.expired_unconfirmed')}</Alert>
          )}

          {item.category === 'transfer' && (
            <Card sx={{ m: 1, p: 1.5 }} elevation={0}>
              <TransferBody recipient={item.recipient} mosaics={item.mosaics} message={item.message} encryptedMessage={item.encryptedMessage} encryptedPayload={item.encryptedPayload} signerAddress={item.signerAddress} signerPublicKey={item.signerPublicKey} />
            </Card>
          )}

          {detail.fields.length > 0 && (
            <Card sx={{ m: 1, p: 1.5 }} elevation={0}><Fields fields={detail.fields} /></Card>
          )}

          {item.category === 'aggregate' && (
            <>
              <Typography sx={{ mx: 2, mt: 2, fontWeight: 600 }}>{t('history.inner_transactions')} ({detail.inner.length})</Typography>
              {detail.inner.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mx: 2 }}>{t('history.inner_unavailable')}</Typography>
              )}
              {detail.inner.map((inner, i) => (
                <Card key={i} sx={{ m: 1, p: 1.5 }} elevation={0}>
                  <Typography sx={{ fontWeight: 600 }}>{i + 1}. {t(`history.type.${inner.typeKey}`)}</Typography>
                  <Row label={t('history.signer')}>{prettyChainAddress(inner.signerAddress)}</Row>
                  {inner.transfer && <TransferBody {...inner.transfer} signerAddress={inner.signerAddress} signerPublicKey={inner.signerPublicKey} />}
                  <Fields fields={inner.fields} />
                </Card>
              ))}

              <Typography sx={{ mx: 2, mt: 2, fontWeight: 600 }}>{t('history.cosignatures')} ({detail.cosigners.length})</Typography>
              {detail.cosigners.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mx: 2 }}>{t('history.no_cosignatures')}</Typography>
              ) : (
                <Card sx={{ m: 1, p: 1.5 }} elevation={0}>
                  {detail.cosigners.map((c) => (
                    <Typography key={c.publicKey} sx={{ wordBreak: 'break-all', py: 0.25 }}>{prettyChainAddress(c.address)}</Typography>
                  ))}
                </Card>
              )}
            </>
          )}

          <Divider sx={{ my: 1 }} />
          <Card sx={{ m: 1, p: 1.5 }} elevation={0}>
            <Row label="Hash">
              {explorerUrl ? <MuiLink href={explorerUrl} target="_blank" rel="noopener">{item.hash}</MuiLink> : item.hash}
            </Row>
          </Card>
        </>
      )}
    </Box>
  );
}
