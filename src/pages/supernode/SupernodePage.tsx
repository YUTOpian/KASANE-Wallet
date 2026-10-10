import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Link, Tab, Tabs, TextField, Typography,
} from '@mui/material';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { SymbolSendError } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { chainExplorerTxUrl, fetchChainBalances, prettyChainAddress } from '../../lib/chainApi';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_NATIVE_ID } from '../../lib/nem/constants';
import {
  SUPERNODE_INFO_URL, SUPERNODE_PAYOUT_PAGE_SIZE, SupernodeEnrollError, enrollInSupernodeProgram,
  fetchSupernodeInfo, fetchSupernodePayouts, isValidEnrollAddress, isValidNodeHost, supernodeEnrollFee,
} from '../../lib/nem/supernode';
import type { SupernodeInfo, SupernodePayout } from '../../lib/nem/supernode';
import { useAppStore } from '../../store/appStore';

type TabKey = 'status' | 'enroll' | 'payout';

const xem = (amount: bigint) => `${formatAtomic(amount, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;

// Maps an enrollment failure (a SupernodeEnrollError, a NIS1 rejection or a local failure) to a message key.
function classifyError(error: unknown): { kind: string; detail: string } {
  if (error instanceof SupernodeEnrollError) return { kind: error.kind, detail: '' };
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'FAILURE_INSUFFICIENT_BALANCE') return { kind: 'insufficient_balance', detail };
  if (code.startsWith('FAILURE_TIMESTAMP') || code.startsWith('FAILURE_DEADLINE')) return { kind: 'deadline', detail };
  if (code === 'FAILURE_WRONG_NETWORK') return { kind: 'wrong_network', detail };
  return { kind: 'unknown', detail: code && code !== detail ? `${code}: ${detail}` : detail };
}

// 「スーパーノードプログラム」: NEM (NIS1) only. Shows whether the active account's main key is
// enrolled in the NEM SuperNode Program, enrolls it, and lists the payouts the node has received.
export default function SupernodePage() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const isMainnet = network === 'mainnet';

  const [tab, setTab] = useState<TabKey>('status');
  const [address, setAddress] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);

  // status
  const [info, setInfo] = useState<SupernodeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // enroll
  const [enrollAddress, setEnrollAddress] = useState('');
  const [nodeHost, setNodeHost] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [working, setWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [done, setDone] = useState(false);

  // payouts
  const [page, setPage] = useState(0);
  const [payouts, setPayouts] = useState<SupernodePayout[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutsFailed, setPayoutsFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) {
        setPublicKey('');
        return;
      }
      setAddress(wallet.address);
      setPublicKey(wallet.publicKey);
      // The balance is only a convenience; the status is what must load.
      fetchChainBalances(wallet.address)
        .then((list) => setBalance(list.find((b) => b.id === NEM_NATIVE_ID)?.amount ?? 0n))
        .catch(() => setBalance(null));
      if (!isMainnet) {
        setInfo(null);
        return;
      }
      setInfo(await fetchSupernodeInfo(wallet.publicKey));
    } catch (e) {
      console.error('Failed to load supernode status', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isMainnet]);

  useEffect(() => {
    load();
  }, [load, network]);

  // When the account is already enrolled the host field starts with the enrolled host.
  useEffect(() => {
    if (info?.host) setNodeHost((prev) => prev || info.host);
  }, [info]);

  const loadPayouts = useCallback(async (nodeId: string, pageNumber: number) => {
    setPayoutsLoading(true);
    setPayoutsFailed(false);
    try {
      setPayouts(await fetchSupernodePayouts(nodeId, pageNumber));
    } catch (e) {
      console.error('Failed to load supernode payouts', e);
      setPayouts([]);
      setPayoutsFailed(true);
    } finally {
      setPayoutsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'payout' || !info?.id) return;
    loadPayouts(info.id, page);
  }, [tab, info?.id, page, loadPayouts]);

  const lastPage = info ? Math.max(0, Math.ceil(info.rewardCount / SUPERNODE_PAYOUT_PAGE_SIZE) - 1) : 0;

  // --- enroll -----------------------------------------------------------------------------------
  const addressValid = isValidEnrollAddress(enrollAddress);
  const hostValid = isValidNodeHost(nodeHost);
  const fee = hostValid ? supernodeEnrollFee(nodeHost) : supernodeEnrollFee('example.com');
  const canEnroll = isMainnet && addressValid && hostValid && !working;

  const onPassed = async (password: string) => {
    setWorking(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      await enrollInSupernodeProgram({
        privateKey,
        publicKey: wallet.publicKey,
        enrollAddress,
        nodeHost,
        currentHost: info?.host || undefined,
      });
      setDone(true);
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setWorking(false);
    }
  };

  const errorTitle = sendError ? t(`supernode.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? (t(`supernode.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[])
    : [];

  // --- rendering --------------------------------------------------------------------------------
  const stateChip = info === null
    ? <Chip variant="outlined" label={t('supernode.state_not_enrolled')} />
    : info.active
      ? <Chip color="success" label={t('supernode.state_active')} />
      : <Chip color="warning" label={t('supernode.state_inactive')} />;

  const statusRows = info === null ? [] : [
    { label: t('supernode.node_name'), value: info.name || '-' },
    { label: t('supernode.node_host'), value: info.host || '-' },
    { label: t('supernode.public_key'), value: info.mainPublicKey || '-' },
    { label: t('supernode.remote_public_key'), value: info.remotePublicKey || '-' },
    { label: t('supernode.last_payout_round'), value: info.lastPayoutRound === null ? '-' : String(info.lastPayoutRound) },
    { label: t('supernode.total_rewards'), value: xem(info.totalRewardsEarned) },
  ];

  const card = { bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 } as const;

  const accountCard = (
    <Box sx={{ ...card, mb: 2 }}>
      <Typography variant="body2" sx={{ py: 0.5, wordBreak: 'break-all' }}>{t('supernode.account')}: {address ? prettyChainAddress(address) : '-'}</Typography>
      <Divider />
      <Typography variant="body2" sx={{ py: 0.5 }}>
        {t('supernode.balance')}: {balance === null ? '-' : xem(balance)}
      </Typography>
    </Box>
  );

  const statusTab = (
    <Box sx={card}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <DnsOutlinedIcon color="primary" />
        <Typography sx={{ fontWeight: 'bold', flexGrow: 1 }}>{t('supernode.status_title')}</Typography>
        {stateChip}
      </Box>
      {info === null ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', py: 1 }}>{t('supernode.not_enrolled_note')}</Typography>
      ) : (
        statusRows.map((r, i) => (
          <Box key={r.label}>
            {i > 0 && <Divider />}
            <Typography variant="body2" sx={{ py: 0.75, wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
          </Box>
        ))
      )}
      <Button onClick={load} sx={{ mt: 1 }}>{t('supernode.reload')}</Button>
    </Box>
  );

  const enrollTab = (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>{t('supernode.enroll_about')}</Alert>
      <TextField
        label={t('supernode.enroll_address')}
        value={enrollAddress}
        onChange={(e) => setEnrollAddress(e.target.value.toUpperCase().replace(/[\s-]/g, ''))}
        error={enrollAddress !== '' && !addressValid}
        helperText={enrollAddress !== '' && !addressValid ? t('supernode.enroll_address_invalid') : t('supernode.enroll_address_hint')}
        fullWidth
        slotProps={{ htmlInput: { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } }}
        sx={{ mb: 2 }}
      />
      <TextField
        label={t('supernode.node_host')}
        value={nodeHost}
        onChange={(e) => setNodeHost(e.target.value.trim())}
        error={nodeHost !== '' && !hostValid}
        helperText={nodeHost !== '' && !hostValid ? t('supernode.node_host_invalid') : t('supernode.node_host_hint')}
        fullWidth
        slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
        sx={{ mb: 2 }}
      />
      <Box sx={card}>
        <Typography variant="body2">{t('supernode.tx_fee')}: {xem(fee)}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('supernode.fee_hint')}</Typography>
      </Box>
      <Button
        variant="contained"
        color="primary"
        size="large"
        fullWidth
        disabled={!canEnroll}
        onClick={() => setShowConfirm(true)}
        startIcon={<LockOutlinedIcon />}
        sx={{ py: 1.25, mt: 2 }}
      >
        {working ? t('supernode.enrolling') : t('supernode.enroll_button')}
      </Button>
    </Box>
  );

  const payoutTab = (
    <Box>
      {info === null ? (
        <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>{t('supernode.payout_needs_enrollment')}</Typography>
      ) : payoutsLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>
      ) : payoutsFailed ? (
        <Box sx={{ textAlign: 'center', py: 2 }}>
          <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t('supernode.payout_failed')}</Typography>
          <Button variant="outlined" onClick={() => loadPayouts(info.id, page)}>{t('supernode.reload')}</Button>
        </Box>
      ) : payouts.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>{t('supernode.payout_none')}</Typography>
      ) : (
        <>
          {payouts.map((p) => (
            <Box key={`${p.fromRound}-${p.toRound}-${p.transactionHash}`} sx={{ ...card, mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold', color: 'success.main' }}>+ {xem(p.amount)}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>{t('supernode.payout_rounds', { from: p.fromRound, to: p.toRound })}</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                {t('supernode.payout_hash')}:{' '}
                {p.isPaid && p.transactionHash
                  ? <Link href={chainExplorerTxUrl(p.transactionHash)} target="_blank" rel="noopener">{p.transactionHash}</Link>
                  : '-'}
              </Typography>
              {p.timestampMs !== null && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{new Date(p.timestampMs).toLocaleString('ja-JP')}</Typography>
              )}
            </Box>
          ))}
        </>
      )}
      {info !== null && lastPage > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mt: 1 }}>
          <IconButton disabled={page === 0 || payoutsLoading} onClick={() => setPage((p) => p - 1)} aria-label={t('supernode.prev_page')}>
            <ChevronLeftIcon />
          </IconButton>
          <Typography>{page + 1} / {lastPage + 1}</Typography>
          <IconButton disabled={page >= lastPage || payoutsLoading} onClick={() => setPage((p) => p + 1)} aria-label={t('supernode.next_page')}>
            <ChevronRightIcon />
          </IconButton>
        </Box>
      )}
    </Box>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', maxWidth: 720, px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('supernode.title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          {t('supernode.about')}{' '}
          <Link href={SUPERNODE_INFO_URL} target="_blank" rel="noopener">{t('supernode.read_more')}</Link>
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={26} /></Box>
        ) : !publicKey ? (
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>{t('supernode.no_wallet')}</Typography>
        ) : (
          <>
            {accountCard}
            {!isMainnet && <Alert severity="warning" sx={{ mb: 2 }}>{t('supernode.mainnet_only')}</Alert>}
            {failed && (
              <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>{t('supernode.reload')}</Button>}>
                {t('supernode.load_failed')}
              </Alert>
            )}
            <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} variant="fullWidth" sx={{ mb: 2 }}>
              <Tab value="status" label={t('supernode.tab_status')} />
              <Tab value="enroll" label={t('supernode.tab_enroll')} />
              <Tab value="payout" label={t('supernode.tab_payout')} />
            </Tabs>
            {tab === 'status' && statusTab}
            {tab === 'enroll' && enrollTab}
            {tab === 'payout' && payoutTab}
          </>
        )}
      </Box>

      <MessageDialog
        open={showConfirm}
        selectable
        title={t('supernode.confirm_title')}
        texts={[
          t('supernode.confirm_host', { host: nodeHost }),
          t('supernode.confirm_address', { address: addressValid ? prettyChainAddress(enrollAddress) : '' }),
          ...(t('supernode.confirm_message', { returnObjects: true }) as string[]),
        ]}
        onClose={() => { setShowConfirm(false); setShowPasswordDialog(true); }}
        onCancel={() => setShowConfirm(false)}
      />
      <PasswordDialog
        open={showPasswordDialog}
        mode="check"
        onClose={() => setShowPasswordDialog(false)}
        onPass={(password) => { setShowPasswordDialog(false); onPassed(password); }}
      />
      <MessageDialog
        open={done}
        title={t('supernode.done_title')}
        texts={t('supernode.done_message', { returnObjects: true }) as string[]}
        onClose={() => { setDone(false); load(); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} variant="error" title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Box>
  );
}
