import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import SignerTrustNotice from '../../components/SignerTrustNotice';
import BlockedSignerDialog from '../../components/BlockedSignerDialog';
import SignRiskNotice, { SignRiskDialog } from '../../components/SignRiskNotice';
import { checkSignRisks, checkSignerTrust, isUnknownSignerDenied } from '../../lib/signerTrust';
import { hasDanger } from '../../lib/signRisk';
import type { SignRisk } from '../../lib/signRisk';
import { WalletsHelper } from '../../lib/storage';
import { cosignPartial, fetchCosignedAccounts, fetchCosignerGraph, fetchMultisigInfo, fetchPartialTransactions } from '../../lib/symbol/multisigApi';
import type { CosignedAccount, MultisigInfo, PartialTransaction } from '../../lib/symbol/multisigApi';
import { missingSignatures } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import { useAppStore } from '../../store/appStore';
import { CosignQrButton, CosignerTree, FormRow, ItemView, SectionCard, mono } from './parts';

// 「マルチシグ」: the account's own multisig state, the multisig accounts this wallet cosigns for,
// and the transactions waiting for a signature (with a cosign button).
// マルチレベルマルチシグ: a multisig account may have multisig cosigners. The accounts listed here include the ones this
// wallet only reaches through another multisig account, and a cosigner that is multisig is shown with its own cosigners.
/** How many signatures each multisig account of each waiting transaction still lacks (what is not known is left out). */
async function approvalProgress(list: PartialTransaction[]): Promise<Record<string, Array<{ account: string; missing: number }>>> {
  const graphs = new Map<string, MultisigGraph>();
  const accounts = [...new Set(list.flatMap((p) => p.items.map((i) => i.account)))];
  await Promise.all(accounts.map(async (a) => {
    try { graphs.set(a, await fetchCosignerGraph(a)); } catch { /* progress is optional */ }
  }));
  const out: Record<string, Array<{ account: string; missing: number }>> = {};
  for (const p of list) {
    const signed = new Set(p.signers);
    out[p.hash] = [...new Set(p.items.map((i) => i.account))].flatMap((account) => {
      const g = graphs.get(account);
      if (!g?.get(account)?.isMultisig) return [];
      const missing = missingSignatures(g, account, signed);
      return Number.isFinite(missing) ? [{ account, missing }] : [];
    });
  }
  return out;
}

