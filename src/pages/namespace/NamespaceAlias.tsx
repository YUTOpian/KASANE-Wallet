import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Divider, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import {
  SymbolSendError, changeAlias, explorerTxUrl, fetchMosaicRows, fetchOwnedNamespaces, quoteAliasFee,
} from '../../lib/symbol/api';
import type { MosaicRow, OwnedNamespace } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { aliasActionFor, currentAliasTarget, isAliasableMosaic } from '../../lib/symbol/namespaceAlias';
import { getNetworkConfig } from '../../lib/symbol/network';
import type { AliasTarget } from '../../lib/symbol/tx';
import { useAppStore } from '../../store/appStore';

// Maps the node's status codes (and local failures) to a message key + detail.
function classifyError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'Failure_Core_Insufficient_Balance') return { kind: 'insufficient_balance', detail };
  if (code === 'Failure_Core_Future_Deadline' || code === 'Failure_Core_Past_Deadline') return { kind: 'deadline', detail };
  if (code === 'Failure_Core_Wrong_Network') return { kind: 'wrong_network', detail };
  if (code.includes('Alias_Owner_Conflict')) return { kind: 'owner', detail: code };
  if (code.startsWith('Failure_Namespace')) return { kind: 'state', detail: code };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

type Step = 'form' | 'confirm';

interface NamespaceAliasProps {
  /** Namespace to select first (the link / unlink button of a row on the owned list). */
  initialNamespaceId?: string;
  /** Shown inside a dialog (the list's row button): no page title of its own. */
  embedded?: boolean;
  /** Called after the transaction was sent (the dialog closes and the list reloads). */
  onDone?: () => void;
}

