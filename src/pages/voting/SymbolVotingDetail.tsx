import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, LinearProgress, Link, Radio, Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { explorerAccountUrl, explorerTxUrl } from '../../lib/symbol/api';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { POLL_TYPE_WHITELIST, isPollEnded } from '../../lib/symbol/voting';
import type { Poll, PollResults } from '../../lib/symbol/voting';
import { fetchSymbolPoll, fetchSymbolPollResults, fetchXymBalance, quoteSymbolVoteFee, sendSymbolVote } from '../../lib/symbol/votingApi';
import { useAppStore } from '../../store/appStore';
import { classifyNemError, ConfirmRows } from '../nem/parts';
import { xymText } from '../multisig/parts';
import { showTxNotice } from '../../store/txNoticeStore';
import { votingErrorKey } from './votingText';

type Step = 'view' | 'confirm';

const LOAD_ERRORS = ['poll_not_found', 'poll_invalid', 'poll_unsupported', 'poll_wrong_network'];

// Symbol の投票 1 件: 内容・集計の途中経過・投票。NEM の投票（pages/nem/NemVotingDetail.tsx）と同じ画面で、数え方も NEM と同じ:
// 承認済みの 0 XYM の票だけを数え、1 つだけ選べる投票では、複数の選択肢に投票したアカウントの票は無効。
// 文言は、Symbol 固有のものだけ symbolvoting.*、ほかは nemvoting.* を使う。
export default function SymbolVotingDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { address = '' } = useParams<{ address: string }>();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig();

  const [step, setStep] = useState<Step>('view');
  const [poll, setPoll] = useState<Poll | null>(null);
  const [results, setResults] = useState<PollResults | null>(null);
  const [loadingPoll, setLoadingPoll] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [resultsFailed, setResultsFailed] = useState(false);
  const [myAddress, setMyAddress] = useState('');
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);
  const [voteFee, setVoteFee] = useState<bigint | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [sentVotes, setSentVotes] = useState<string[]>([]); // ここから投票したが、まだ集計に入っていない票
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  const loadResults = useCallback(async (p: Poll, me: string) => {
    setLoadingResults(true);
    setResultsFailed(false);
    try {
      setResults(await fetchSymbolPollResults(p, me || undefined));
    } catch (e) {
      console.error('Failed to count votes', e);
      setResultsFailed(true);
    } finally {
      setLoadingResults(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoadingPoll(true);
    setLoadError(null);
    setPoll(null);
    setResults(null);
    setSelected([]);
    setSentVotes([]);
    try {
      const wallet = await WalletsHelper.getActive();
      const me = wallet?.address ?? '';
      setMyAddress(me);
      if (wallet) fetchXymBalance(wallet.address).then(setXymBalance).catch(() => setXymBalance(null));
      quoteSymbolVoteFee().then(setVoteFee).catch(() => setVoteFee(null));
      const p = await fetchSymbolPoll(address);
      setPoll(p);
      setLoadingPoll(false);
      void loadResults(p, me);
    } catch (e) {
      console.error('Failed to load poll', e);
      const message = e instanceof Error ? e.message : '';
      setLoadError(LOAD_ERRORS.includes(message) ? message : 'load_failed');
      setLoadingPoll(false);
    }
  }, [address, loadResults]);

  useEffect(() => {
    load();
  }, [load, network]);

  const ended = poll ? isPollEnded(poll) : false;
  const myVoted = useMemo(() => [...new Set([...(results?.myVotes ?? []), ...sentVotes])], [results, sentVotes]);
  const onWhitelist = poll?.type === POLL_TYPE_WHITELIST ? Boolean(myAddress && poll.whitelist?.includes(normalizeAddress(myAddress))) : true;
  const singleAlreadyVoted = poll !== null && !poll.multiple && myVoted.length > 0;
  const votingOpen = poll !== null && poll.valid && !ended && onWhitelist && !singleAlreadyVoted && myAddress !== '';
  const totalFee = voteFee === null ? null : voteFee * BigInt(selected.length);
  const balanceShort = xymBalance !== null && totalFee !== null && selected.length > 0 && xymBalance < totalFee;
  const canVote = votingOpen && selected.length > 0 && !balanceShort;
  const feeText = totalFee === null ? '-' : xymText(totalFee);

  const toggle = (option: string) => {
    if (!poll) return;
    if (poll.multiple) setSelected((cur) => (cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option]));
    else setSelected([option]);
  };

  const onPassed = async (password: string) => {
    if (!poll) return;
    setSending(true);
    const done: string[] = [];
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      let hash = '';
      for (const option of selected) {
        hash = (await sendSymbolVote({ privateKey, publicKey: wallet.publicKey, poll, option })).hash;
        done.push(option);
      }
      setSentVotes((cur) => [...cur, ...done]);
      showTxNotice({ lines: t('nemvoting.done_message', { returnObjects: true }) as string[], explorerUrl: hash ? explorerTxUrl(hash) : undefined, explorerLabel: t('nemvoting.view_explorer') });
      setStep('view');
      setSelected([]);
      void loadResults(poll, myAddress);
    } catch (error) {
      if (done.length > 0) setSentVotes((cur) => [...cur, ...done]);
      const message = error instanceof Error ? error.message : '';
      if (message === 'poll_ended' || message === 'poll_invalid') setSendError({ kind: message, detail: message });
      else setSendError(classifyNemError(error, 'NONE'));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('view');
    else navigate('/voting');
  };

  const errorTitle = sendError ? t(votingErrorKey(sendError.kind, 'title')) : '';
  const errorTexts = sendError ? (t(votingErrorKey(sendError.kind, 'message'), { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  // ---- loading / failure ------------------------------------------------------------------
  if (loadingPoll || loadError || !poll) {
    return (
      <Box sx={{ minHeight: '100vh' }}>
        <BackButton onBack={() => navigate('/voting')} back="/voting" />
        <Box sx={{ px: { xs: 2, md: 4 }, py: 4, textAlign: 'center' }}>
          {loadingPoll ? (
            <CircularProgress size={28} />
          ) : (
            <>
              <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{t(`nemvoting.${loadError ?? 'load_failed'}`)}</Typography>
              <Button variant="outlined" onClick={load}>{t('nemvoting.retry')}</Button>
            </>
          )}
        </Box>
      </Box>
    );
  }

  // ---- confirm ----------------------------------------------------------------------------
  if (step === 'confirm') {
    const rows = [
      { label: t('nemvoting.poll_label'), value: poll.title, big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('nemvoting.your_choice'), value: selected.join('\n') },
      { label: t('nemvoting.vote_fee'), value: feeText },
    ];
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back={`/voting/poll/${poll.address}`} />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
          {!poll.multiple && <Alert severity="warning" sx={{ mt: 2 }}>{t('nemvoting.single_warning')}</Alert>}
        </Box>
        <MessageDialog open={showCaution} title={t('nemvoting.confirm_title')} texts={t('nemvoting.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('nemvoting.sending') : t('nemvoting.confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemvoting.confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ---- view -------------------------------------------------------------------------------
  const resultOf = (option: string) => results?.options.find((o) => o.text === option);
  const showControls = !ended && poll.valid;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} back="/voting" />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left', maxWidth: 900 }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 'bold', wordBreak: 'break-word', mb: 1 }}>{poll.title}</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
          <Chip size="small" color={ended ? 'default' : 'success'} label={ended ? t('nemvoting.status_ended') : t('nemvoting.status_active')} />
          <Chip size="small" variant="outlined" label={poll.type === POLL_TYPE_WHITELIST ? t('nemvoting.type_whitelist_short') : t('nemvoting.type_poi_short')} />
          <Chip size="small" variant="outlined" label={poll.multiple ? t('nemvoting.multiple_badge') : t('nemvoting.single_badge')} />
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {ended ? t('nemvoting.ended_at', { date: new Date(poll.doe).toLocaleString() }) : t('nemvoting.ends_at', { date: new Date(poll.doe).toLocaleString() })}
        </Typography>
        {poll.creator && (
          <Typography variant="body2" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>
            {t('nemvoting.creator')}: <Link href={explorerAccountUrl(poll.creator)} target="_blank" rel="noopener">{poll.creator}</Link>
          </Typography>
        )}
        {poll.description.trim() !== '' && (
          <Typography sx={{ mt: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{poll.description}</Typography>
        )}

        <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {!poll.valid && <Alert severity="error">{t('nemvoting.unverified_warning')}</Alert>}
          {poll.type === POLL_TYPE_WHITELIST && !ended && myAddress !== '' && !onWhitelist && <Alert severity="warning">{t('nemvoting.not_on_whitelist')}</Alert>}
          {singleAlreadyVoted && myVoted.length === 1 && <Alert severity="info">{t('nemvoting.already_voted')}</Alert>}
          {!poll.multiple && myVoted.length > 1 && <Alert severity="error">{t('nemvoting.vote_invalidated')}</Alert>}
          {poll.multiple && myVoted.length > 0 && !ended && <Alert severity="info">{t('nemvoting.already_voted_multiple')}</Alert>}
        </Box>

        <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 'bold', flexGrow: 1 }}>{showControls ? t('nemvoting.options_title') : t('nemvoting.results_title')}</Typography>
          <Button size="small" startIcon={<RefreshIcon />} disabled={loadingResults} onClick={() => void loadResults(poll, myAddress)}>{t('nemvoting.refresh')}</Button>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
          {poll.options.map((option) => {
            const r = resultOf(option);
            const mine = myVoted.includes(option);
            const disabledOption = !votingOpen || (poll.multiple && mine);
            const checked = selected.includes(option) || (poll.multiple && mine);
            const label = (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ wordBreak: 'break-word' }}>{option}</Typography>
                {mine && <Chip size="small" color="primary" label={t('nemvoting.mine_badge')} />}
              </Box>
            );
            return (
              <Box key={option} sx={{ bgcolor: 'background.paper', border: 1, borderColor: checked ? 'primary.main' : 'divider', borderRadius: 3, px: 2, py: 1.25 }}>
                {showControls ? (
                  <FormControlLabel
                    sx={{ m: 0, width: '100%', alignItems: 'center' }}
                    control={poll.multiple
                      ? <Checkbox checked={checked} disabled={disabledOption} onChange={() => toggle(option)} />
                      : <Radio checked={checked} disabled={disabledOption} onChange={() => toggle(option)} />}
                    label={label}
                  />
                ) : label}
                <Box sx={{ mt: 0.75 }}>
                  <LinearProgress variant="determinate" value={Math.min(100, r?.percentage ?? 0)} sx={{ height: 8, borderRadius: 4 }} />
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                    {loadingResults && !r ? t('nemvoting.counting') : `${(r?.percentage ?? 0).toFixed(2)}%　${t('nemvoting.votes_count', { count: r?.votes ?? 0 })}`}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>

        {resultsFailed && (
          <Box sx={{ mt: 2, textAlign: 'center' }}>
            <Typography sx={{ color: 'text.secondary', mb: 1 }}>{t('nemvoting.results_failed')}</Typography>
            <Button variant="outlined" onClick={() => void loadResults(poll, myAddress)}>{t('nemvoting.retry')}</Button>
          </Box>
        )}
        {results && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2">{t('nemvoting.total_votes', { count: results.totalVotes })}</Typography>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
              {poll.type === POLL_TYPE_WHITELIST ? t('nemvoting.counting_whitelist') : t('nemvoting.counting_poi')}
            </Typography>
            {results.approximateImportance && <Alert severity="info" sx={{ mt: 1 }}>{t('nemvoting.approximate_note')}</Alert>}
          </Box>
        )}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 2, wordBreak: 'break-all' }}>
          {t('nemvoting.poll_address')}: <Link href={explorerAccountUrl(poll.address)} target="_blank" rel="noopener">{poll.address}</Link>
        </Typography>
      </Box>

      {showControls && (
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
          {balanceShort && <Typography variant="body2" sx={{ color: 'warning.main', fontWeight: 'bold', mb: 1 }}>{t('symbolvoting.xym_short_warning')}</Typography>}
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canVote} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
            {selected.length > 0 ? t('nemvoting.go_confirm_fee', { fee: feeText }) : t('nemvoting.select_option')}
          </Button>
        </Box>
      )}
    </Box>
  );
}
