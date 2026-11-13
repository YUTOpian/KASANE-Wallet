import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import { useTranslation } from 'react-i18next';
import { quoteHarvestFees } from '../../lib/symbol/api';
import type { HarvestStatus } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { planDelegationResend } from '../../lib/symbol/harvestKeys';
import { Field, FormRow, ValueBox } from '../multisig/parts';

/**
 * What the person asked for, handed to the page (which shows the confirmation, asks for the password and sends it):
 * the keys they typed, or the ones this wallet kept (encrypted) when harvesting was started.
 */
export type ResendRequest = { source: 'typed'; remotePrivateKey: string; vrfPrivateKey: string } | { source: 'stored' };

const shortKey = (key: string) => `${key.slice(0, 8)}…${key.slice(-8)}`;
const hexOnly = (text: string) => text.replace(/[^0-9a-fA-F]/g, '').slice(0, 64);

/**
 * 「委任リクエストの再送」: harvesting is already linked (remote + VRF + node), but the node may not have received (or may
 * have lost) the request with the remote / VRF private keys. The keys are the ones this wallet kept when harvesting was started
 * (encrypted with the password), or two private keys the person types. Either way they are checked against the public keys
 * linked on the chain, and only the encrypted request is sent again to the linked node. Nothing is linked or unlinked.
 */
export default function ResendDelegationPanel({ status, busy, hasStored, onRequest, onReveal }: {
  status: HarvestStatus; busy: boolean;
  hasStored: boolean; // this wallet kept the remote / VRF private keys of the start (encrypted)
  onRequest: (request: ResendRequest) => void;
  onReveal: () => void; // show the kept keys (after the password), to write them down
}) {
  const { t } = useTranslation();
  const [remoteKey, setRemoteKey] = useState('');
  const [vrfKey, setVrfKey] = useState('');
  const [fee, setFee] = useState<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;
    quoteHarvestFees(0, true)
      .then((q) => { if (!cancelled && q.delegation) setFee(q.delegation.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, []);

  // The linked keys changed (a change went through, or the status was reloaded): the typed keys may no longer fit.
  useEffect(() => { setRemoteKey(''); setVrfKey(''); }, [status.remotePublicKey, status.vrfPublicKey, status.nodePublicKey]);

  const plan = useMemo(() => planDelegationResend(status, remoteKey, vrfKey), [status, remoteKey, vrfKey]);
  const remoteError = remoteKey !== '' && !plan.ok && (plan.error === 'invalid_remote' || plan.error === 'remote_mismatch') ? plan.error : null;
  const vrfError = vrfKey !== '' && !plan.ok && (plan.error === 'invalid_vrf' || plan.error === 'vrf_mismatch' || plan.error === 'same_key') ? plan.error : null;
  const feeShort = fee !== null && status.xymBalance < fee;
  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;

  const send = () => {
    if (!plan.ok) return;
    // The page clears these fields (by giving the panel a new key) once the request has been sent.
    onRequest({ source: 'typed', remotePrivateKey: plan.remotePrivateKey, vrfPrivateKey: plan.vrfPrivateKey });
  };

  const keyField = (value: string, set: (v: string) => void, label: string, error: string | null, hint: string) => (
    <Field
      ariaLabel={label}
      type="password"
      value={value}
      onChange={(e) => set(hexOnly(e.target.value))}
      error={error !== null}
      helperText={error === null ? hint : t(`harvest.resend_err_${error}`)}
      htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', autoComplete: 'off', spellCheck: false }}
    />
  );

  return (
    <Box sx={{ mt: 3 }}>
      <Typography sx={{ fontSize: '1.05rem', mb: 1 }}>{t('harvest.resend_title')}</Typography>
      <Typography variant="body2" sx={{ lineHeight: 1.9, mb: 2, color: 'text.secondary' }}>{t('harvest.resend_about')}</Typography>
      <FormRow label={t('harvest.linked_node')}>
        <ValueBox>{status.nodePublicKey ? shortKey(status.nodePublicKey) : '–'}</ValueBox>
      </FormRow>
      {hasStored && (
        <Box sx={{ mt: 1.5, mb: 2 }}>
          <Alert severity="success" sx={{ mb: 1.5 }}>{t('harvest.resend_stored_hint')}</Alert>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'flex-end', gap: 1 }}>
            <Button variant="text" disabled={busy} onClick={onReveal} startIcon={<VisibilityIcon />} sx={{ px: { md: 3 } }}>{t('harvest.reveal_button')}</Button>
            <Button variant="contained" color="primary" disabled={busy || feeShort} onClick={() => onRequest({ source: 'stored' })} startIcon={<SendIcon />} sx={{ px: { md: 4 } }}>
              {t('harvest.resend_stored_button')}
            </Button>
          </Box>
        </Box>
      )}
      {hasStored && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('harvest.resend_manual_title')}</Typography>}
      <FormRow label={t('harvest.resend_remote_label')} top>
        {keyField(remoteKey, setRemoteKey, t('harvest.resend_remote_label'), remoteError, t('harvest.resend_key_hint'))}
      </FormRow>
      <FormRow label={t('harvest.resend_vrf_label')} top>
        {keyField(vrfKey, setVrfKey, t('harvest.resend_vrf_label'), vrfError, t('harvest.resend_key_hint'))}
      </FormRow>
      <FormRow label={t('harvest.tx_fee')}>
        <Typography>{fee === null ? t('harvest.cost_loading') : xym(fee)}</Typography>
      </FormRow>
      {feeShort && <Alert severity="warning" sx={{ mt: 1 }}>{t('harvest.resend_fee_short')}</Alert>}
      <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 1.5 }}>
        <Button
          variant="outlined"
          color="primary"
          fullWidth
          disabled={busy || !plan.ok || feeShort}
          onClick={send}
          startIcon={<SendIcon />}
          sx={{ width: { md: 'auto' }, px: { md: 4 } }}
        >
          {t('harvest.resend_button')}
        </Button>
      </Box>
      <Alert severity="info" sx={{ mt: 2 }}>{t('harvest.resend_note')}</Alert>
    </Box>
  );
}
