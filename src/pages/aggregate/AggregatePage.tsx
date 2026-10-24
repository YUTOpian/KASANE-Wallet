import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Divider, IconButton, MenuItem, Select, Tab, Tabs, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import {
  FEE_SPEEDS, SymbolSendError, explorerTxUrl, fetchBalances, fetchOwnedMosaics, fetchOwnedNamespaces,
} from '../../lib/symbol/api';
import type { FeeSpeed, MosaicBalance, OwnedMosaic, OwnedNamespace } from '../../lib/symbol/api';
import { MAX_AGGREGATE_INNER, aggregateMosaicId, namespaceFullName, needsBonded, otherSigners, uidsToRemove } from '../../lib/symbol/aggregate';
import type { AggregateItem, AggregateItemKind, AggregateSigner } from '../../lib/symbol/aggregate';
import { quoteAggregate, resolveSigner, sendAggregate } from '../../lib/symbol/aggregateApi';
import { fetchCosignedAccounts } from '../../lib/symbol/multisigApi';
import type { AggregateQuote } from '../../lib/symbol/aggregateApi';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { getNetworkConfig } from '../../lib/symbol/network';
import { BLOCKS_PER_DAY } from '../../lib/symbol/tx';
import { prettyAddress } from '../../lib/symbol/crypto';
import { useAggregateStore } from '../../store/aggregateStore';
import { useAppStore } from '../../store/appStore';
import AggregateItemForm from './AggregateItemForm';
import type { AggregateContext } from './AggregateItemForm';
import { SectionCard } from '../multisig/parts';

const KINDS: AggregateItemKind[] = ['transfer', 'mosaic_definition', 'mosaic_supply', 'namespace'];
const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

// Maps the node's transaction-status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code === 'lock_timeout') return { kind: 'lock_timeout', detail };
  if (code.startsWith('Failure_Mosaic') || code.startsWith('Failure_Namespace')) return { kind: 'conflict', detail: code };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm';
type Quote = AggregateQuote | null | 'loading';

