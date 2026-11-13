import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, LinearProgress, MenuItem, Radio, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planCastVote, planCloseVote, planCreateVote, planResumeVote } from '../../lib/dao/daoActions';
import { daoAddressOf, fetchHeld, fetchHolders, fetchMembers, fetchVotes } from '../../lib/dao/daoApi';
import { clearPendingVote, loadPendingVote, submitCreateVote, submitDaoBatches, submitResumeVote } from '../../lib/dao/daoBatch';
import type { PendingVote } from '../../lib/dao/daoBatch';
import type { VoteView } from '../../lib/dao/daoApi';
import { MAX_VOTE_OPTIONS, VOTE_LETTERS, VOTE_OPTION_MAX_BYTES, VOTE_TITLE_MAX_BYTES, byteLength, isVoteClosed, voteOptionIndexes, voteTexts } from '../../lib/dao/daoCore';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard } from '../multisig/parts';
import { DaoAction, LoadingBox, useDao } from './daoUi';

// 「ガバナンス投票」: ガバナンストークンを持っている人だけが、A〜F（最大 6 つ）の選択肢に投票できる。票の重みは投票ごとに選ぶ
// （保有量に応じる / 1 人 1 票）。投票ごとに専用の投票トークンを会員へ配り、会員は選んだ選択肢の投票箱へ送る。集計は投票箱の持ち分。
export default function DaoGovernance() {
  const { t } = useTranslation();
  const { dao, actor, isAdmin, reload } = useDao();
  const [votes, setVotes] = useState<VoteView[] | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchVotes(dao, actor.address)
      .then((v) => { if (!cancelled) setVotes(v); })
      .catch(() => { if (!cancelled) setVotes([]); });
    // 投票できるのは、いまガバナンストークンを持っている人だけ（投票トークンだけ受け取っても投票できない）。
    fetchHeld(actor.address)
      .then((h) => { if (!cancelled) setIsMember((h.get(dao.governanceTokenId) ?? 0n) > 0n); })
      .catch(() => { if (!cancelled) setIsMember(false); });
    return () => { cancelled = true; };
  }, [dao, actor.address, version]);

  return (
    <>
      <SectionCard title={t('dao.vote_list')}>
        {votes !== null && !isMember && <Alert severity="info" sx={{ mb: 1.5 }}>{t('dao.vote_members_only')}</Alert>}
        {votes === null ? <LoadingBox /> : votes.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.vote_none')}</Typography>
          : [...votes].reverse().map((v) => <VoteCard key={v.txHash} vote={v} isMember={isMember} onDone={() => setVersion((n) => n + 1)} />)}
      </SectionCard>
      {isAdmin && <CreateVote onDone={() => { reload(); setVersion((n) => n + 1); }} />}
    </>
  );
}

