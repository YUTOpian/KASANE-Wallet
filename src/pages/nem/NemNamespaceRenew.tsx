import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, MenuItem, Tab, Tabs, TextField, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemOwnedNamespaces, fetchNemXemBalance, nemExplorerTxUrl, registerNemNamespace } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { fetchNemMultisigInfo, sendNemMultisigWrapped } from '../../lib/nem/multisigApi';
import type { NemMultisigInfo } from '../../lib/nem/multisigApi';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { NEM_MULTISIG_WRAPPER_FEE, NEM_PROVISION_TX_FEE, nemNamespaceRentalFee, nemNamespaceSinkAddress } from '../../lib/nem/tx';
import { NEM_RENEW_DAYS, nemExtendedExpiryMs, nemRemainingDays, renewableNemNamespaces } from '../../lib/nem/namespaceRenew';
import { useAppStore } from '../../store/appStore';
import { ConfirmRows, CostBox, classifyNemError, nemXem } from './parts';
import { classifyNemMultisigError } from './multisigParts';

type Mode = 'normal' | 'multisig';
type Step = 'form' | 'confirm';
interface SendError { scope: 'nemns' | 'nemmultisig'; kind: string; detail: string }

const monoSx = { '& input': { fontFamily: 'monospace' } } as const;

// NEM 「ネームスペースの更新」（ネームスペース一覧の行の「更新」ボタンから開くポップアップ）。Symbol の更新タブと同じ並び:
//   説明 → 更新するネームスペース → 現在の有効期限 → 延長する期間 → 延長後の有効期限（目安）→ 費用の枠 → 下に固定の「確認画面へ」。
// 期限まで1か月以内（または期限切れ）のルートが対象（公式 NEM Wallet の RenewNamespacesCtrl と同じ判定）。
// NEM では1回の更新で必ず1年延びる（期間は選べない）。連署しているアカウントがあるときは「ノーマル / マルチシグ」の切り替えが出る。
// 入力 → 確認（パスワード）→ 送信。
interface NemNamespaceRenewProps {
  /** Root to select first (the renew button of a row on the owned list). */
  initialName?: string;
  /** Called after the renewal was sent (the dialog closes and the list reloads). */
  onDone?: () => void;
}