// 「エイリアス」: ネームスペース一覧の行のボタンから開くポップアップ。自分のネームスペースにアドレス / モザイクのエイリアスをリンクし、
// リンク済みなら解除する（単独のトランザクション）。入力 → 確認（パスワード）→ 送信。
function NamespaceAlias({ initialNamespaceId, embedded, onDone, onSent }: NamespaceAliasProps & SentProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [namespaces, setNamespaces] = useState<OwnedNamespace[] | null>(null);
  const [mosaics, setMosaics] = useState<MosaicRow[]>([]);
  const [ownAddress, setOwnAddress] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [nsId, setNsId] = useState(initialNamespaceId ?? '');
  const [linkType, setLinkType] = useState<'address' | 'mosaic'>('address');
  const [mosaicId, setMosaicId] = useState('');

  const [fee, setFee] = useState<bigint | null | 'loading'>('loading');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // Namespaces that are not expired, the mosaics this wallet created (alias targets) and its own address.
  useEffect(() => {
    let cancelled = false;
    setNamespaces(null);
    setLoadFailed(false);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) { if (!cancelled) setNamespaces([]); return; }
        if (!cancelled) setOwnAddress(wallet.address);
        const [list, mosaicRows] = await Promise.all([
          fetchOwnedNamespaces(wallet.address),
          fetchMosaicRows(wallet.address).catch((e) => { console.warn('Failed to load mosaics', e); return [] as MosaicRow[]; }),
        ]);
        if (cancelled) return;
        setNamespaces(list.filter((n) => !n.expired));
        setMosaics(mosaicRows.filter(isAliasableMosaic));
      } catch (e) {
        console.error('Failed to load namespaces', e);
        if (!cancelled) { setNamespaces([]); setLoadFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const selected = useMemo(() => (namespaces ?? []).find((n) => n.id === nsId) ?? (namespaces ?? [])[0], [namespaces, nsId]);
  const action = selected ? aliasActionFor(selected) : null;
  const mosaicChoice = mosaics.find((m) => m.id === mosaicId) ?? mosaics[0];

  // What the transaction names: the new target (link) or exactly what is linked now (unlink).
  const target: AliasTarget | null = !selected || action === null ? null
    : action === 'unlink' ? currentAliasTarget(selected)
      : linkType === 'address' ? (ownAddress ? { type: 'address', address: ownAddress } : null)
        : mosaicChoice ? { type: 'mosaic', mosaicId: mosaicChoice.id } : null;
  const targetType = target?.type ?? null;

  useEffect(() => {
    if (targetType === null) return;
    let cancelled = false;
    setFee('loading');
    quoteAliasFee(targetType).then((q) => { if (!cancelled) setFee(q.fee); }).catch(() => { if (!cancelled) setFee(null); });
    return () => { cancelled = true; };
  }, [targetType, network]);

  const xym = (v: bigint) => `${formatAtomic(v, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = fee === 'loading' ? t('mosaic.cost_loading') : fee === null ? t('mosaic.cost_unavailable') : xym(fee);
  const targetText = (tg: AliasTarget) => (tg.type === 'address' ? tg.address : tg.mosaicId);
  const typeText = (type: 'address' | 'mosaic') => t(type === 'address' ? 'namespace.alias_address' : 'namespace.alias_mosaic');
  const canContinue = selected !== undefined && action !== null && target !== null;

  const onPassed = async (password: string) => {
    if (!selected || action === null || target === null) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await changeAlias({ privateKey, publicKey: wallet.publicKey, namespaceId: selected.id, action, target });
      showTxNotice({ lines: t(`namespace.alias_done_${action}`, { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(sent.hash), explorerLabel: t('namespace.view_explorer') });
      onDone?.();
      onSent();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const errorTitle = sendError ? t(`namespace.alias_error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`namespace.alias_error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];
  const rootSx = { flexGrow: 1, display: 'flex', flexDirection: 'column' } as const;

  // ============================ confirm ============================
  if (step === 'confirm' && selected && action !== null && target !== null) {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('namespace.alias_namespace'), value: `${selected.name}\n${selected.id}`, big: true },
      { label: t('namespace.alias_operation'), value: t(action === 'link' ? 'namespace.alias_link' : 'namespace.alias_unlink') },
      { label: t('namespace.table_alias_type'), value: typeText(target.type) },
      { label: t('namespace.table_alias'), value: targetText(target) },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('mosaic.tx_fee'), value: feeText },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => setStep('form')} back="/namespace" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 4, px: 3, py: 1 }}>
            {rows.map((row, i) => (
              <Box key={row.label}>
                {i > 0 && <Divider />}
                <Box sx={{ py: 2 }}>
                  <Typography sx={{ color: 'primary.main', fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                  <Typography sx={{ fontSize: row.big ? '1.3rem' : '1rem', fontWeight: row.big ? 'bold' : 'normal', lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                    {row.value}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('namespace.alias_sending') : t(`namespace.alias_confirm_ready_${action}`)}</Typography>
            <Button
              variant="contained" color="primary" size="large" fullWidth disabled={sending}
              onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}
            >
              {t('namespace.alias_confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {!embedded && <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('namespace.alias_title')}</Typography>}
        <Alert severity="info" sx={{ mb: 2 }}>{t('namespace.alias_intro')}</Alert>

        {namespaces === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : loadFailed ? (
          <Alert severity="error">{t('namespace.load_failed')}</Alert>
        ) : namespaces.length === 0 || !selected ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('namespace.alias_none_available')}</Typography>
        ) : (
          <>
            <TextField
              select label={t('namespace.alias_namespace')} value={selected.id} fullWidth sx={{ mb: 2 }}
              onChange={(e) => setNsId(e.target.value)}
            >
              {namespaces.map((n) => (
                <MenuItem key={n.id} value={n.id}>
                  {n.name}{n.aliasType !== 'none' ? ` (${typeText(n.aliasType)})` : ''}
                </MenuItem>
              ))}
            </TextField>

            {action === 'unlink' && target !== null ? (
              <>
                <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('namespace.alias_current')}</Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>{typeText(target.type)}</Typography>
                  <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{targetText(target)}</Typography>
                </Box>
                <Alert severity="warning" sx={{ mb: 2 }}>{t('namespace.alias_unlink_hint')}</Alert>
              </>
            ) : (
              <>
                <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('namespace.table_alias_type')}</Typography>
                <ToggleButtonGroup
                  exclusive fullWidth size="small" color="primary" value={linkType} sx={{ mb: 2 }}
                  onChange={(_, v: 'address' | 'mosaic' | null) => { if (v) setLinkType(v); }}
                >
                  <ToggleButton value="address">{t('namespace.alias_address')}</ToggleButton>
                  <ToggleButton value="mosaic">{t('namespace.alias_mosaic')}</ToggleButton>
                </ToggleButtonGroup>

                {linkType === 'address' ? (
                  <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('namespace.alias_own_address')}</Typography>
                    <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{ownAddress}</Typography>
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('namespace.alias_address_hint')}</Typography>
                  </Box>
                ) : mosaics.length === 0 ? (
                  <Alert severity="warning" sx={{ mb: 2 }}>{t('namespace.alias_no_mosaic')}</Alert>
                ) : (
                  <TextField
                    select label={t('namespace.alias_mosaic_pick')} value={mosaicChoice?.id ?? ''} fullWidth sx={{ mb: 2 }}
                    helperText={t('namespace.alias_mosaic_hint')}
                    onChange={(e) => setMosaicId(e.target.value)}
                  >
                    {mosaics.map((m) => (
                      <MenuItem key={m.id} value={m.id}>{m.name ? `${m.name} (${m.id})` : m.id}</MenuItem>
                    ))}
                  </TextField>
                )}
              </>
            )}

            <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('mosaic.tx_fee')}: <span style={{ fontWeight: 'normal' }}>{target === null ? '–' : feeText}</span></Typography>
            </Box>
          </>
        )}
      </Box>

      {namespaces !== null && namespaces.length > 0 && selected && (
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => setStep('confirm')} sx={{ py: 1.5 }}>
            {t('namespace.alias_go_confirm')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default withFormReset<NamespaceAliasProps>(NamespaceAlias);