const VoteCard = withFormReset<{ vote: VoteView; isMember: boolean; onDone: () => void }>(function VoteCard({ vote, isMember, onDone, onSent }: { vote: VoteView; isMember: boolean; onDone: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor } = useDao();
  const options = voteOptionIndexes(vote.doc);
  const total = vote.tallies.reduce((s, n) => s + n, 0n);
  const [choice, setChoice] = useState<number | null>(null);
  const texts = voteTexts(vote.doc);
  const boxKey = choice !== null ? dao.voteBoxKeys[choice] : '';
  // 締め切り済み（作成者が残りの投票トークンを回収した）か、期限切れ。
  const sealed = vote.closedOnChain;
  const closed = sealed || isVoteClosed(vote.doc);
  const mayVote = isMember && vote.myBalance > 0n && !closed;
  // 締め切れるのは、この投票を作ったアカウント（投票トークンの持ち主）だけ。
  const canClose = !sealed && vote.creator !== '' && normalizeAddress(vote.creator) === normalizeAddress(actor.address);
  const canVote = mayVote && choice !== null && /^[0-9A-F]{64}$/.test(boxKey);
  return (
    <Box sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 'bold' }}>{vote.doc.title}</Typography>
        <Chip size="small" variant="outlined" label={t(vote.doc.weighted ? 'dao.vote_chip_weighted' : 'dao.vote_chip_equal')} />
        {sealed
          ? <Chip size="small" color="default" label={t('dao.vote_chip_sealed')} />
          : closed
            ? <Chip size="small" color="default" label={t('dao.vote_chip_closed')} />
            : vote.doc.end > 0 && <Chip size="small" color="primary" variant="outlined" label={t('dao.vote_chip_until', { date: new Date(vote.doc.end).toLocaleString() })} />}
      </Box>
      {options.map((i) => {
        const share = total > 0n ? Number((vote.tallies[i] * 1000n) / total) / 10 : 0;
        return (
          <Box key={i} sx={{ mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {mayVote && <Radio size="small" checked={choice === i} onChange={() => setChoice(i)} />}
              <Typography variant="body2" sx={{ flexGrow: 1 }}>{VOTE_LETTERS[i]}. {texts[i]}</Typography>
              <Typography variant="body2">{vote.tallies[i].toString()} ({share}%)</Typography>
            </Box>
            <LinearProgress variant="determinate" value={share} sx={{ height: 6, borderRadius: 3 }} />
          </Box>
        );
      })}
      {sealed
        ? <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('dao.vote_sealed_note')}</Typography>
        : closed && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('dao.vote_closed_note', { date: new Date(vote.doc.end).toLocaleString() })}</Typography>}
      {vote.lateExcluded > 0n && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('dao.vote_late_excluded', { amount: vote.lateExcluded.toString() })}</Typography>}
      {vote.lateUnknown && <Alert severity="warning" sx={{ mb: 1 }}>{t('dao.vote_late_unknown')}</Alert>}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('dao.vote_my_power', { amount: vote.myBalance.toString() })}</Typography>
      {mayVote && (
        <DaoAction
          label={t('dao.vote_do')}
          disabled={!canVote}
          prepare={async () => ({
            plans: [planCastVote(actor, vote, boxKey)],
            rows: [
              { label: t('dao.vote_title'), value: vote.doc.title, big: true },
              { label: t('dao.vote_choice'), value: choice === null ? '' : `${VOTE_LETTERS[choice]}. ${texts[choice]}` },
              { label: t('dao.vote_my_power_label'), value: vote.myBalance.toString() },
            ],
          })}
          onSent={() => { onDone(); onSent(); }}
        />
      )}
      {canClose && (
        <Box sx={{ mt: 2, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('dao.vote_close_title')}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('dao.vote_close_note')}</Typography>
          <DaoAction
            label={t('dao.vote_close')}
            prepare={async () => {
              // 投票トークンを持っている人（投票箱と自分は除く）から、残りを回収する。自分の手元の分は、回収した分といっしょに焼却する。
              const boxes = new Set(dao.voteBoxKeys.filter((k) => /^[0-9A-F]{64}$/.test(k)).map(daoAddressOf));
              const [all, held] = await Promise.all([fetchHolders(vote.tokenId, actor.address), fetchHeld(actor.address)]);
              const plan = planCloseVote(actor, vote.tokenId, all.filter((h) => !boxes.has(h.address)), held.get(vote.tokenId) ?? 0n);
              return {
                plans: plan.batches,
                unit: plan.unit,
                execute: (privateKey, keyless, onProgress) => submitDaoBatches(privateKey, plan.batches.map((p) => p.input), keyless, onProgress),
                rows: [
                  { label: t('dao.vote_title'), value: vote.doc.title, big: true },
                  { label: t('dao.vote_close_targets'), value: t('dao.vote_close_targets_value', { count: plan.targets, amount: plan.revoked.toString() }) },
                  { label: t('dao.vote_close_burn'), value: `${plan.burnAddress}\n${t('dao.vote_close_burn_note')}` },
                ],
              };
            }}
            onSent={() => { onDone(); onSent(); }}
          />
        </Box>
      )}
    </Box>
  );
});

