import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogTitle, Divider, IconButton, MenuItem, TextField, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from './ErrorSnackbar';
import MessageDialog from './MessageDialog';
import PasswordDialog from './PasswordDialog';
import { showTxNotice } from '../store/txNoticeStore';
import { WalletsHelper } from '../lib/storage';
import type { Wallet } from '../lib/storage';
import {
  SymbolSendError, changeAlias, explorerTxUrl, fetchOwnedNamespaces, quoteAliasFee,
} from '../lib/symbol/api';
import type { OwnedNamespace } from '../lib/symbol/api';
import { formatAtomic } from '../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../lib/symbol/constants';
import { normalizeAddress } from '../lib/symbol/crypto';
import { getNetworkConfig } from '../lib/symbol/network';
import type { AliasAction, AliasTarget } from '../lib/symbol/tx';
import { useAppStore } from '../store/appStore';

// Same mapping as the namespace screen's alias form: node status codes -> message key + detail.
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

const sameTarget = (ns: OwnedNamespace, target: AliasTarget): boolean => {
  if (ns.alias === '') return false;
  if (target.type === 'mosaic') return ns.aliasType === 'mosaic' && ns.alias.toUpperCase() === target.mosaicId.toUpperCase();
  return ns.aliasType === 'address' && normalizeAddress(ns.alias) === normalizeAddress(target.address);
};

interface AliasLinkDialogProps {
  open: boolean;
  onClose: () => void;
  /** The account that owns both the namespaces and the target; it signs. */
  account: Pick<Wallet, 'id' | 'address' | 'publicKey'> | null;
  /** The mosaic or address the namespace is linked to (fixed: chosen by the screen that opened this). */
  target: AliasTarget | null;
  /** Called after a link / unlink was announced (the caller reloads its own list). */
  onChanged?: () => void;
}

