import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { cosignPartial, fetchMultisigInfo, fetchPartialTransactions } from '../../lib/symbol/multisigApi';
import type { MultisigInfo, PartialItem, PartialTransaction } from '../../lib/symbol/multisigApi';
import { useAppStore } from '../../store/appStore';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

function ItemView({ item }: { item: PartialItem }) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (item.kind === 'transfer') {
    lines.push(`${t('multisig.item_to')}: ${item.recipient}`);
    lines.push(item.mosaics.map((m) => `${m.amount} ${m.symbol}`).join(', '));
    if (item.encrypted) lines.push(t('multisig.item_encrypted'));
    else if (item.message) lines.push(`${t('multisig.item_message')}: ${item.message}`);
  } else if (item.kind === 'multisig') {
    if (item.additions.length) lines.push(`${t('multisig.item_add')}:\n${item.additions.join('\n')}`);
    if (item.deletions.length) lines.push(`${t('multisig.item_remove')}:\n${item.deletions.join('\n')}`);
    lines.push(t('multisig.item_thresholds', { approval: signed(item.minApprovalDelta), removal: signed(item.minRemovalDelta) }));
  }
  const title = item.kind === 'transfer' ? t('multisig.item_transfer', { account: item.account })
    : item.kind === 'multisig' ? t('multisig.item_multisig', { account: item.account })
      : t('multisig.item_other', { account: item.account });
  return (
    <Box sx={{ mb: 1 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', ...mono }}>{title}</Typography>
      {lines.map((l, i) => <Typography key={i} variant="body2" sx={{ whiteSpace: 'pre-wrap', ...mono }}>{l}</Typography>)}
    </Box>
  );
}
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

// 「マルチシグ」: the account's own multisig state, the multisig accounts this wallet cosigns for,
// and the transactions waiting for a signature (with a cosign button).
export default function MultisigTop() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [mine, setMine] = useState<MultisigInfo | null>(null);
  const [parents, setParents] = useState<MultisigInfo[]>([]);
  const [pending, setPending] = useState<PartialTransaction[]>([]);
  const [cosignHash, setCosignHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const info = await fetchMultisigInfo(wallet.address);
      const infos = await Promise.all(info.multisigOf.map((a) => fetchMultisigInfo(a)));
      setMine(info);
      setParents(infos);
      setPending(await fetchPartialTransactions(wallet.address, wallet.publicKey, info.multisigOf));
    } catch (e) {
      console.error('Failed to load multisig', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, network]);

  const onPass = async (password: string) => {
    const hash = cosignHash;
    setCosignHash(null);
    if (!hash) return;
    setBusy(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      await cosignPartial(privateKey, hash);
      setNotice(t('multisig.cosign_done'));
    } catch (e) {
      console.error('Cosign failed', e);
      setErrorMessage(`${t('multisig.cosign_failed')}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('multisig.intro')}</Typography>
        {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2 }}>{notice}</Alert>}
        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>{t('multisig.reload')}</Button>}>
            {t('multisig.load_failed')}
          </Alert>
        )}

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('multisig.status_title')}</Typography>
        {loading && !mine ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>
        ) : mine && (
          <Card variant="outlined" sx={{ px: 2, py: 1.5, mb: 2 }}>
            <Chip size="small" color={mine.isMultisig ? 'primary' : 'default'} label={mine.isMultisig ? t('multisig.status_multisig') : t('multisig.status_normal')} sx={{ mb: 1 }} />
            {mine.isMultisig ? (
              <>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {t('multisig.threshold_text', { approval: mine.minApproval, removal: mine.minRemoval, count: mine.cosignatories.length })}
                </Typography>
                {mine.cosignatories.map((a) => <Typography key={a} variant="body2" sx={mono}>{a}</Typography>)}
                <Alert severity="info" sx={{ mt: 1.5 }}>{t('multisig.is_multisig_note')}</Alert>
              </>
            ) : (
              <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/multisig/convert')} sx={{ mt: 0.5 }}>
                {t('multisig.convert_button')}
              </Button>
            )}
          </Card>
        )}

        <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t('multisig.cosigning_title')}</Typography>
        {parents.length === 0 && !loading && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('multisig.cosigning_none')}</Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
          {parents.map((p) => (
            <Card key={p.address} variant="outlined" sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5, ...mono }}>{p.address}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
                {t('multisig.threshold_text', { approval: p.minApproval, removal: p.minRemoval, count: p.cosignatories.length })}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button variant="contained" color="primary" fullWidth onClick={() => navigate(`/multisig/send?account=${p.address}`)}>{t('multisig.send_button')}</Button>
                <Button variant="outlined" color="primary" fullWidth onClick={() => navigate(`/multisig/convert?account=${p.address}`)}>{t('multisig.edit_button')}</Button>
              </Box>
            </Card>
          ))}
        </Box>

        <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t('multisig.pending_title')}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t('multisig.pending_hint')}</Typography>
        {pending.length === 0 && !loading && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('multisig.pending_none')}</Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {pending.map((p) => (
            <Card key={p.hash} variant="outlined" sx={{ px: 2, py: 1.5 }}>
              {p.items.map((item, i) => <ItemView key={i} item={item} />)}
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ...mono }}>
                {t('multisig.initiator_label')}: {p.initiator}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                {t('multisig.deadline_label')}: {new Date(p.deadlineMs).toLocaleString()} / {t('multisig.cosigned_count', { count: p.cosignedBy })}
              </Typography>
              {p.signedByMe ? (
                <Chip size="small" color="success" label={t('multisig.signed_by_me')} sx={{ mt: 1 }} />
              ) : (
                <Button variant="contained" color="primary" fullWidth disabled={busy} onClick={() => setCosignHash(p.hash)} sx={{ mt: 1.5 }}>
                  {t('multisig.cosign_button')}
                </Button>
              )}
            </Card>
          ))}
        </Box>
        {!loading && <Button onClick={load} sx={{ mt: 2 }}>{t('multisig.reload')}</Button>}
      </Box>
      <PasswordDialog open={cosignHash !== null} mode="check" onClose={() => setCosignHash(null)} onPass={onPass} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
