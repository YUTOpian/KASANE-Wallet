import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, IconButton, LinearProgress, MenuItem, Radio, Switch, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import { useLiveRefresh } from '../../hooks/useLiveRefresh';
import { fetchNemXemBalance } from '../../lib/nem/api';
import { fetchDaoPolls } from '../../lib/nem/dao';
import type { DaoPoll, NemDao } from '../../lib/nem/dao';
import { getNemNetworkConfig, nemNetworkOf } from '../../lib/nem/network';
import {
  NEM_VOTE_FEE, POLL_INDEX_ADDRESS, POLL_MAX_OPTION_LENGTH, POLL_MAX_OPTIONS, POLL_MAX_TITLE_LENGTH, POLL_MIN_OPTIONS, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER,
  PollBroadcastError, buildPollMessages, fetchPollResults, isPollEnded, pollAddressInUse, resolveNemMosaicInput, sendNemPoll, sendNemVote, totalPollFee, validateNewPoll,
} from '../../lib/nem/voting';
import type { NewPollInput, Poll, PollResults } from '../../lib/nem/voting';
import { normalizeNemAddress } from '../../lib/nem/crypto';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard } from '../multisig/parts';
import { nemXem } from './parts';
import { useConfirm } from './NemDaoItems';
import { LoadingBox, groupDigits } from './NemDaoUi';
import type { NemActor } from './NemDaoUi';

// NEM 「ガバナンス投票」: Symbol の DAO と同じ作り。上に投票の一覧（カードの上でそのまま投票できる）、下に管理者用の「投票を作成」。
// 投票は NEM の公式ウォレットと同じ形式で書き込まれるので、公式ウォレットの投票一覧にも出る。
// 票の重みは投票ごとに選ぶ（保有量に応じる = モザイク重み付け / 1 人 1 票 = モザイク保有者）。

export function GovernanceTab({ dao, actor, isAdmin, myHolding }: { dao: NemDao; actor: NemActor; isAdmin: boolean; myHolding: bigint | null }) {
  const { t } = useTranslation();
  const [polls, setPolls] = useState<DaoPoll[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchDaoPolls(dao.mosaicId)
      .then((list) => { if (!cancelled) setPolls(list); })
      .catch(() => { if (!cancelled) { setFailed(true); setPolls([]); } });
    return () => { cancelled = true; };
  }, [dao.mosaicId, version]);

  return (
    <>
      <SectionCard title={t('nemdao.vote_list')}>
        {polls !== null && myHolding === 0n && <Alert severity="info" sx={{ mb: 1.5 }}>{t('nemdao.vote_members_only')}</Alert>}
        {polls === null ? <LoadingBox /> : polls.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{failed ? t('nemdao.gov_load_failed') : t('nemdao.vote_none')}</Typography>
        ) : polls.map(({ poll }) => <PollCard key={poll.address} poll={poll} actorAddress={actor.address} myHolding={myHolding} />)}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemdao.gov_note')}</Typography>
      </SectionCard>
      {isAdmin && <CreateVote dao={dao} actor={actor} onDone={() => setVersion((n) => n + 1)} />}
    </>
  );
}