// 「ネームスペース連携」: ネームスペース画面の「エイリアス」タブと同じ操作を、モザイク画面・アカウント画面から
// 行うためのダイアログ。リンク先（モザイク / アドレス）は呼び出し側で決まっているので、ネームスペースだけ選ぶ。
// このターゲットにすでにリンクしているネームスペースは解除でき、まだ何にもリンクしていないものは新しくリンクできる。
export default function AliasLinkDialog({ open, onClose, account, target, onChanged }: AliasLinkDialogProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [namespaces, setNamespaces] = useState<OwnedNamespace[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nsId, setNsId] = useState('');
  const [pending, setPending] = useState<{ ns: OwnedNamespace; action: AliasAction } | null>(null);
  const [fee, setFee] = useState<bigint | null | 'loading'>('loading');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  const targetKey = target === null ? '' : target.type === 'mosaic' ? `m:${target.mosaicId}` : `a:${target.address}`;
  const accountAddress = account?.address ?? '';

  // Reload every time the dialog opens (the previous link / unlink may have been confirmed since).
  useEffect(() => {
    if (!open || accountAddress === '') return undefined;
    let cancelled = false;
    setNamespaces(null);
    setLoadFailed(false);
    setPending(null);
    setNsId('');
    fetchOwnedNamespaces(accountAddress)
      .then((list) => { if (!cancelled) setNamespaces(list.filter((n) => !n.expired)); })
      .catch((e) => {
        console.error('Failed to load namespaces', e);
        if (!cancelled) { setNamespaces([]); setLoadFailed(true); }
      });
    return () => { cancelled = true; };
  }, [open, accountAddress, targetKey, network]);

  const linked = useMemo(() => (target && namespaces ? namespaces.filter((n) => sameTarget(n, target)) : []), [namespaces, target]);
  const linkable = useMemo(() => (namespaces ?? []).filter((n) => n.aliasType === 'none' || n.alias === ''), [namespaces]);
  const chosen = linkable.find((n) => n.id === nsId) ?? linkable[0];

  const feeType = target?.type ?? null;
  useEffect(() => {
    if (!open || feeType === null) return undefined;
    let cancelled = false;
    setFee('loading');
    quoteAliasFee(feeType).then((q) => { if (!cancelled) setFee(q.fee); }).catch(() => { if (!cancelled) setFee(null); });
    return () => { cancelled = true; };
  }, [open, feeType, network]);

  const xym = (v: bigint) => `${formatAtomic(v, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeText = fee === 'loading' ? t('mosaic.cost_loading') : fee === null ? t('mosaic.cost_unavailable') : xym(fee);
  const typeText = (type: 'address' | 'mosaic') => t(type === 'address' ? 'namespace.alias_address' : 'namespace.alias_mosaic');
  const targetText = target === null ? '' : target.type === 'address' ? target.address : target.mosaicId;

  const close = () => {
    if (sending) return;
    setPending(null);
    onClose();
  };

  const onPassed = async (password: string) => {
    if (!pending || !account || !target) return;
    setSending(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(account.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await changeAlias({
        privateKey, publicKey: account.publicKey, namespaceId: pending.ns.id, action: pending.action, target,
      });
      showTxNotice({
        lines: t(`namespace.alias_done_${pending.action}`, { returnObjects: true }) as string[],
        explorerUrl: explorerTxUrl(sent.hash),
        explorerLabel: t('namespace.view_explorer'),
      });
      onChanged?.();
      setPending(null);
      onClose();
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

  const box = { bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 } as const;

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        {t('namespace.alias_link_dialog_title')}
        <IconButton aria-label={t('common.close')} onClick={close}><CloseIcon /></IconButton>
      </DialogTitle>

      <Box sx={{ overflowY: 'auto', px: 3, pb: 3 }}>
        {target !== null && (
          <Box sx={{ ...box, mb: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('namespace.alias_link_target')}（{typeText(target.type)}）</Typography>
            <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{targetText}</Typography>
          </Box>
        )}

        {pending ? (
          // ---- confirm ----
          <>
            <Box sx={{ ...box, mb: 2 }}>
              {[
                { label: t('namespace.alias_namespace'), value: `${pending.ns.name}\n${pending.ns.id}`, big: true },
                { label: t('namespace.alias_operation'), value: t(pending.action === 'link' ? 'namespace.alias_link' : 'namespace.alias_unlink') },
                { label: t('namespace.table_alias_type'), value: target ? typeText(target.type) : '' },
                { label: t('namespace.table_alias'), value: targetText },
                { label: t('send.network'), value: `${netCfg.key === 'mijin' ? '' : 'Symbol '}${netCfg.label}` },
                { label: t('mosaic.tx_fee'), value: feeText },
              ].map((row, i) => (
                <Box key={row.label}>
                  {i > 0 && <Divider />}
                  <Box sx={{ py: 1.25 }}>
                    <Typography sx={{ color: 'primary.main', fontSize: '0.8rem', mb: 0.25 }}>{row.label}</Typography>
                    <Typography sx={{ fontSize: row.big ? '1.15rem' : '0.95rem', fontWeight: row.big ? 'bold' : 'normal', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                      {row.value}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>
            <Typography sx={{ textAlign: 'center', mb: 1.5 }}>
              {sending ? t('namespace.alias_sending') : t(`namespace.alias_confirm_ready_${pending.action}`)}
            </Typography>
            <Button
              variant="contained" fullWidth size="large" disabled={sending} startIcon={<LockOutlinedIcon />}
              onClick={() => setShowPasswordDialog(true)} sx={{ py: 1.25, mb: 1 }}
            >
              {t('namespace.alias_confirm_password')}
            </Button>
            <Button color="inherit" fullWidth disabled={sending} onClick={() => setPending(null)}>{t('namespace.alias_link_back')}</Button>
          </>
        ) : namespaces === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : loadFailed ? (
          <Alert severity="error">{t('namespace.load_failed')}</Alert>
        ) : (
          // ---- choose ----
          <>
            <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('namespace.alias_link_current')}</Typography>
            {linked.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('namespace.alias_link_none_linked')}</Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
                {linked.map((n) => (
                  <Box key={n.id} sx={{ ...box, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{n.name}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{n.id}</Typography>
                    </Box>
                    <Button size="small" variant="outlined" color="inherit" startIcon={<LinkOffIcon />} onClick={() => setPending({ ns: n, action: 'unlink' })}>
                      {t('namespace.alias_unlink')}
                    </Button>
                  </Box>
                ))}
              </Box>
            )}

            <Divider sx={{ mb: 2 }} />

            <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('namespace.alias_link_new')}</Typography>
            {linkable.length === 0 || !chosen ? (
              <Alert severity="info">{t('namespace.alias_link_no_free')}</Alert>
            ) : (
              <>
                <TextField
                  select fullWidth label={t('namespace.alias_namespace')} value={chosen.id} sx={{ mb: 1.5 }}
                  helperText={t('namespace.alias_link_free_hint')}
                  onChange={(e) => setNsId(e.target.value)}
                >
                  {linkable.map((n) => <MenuItem key={n.id} value={n.id}>{n.name}</MenuItem>)}
                </TextField>
                <Box sx={{ ...box, mb: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                    {t('mosaic.tx_fee')}: <span style={{ fontWeight: 'normal' }}>{feeText}</span>
                  </Typography>
                </Box>
                <Button variant="contained" fullWidth startIcon={<LinkIcon />} sx={{ py: 1.1 }} onClick={() => setPending({ ns: chosen, action: 'link' })}>
                  {t('namespace.alias_link_go_confirm')}
                </Button>
              </>
            )}
          </>
        )}
      </Box>

      <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Dialog>
  );
}