const CreateVote = withFormReset<{ onDone: () => void }>(function CreateVote({ onDone, onSent }: { onDone: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer } = useDao();
  const [title, setTitle] = useState('');
  const [opts, setOpts] = useState<string[]>(Array.from({ length: MAX_VOTE_OPTIONS }, () => ''));
  const [weighted, setWeighted] = useState(true);
  // 投票の期限（この端末の時刻で入力。空 = 期限なし）。
  const [deadline, setDeadline] = useState('');
  const endsAt = deadline === '' ? 0 : new Date(deadline).getTime();
  const deadlineOk = deadline === '' || (Number.isFinite(endsAt) && endsAt > Date.now());
  // 配布の途中で止まった投票（この端末に再開用の記録がある。索引に登録済みなら記録は要らないので消す）。
  const [pending, setPending] = useState<PendingVote | null>(() => {
    const p = loadPendingVote(dao.id);
    if (p && dao.voteIndex.some((v) => v.txHash.toUpperCase() === p.firstHash.toUpperCase())) { clearPendingVote(dao.id); return null; }
    return p;
  });
  const bytesOk = byteLength(title.trim()) <= VOTE_TITLE_MAX_BYTES && opts.every((o) => byteLength(o.trim()) <= VOTE_OPTION_MAX_BYTES);
  const valid = title.trim() !== '' && opts[0].trim() !== '' && opts[1].trim() !== '' && bytesOk && deadlineOk;
  return (
    <>
    {pending && (
      <SectionCard title={t('dao.vote_pending_title')}>
        <Alert severity="warning" sx={{ mb: 1.5 }}>{t('dao.vote_pending_note', { title: pending.title || pending.tokenId })}</Alert>
        <DaoAction
          label={t('dao.vote_pending_resume')}
          disabled={!signer}
          prepare={async () => {
            // まだ投票トークンを受け取っていない会員だけに配る（受け取り済みは投票トークンの保有者で分かる）。
            const [members, voteHolders, held] = await Promise.all([fetchMembers(dao), fetchHolders(pending.tokenId, actor.address), fetchHeld(actor.address)]);
            const plan = planResumeVote(actor, dao, signer!, dao.voteIndex.length, pending, members, new Set(voteHolders.map((h) => h.address)), held.get(pending.tokenId) ?? 0n);
            return {
              plans: [...plan.batches, plan.stage2(pending.firstHash)],
              execute: (privateKey, keyless, onProgress) => submitResumeVote(privateKey, plan, pending, dao.id, keyless, onProgress),
              rows: [
                { label: t('dao.vote_title'), value: pending.title || pending.tokenId, big: true },
                { label: t('dao.vote_pending_remaining'), value: t('dao.vote_voters_value', { count: plan.remaining, supply: plan.needed.toString() }) },
              ],
            };
          }}
          onSent={() => { setPending(null); onDone(); }}
        />
        <Box sx={{ mt: 1 }}>
          <Button color="inherit" onClick={() => { clearPendingVote(dao.id); setPending(null); }}>{t('dao.vote_pending_discard')}</Button>
        </Box>
      </SectionCard>
    )}
    <SectionCard title={t('dao.vote_create')}>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!signer || !valid}
        prepare={async () => {
          const holders = (await fetchMembers(dao)).filter((h) => h.amount > 0n);
          const plan = planCreateVote(actor, dao, signer!, dao.voteIndex.length, title.trim(), opts.map((o) => o.trim()), holders, weighted, endsAt);
          const stage2 = plan.stage2('0'.repeat(64)); // 見積もり用（実際は 1 回目のハッシュが入る。大きさは同じ）
          return {
            plans: [...plan.batches, stage2],
            execute: (privateKey, keyless, onProgress) => submitCreateVote(privateKey, plan, { daoId: dao.id, weighted, title: title.trim() }, keyless, onProgress),
            rows: [
              { label: t('dao.vote_title'), value: title.trim(), big: true },
              { label: t('dao.vote_options'), value: opts.map((o, i) => (o.trim() ? `${VOTE_LETTERS[i]}. ${o.trim()}` : '')).filter(Boolean).join('\n') },
              { label: t('dao.vote_weight'), value: t(weighted ? 'dao.vote_weight_on' : 'dao.vote_weight_off') },
              { label: t('dao.vote_deadline'), value: endsAt > 0 ? new Date(endsAt).toLocaleString() : t('dao.vote_deadline_none') },
              { label: t('dao.vote_voters'), value: t('dao.vote_voters_value', { count: holders.length, supply: plan.totalSupply.toString() }) },
            ],
          };
        }}
        onSent={() => { onDone(); onSent(); }}
      >
        <FormRow label={t('dao.vote_title')}>
          <Field ariaLabel={t('dao.vote_title')} value={title} onChange={(e) => setTitle(e.target.value)} helperText={`${byteLength(title.trim())} / ${VOTE_TITLE_MAX_BYTES} bytes`} />
        </FormRow>
        {opts.map((o, i) => (
          <FormRow key={i} label={`${t('dao.vote_option')} ${VOTE_LETTERS[i]}`} hint={i >= 2 ? t('dao.hint_option_optional') : undefined}>
            <Field ariaLabel={`${t('dao.vote_option')} ${VOTE_LETTERS[i]}`} value={o} onChange={(e) => setOpts((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
          </FormRow>
        ))}
        <FormRow label={t('dao.vote_deadline')} hint={t(deadlineOk ? 'dao.vote_deadline_hint' : 'dao.vote_deadline_past')}>
          <Field type="datetime-local" ariaLabel={t('dao.vote_deadline')} value={deadline} onChange={(e) => setDeadline(e.target.value)} error={!deadlineOk} />
        </FormRow>
        <FormRow label={t('dao.vote_weight')} hint={t('dao.vote_weight_hint')}>
          <Field select ariaLabel={t('dao.vote_weight')} value={weighted ? 'on' : 'off'} onChange={(e) => setWeighted(e.target.value === 'on')}>
            <MenuItem value="on">{t('dao.vote_weight_on')}</MenuItem>
            <MenuItem value="off">{t('dao.vote_weight_off')}</MenuItem>
          </Field>
        </FormRow>
        <Alert severity="info" sx={{ mt: 1.5 }}>{t('dao.vote_create_note')}</Alert>
      </DaoAction>
    </SectionCard>
    </>
  );
});
