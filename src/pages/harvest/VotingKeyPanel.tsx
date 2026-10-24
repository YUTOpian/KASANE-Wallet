import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { fetchVotingContext, quoteVotingFee } from '../../lib/symbol/api';
import type { HarvestStatus, VotingContext } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import {
  DEFAULT_VOTING_LIMITS, checkVotingRange, defaultVotingRange, isVotingPublicKeyHex, parseEpoch, planVotingLink, planVotingUnlink, votingLifetime,
} from '../../lib/symbol/votingKeys';
import type { LinkedVotingKey, VotingLink } from '../../lib/symbol/votingKeys';
import { Field, FormRow, ValueBox } from '../multisig/parts';

/** A voting key change the person asked for, handed to the page (which shows the confirmation, asks for the password and sends it). */
export interface VotingChangeRequest { links: VotingLink[]; fee: bigint | null }

type EpochState = 'upcoming' | 'active' | 'expired';
const epochState = (key: LinkedVotingKey, currentEpoch: number | null): EpochState | null => {
  if (currentEpoch === null) return null;
  return key.startEpoch > currentEpoch ? 'upcoming' : key.endEpoch < currentEpoch ? 'expired' : 'active';
};

/**
 * 「投票鍵」: the voting keys (finalization) linked to the account, each with an unlink button, and a form that links a new one
 * (BLS public key of 96 hex characters + the range of finalization epochs it is valid for). An unlink names the key and the range
 * exactly as they are on the chain, so it is never typed.
 */
export default function VotingKeyPanel({ status, busy, onRequest }: {
  status: HarvestStatus; busy: boolean; onRequest: (request: VotingChangeRequest) => void;
}) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<VotingContext | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [keyText, setKeyText] = useState('');
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [context, quote] = await Promise.all([fetchVotingContext(), quoteVotingFee(1).catch(() => null)]);
      if (cancelled) return;
      setCtx(context);
      setFee(quote ? quote.fee : null);
    })();
    return () => { cancelled = true; };
  }, []);

  const limits = ctx?.limits ?? DEFAULT_VOTING_LIMITS;
  const linked = status.votingKeys;
  const linkedSignature = linked.map((k) => `${k.publicKey}:${k.startEpoch}:${k.endEpoch}`).join('|');

  // The links on the chain changed (a change went through, or the status was reloaded) or the epoch became known: start the form afresh.
  useEffect(() => {
    const range = defaultVotingRange(ctx?.currentEpoch ?? null, linked, limits);
    setKeyText('');
    setStartText(range ? String(range.startEpoch) : '');
    setEndText(range ? String(range.endEpoch) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedSignature, ctx]);

  const start = parseEpoch(startText);
  const end = parseEpoch(endText);
  const keyError = keyText !== '' && !isVotingPublicKeyHex(keyText) ? 'invalid_key' : null;
  const rangeTyped = startText !== '' && endText !== '';
  const rangeError = useMemo(() => {
    if (!rangeTyped) return null;
    if (start === null || end === null) return 'invalid_epoch';
    return checkVotingRange(linked, start, end, limits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeTyped, start, end, linkedSignature, limits]);
  const plan = start !== null && end !== null ? planVotingLink(linked, { publicKey: keyText, startEpoch: start, endEpoch: end }, limits) : null;
  const planError = plan && !plan.ok ? plan.error : null;
  // 'too_many' belongs to the whole form, 'already_linked' to the key; the others to the epoch fields.
  const rangeFieldError = rangeError && rangeError !== 'too_many' ? rangeError : null;

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeShort = fee !== null && status.xymBalance < fee;

  const requestLink = () => {
    if (!plan || !plan.ok) return;
    onRequest({ links: plan.links, fee });
  };
  const requestUnlink = (key: LinkedVotingKey) => {
    const unlink = planVotingUnlink(linked, key);
    if (!unlink.ok) return;
    onRequest({ links: unlink.links, fee });
  };

  return (
    <Box>
      <Typography sx={{ fontWeight: 'bold' }}>{t('harvest.voting_title')}</Typography>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t('harvest.voting_hint')}</Typography>

      <FormRow label={t('harvest.voting_current')} top>
        {linked.length === 0 ? (
          <ValueBox>{t('harvest.keys_not_linked')}</ValueBox>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {linked.map((k) => {
              const state = epochState(k, ctx?.currentEpoch ?? null);
              return (
                <Box key={`${k.publicKey}:${k.startEpoch}:${k.endEpoch}`} sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, alignItems: { md: 'center' }, gap: 1 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <ValueBox><Box component="span" sx={{ wordBreak: 'break-all' }}>{k.publicKey}</Box></ValueBox>
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
                      {t('harvest.voting_range_line', { start: k.startEpoch, end: k.endEpoch, count: votingLifetime(k.startEpoch, k.endEpoch) })}
                      {state && `（${t(`harvest.voting_state_${state}`)}）`}
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    color="error"
                    disabled={busy || feeShort}
                    onClick={() => requestUnlink(k)}
                    sx={{ px: { md: 3 }, flexShrink: 0 }}
                  >
                    {t('harvest.keys_unlink')}
                  </Button>
                </Box>
              );
            })}
          </Box>
        )}
      </FormRow>

      <FormRow label={t('harvest.voting_key_label')} top>
        <Field
          ariaLabel={t('harvest.voting_key_label')}
          value={keyText}
          onChange={(e) => setKeyText(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 96))}
          error={keyError !== null || planError === 'already_linked'}
          helperText={keyError !== null ? t('harvest.voting_err_invalid_key') : planError === 'already_linked' ? t('harvest.voting_err_already_linked') : t('harvest.voting_key_hint')}
          htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
        />
      </FormRow>
      <FormRow label={t('harvest.voting_start_label')} top>
        <Field
          ariaLabel={t('harvest.voting_start_label')}
          value={startText}
          onChange={(e) => setStartText(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
          error={rangeFieldError !== null}
          helperText={ctx?.currentEpoch ? t('harvest.voting_start_hint', { current: ctx.currentEpoch }) : t('harvest.voting_start_hint_unknown')}
          htmlInput={{ inputMode: 'numeric' }}
        />
      </FormRow>
      <FormRow label={t('harvest.voting_end_label')} top>
        <Field
          ariaLabel={t('harvest.voting_end_label')}
          value={endText}
          onChange={(e) => setEndText(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
          error={rangeFieldError !== null}
          helperText={rangeFieldError !== null ? t(`harvest.voting_err_${rangeFieldError}`, { min: limits.minLifetime, max: limits.maxLifetime }) : t('harvest.voting_end_hint', { min: limits.minLifetime, max: limits.maxLifetime })}
          htmlInput={{ inputMode: 'numeric' }}
        />
      </FormRow>
      {rangeError === 'too_many' && <Alert severity="warning" sx={{ mt: 1 }}>{t('harvest.voting_err_too_many', { max: limits.maxKeys })}</Alert>}

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1 }}>
        <Button variant="contained" color="primary" disabled={busy || !plan || !plan.ok || feeShort} onClick={requestLink} sx={{ px: { md: 3 } }}>
          {t('harvest.keys_link')}
        </Button>
      </Box>

      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
        {t('harvest.keys_fee')}: {fee === null ? t('harvest.cost_loading') : xym(fee)}
      </Typography>
      <Alert severity="info" sx={{ mt: 2 }}>{t('harvest.voting_note')}</Alert>
    </Box>
  );
}
