import { useLiveRefresh } from '../../hooks/useLiveRefresh';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import SignerTrustNotice from '../../components/SignerTrustNotice';
import BlockedSignerDialog from '../../components/BlockedSignerDialog';
import { checkSignerTrust } from '../../lib/signerTrust';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemMultisigInfo, fetchNemPending, sendNemCosignature } from '../../lib/nem/multisigApi';
import type { NemMultisigInfo, NemPendingTransaction } from '../../lib/nem/multisigApi';
import { useAppStore } from '../../store/appStore';
import { SectionCard } from '../multisig/parts';

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
  } else if (s.kind === 'mosaic_transfer') {
    title = t('multisig.item_transfer', { account: p.multisigAddress });
    lines.push(`${t('multisig.item_to')}: ${s.recipient}`, ...s.mosaics);
    if (s.message) lines.push(`${t('multisig.item_message')}: ${s.message}`);
  } else if (s.kind === 'namespace') {
    title = t('nemmultisig.item_namespace', { account: p.multisigAddress });
    lines.push(s.name);
  } else if (s.kind === 'mosaic_definition') {
    title = t('nemmultisig.item_mosaic', { account: p.multisigAddress });
    lines.push(s.mosaicId, t('nemmultisig.item_mosaic_supply', { amount: s.initialSupply }));
    if (!s.transferable) lines.push(t('nemmultisig.item_mosaic_not_transferable'));
  } else if (s.kind === 'mosaic_supply') {
    title = t('nemmultisig.item_supply', { account: p.multisigAddress });
    lines.push(s.mosaicId, t(s.increase ? 'nemmultisig.item_supply_increase' : 'nemmultisig.item_supply_decrease', { amount: s.delta }));
  } else if (s.kind === 'modification') {
    title = t('multisig.item_multisig', { account: p.multisigAddress });
    if (s.additions.length) lines.push(`${t('multisig.item_add')}:\n${s.additions.join('\n')}`);
    if (s.deletions.length) lines.push(`${t('multisig.item_remove')}:\n${s.deletions.join('\n')}`);
    if (s.delta !== 0) lines.push(t('nemmultisig.item_threshold_delta', { delta: signed(s.delta) }));
  } else if (s.kind === 'importance') {
    // Delegated harvesting: a cosigner must see what they are about to sign.
    title = t('multisig.item_importance', { account: p.multisigAddress });
    lines.push(t(s.activate ? 'nemmultisig.item_importance_activate' : 'nemmultisig.item_importance_deactivate'));
    if (s.remoteAddress) lines.push(`${t('nemmultisig.item_importance_remote')}: ${s.remoteAddress}`);
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
  // ブラックリストの相手からの依頼に署名しようとしたときの確認（OK ならパスワード入力へ）。
  const [blockedCosign, setBlockedCosign] = useState<NemPendingTransaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async (silent?: unknown) => {
    const quiet = silent === true;
    if (!quiet) setLoading(true);
    if (!quiet) setFailed(false);
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
      if (!quiet) setFailed(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // 画面を開いたまま、取引を受け取ったとき（LiveUpdates）に、静かに読み直す。
  useLiveRefresh(() => { if (!failed) void load(true); });

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
        {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2 }}>{notice}</Alert>}
        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>{t('multisig.reload')}</Button>}>
            {t('multisig.load_failed')}
          </Alert>
        )}

        <Alert severity="info" sx={{ mb: 2 }}>{t('multisig.intro')}</Alert>

        {/* このウォレットのアカウント */}
        <SectionCard compact title={t('multisig.manage_title')}>
          {loading && !mine ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>
          ) : mine && (
            <>
              <Card variant="outlined" sx={{ px: 2, py: 1.5 }}>
                <Box><Chip size="small" color={mine.isMultisig ? 'primary' : 'default'} label={mine.isMultisig ? t('multisig.status_multisig') : t('multisig.status_normal')} /></Box>
                {mine.isMultisig && (
                  <>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      {t('nemmultisig.threshold_text', { approval: mine.minCosignatories === 0 ? mine.cosignatories.length : mine.minCosignatories, count: mine.cosignatories.length })}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1.5 }}>{t('multisig.cosigners_label')}</Typography>
                    {mine.cosignatories.map((a) => <Typography key={a.address} variant="body2" sx={{ py: 0.25, ...mono }}>{a.address}</Typography>)}
                  </>
                )}
                {!mine.isMultisig && (
                  <Box sx={{ mt: 1.5 }}>
                    <Button variant="contained" color="primary" onClick={() => navigate('/multisig/convert')} sx={{ px: 4 }}>
                      {t('multisig.convert_button')}
                    </Button>
                  </Box>
                )}
              </Card>
              {mine.isMultisig && <Alert severity="info" sx={{ mt: 1.5 }}>{t('multisig.is_multisig_note')}</Alert>}
            </>
          )}
        </SectionCard>

        {/* 連署しているアカウント */}
        <SectionCard compact title={t('multisig.cosigning_title')}>
          {parents.length === 0 && !loading && (
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('multisig.cosigning_none')}</Typography>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(auto-fill, minmax(400px, 1fr))' }, gap: 1.5, alignItems: 'start' }}>
            {parents.map((p) => (
              <Card key={p.address} variant="outlined" sx={{ px: 2, py: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', ...mono }}>{p.address}</Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                  {t('nemmultisig.threshold_text', { approval: p.minCosignatories === 0 ? p.cosignatories.length : p.minCosignatories, count: p.cosignatories.length })}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, mt: 1.25, flexWrap: 'wrap' }}>
                  <Button variant="contained" color="primary" onClick={() => navigate(`/multisig/send?account=${p.address}`)}>{t('multisig.send_button')}</Button>
                  <Button variant="outlined" color="primary" onClick={() => navigate(`/multisig/convert?account=${p.address}`)}>{t('multisig.edit_button')}</Button>
                  <Button variant="outlined" color="primary" onClick={() => navigate(`/multisig/harvest?account=${p.address}`)}>{t('nemmsharvest.button')}</Button>
                </Box>
              </Card>
            ))}
          </Box>
        </SectionCard>

        {/* 署名待ち */}
        <SectionCard compact title={t('multisig.pending_title')}>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t('multisig.pending_hint')}</Typography>
          {pending.length === 0 && !loading && (
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('multisig.pending_none')}</Typography>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(auto-fill, minmax(400px, 1fr))' }, gap: 1.5, alignItems: 'start' }}>
            {pending.map((p) => (
              <Card key={p.innerHash} variant="outlined" sx={{ px: 2, py: 1.5 }}>
                <Summary p={p} />
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ...mono }}>{t('multisig.initiator_label')}: {p.initiator}</Typography>
                <SignerTrustNotice address={p.initiator} sx={{ my: 1 }} />
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                  {t('multisig.deadline_label')}: {new Date(p.deadlineMs).toLocaleString()} / {t('nemmultisig.signature_progress', { count: p.signedCount, needed: needed(p.multisigAddress) ?? '?' })}
                </Typography>
                {p.signedByMe ? (
                  <Chip size="small" color="success" label={t('multisig.signed_by_me')} sx={{ mt: 1 }} />
                ) : (
                  <Button variant="contained" color="primary" disabled={busy} onClick={async () => { if ((await checkSignerTrust(p.initiator)) === 'black') setBlockedCosign(p); else setCosign(p); }} sx={{ mt: 1.5 }}>{t('multisig.cosign_button')}</Button>
                )}
              </Card>
            ))}
          </Box>
        </SectionCard>
        {!loading && <Button onClick={load}>{t('multisig.reload')}</Button>}
      </Box>
      <PasswordDialog open={cosign !== null} mode="check" popup onClose={() => setCosign(null)} onPass={onPass} />
      <BlockedSignerDialog
        open={blockedCosign !== null}
        onCancel={() => setBlockedCosign(null)}
        onContinue={() => { setCosign(blockedCosign); setBlockedCosign(null); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