function NemNamespaceRenew({ initialName, onDone, onSent }: NemNamespaceRenewProps & SentProps) {
  const { t, i18n } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [mode, setMode] = useState<Mode>('normal');
  const [multisigAccounts, setMultisigAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState('');
  const [accountInfo, setAccountInfo] = useState<NemMultisigInfo | null>(null);
  const [renewable, setRenewable] = useState<NemOwnedNamespace[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);

  const [showCaution, setShowCaution] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<SendError | null>(null);

  const isMultisig = mode === 'multisig';

  // The accounts this wallet cosigns for (the 「マルチシグ」 switch only appears when there are any), and the XEM balance.
  useEffect(() => {
    let cancelled = false;
    setXemBalance(null);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        fetchNemXemBalance(wallet.address).then((b) => { if (!cancelled) setXemBalance(b); }).catch(() => { /* the warning is optional */ });
        const own = await fetchNemMultisigInfo(wallet.address);
        if (cancelled) return;
        const list = own.multisigOf.map((a) => a.address);
        setMultisigAccounts(list);
        setAccount((cur) => (list.includes(cur) ? cur : (list[0] ?? '')));
      } catch (e) {
        console.error('Failed to load multisig accounts', e);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // The renewable roots of the account the form is for. The first one (soonest expiry) is selected.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const wallet = await WalletsHelper.getActive();
      const target = isMultisig ? account : wallet?.address ?? '';
      if (!target) { setRenewable([]); setSelected(''); return; }
      const list = renewableNemNamespaces(await fetchNemOwnedNamespaces(target));
      setRenewable(list);
      setSelected(list.find((r) => r.name === initialName)?.name ?? list[0]?.name ?? '');
    } catch (e) {
      console.error('Failed to load namespaces', e);
      setRenewable([]);
      setSelected('');
    } finally {
      setLoading(false);
    }
  }, [isMultisig, account, initialName]);

  useEffect(() => {
    load();
  }, [load, network]);

  // The multisig account's public key is needed to wrap the renewal in its name.
  useEffect(() => {
    if (!isMultisig || !account) { setAccountInfo(null); return undefined; }
    let cancelled = false;
    setAccountInfo(null);
    fetchNemMultisigInfo(account).then((i) => { if (!cancelled) setAccountInfo(i); }).catch((e) => console.error('Failed to load account', e));
    return () => { cancelled = true; };
  }, [isMultisig, account, network]);

  const ns = renewable.find((r) => r.name === selected);
  const rental = nemNamespaceRentalFee(true);
  const txFee = isMultisig ? NEM_PROVISION_TX_FEE + NEM_MULTISIG_WRAPPER_FEE : NEM_PROVISION_TX_FEE;
  const total = rental + txFee;
  const balanceShort = xemBalance !== null && xemBalance < total;
  const needAccountKey = isMultisig && accountInfo !== null && !accountInfo.publicKey;
  const canContinue = ns !== undefined && (!isMultisig || (accountInfo !== null && !!accountInfo.publicKey));

  const date = (ms: number) => new Date(ms).toLocaleDateString(i18n.language);
  const left = ns ? nemRemainingDays(ns) : null;
  const soon = ns !== undefined && !ns.expired;
  const daysLabel = t('nemns.renew_period_value');

  const onPassed = async (password: string) => {
    if (!ns) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = isMultisig && accountInfo?.publicKey
        ? await sendNemMultisigWrapped(privateKey, wallet.publicKey, accountInfo.publicKey, { kind: 'namespace', name: ns.name })
        : await registerNemNamespace({ privateKey, publicKey: wallet.publicKey, name: ns.name });
      showTxNotice({ lines: t('nemns.renew_done_message', { returnObjects: true }) as string[], explorerUrl: sent.hash ? nemExplorerTxUrl(sent.hash) : undefined, explorerLabel: t('nemns.view_explorer') });
      onDone?.();
      onSent();
    } catch (error) {
      setSendError(isMultisig
        ? { scope: 'nemmultisig', ...classifyNemMultisigError(error) }
        : { scope: 'nemns', ...classifyNemError(error, 'NAMESPACE') });
    } finally {
      setSending(false);
    }
  };

  const errorTitle = sendError ? t(`${sendError.scope}.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`${sendError.scope}.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  const rootSx = { flexGrow: 1, display: 'flex', flexDirection: 'column' } as const;

  // ============================ confirm ============================
  if (step === 'confirm' && ns) {
    const rows: { label: string; value: string; big?: boolean }[] = [
      { label: t('namespace.table_name'), value: ns.name, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      ...(isMultisig ? [{ label: t('nemns.renew_multisig_account'), value: account }] : []),
      { label: t('nemns.renew_current_expiry'), value: date(ns.expiresAtMs) },
      { label: t('nemns.renew_period_label'), value: daysLabel },
      { label: t('nemns.renew_after_expiry'), value: date(nemExtendedExpiryMs(ns)) },
      { label: t('nemns.renew_sink'), value: nemNamespaceSinkAddress(netCfg.networkByte) },
      { label: t('nemns.rental_fee'), value: nemXem(rental) },
      { label: t('nemns.tx_fee'), value: nemXem(txFee) },
      { label: t('nemns.total'), value: nemXem(total) },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => setStep('form')} back="/namespace" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>

        <MessageDialog
          open={showCaution}
          title={t('nemns.confirm_title')}
          texts={t('nemns.renew_confirm_dialog', { returnObjects: true }) as string[]}
          onClose={() => setShowCaution(false)}
        />

        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('nemns.renew_sending') : t('nemns.renew_confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPassword(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemns.renew_confirm_password')}
            </Button>
          </Box>
        </Box>

        <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={(pw) => { setShowPassword(false); onPassed(pw); }} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  const rootLabel = (r: NemOwnedNamespace) => {
    const days = nemRemainingDays(r);
    return `${r.name}  (${days === null ? t('namespace.expired') : t('nemns.renew_left', { days })})`;
  };

  return (
    <Box sx={rootSx}>
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {multisigAccounts.length > 0 && (
          <Tabs value={mode} onChange={(_, v: Mode) => setMode(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
            <Tab value="normal" label={t('nemns.renew_tab_normal')} />
            <Tab value="multisig" label={t('nemns.renew_tab_multisig')} />
          </Tabs>
        )}

        <Alert severity="info" sx={{ mb: 2 }}>{t('nemns.renew_intro')}</Alert>

        {isMultisig && (
          <>
            <TextField select fullWidth label={t('nemns.renew_multisig_account')} value={account} onChange={(e) => setAccount(e.target.value)} sx={{ mb: 2, ...monoSx }}>
              {multisigAccounts.map((a) => <MenuItem key={a} value={a} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>{a}</MenuItem>)}
            </TextField>
            {needAccountKey && <Alert severity="warning" sx={{ mb: 2 }}>{t('multisig.err_no_public_key')}</Alert>}
          </>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : !ns ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('nemns.renew_none')}</Typography>
        ) : (
          <>
            <TextField select label={t('nemns.renew_pick')} value={ns.name} onChange={(e) => setSelected(e.target.value)} fullWidth sx={{ mb: 2 }}>
              {renewable.map((r) => <MenuItem key={r.name} value={r.name}>{rootLabel(r)}</MenuItem>)}
            </TextField>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 0.75, mb: 2, fontSize: 14, alignItems: 'center' }}>
              <Box sx={{ color: 'text.secondary' }}>{t('nemns.renew_current_expiry')}</Box>
              <Box sx={{ fontWeight: 'bold' }}>
                {date(ns.expiresAtMs)}
                {ns.expired && <Chip size="small" color="error" variant="outlined" label={t('namespace.expired')} sx={{ ml: 1 }} />}
                {soon && <Chip size="small" color="warning" variant="outlined" label={t('nemns.renew_soon')} sx={{ ml: 1 }} />}
              </Box>
              {left !== null && (
                <>
                  <Box />
                  <Box sx={{ color: 'text.secondary' }}>{t('nemns.renew_left', { days: left })}</Box>
                </>
              )}
            </Box>

            {ns.expired && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemns.renew_expired_warning')}</Alert>}

            <TextField
              label={t('nemns.renew_period_label')}
              value={String(NEM_RENEW_DAYS)}
              helperText={t('nemns.renew_period_hint')}
              fullWidth
              slotProps={{ input: { readOnly: true } }}
              sx={{ mb: 2 }}
            />

            <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemns.renew_after_expiry')}</Typography>
              <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem' }}>{date(nemExtendedExpiryMs(ns))}</Typography>
            </Box>

            <CostBox
              title={t('nemns.cost_title')}
              rows={[
                { label: t('nemns.rental_fee'), value: nemXem(rental) },
                { label: t('nemns.tx_fee'), value: nemXem(txFee) },
                { label: t('nemns.total'), value: nemXem(total), bold: true },
              ]}
              hint={t('nemns.cost_hint')}
              warning={balanceShort ? t('nemns.xem_short_warning') : undefined}
            />
          </>
        )}
      </Box>

      {!loading && ns && (
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
            {t('nemns.go_confirm')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default withFormReset<NemNamespaceRenewProps>(NemNamespaceRenew);