export default function MultisigTop() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [mine, setMine] = useState<MultisigInfo | null>(null);
  const [parents, setParents] = useState<CosignedAccount[]>([]);
  const [tree, setTree] = useState<MultisigGraph | null>(null); // the cosigner tree of the wallet's own account
  // For each waiting transaction: the multisig accounts it is signed for and how many signatures each still lacks.
  const [progress, setProgress] = useState<Record<string, Array<{ account: string; missing: number }>>>({});
  const [pending, setPending] = useState<PartialTransaction[]>([]);
  const [cosignHash, setCosignHash] = useState<string | null>(null);
  // ブラックリストの相手からの依頼に署名しようとしたときの確認（OK ならパスワード入力へ）。
  const [blockedHash, setBlockedHash] = useState<string | null>(null);
  // 署名依頼の中身に危険な点があるとき、署名に進む前の最後の確認に出す（要注意のアドレスへの送金・連署者への追加など）。
  const [riskAsk, setRiskAsk] = useState<{ hash: string; risks: SignRisk[] } | null>(null);
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
      // Every multisig account this wallet can sign for, also through other multisig accounts.
      const cosigned = await fetchCosignedAccounts(wallet.address, undefined, info);
      setMine(info);
      setParents(cosigned);
      setTree(info.isMultisig ? await fetchCosignerGraph(wallet.address).catch(() => null) : null);
      const list = await fetchPartialTransactions(wallet.address, wallet.publicKey, cosigned.map((c) => c.info.address));
      setPending(list);
      setProgress(await approvalProgress(list));
    } catch (e) {
      console.error('Failed to load multisig', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, network]);

  // 署名のパスワード入力へ進む。ただし中身に危険な点（要注意のアドレスが関わる）があれば、その前に確認を出す。
  const proceedToSign = async (hash: string) => {
    const target = pending.find((p) => p.hash === hash);
    const risks = target ? await checkSignRisks(target.items) : [];
    if (hasDanger(risks)) setRiskAsk({ hash, risks });
    else setCosignHash(hash);
  };

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
        {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2 }}>{notice}</Alert>}
        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>{t('multisig.reload')}</Button>}>
            {t('multisig.load_failed')}
          </Alert>
        )}

        {/* このウォレットのアカウント */}
        <SectionCard title={t('multisig.manage_title')}>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('multisig.intro')}</Typography>
          {loading && !mine ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>
          ) : mine && (
            <>
              <FormRow label={t('multisig.status_title')}>
                <Chip size="small" color={mine.isMultisig ? 'primary' : 'default'} label={mine.isMultisig ? t('multisig.status_multisig') : t('multisig.status_normal')} />
              </FormRow>
              {mine.isMultisig ? (
                <>
                  <FormRow label={t('multisig.f_thresholds')}>
                    <Typography variant="body2">{t('multisig.threshold_text', { approval: mine.minApproval, removal: mine.minRemoval, count: mine.cosignatories.length })}</Typography>
                  </FormRow>
                  <FormRow label={t('multisig.cosigners_label')} top>
                    {mine.cosignatories.map((a) => <Typography key={a} variant="body2" sx={{ py: 0.25, ...mono }}>{a}</Typography>)}
                  </FormRow>
                  {tree && tree.size > 1 && tree.get(mine.address) && (
                    <FormRow label={t('multisig.tree_label')} top>
                      <CosignerTree graph={tree} root={mine.address} />
                    </FormRow>
                  )}
                  <Alert severity="info" sx={{ mt: 1 }}>{t('multisig.is_multisig_note')}</Alert>
                </>
              ) : (
                <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/multisig/convert')} sx={{ mt: 1.5, py: 1.25 }}>
                  {t('multisig.convert_button')}
                </Button>
              )}
            </>
          )}
        </SectionCard>

        {/* 連署しているアカウント */}
        <SectionCard title={t('multisig.cosigning_title')}>
          {parents.length === 0 && !loading && (
            <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 1.5 }}>{t('multisig.cosigning_none')}</Typography>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {parents.map(({ info: p, level, via }) => (
              <Card key={p.address} variant="outlined" sx={{ px: 2, py: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5, ...mono }}>{p.address}</Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: level > 1 ? 0.5 : 1 }}>
                  {t('multisig.threshold_text', { approval: p.minApproval, removal: p.minRemoval, count: p.cosignatories.length })}
                </Typography>
                {level > 1 && (
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1, ...mono }}>
                    {t('multisig.indirect_label', { via, level })}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button variant="contained" color="primary" fullWidth onClick={() => navigate(`/multisig/send?account=${p.address}`)}>{t('multisig.send_button')}</Button>
                  <Button variant="outlined" color="primary" fullWidth onClick={() => navigate(`/multisig/convert?account=${p.address}`)}>{t('multisig.edit_button')}</Button>
                  <Button variant="text" color="primary" onClick={() => navigate(`/multisig/tree?account=${p.address}`)} sx={{ flexShrink: 0 }}>{t('multisig.tree_short')}</Button>
                </Box>
              </Card>
            ))}
          </Box>
        </SectionCard>

        {/* 署名待ち */}
        <SectionCard title={t('multisig.pending_title')}>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t('multisig.pending_hint')}</Typography>
          {pending.length === 0 && !loading && (
            <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 1.5 }}>{t('multisig.pending_none')}</Typography>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {pending.map((p) => (
              <Card key={p.hash} variant="outlined" sx={{ px: 2, py: 1.5 }}>
                {p.items.map((item, i) => <ItemView key={i} item={item} />)}
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ...mono }}>
                  {t('multisig.initiator_label')}: {p.initiator}
                </Typography>
                <SignerTrustNotice address={p.initiator} sx={{ my: 1 }} />
                <SignRiskNotice items={p.items} sx={{ mb: 1 }} />
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                  {t('multisig.deadline_label')}: {new Date(p.deadlineMs).toLocaleString()} / {t('multisig.cosigned_count', { count: p.cosignedBy })}
                </Typography>
                {(progress[p.hash] ?? []).map((g) => (
                  <Typography key={g.account} variant="caption" sx={{ display: 'block', color: g.missing === 0 ? 'success.main' : 'text.secondary', ...mono }}>
                    {g.missing === 0 ? t('multisig.progress_ok', { account: g.account }) : t('multisig.progress_missing', { account: g.account, count: g.missing })}
                  </Typography>
                ))}
                <Box sx={{ mt: 1.5 }}><CosignQrButton hash={p.hash} /></Box>
                {p.signedByMe ? (
                  <Chip size="small" color="success" label={t('multisig.signed_by_me')} sx={{ mt: 1 }} />
                ) : (
                  <Button variant="contained" color="primary" fullWidth disabled={busy} onClick={async () => {
                    const trust = await checkSignerTrust(p.initiator);
                    if (isUnknownSignerDenied(trust)) setErrorMessage(t('addressbook.signer_unknown_denied'));
                    else if (trust === 'black') setBlockedHash(p.hash);
                    else void proceedToSign(p.hash);
                  }} sx={{ mt: 1.5 }}>
                    {t('multisig.cosign_button')}
                  </Button>
                )}
              </Card>
            ))}
          </Box>
        </SectionCard>
        <Button variant="outlined" color="primary" fullWidth onClick={() => navigate('/multisig/tree')} sx={{ mb: 1 }}>{t('multisig.tree_open')}</Button>
        {!loading && <Button onClick={load}>{t('multisig.reload')}</Button>}
      </Box>
      <PasswordDialog open={cosignHash !== null} mode="check" popup onClose={() => setCosignHash(null)} onPass={onPass} />
      <BlockedSignerDialog
        open={blockedHash !== null}
        onCancel={() => setBlockedHash(null)}
        onContinue={() => { const hash = blockedHash; setBlockedHash(null); if (hash) void proceedToSign(hash); }}
      />
      <SignRiskDialog
        risks={riskAsk?.risks ?? null}
        onCancel={() => setRiskAsk(null)}
        onContinue={() => { const hash = riskAsk?.hash ?? null; setRiskAsk(null); setCosignHash(hash); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