// --- 1 つの投票: 選択肢と途中経過、そしてそのまま投票 -------------------------------------------------------------
function PollCard({ poll, actorAddress, myHolding }: { poll: Poll; actorAddress: string; myHolding: bigint | null }) {
  const { t } = useTranslation();
  const [results, setResults] = useState<PollResults | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sentVotes, setSentVotes] = useState<string[]>([]); // ここから投票した分（まだ集計に入っていない）
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ended = isPollEnded(poll);

  const load = useCallback(async (quiet?: boolean) => {
    try {
      setResults(await fetchPollResults(poll, actorAddress));
      setFailed(false);
    } catch {
      if (!quiet) setFailed(true);
    }
  }, [poll, actorAddress]);

  useEffect(() => { void load(); }, [load]);
  // ほかの人の票は自分のアカウントの知らせには出てこないので、終わっていない投票は 30 秒ごとに数え直す。
  useLiveRefresh(() => { void load(true); }, { pollMs: 30_000, paused: ended });

  const { setConfirm, screen } = useConfirm('nemvoting.done_message', () => { void load(); });

  const myVoted = useMemo(() => [...new Set([...(results?.myVotes ?? []), ...sentVotes])], [results, sentVotes]);
  const holds = myHolding !== null && myHolding > 0n;
  const singleDone = !poll.multiple && myVoted.length > 0;
  const mayVote = !ended && poll.valid && holds && !singleDone;
  const totalFee = NEM_VOTE_FEE * BigInt(selected.length);

  const toggle = (option: string) => {
    if (poll.multiple) setSelected((cur) => (cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option]));
    else setSelected([option]);
  };

  const toConfirm = async () => {
    setError('');
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const balance = await fetchNemXemBalance(actorAddress).catch(() => null);
      if (balance !== null && balance < totalFee) {
        setError(t('nemvoting.xem_short_warning'));
        return;
      }
      const chosen = [...selected];
      setConfirm({
        rows: [
          { label: t('nemdao.vote_list'), value: poll.title, big: true },
          { label: t('nemdao.vote_choice'), value: chosen.join('\n') },
          { label: t('nemvoting.vote_fee'), value: nemXem(totalFee) },
        ],
        run: async (key) => {
          const hashes: string[] = [];
          try {
            for (const option of chosen) hashes.push((await sendNemVote({ privateKey: key.privateKey, publicKey: key.publicKey, poll, option })).hash);
          } finally {
            // 途中で止まっても、送れた分は「投票済み」にしておく。
            if (hashes.length > 0) setSentVotes((cur) => [...new Set([...cur, ...chosen.slice(0, hashes.length)])]);
          }
          return hashes;
        },
        after: () => setSelected([]),
      });
    } finally {
      setBusy(false);
    }
  };

  if (screen) return screen;
  const resultOf = (option: string) => results?.options.find((o) => o.text === option);
  return (
    <Box sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-word' }}>{poll.title}</Typography>
        <Chip size="small" variant="outlined" label={t(poll.type === POLL_TYPE_MOSAIC ? 'nemdao.vote_chip_weighted' : 'nemdao.vote_chip_equal')} />
        <Chip size="small" color={ended ? 'default' : 'success'} label={t(ended ? 'nemdao.gov_ended' : 'nemdao.gov_active')} />
        {poll.multiple && <Chip size="small" variant="outlined" label={t('nemvoting.multiple_badge')} />}
      </Box>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: poll.description.trim() ? 0.5 : 1 }}>
        {t(ended ? 'nemvoting.ended_at' : 'nemvoting.ends_at', { date: new Date(poll.doe).toLocaleString() })}
      </Typography>
      {poll.description.trim() !== '' && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mb: 1 }}>{poll.description}</Typography>}
      {!poll.valid && <Alert severity="error" sx={{ mb: 1 }}>{t('nemvoting.unverified_warning')}</Alert>}
      {singleDone && myVoted.length === 1 && <Alert severity="info" sx={{ mb: 1 }}>{t('nemvoting.already_voted')}</Alert>}
      {!poll.multiple && myVoted.length > 1 && <Alert severity="error" sx={{ mb: 1 }}>{t('nemvoting.vote_invalidated')}</Alert>}

      {poll.options.map((option) => {
        const r = resultOf(option);
        const share = Math.min(100, r?.percentage ?? 0);
        const mine = myVoted.includes(option);
        const pickable = mayVote && !(poll.multiple && mine);
        const checked = selected.includes(option);
        return (
          <Box key={option} sx={{ mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {mayVote && (poll.multiple
                ? <Checkbox size="small" checked={checked || mine} disabled={!pickable} onChange={() => toggle(option)} />
                : <Radio size="small" checked={checked} disabled={!pickable} onChange={() => toggle(option)} />)}
              <Typography variant="body2" sx={{ flexGrow: 1, wordBreak: 'break-word' }}>{option}</Typography>
              {mine && <Chip size="small" color="primary" label={t('nemvoting.mine_badge')} sx={{ mx: 1 }} />}
              <Typography variant="body2">{results ? `${r?.votes ?? 0} (${share.toFixed(1)}%)` : t('nemvoting.counting')}</Typography>
            </Box>
            <LinearProgress variant="determinate" value={share} sx={{ height: 6, borderRadius: 3 }} />
          </Box>
        );
      })}

      {failed && <Alert severity="warning" sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={() => void load()}>{t('nemvoting.retry')}</Button>}>{t('nemvoting.results_failed')}</Alert>}
      {results?.mosaicRuleBroken && <Alert severity="error" sx={{ mt: 1 }}>{t('symbolvoting.holder_rule_broken_note')}</Alert>}
      {results?.excludedVoters?.includes(normalizeNemAddress(actorAddress)) && (
        <Alert severity="warning" sx={{ mt: 1 }}>{t(poll.type === POLL_TYPE_MOSAIC_HOLDER ? 'symbolvoting.holder_my_vote_invalid' : 'symbolvoting.my_vote_invalid')}</Alert>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
        {t('nemdao.vote_my_power', { amount: myHolding === null ? '—' : groupDigits(myHolding) })}
        {results ? `　${t('nemvoting.total_votes', { count: results.totalVotes })}` : ''}
      </Typography>
      {mayVote && (
        <>
          {error && <Alert severity="error" sx={{ mb: 1, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
          <Button variant="contained" color="primary" size="large" fullWidth disabled={selected.length === 0 || busy} onClick={toConfirm} sx={{ py: 1.25 }}>
            {t('nemdao.vote_do')}
          </Button>
        </>
      )}
    </Box>
  );
}

// --- 投票を作成（管理者） ---------------------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const defaultEnd = () => {
  const d = new Date(Date.now() + 7 * 86400_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d.getTime());
};

function CreateVote({ dao, actor, onDone }: { dao: NemDao; actor: NemActor; onDone: () => void }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [weighted, setWeighted] = useState(true);
  const [multiple, setMultiple] = useState(false);
  const [endLocal, setEndLocal] = useState(defaultEnd);
  const [transferable, setTransferable] = useState<boolean | null>(null); // このガバナンストークンが譲渡できるか（確認できるまで null）
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setConfirm, screen } = useConfirm('nemvoting.create_done_message', onDone);

  useEffect(() => {
    let cancelled = false;
    setTransferable(null);
    resolveNemMosaicInput(dao.mosaicId)
      .then((info) => { if (!cancelled) setTransferable(info.transferable); })
      .catch(() => { if (!cancelled) setTransferable(null); });
    return () => { cancelled = true; };
  }, [dao.mosaicId, network]);

  const type = weighted ? POLL_TYPE_MOSAIC : POLL_TYPE_MOSAIC_HOLDER;
  const doe = new Date(endLocal).getTime();
  const input: NewPollInput = {
    title, description, options, doe: Number.isNaN(doe) ? 0 : doe, type, multiple, whitelist: [], mosaicId: dao.mosaicId,
    // 1 人 1 票の投票は、譲渡できないモザイクだけを数える約束にする（このトークンは譲渡できない）。
    ...(type === POLL_TYPE_MOSAIC_HOLDER ? { nonTransferableOnly: transferable !== true, mosaicTransferable: transferable ?? undefined } : {}),
  };
  const issues = validateNewPoll(input, netCfg.networkByte);
  const indexAddress = POLL_INDEX_ADDRESS[nemNetworkOf(network)];
  const messages = useMemo(
    () => buildPollMessages(input, actor.publicKey, netCfg.networkByte, indexAddress).messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, description, options, doe, type, multiple, transferable, actor.publicKey, network],
  );
  const totalFee = totalPollFee(messages);
  const filled = options.map((o) => o.trim());
  const setOption = (i: number, value: string) => setOptions((cur) => cur.map((o, j) => (j === i ? value : o)));
  const canContinue = issues.length === 0 && transferable !== null && !busy;

  const toConfirm = async () => {
    setError('');
    if (!canContinue) return;
    setBusy(true);
    try {
      const balance = await fetchNemXemBalance(actor.address).catch(() => null);
      if (balance !== null && balance < totalFee) {
        setError(t('nemvoting.xem_short_warning'));
        return;
      }
      setConfirm({
        rows: [
          { label: t('nemvoting.title_label'), value: title.trim(), big: true },
          { label: t('nemvoting.options_label'), value: filled.join('\n') },
          { label: t('nemdao.vote_end'), value: new Date(doe).toLocaleString() },
          { label: t('nemdao.vote_weight'), value: t(weighted ? 'nemdao.vote_weight_on' : 'nemdao.vote_weight_off') },
          { label: t('nemvoting.choice_label'), value: t(multiple ? 'nemvoting.multiple_badge' : 'nemvoting.single_badge') },
          { label: t('nemvoting.tx_count_label'), value: String(messages.length) },
          { label: t('nemvoting.total_fee'), value: nemXem(totalFee) },
        ],
        run: async (key) => {
          const built = buildPollMessages(input, key.publicKey, netCfg.networkByte, indexAddress);
          if (await pollAddressInUse(built.pollAddress)) throw new Error((t('nemvoting.error_duplicate_message', { returnObjects: true }) as string[]).join('\n'));
          try {
            return await sendNemPoll(key.privateKey, key.publicKey, built.messages);
          } catch (e) {
            if (e instanceof PollBroadcastError && e.sent > 0) throw new Error(`${t('nemvoting.error_partial', { sent: e.sent, total: built.messages.length })}\n${e.message}`);
            throw e;
          }
        },
        after: () => { setTitle(''); setDescription(''); setOptions(['', '']); setMultiple(false); setEndLocal(defaultEnd()); },
      });
    } finally {
      setBusy(false);
    }
  };

  if (screen) return screen;
  const duplicate = issues.includes('option_duplicate');
  return (
    <SectionCard title={t('nemdao.vote_create')}>
      <FormRow label={t('nemvoting.title_label')} hint={t('nemvoting.title_hint', { max: POLL_MAX_TITLE_LENGTH })}>
        <Field
          ariaLabel={t('nemvoting.title_label')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={issues.includes('title_long')}
          helperText={issues.includes('title_long') ? t('nemvoting.issue_title_long', { max: POLL_MAX_TITLE_LENGTH }) : `${title.trim().length} / ${POLL_MAX_TITLE_LENGTH}`}
        />
      </FormRow>
      <FormRow label={t('nemdao.vote_description')} top>
        <Field ariaLabel={t('nemdao.vote_description')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} />
      </FormRow>
      {options.map((o, i) => (
        <FormRow key={i} label={`${t('nemvoting.options_label')} ${i + 1}`} hint={i === 0 ? t('nemvoting.options_hint', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS }) : undefined}>
          <Field
            ariaLabel={`${t('nemvoting.options_label')} ${i + 1}`}
            value={o}
            onChange={(e) => setOption(i, e.target.value)}
            error={o.length > POLL_MAX_OPTION_LENGTH || (duplicate && o.trim() !== '' && filled.filter((x) => x === o.trim()).length > 1)}
            helperText={o.length > POLL_MAX_OPTION_LENGTH ? t('nemvoting.issue_option_long', { max: POLL_MAX_OPTION_LENGTH }) : undefined}
            endAdornment={(
              <IconButton size="small" aria-label={t('nemvoting.remove_option')} disabled={options.length <= POLL_MIN_OPTIONS} onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}>
                <DeleteOutlinedIcon fontSize="small" />
              </IconButton>
            )}
          />
        </FormRow>
      ))}
      <Box sx={{ py: 0.5 }}>
        <Button startIcon={<AddIcon />} disabled={options.length >= POLL_MAX_OPTIONS} onClick={() => setOptions((cur) => [...cur, ''])}>{t('nemvoting.add_option')}</Button>
      </Box>
      {duplicate && <Typography variant="caption" sx={{ display: 'block', color: 'error.main' }}>{t('nemvoting.issue_option_duplicate')}</Typography>}
      <FormRow label={t('nemdao.vote_end')} hint={t('nemvoting.end_hint')}>
        <Field
          ariaLabel={t('nemdao.vote_end')}
          type="datetime-local"
          value={endLocal}
          onChange={(e) => setEndLocal(e.target.value)}
          error={issues.includes('end_past')}
          helperText={issues.includes('end_past') ? t('nemvoting.issue_end_past') : undefined}
        />
      </FormRow>
      <FormRow label={t('nemdao.vote_weight')} hint={t('nemdao.vote_weight_hint')}>
        <Field select ariaLabel={t('nemdao.vote_weight')} value={weighted ? 'on' : 'off'} onChange={(e) => setWeighted(e.target.value === 'on')}>
          <MenuItem value="on">{t('nemdao.vote_weight_on')}</MenuItem>
          <MenuItem value="off">{t('nemdao.vote_weight_off')}</MenuItem>
        </Field>
      </FormRow>
      <FormRow label={t('nemvoting.choice_label')} hint={t('nemvoting.multiple_hint')}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Switch checked={multiple} onChange={(e) => setMultiple(e.target.checked)} slotProps={{ input: { 'aria-label': t('nemvoting.multiple_label') } }} />
          <Typography variant="body2">{t('nemvoting.multiple_label')}</Typography>
        </Box>
      </FormRow>
      <FormRow label={t('nemdao.vote_cost')} hint={t('nemvoting.cost_hint')}>
        <Typography variant="body2">{nemXem(totalFee)}（{t('nemvoting.tx_count_label')}: {messages.length}）</Typography>
      </FormRow>
      {issues.includes('message_too_large') && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('nemvoting.issue_too_large')}</Alert>}
      <Alert severity="info" sx={{ mt: 1.5 }}>{t('nemdao.vote_create_note')}</Alert>
      {error && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={toConfirm} sx={{ py: 1.25 }}>
          {t('nemdao.go_confirm')}
        </Button>
      </Box>
    </SectionCard>
  );
}
