import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem } from '@mui/material';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import QrTextDialog from '../../components/QrTextDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchBalances } from '../../lib/symbol/api';
import type { MosaicBalance } from '../../lib/symbol/api';
import { fetchAccountPublicKey, fetchCosignedAccounts, fetchCosignerGraph, quoteMultisigCost, submitMultisig } from '../../lib/symbol/multisigApi';
import type { CosignedAccount, MultisigCost } from '../../lib/symbol/multisigApi';
import { planApproval, treeRows } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { buildKasaneQr } from '../../lib/symbol/kasaneQr';
import type { TemplateQr } from '../../lib/symbol/kasaneQr';
import { getNetworkConfig } from '../../lib/symbol/network';
import { MAX_MESSAGE_BYTES, messageByteLength, multisigTransferAggregateSize } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';
import { ConfirmScreen, CostBox, Field, FormRow, SectionCard, addressPrefix, addressProblem } from './parts';
import type { ConfirmRow } from './parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { explorerTxUrl } from '../../lib/symbol/api';

type Step = 'form' | 'confirm';

// 「マルチシグから送金」: a transfer in the name of a multisig account this wallet cosigns for.
// With minApproval 1 it is a complete aggregate; otherwise it is bonded and waits for signatures.
function MultisigSend({ onSent }: SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // A template QR (read on the signing-QR screen) arrives as router state and fills this form in.
  const template = (useLocation().state as { template?: TemplateQr } | null)?.template;
  const templateApplied = useRef(false);
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(true);
  const [walletAddress, setWalletAddress] = useState('');
  const [accounts, setAccounts] = useState<CosignedAccount[]>([]); // every multisig account the wallet can sign for, also through other multisig accounts
  const addresses = useMemo(() => accounts.map((a) => a.info.address), [accounts]);
  const [account, setAccount] = useState((template?.account ?? params.get('account') ?? '').toUpperCase());
  const [graph, setGraph] = useState<MultisigGraph | null>(null); // the cosigner tree of the selected account (マルチレベルマルチシグ)
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [balances, setBalances] = useState<MosaicBalance[]>([]);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [recipient, setRecipient] = useState(template?.recipient ?? '');
  const [mosaicId, setMosaicId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState(template?.message ?? '');

  const [cost, setCost] = useState<MultisigCost | null>(null);
  const [templateQrOpen, setTemplateQrOpen] = useState(false);

  // The multisig accounts this wallet cosigns for, and the wallet's own XYM (it pays fees / lock).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        const cosigned = await fetchCosignedAccounts(wallet.address);
        const own_balances = await fetchBalances(wallet.address).catch(() => null);
        if (cancelled) return;
        setWalletAddress(wallet.address);
        setAccounts(cosigned);
        setAccount((cur) => (cosigned.some((c) => c.info.address === cur) ? cur : (cosigned[0]?.info.address ?? '')));
        const xym = own_balances?.find((b) => b.id === getNetworkConfig(network).currencyMosaicId);
        setXymBalance(own_balances ? (xym?.amount ?? 0n) : null);
      } catch (e) {
        console.error('Failed to load multisig accounts', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // Thresholds, public key and holdings of the selected account.
  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setGraph(null);
    setBalances([]);
    Promise.all([fetchCosignerGraph(account), fetchAccountPublicKey(account), fetchBalances(account)])
      .then(([g, key, b]) => {
        if (cancelled) return;
        setGraph(g);
        setAccountKey(key);
        const usable = b.filter((m) => m.amount > 0n && m.transferable);
        setBalances(usable);
        setMosaicId((cur) => (usable.some((m) => m.id === cur) ? cur : (usable[0]?.id ?? '')));
      })
      .catch((e) => console.error('Failed to load account', e));
    return () => { cancelled = true; };
  }, [account, network]);

  // The template's mosaic and amount, once the account's holdings are known (the amount needs the divisibility).
  useEffect(() => {
    if (!template || templateApplied.current || balances.length === 0 || account !== template.account) return;
    const wanted = template.mosaics[0];
    const m = balances.find((b) => b.id === wanted?.id.toUpperCase());
    templateApplied.current = true;
    if (!m || !wanted) return;
    setMosaicId(m.id);
    setAmountText(formatAtomic(BigInt(wanted.amount), m.divisibility));
  }, [template, balances, account]);
  const templateAccountMissing = !!template && !loading && !addresses.includes(template.account);

  const mosaic = balances.find((m) => m.id === mosaicId);
  const amount = mosaic ? parseDecimal(amountText, mosaic.divisibility) : null;
  const recipientProblem = recipient.trim() === '' ? null : addressProblem(recipient);
  const amountError = amountText === '' ? '' : amount === null || amount <= 0n ? 'err_amount' : mosaic && amount > mosaic.amount ? 'err_amount_over' : '';
  const messageTooLong = messageByteLength(message) > MAX_MESSAGE_BYTES;
  const info = graph?.get(account) ?? null;
  // Complete only when the wallet's signature alone approves the account. Otherwise the others still have to sign:
  // a cosigner that is itself a multisig account is approved by ITS cosigners, so those are the signatures needed.
  const plan = graph && walletAddress ? planApproval(graph, account, walletAddress) : null;
  const nested = graph !== null && treeRows(graph, account).some((r) => r.multisig);
  const bonded = plan ? !plan.selfSufficient : true;
  const cosignatureCount = Math.max(plan?.others ?? 1, 1);
  const canContinue = !!info && accountKey !== null && !!mosaic && recipient.trim() !== '' && recipientProblem === null
    && amount !== null && amount > 0n && amountError === '' && !messageTooLong;

  const baseSize = multisigTransferAggregateSize(1, message || undefined);
  useEffect(() => {
    if (!info) return undefined;
    let cancelled = false;
    setCost(null);
    quoteMultisigCost(baseSize, cosignatureCount, bonded)
      .then((c) => { if (!cancelled) setCost(c); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [baseSize, cosignatureCount, bonded, info, network]);
  const accountLevel = accounts.find((a) => a.info.address === account);
  const balanceShort = cost !== null && xymBalance !== null && xymBalance < cost.totalNeeded;

  const rows = useMemo<ConfirmRow[]>(() => [
    { label: t('multisig.from_account'), value: account, big: true },
    { label: t('multisig.recipient_label'), value: normalizeAddress(recipient), big: true },
    { label: t('multisig.network_label'), value: `${netCfg.key === 'mijin' ? '' : 'Symbol '}${netCfg.label}` },
    { label: t('multisig.amount_row'), value: `${amountText} ${mosaic?.symbol ?? ''}`, big: true },
    ...(message ? [{ label: t('multisig.message_row'), value: message }] : []),
    { label: t('multisig.approval_row'), value: `${info?.minApproval ?? ''} / ${info?.cosignatories.length ?? ''}` },
    ...(nested && plan ? [{ label: t('multisig.multilevel_signatures_row'), value: t('multisig.multilevel_signatures_value', { count: plan.others + 1 }) }] : []),
  ], [t, account, recipient, netCfg.label, amountText, mosaic, message, info, nested, plan]);

  const onSend = async (password: string) => {
    const wallet = await WalletsHelper.getActive();
    if (!wallet || accountKey === null || !mosaic || amount === null) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    const sent = await submitMultisig({
      privateKey,
      publicKey: wallet.publicKey,
      inner: { kind: 'transfer', accountPublicKey: accountKey, recipient, mosaics: [{ id: mosaic.id, amount }], message: message || undefined },
      bonded,
      cosignatureCount,
    });
    showTxNotice({ lines: t(sent.bonded ? 'multisig.done_bonded' : 'multisig.done_complete', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('multisig.view_explorer') });
    onSent();
  };

  if (step === 'confirm') return <ConfirmScreen rows={rows} onBack={() => setStep('form')} onPassword={onSend} />;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('multisig.send_note')}</Alert>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {!loading && addresses.length === 0 && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.no_account')}</Alert>}
        {templateAccountMissing && <Alert severity="warning" sx={{ mb: 2 }}>{t('signqr.template_account_missing')}</Alert>}
        {addresses.length > 0 && (
          <>
            <SectionCard title={t('multisig.send_title')}>
              <FormRow label={t('multisig.from_account')}>
                <Field select ariaLabel={t('multisig.from_account')} value={account} onChange={(e) => setAccount(e.target.value)}>
                  {addresses.map((a) => <MenuItem key={a} value={a} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>{a}</MenuItem>)}
                </Field>
                {accountLevel && accountLevel.level > 1 && (
                  <Alert severity="info" sx={{ mt: 1 }}>{t('multisig.indirect_note', { via: accountLevel.via })}</Alert>
                )}
                {nested && <Alert severity="info" sx={{ mt: 1 }}>{t('multisig.multilevel_note')}</Alert>}
                {info && accountKey === null && <Alert severity="warning" sx={{ mt: 1 }}>{t('multisig.err_no_public_key')}</Alert>}
              </FormRow>
              <FormRow label={t('multisig.recipient_label')}>
                <Field
                  ariaLabel={t('multisig.recipient_label')}
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  error={recipientProblem !== null}
                  helperText={recipientProblem ? t(`multisig.${recipientProblem}`) : t('multisig.address_hint', { prefix: addressPrefix() })}
                  htmlInput={{ autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false }}
                />
              </FormRow>
              <FormRow label={t('multisig.mosaic_label')}>
                <Field select ariaLabel={t('multisig.mosaic_label')} value={mosaicId} onChange={(e) => { setMosaicId(e.target.value); setAmountText(''); }}>
                  {balances.map((m) => <MenuItem key={m.id} value={m.id}>{m.symbol}</MenuItem>)}
                </Field>
              </FormRow>
              <FormRow label={t('multisig.amount_label')}>
                <Field
                  ariaLabel={t('multisig.amount_label')}
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  error={amountError !== ''}
                  helperText={amountError ? t(`multisig.${amountError}`) : mosaic ? t('multisig.available', { amount: `${formatAtomic(mosaic.amount, mosaic.divisibility)} ${mosaic.symbol}` }) : ''}
                  htmlInput={{ inputMode: 'decimal' }}
                />
              </FormRow>
              <FormRow label={t('multisig.message_label')} top>
                <Field
                  ariaLabel={t('multisig.message_label')}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  error={messageTooLong}
                  helperText={messageTooLong ? t('multisig.err_message_long') : `${messageByteLength(message)} / ${MAX_MESSAGE_BYTES}`}
                  multiline
                  minRows={2}
                />
              </FormRow>
            </SectionCard>
            <CostBox cost={cost} hasBalanceShort={balanceShort} />
            {canContinue && mosaic && amount !== null && (
              <>
                <Button variant="outlined" color="primary" fullWidth onClick={() => setTemplateQrOpen(true)} sx={{ mt: 2 }}>{t('signqr.template_make_button')}</Button>
                <QrTextDialog
                  open={templateQrOpen}
                  title={t('signqr.template_title')}
                  hint={t('signqr.template_hint')}
                  text={buildKasaneQr({ kind: 'template', account, recipient, mosaics: [{ id: mosaic.id, amount: amount.toString() }], message: message || undefined })}
                  onClose={() => setTemplateQrOpen(false)}
                />
              </>
            )}
          </>
        )}
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>
          {t('multisig.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}

export default withFormReset<object>(MultisigSend);
