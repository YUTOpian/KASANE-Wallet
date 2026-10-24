import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Divider, MenuItem, Select, Typography } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import { useTranslation } from 'react-i18next';
import { FEE_SPEEDS, quoteHarvestLinkFees } from '../../lib/symbol/api';
import { isBelowAverageFee } from '../../lib/symbol/feeSpeed';
import { useAppStore } from '../../store/appStore';
import type { FeeSpeed, HarvestStatus } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { HARVEST_LINK_KINDS, currentKey, isPublicKeyHex, planKeyChange } from '../../lib/symbol/harvestKeys';
import type { KeyAction, KeyChangePlan } from '../../lib/symbol/harvestKeys';
import type { HarvestLink, HarvestLinkKind } from '../../lib/symbol/tx';
import { Field, FormRow, ValueBox } from '../multisig/parts';
import VotingKeyPanel from './VotingKeyPanel';
import type { VotingChangeRequest } from './VotingKeyPanel';

type Inputs = Record<HarvestLinkKind, string>;
const EMPTY: Inputs = { remote: '', vrf: '', node: '' };

/** A change the person asked for, handed to the page (which shows the confirmation, asks for the password and sends it). */
export interface KeyChangeRequest { links: HarvestLink[]; fee: bigint | null; feeSpeed: FeeSpeed }

/**
 * 「キーリンク」タブ: the remote / VRF / node keys one by one. Each shows the key that is linked now and lets the person
 * link a key by its public key, unlink it, or replace it (unlink + link in one transaction). 「開始（自動生成）」と「全解除」は
 * 「デリゲートハーベスティング」タブ。その下に、投票鍵（ファイナライズ用のVoting Key）のリンク／解除（VotingKeyPanel）。
 */
