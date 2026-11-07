import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert, Box, Button, CircularProgress, IconButton, Link, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FirstPageIcon from '@mui/icons-material/FirstPage';
import LastPageIcon from '@mui/icons-material/LastPage';
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
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';

type TabKey = 'status' | 'enroll' | 'payout';

const xem = (amount: bigint) => `${formatAtomic(amount, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;

/** A read-only value in a grey box, with an optional unit on the right (the NanoWallet look: label on the left, value in a box). */
function Val({ children, unit, mono: useMono = false }: { children: ReactNode; unit?: string; mono?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, bgcolor: 'action.hover', borderRadius: 1.5, px: 1.5, py: 1, minHeight: 20, fontSize: 14, wordBreak: 'break-all', ...(useMono ? mono : {}) }}>
      <Box component="span" sx={{ minWidth: 0 }}>{children}</Box>
      {unit && <Typography component="span" sx={{ fontSize: 12, fontWeight: 'bold', color: 'text.secondary', flexShrink: 0 }}>{unit}</Typography>}
    </Box>
  );
}

/** XEM amount as a number (without the symbol) for a Val with unit. */
const xemNumber = (amount: bigint) => formatAtomic(amount, NEM_CURRENCY_DIVISIBILITY);

/** A transaction hash shortened for a table cell. */
const shortHash = (hash: string) => (hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash);

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
  const enrolledNote = info === null ? t('supernode.not_enrolled_note') : info.active ? t('supernode.state_active_note') : t('supernode.state_inactive_note');
  const banner = {
    label: info === null ? t('supernode.state_not_enrolled') : info.active ? t('supernode.state_active') : t('supernode.state_inactive'),
    color: info === null ? 'text.secondary' : info.active ? 'success.main' : 'error.main',
  };

  const accountCard = (
    <SectionCard sx={{ py: { xs: 1, md: 1.5 } }}>
      <FormRow label={t('supernode.account')}><Val mono>{address ? prettyChainAddress(address) : '-'}</Val></FormRow>
      <FormRow label={t('supernode.balance')}><Val unit={NEM_CURRENCY_SYMBOL}>{balance === null ? '-' : xemNumber(balance)}</Val></FormRow>
    </SectionCard>
  );

  // The state at a glance (big, coloured), what it means, and what to do next.
  const statusBanner = (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, bgcolor: 'background.paper', border: 1, borderColor: banner.color, borderRadius: 3, px: 2.5, py: 2, mb: 2 }}>
      <Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: banner.color, flexShrink: 0 }} aria-hidden />
      <Box sx={{ flex: 1, minWidth: 200 }}>
        <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem', color: banner.color }}>{banner.label}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25, lineHeight: 1.7 }}>{enrolledNote}</Typography>
      </Box>
      {info === null && isMainnet && <Button variant="contained" color="primary" onClick={() => setTab('enroll')}>{t('supernode.go_enroll')}</Button>}
    </Box>
  );

  const statusTab = (
    <>
      {statusBanner}
      <SectionCard title={t('supernode.status_title')}>
        <FormRow label={t('supernode.node_name')}><Val>{info?.name || '-'}</Val></FormRow>
        <FormRow label={t('supernode.node_host')}><Val>{info?.host || '-'}</Val></FormRow>
        <FormRow label={t('supernode.public_key')}><Val mono>{info?.mainPublicKey || '-'}</Val></FormRow>
        <FormRow label={t('supernode.remote_public_key')}><Val mono>{info?.remotePublicKey || '-'}</Val></FormRow>
        <FormRow label={t('supernode.last_payout_round')}><Val>{info === null || info.lastPayoutRound === null ? '-' : String(info.lastPayoutRound)}</Val></FormRow>
        <FormRow label={t('supernode.total_rewards')}><Val unit={NEM_CURRENCY_SYMBOL}>{info === null ? '-' : xemNumber(info.totalRewardsEarned)}</Val></FormRow>
        <Button onClick={load} sx={{ mt: 1 }}>{t('supernode.reload')}</Button>
      </SectionCard>
    </>
  );

  const enrollSteps = ['supernode.step_1', 'supernode.step_2', 'supernode.step_3'];
  const enrollTab = (
    <>
      <Alert severity="info" sx={{ mb: 2 }}>{t('supernode.enroll_about')}</Alert>
      {/* Wide screens: the steps on the left, the form on the right (one column on a phone). */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 2fr) minmax(0, 3fr)' }, columnGap: 3, alignItems: 'start' }}>
      <SectionCard title={t('supernode.steps_title')}>
        <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1 }}>
          {enrollSteps.map((key, i) => (
            <Box component="li" key={key} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
              <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: 13, fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</Box>
              <Typography variant="body2" sx={{ lineHeight: 1.7, pt: 0.25 }}>{t(key)}</Typography>
            </Box>
          ))}
        </Box>
      </SectionCard>
      <SectionCard>
        {info?.host && <Alert severity="info" sx={{ mb: 1 }}>{t('supernode.enroll_current', { host: info.host })}</Alert>}
        <FormRow label={t('supernode.enroll_address')} top hint={t('supernode.enroll_address_hint')}>
          <Field
            ariaLabel={t('supernode.enroll_address')}
            value={enrollAddress}
            onChange={(e) => setEnrollAddress(e.target.value.toUpperCase().replace(/[\s-]/g, ''))}
            error={enrollAddress !== '' && !addressValid}
            helperText={enrollAddress !== '' && !addressValid ? t('supernode.enroll_address_invalid') : ''}
            htmlInput={{ autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false }}
          />
        </FormRow>
        <FormRow label={t('supernode.node_host')} top hint={t('supernode.node_host_hint')}>
          <Field
            ariaLabel={t('supernode.node_host')}
            value={nodeHost}
            onChange={(e) => setNodeHost(e.target.value.trim())}
            error={nodeHost !== '' && !hostValid}
            helperText={nodeHost !== '' && !hostValid ? t('supernode.node_host_invalid') : ''}
            htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
          />
        </FormRow>
        <FormRow label={t('supernode.tx_fee')} hint={t('supernode.fee_hint')}><Val unit={NEM_CURRENCY_SYMBOL}>{xemNumber(fee)}</Val></FormRow>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1, mb: 1.5 }}>{t('supernode.enroll_password_note')}</Typography>
        <Button
          variant="contained"
          color="primary"
          size="large"
          fullWidth
          disabled={!canEnroll}
          onClick={() => setShowConfirm(true)}
          startIcon={<LockOutlinedIcon />}
          sx={{ py: 1.25 }}
        >
          {working ? t('supernode.enrolling') : t('supernode.enroll_button')}
        </Button>
      </SectionCard>
      </Box>
    </>
  );

  // The payouts as a table (the NanoWallet columns), with first / previous / next / last page buttons.
  const pager = info !== null && lastPage > 0 && (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, mt: 1.5 }}>
      <IconButton disabled={page === 0 || payoutsLoading} onClick={() => setPage(0)} aria-label={t('supernode.first_page')}><FirstPageIcon /></IconButton>
      <IconButton disabled={page === 0 || payoutsLoading} onClick={() => setPage((p) => p - 1)} aria-label={t('supernode.prev_page')}><ChevronLeftIcon /></IconButton>
      <Typography sx={{ px: 1, fontVariantNumeric: 'tabular-nums' }}>{page + 1} / {lastPage + 1}</Typography>
      <IconButton disabled={page >= lastPage || payoutsLoading} onClick={() => setPage((p) => p + 1)} aria-label={t('supernode.next_page')}><ChevronRightIcon /></IconButton>
      <IconButton disabled={page >= lastPage || payoutsLoading} onClick={() => setPage(lastPage)} aria-label={t('supernode.last_page')}><LastPageIcon /></IconButton>
    </Box>
  );
  const emptyRow = (text: ReactNode) => <TableRow><TableCell colSpan={5} sx={{ textAlign: 'center', color: 'text.secondary', py: 3, borderBottom: 0 }}>{text}</TableCell></TableRow>;
  const payoutTab = (
    <SectionCard sx={{ px: { xs: 1, md: 2 } }}>
      {info !== null && <Typography variant="body2" sx={{ color: 'text.secondary', px: 1, pb: 1 }}>{t('supernode.payout_count', { count: info.rewardCount })}</Typography>}
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 560 }}>
          <TableHead>
            <TableRow sx={{ '& th': { color: 'text.secondary', fontWeight: 'normal', whiteSpace: 'nowrap' } }}>
              <TableCell>{t('supernode.payout_col_from')}</TableCell>
              <TableCell>{t('supernode.payout_col_to')}</TableCell>
              <TableCell align="right">{t('supernode.payout_col_amount')}</TableCell>
              <TableCell>{t('supernode.payout_col_hash')}</TableCell>
              <TableCell>{t('supernode.payout_col_date')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {info === null ? emptyRow(t('supernode.payout_needs_enrollment'))
              : payoutsLoading ? emptyRow(<CircularProgress size={22} />)
              : payoutsFailed ? emptyRow(<><Box sx={{ mb: 1 }}>{t('supernode.payout_failed')}</Box><Button variant="outlined" size="small" onClick={() => loadPayouts(info.id, page)}>{t('supernode.reload')}</Button></>)
              : payouts.length === 0 ? emptyRow(t('supernode.payout_none'))
              : payouts.map((p) => (
                <TableRow key={`${p.fromRound}-${p.toRound}-${p.transactionHash}`}>
                  <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{p.fromRound}</TableCell>
                  <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{p.toRound}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'success.main', fontWeight: 'bold', whiteSpace: 'nowrap' }}>+ {xem(p.amount)}</TableCell>
                  <TableCell sx={mono}>
                    {p.isPaid && p.transactionHash
                      ? <Link href={chainExplorerTxUrl(p.transactionHash)} target="_blank" rel="noopener" title={p.transactionHash}>{shortHash(p.transactionHash)}</Link>
                      : '-'}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{p.timestampMs !== null ? new Date(p.timestampMs).toLocaleString() : '-'}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>
      {pager}
    </SectionCard>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
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
            <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
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
        mode="check" popup
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
