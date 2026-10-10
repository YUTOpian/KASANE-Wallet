import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemMultisigInfo, fetchNemPending, sendNemCosignature } from '../../lib/nem/multisigApi';
import type { NemMultisigInfo, NemPendingTransaction } from '../../lib/nem/multisigApi';
import { useAppStore } from '../../store/appStore';

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function Summary({ p }: { p: NemPendingTransaction }) {
  const { t } = useTranslation();
  const s = p.summary;
  const lines: string[] = [];
  let title = t('multisig.item_other', { account: p.multisigAddress });
  if (s.kind === 'transfer') {
    title = t('multisig.item_transfer', { account: p.multisigAddress });
    lines.push(`${t('multisig.item_to')}: ${s.recipient}`, s.amount);
    if (s.message) lines.push(`${t('multisig.item_message')}: ${s.message}`);
  } else if (s.kind === 'modification') {
    title = t('multisig.item_multisig', { account: p.multisigAddress });
    if (s.additions.length) lines.push(`${t('multisig.item_add')}:\n${s.additions.join('\n')}`);
    if (s.deletions.length) lines.push(`${t('multisig.item_remove')}:\n${s.deletions.join('\n')}`);
    if (s.delta !== 0) lines.push(t('nemmultisig.item_threshold_delta', { delta: signed(s.delta) }));
  }
  return (
    <Box sx={{ mb: 1 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', ...mono }}>{title}</Typography>
      {lines.map((l, i) => <Typography key={i} variant="body2" sx={{ whiteSpace: 'pre-wrap', ...mono }}>{l}</Typography>)}
    </Box>
  );
}

// NEM 「マルチシグ」: this wallet's multisig state, the multisig accounts it cosigns for, and the
// transactions waiting for a signature (with a cosign button).
export default function NemMultisigTop() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [mine, setMine] = useState<NemMultisigInfo | null>(null);
  const [parents, setParents] = useState<NemMultisigInfo[]>([]);
  const [pending, setPending] = useState<NemPendingTransaction[]>([]);
  const [cosign, setCosign] = useState<NemPendingTransaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const info = await fetchNemMultisigInfo(wallet.address);
      const infos = await Promise.all(info.multisigOf.map((a) => fetchNemMultisigInfo(a.address)));
      setMine(info);
      setParents(infos);
      setPending(await fetchNemPending(wallet.address, wallet.publicKey, info.multisigOf.map((a) => a.address)));
    } catch (e) {
      console.error('Failed to load multisig', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, network]);

  const onPass = async (password: string) => {
    const target = cosign;
    setCosign(null);
    if (!target) return;
    setBusy(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      await sendNemCosignature(privateKey, wallet.publicKey, target.multisigAddress, target.innerHash);
      setNotice(t('multisig.cosign_done'));
    } catch (e) {
      console.error('Cosign failed', e);
      setErrorMessage(`${t('multisig.cosign_failed')}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const needed = (address: string) => {
    const p = parents.find((x) => x.address === address);
    if (!p) return null;
    return p.minCosignatories === 0 ? p.cosignatories.length : p.minCosignatories;
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
                  {t('nemmultisig.threshold_text', { approval: mine.minCosignatories === 0 ? mine.cosignatories.length : mine.minCosignatories, count: mine.cosignatories.length })}
                </Typography>
                {mine.cosignatories.map((a) => <Typography key={a.address} variant="body2" sx={mono}>{a.address}</Typography>)}
                <Alert severity="info" sx={{ mt: 1.5 }}>{t('multisig.is_multisig_note')}</Alert>
              </>
            ) : (
              <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/multisig/convert')} sx={{ mt: 0.5 }}>{t('multisig.convert_button')}</Button>
            )}
          </Card>
        )}

        <Typography sx={{ fontWeight: 'bold', mt: 1, mb: 0.5 }}>{t('multisig.cosigning_title')}</Typography>
        {parents.length === 0 && !loading && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('multisig.cosigning_none')}</Typography>}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
          {parents.map((p) => (
            <Card key={p.address} variant="outlined" sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5, ...mono }}>{p.address}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
                {t('nemmultisig.threshold_text', { approval: p.minCosignatories === 0 ? p.cosignatories.length : p.minCosignatories, count: p.cosignatories.length })}
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
        {pending.length === 0 && !loading && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('multisig.pending_none')}</Typography>}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {pending.map((p) => (
            <Card key={p.innerHash} variant="outlined" sx={{ px: 2, py: 1.5 }}>
              <Summary p={p} />
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ...mono }}>{t('multisig.initiator_label')}: {p.initiator}</Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                {t('multisig.deadline_label')}: {new Date(p.deadlineMs).toLocaleString()} / {t('nemmultisig.signature_progress', { count: p.signedCount, needed: needed(p.multisigAddress) ?? '?' })}
              </Typography>
              {p.signedByMe ? (
                <Chip size="small" color="success" label={t('multisig.signed_by_me')} sx={{ mt: 1 }} />
              ) : (
                <Button variant="contained" color="primary" fullWidth disabled={busy} onClick={() => setCosign(p)} sx={{ mt: 1.5 }}>{t('multisig.cosign_button')}</Button>
              )}
            </Card>
          ))}
        </Box>
        {!loading && <Button onClick={load} sx={{ mt: 2 }}>{t('multisig.reload')}</Button>}
      </Box>
      <PasswordDialog open={cosign !== null} mode="check" onClose={() => setCosign(null)} onPass={onPass} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