export default function KeyLinkPanel({ status, ownPublicKey, busy, hasStored, onRequest, onVotingRequest, onReveal }: {
  status: HarvestStatus; ownPublicKey: string; busy: boolean; onRequest: (request: KeyChangeRequest) => void;
  onVotingRequest: (request: VotingChangeRequest) => void;
  hasStored: boolean; // this wallet kept the remote / VRF private keys of the start (encrypted)
  onReveal: () => void; // show the kept keys (after the password)
}) {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<Inputs>(EMPTY);
  // Fee of a one-key change and of a replacement (two keys), at each level; the chosen level is what the change pays.
  const [allFees, setAllFees] = useState<Record<FeeSpeed, { one: bigint; two: bigint }> | null>(null);
  const [feeSpeed, setFeeSpeed] = useState<FeeSpeed>(() => useAppStore.getState().defaultFeeSpeed);
  const fees = allFees === null ? null : allFees[feeSpeed];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const quoted = await quoteHarvestLinkFees();
        if (!cancelled) setAllFees(quoted);
      } catch { /* shown as unavailable */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // The links on the chain changed (a change went through, or the status was reloaded): start the fields afresh.
  useEffect(() => { setInputs(EMPTY); }, [status.remotePublicKey, status.vrfPublicKey, status.nodePublicKey]);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const feeFor = (links: HarvestLink[]): bigint | null => (fees === null ? null : links.length >= 2 ? fees.two : fees.one);

  const plans = useMemo(() => {
    const out = {} as Record<HarvestLinkKind, KeyChangePlan>;
    for (const kind of HARVEST_LINK_KINDS) {
      out[kind] = planKeyChange(status, kind, currentKey(status, kind) ? 'replace' : 'link', inputs[kind], ownPublicKey);
    }
    return out;
  }, [status, inputs, ownPublicKey]);

  const request = (kind: HarvestLinkKind, action: KeyAction) => {
    const plan = action === 'unlink' ? planKeyChange(status, kind, 'unlink', '', ownPublicKey) : plans[kind];
    if (!plan.ok) return;
    onRequest({ links: plan.links, fee: feeFor(plan.links), feeSpeed });
  };

  const feeShort = (links: HarvestLink[]) => {
    const fee = feeFor(links);
    return fee !== null && status.xymBalance < fee;
  };

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>{t('harvest.keys_intro')}</Alert>
      {HARVEST_LINK_KINDS.map((kind) => {
        const current = currentKey(status, kind);
        const input = inputs[kind];
        const plan = plans[kind];
        const typed = input !== '';
        const error = typed && !plan.ok ? plan.error : null;
        const unlinkLinks: HarvestLink[] = current ? [{ kind, publicKey: current, link: false }] : [];
        return (
          <Box key={kind} sx={{ mb: 3 }}>
            <Typography sx={{ fontWeight: 'bold' }}>{t(`harvest.keys_kind_${kind}`)}</Typography>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t(`harvest.keys_kind_${kind}_hint`)}</Typography>
            <FormRow label={t('harvest.keys_current')}>
              <ValueBox>{current ?? t('harvest.keys_not_linked')}</ValueBox>
            </FormRow>
            {(kind === 'remote' || kind === 'vrf') && (
              <FormRow label={t(`harvest.keys_secret_${kind}`)}>
                {current && hasStored ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <ValueBox>{t('harvest.keys_secret_saved')}</ValueBox>
                    <Button variant="text" size="small" disabled={busy} onClick={onReveal} startIcon={<VisibilityIcon />}>{t('harvest.reveal_button')}</Button>
                  </Box>
                ) : (
                  <ValueBox>{current ? t('harvest.keys_secret_none') : t('harvest.keys_not_linked')}</ValueBox>
                )}
              </FormRow>
            )}
            <FormRow label={t('harvest.keys_new_label')} top>
              <Field
                ariaLabel={`${t(`harvest.keys_kind_${kind}`)} ${t('harvest.keys_new_label')}`}
                value={input}
                onChange={(e) => setInputs((prev) => ({ ...prev, [kind]: e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64) }))}
                error={error !== null}
                helperText={error === null ? t(current ? 'harvest.keys_replace_hint' : 'harvest.keys_link_hint') : t(`harvest.keys_err_${error}`)}
                htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
              />
            </FormRow>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1, mt: 1 }}>
              {current && (
                <Button
                  variant="outlined"
                  color="error"
                  disabled={busy || feeShort(unlinkLinks)}
                  onClick={() => request(kind, 'unlink')}
                  sx={{ px: { md: 3 } }}
                >
                  {t('harvest.keys_unlink')}
                </Button>
              )}
              <Button
                variant="contained"
                color="primary"
                disabled={busy || !plan.ok || !isPublicKeyHex(input) || (plan.ok && feeShort(plan.links))}
                onClick={() => request(kind, current ? 'replace' : 'link')}
                sx={{ px: { md: 3 } }}
              >
                {t(current ? 'harvest.keys_replace' : 'harvest.keys_link')}
              </Button>
            </Box>
          </Box>
        );
      })}
      <FormRow label={t('harvest.keys_fee')} top>
        <Box>
          <Select
            fullWidth
            size="small"
            value={feeSpeed}
            onChange={(e) => setFeeSpeed(e.target.value as FeeSpeed)}
            inputProps={{ 'aria-label': t('harvest.keys_fee') }}
            sx={{ '& .MuiSelect-select': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 } }}
          >
            {FEE_SPEEDS.map((speed) => (
              <MenuItem key={speed} value={speed} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}>
                <span>{t(`send.fee_speed_${speed}`)}</span>
                <Typography component="span" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                  {allFees === null ? t('harvest.cost_loading') : `${xym(allFees[speed].one)}`}
                </Typography>
              </MenuItem>
            ))}
          </Select>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.75 }}>
            {fees === null ? t('harvest.cost_loading') : `${t('harvest.keys_fee_replace')}: ${xym(fees.two)}`}
          </Typography>
          {isBelowAverageFee(feeSpeed) && <Alert severity="warning" sx={{ mt: 1 }}>{t('harvest.keys_fee_slow_warning')}</Alert>}
        </Box>
      </FormRow>
      <Alert severity="warning" sx={{ mt: 2 }}>{t('harvest.keys_private_note')}</Alert>
      <Divider sx={{ my: 3 }} />
      <VotingKeyPanel status={status} busy={busy} onRequest={onVotingRequest} />
    </Box>
  );
}