// まとめて送信（アグリゲート）: 送金・モザイク定義・供給量変更・ネームスペース登録を積んで、1つのトランザクションとして送る。
// すべて成功するか、すべて失敗する。公式 Symbol Desktop Wallet の「アグリゲート」画面に相当。
export default function AggregatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const items = useAggregateStore((s) => s.items);
  const { bind, add, remove, clear } = useAggregateStore.getState();
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [wallet, setWallet] = useState<{ address: string; publicKey: string; id: string } | null>(null);
  const [balances, setBalances] = useState<MosaicBalance[]>([]);
  const [ownedMosaics, setOwnedMosaics] = useState<OwnedMosaic[]>([]);
  const [ownedNamespaces, setOwnedNamespaces] = useState<OwnedNamespace[]>([]);
  const [signers, setSigners] = useState<AggregateSigner[]>([]);
  const [formKind, setFormKind] = useState<AggregateItemKind>('transfer');
  // Bumped after each save so the form starts empty again.
  const [formNonce, setFormNonce] = useState(0);
  const [feeSpeed, setFeeSpeed] = useState<FeeSpeed>(() => useAppStore.getState().defaultFeeSpeed);
  const [quote, setQuote] = useState<Quote>(null);
  const [showCaution, setShowCaution] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The active wallet and what it owns (balances for transfers, owned mosaics / namespaces for supply changes and parents).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const w = await WalletsHelper.getActive('symbol');
      if (!w || cancelled) return;
      bind(`${network}:${w.address}`); // a draft made for another wallet / network is dropped
      setWallet({ address: w.address, publicKey: w.publicKey, id: w.id });
      const [b, m, n] = await Promise.all([
        fetchBalances(w.address).catch(() => [] as MosaicBalance[]),
        fetchOwnedMosaics(w.address).catch(() => [] as OwnedMosaic[]),
        fetchOwnedNamespaces(w.address).catch(() => [] as OwnedNamespace[]),
      ]);
      if (cancelled) return;
      setBalances(b); setOwnedMosaics(m); setOwnedNamespaces(n);
      // Multisig accounts this wallet cosigns for: transfers can be sent from them (the others' signatures are collected afterwards).
      try {
        // Includes multisig accounts the wallet only reaches through another multisig account (マルチレベルマルチシグ).
        const cosigned = await fetchCosignedAccounts(w.address);
        const found = await Promise.all(cosigned.map((c) => resolveSigner(w.address, c.info.address).catch(() => null)));
        if (!cancelled) setSigners(found.filter((x): x is AggregateSigner => x !== null));
      } catch { /* the multisig senders are optional */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  // Cost of the draft, quoted again whenever it changes.
  const itemsKey = items.map((i) => i.uid).join(',');
  useEffect(() => {
    if (!wallet || items.length === 0) { setQuote(null); return undefined; }
    let cancelled = false;
    setQuote('loading');
    quoteAggregate(wallet.publicKey, wallet.address, items)
      .then((q) => { if (!cancelled) setQuote(q); })
      .catch(() => { if (!cancelled) setQuote(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, wallet, network]);

  const ctx: AggregateContext = { address: wallet?.address ?? '', items, balances, ownedMosaics, ownedNamespaces, signers };
  const bonded = needsBonded(items);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const ready = quote !== null && quote !== 'loading' ? quote : null;
  // With a hash lock the fee of the lock is paid as well; the locked XYM itself is returned once the aggregate is confirmed.
  const txFee = ready ? ready.fees[feeSpeed].fee + ready.lockFees[feeSpeed] : null;
  const rental = ready ? ready.rental : null;
  const lockAmount = ready ? ready.lockAmount : null;
  const total = txFee !== null && rental !== null ? txFee + rental : null;
  // XYM that the transfers inside the aggregate send out, on top of the fees.
  const xymSent = items.reduce((sum, i) => (i.kind === 'transfer' && i.mosaicId === netCfg.currencyMosaicId ? sum + i.amount : sum), 0n);
  const xymBalance = balances.find((b) => b.id === netCfg.currencyMosaicId)?.amount ?? null;
  const balanceShort = total !== null && xymBalance !== null && xymBalance < total + xymSent + (lockAmount ?? 0n);
  const costText = (value: bigint | null) => (quote === 'loading' ? t('aggregate.cost_loading') : value === null ? t('aggregate.cost_unavailable') : xym(value));

  const describe = (item: AggregateItem): { title: string; lines: string[] } => {
    const owner = wallet?.address ?? '';
    switch (item.kind) {
      case 'transfer':
        return {
          title: t('aggregate.kind_transfer'),
          lines: [
            ...(item.signer ? [`${t('aggregate.sender')}: ${prettyAddress(item.signer.address)}${item.signer.selfSufficient ? '' : ` ${t('aggregate.needs_cosign')}`}`] : []),
            `${t('common.destination')}: ${item.recipientAlias ? `${item.recipientAlias} (${prettyAddress(item.recipient)})` : prettyAddress(item.recipient)}`,
            ...(item.amount > 0n ? [`${formatAtomic(item.amount, item.divisibility)} ${item.mosaicSymbol}`] : []),
            ...(item.message ? [`${t('common.message')}: ${item.message}`] : []),
          ],
        };
      case 'mosaic_definition':
        return {
          title: t('aggregate.kind_mosaic_definition'),
          lines: [
            `ID: ${aggregateMosaicId(owner, item.nonce)}`,
            `${t('mosaic.divisibility_label')}: ${item.divisibility}`,
            `${t('mosaic.duration_label')}: ${item.durationBlocks === 0n ? t('mosaic.duration_unlimited') : t('mosaic.duration_days', { days: Math.max(1, Math.round(Number(item.durationBlocks) / BLOCKS_PER_DAY)) })}`,
          ],
        };
      case 'mosaic_supply':
        return {
          title: t('aggregate.kind_mosaic_supply'),
          lines: [`${item.mosaicSymbol}: ${item.action === 'increase' ? '+' : '-'}${formatAtomic(item.delta, item.divisibility)}`],
        };
      default:
        return {
          title: t('aggregate.kind_namespace'),
          lines: [
            namespaceFullName(item),
            item.parent ? t('namespace.child_badge') : `${t('namespace.duration_label')}: ${t('namespace.days_value', { days: Math.round(Number(item.durationBlocks) / BLOCKS_PER_DAY) })}`,
          ],
        };
    }
  };

  const onRemove = (uid: string) => {
    if (!wallet) return;
    remove(uidsToRemove(items, uid, wallet.address));
  };

  const onPassed = async (password: string) => {
    if (!wallet || items.length === 0) return;
    setSending(true);
    try {
      const w = await WalletsHelper.getActive('symbol');
      if (!w) return;
      const privateKey = await WalletsHelper.decryptKey(w.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await sendAggregate({ privateKey, publicKey: w.publicKey, address: w.address, items, feeSpeed });
      showTxNotice({ lines: t(sent.bonded ? 'aggregate.done_bonded_message' : 'aggregate.done_message', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('aggregate.view_explorer') });
      clear();
      setStep('form');
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate('/top');
  };

  const errorTitle = sendError ? t(`aggregate.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`aggregate.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  const itemCards = useMemo(() => items.map((item) => {
    const d = describe(item);
    return { item, ...d };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items, wallet, t]);

  const costBox = (
    <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('aggregate.cost_title')}</Typography>
      {step === 'form' && (
        <Box sx={{ mb: 1.5 }}>
          <Select fullWidth size="small" value={feeSpeed} onChange={(e) => setFeeSpeed(e.target.value as FeeSpeed)} inputProps={{ 'aria-label': t('aggregate.tx_fee') }}>
            {FEE_SPEEDS.map((s) => <MenuItem key={s} value={s}>{t(`send.fee_speed_${s}`)}</MenuItem>)}
          </Select>
        </Box>
      )}
      {[
        { label: t('aggregate.tx_fee'), value: costText(txFee) },
        { label: t('aggregate.rental_fee'), value: costText(rental) },
        ...(bonded ? [{ label: t('aggregate.lock_deposit'), value: costText(lockAmount) }] : []),
        { label: t('aggregate.total'), value: costText(total), bold: true },
      ].map((r) => (
        <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
      ))}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('aggregate.cost_hint')}{bonded ? ` ${t('aggregate.lock_hint')}` : ''}</Typography>
      {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('aggregate.xym_short_warning')}</Alert>}
    </Box>
  );

  // ============================ confirm ============================
  if (step === 'confirm') {
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back="/aggregate" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('aggregate.confirm_title', { count: items.length })}</Typography>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {itemCards.map(({ item, title, lines }, i) => (
              <Box key={item.uid}>
                {i > 0 && <Divider />}
                <Box sx={{ py: 1.5 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{i + 1}. {title}</Typography>
                  {lines.map((line, j) => <Typography key={j} sx={{ ...mono, whiteSpace: 'pre-wrap' }}>{line}</Typography>)}
                </Box>
              </Box>
            ))}
          </Box>
          {costBox}
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 2 }}>{t('aggregate.caution_atomic')}</Typography>
          {bonded && <Alert severity="info" sx={{ mt: 2 }}>{t('aggregate.bonded_flow', { count: otherSigners(items).length })}</Alert>}
        </Box>
        <MessageDialog open={showCaution} title={t('aggregate.confirm_dialog_title')} texts={t('aggregate.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t(bonded ? 'aggregate.sending_bonded' : 'aggregate.sending') : t('aggregate.confirm_ready')}</Typography>
            <Button variant="contained" size="large" fullWidth disabled={sending} onClick={() => setShowPassword(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('aggregate.confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  const full = items.length >= MAX_AGGREGATE_INNER;
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('aggregate.intro')}</Alert>

        {/* 種類ごとのタブ: 入力して「保存」すると、下の「まとめる内容」に積まれる */}
        <SectionCard sx={{ px: { xs: 2, md: 3 }, pt: 0 }}>
          <Tabs value={formKind} onChange={(_, v: AggregateItemKind) => { setFormKind(v); setFormNonce((n) => n + 1); }} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}>
            {KINDS.map((k) => <Tab key={k} value={k} label={t(`aggregate.tab_${k}`)} />)}
          </Tabs>
          {wallet ? (
            <AggregateItemForm
              key={`${formKind}-${formNonce}`}
              kind={formKind}
              ctx={ctx}
              index={items.filter((i) => i.kind === formKind).length + 1}
              full={full}
              onAdd={(list) => { list.forEach(add); setFormNonce((n) => n + 1); }}
            />
          ) : (
            <Typography variant="body2" sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>{t('aggregate.cost_loading')}</Typography>
          )}
        </SectionCard>

        <SectionCard title={t('aggregate.items_title', { count: items.length, max: MAX_AGGREGATE_INNER })}>
          {items.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('aggregate.empty')}</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {itemCards.map(({ item, title, lines }, i) => (
                <Box key={item.uid} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
                  <Chip size="small" label={i + 1} color="primary" />
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{title}</Typography>
                    {lines.map((line, j) => <Typography key={j} variant="body2" sx={{ ...mono, whiteSpace: 'pre-wrap' }}>{line}</Typography>)}
                  </Box>
                  <IconButton aria-label={t('common.delete')} onClick={() => onRemove(item.uid)} size="small"><DeleteOutlineIcon /></IconButton>
                </Box>
              ))}
            </Box>
          )}
          {items.length > 0 && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('aggregate.order_hint')}</Typography>}
        </SectionCard>

        {bonded && <Alert severity="warning" sx={{ mt: 2 }}>{t('aggregate.bonded_notice')}</Alert>}
        {items.length > 0 && costBox}
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" size="large" fullWidth disabled={items.length === 0 || total === null} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('aggregate.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}
