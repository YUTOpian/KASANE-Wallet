import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { planLinkNamespace } from '../../lib/dao/daoActions';
import type { NamespaceLinkTarget } from '../../lib/dao/daoActions';
import { fetchOwnedNamespaces, lookupNamespace } from '../../lib/dao/daoApi';
import type { NamespaceLookup, OwnedNamespace } from '../../lib/dao/daoApi';
import { fetchNamespaceRentalFees } from '../../lib/symbol/api';
import type { NamespaceRentalFees } from '../../lib/symbol/api';
import { BLOCKS_PER_DAY, MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS } from '../../lib/symbol/tx';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, mono, xymText } from '../multisig/parts';
import LinkedNamespaceWarning from './DaoNamespaceWarning';
import { daoPath } from './DaoTop';
import { DaoAction, useDao } from './daoUi';

// ガバナンストークン・ポイント・特典にネームスペースを紐付ける（「ポイント管理」「特典管理」から）。
// ネームスペースもモザイクも DAO アカウントのものなので、DAO が署名者。DAO が持っているネームスペースならそのまま紐付け、
// まだ無い名前なら（ルートは日数分レンタルして / 親が DAO のものなら子として）作ってから紐付ける。
const LinkNamespace = withFormReset<{ mosaicId: string; label: string; current: string; onBack: () => void }>(function LinkNamespace({ mosaicId, label, current, onBack, onSent }: { mosaicId: string; label: string; current: string; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dao, actor, signer, reload } = useDao();
  const [owned, setOwned] = useState<OwnedNamespace[] | null>(null);
  const [fees, setFees] = useState<NamespaceRentalFees | null>(null);
  const [nameText, setNameText] = useState('');
  const [daysText, setDaysText] = useState('365');
  const [lookup, setLookup] = useState<NamespaceLookup | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOwnedNamespaces(dao.address).then((o) => { if (!cancelled) setOwned(o); }).catch(() => { if (!cancelled) { setOwned([]); setFailed(true); } });
    fetchNamespaceRentalFees().then((f) => { if (!cancelled) setFees(f); });
    return () => { cancelled = true; };
  }, [dao.address]);

  const name = nameText.trim().toLowerCase();
  useEffect(() => {
    setLookup(null);
    if (name === '' || owned === null) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupNamespace(name, owned).then((r) => { if (!cancelled) setLookup(r); }).catch(() => { if (!cancelled) { setLookup({ kind: 'invalid' }); setFailed(true); } });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [name, owned]);

  const days = /^\d+$/.test(daysText.trim()) ? Number(daysText.trim()) : null;
  const daysOk = days !== null && days >= MIN_NAMESPACE_DAYS && days <= MAX_NAMESPACE_DAYS;
  const rentalRoot = fees && daysOk ? fees.rootFeePerBlock * BigInt(days) * BigInt(BLOCKS_PER_DAY) : null;
  const free = (owned ?? []).filter((n) => !n.expired && n.aliasType === 'none');

  let target: NamespaceLinkTarget | null = null;
  if (lookup?.kind === 'owned') target = { kind: 'owned', id: lookup.id };
  else if (lookup?.kind === 'root' && daysOk && fees) target = { kind: 'root', name, days: days! };
  else if (lookup?.kind === 'child' && fees) target = { kind: 'child', name: name.split('.').pop()!, parentId: lookup.parentId };

  const status = (): { severity: 'info' | 'error' | 'success'; text: string } | null => {
    if (name === '') return null;
    if (lookup === null) return { severity: 'info', text: t('dao.ns_checking') };
    switch (lookup.kind) {
      case 'invalid': return { severity: 'error', text: t('dao.ns_err_invalid') };
      case 'owned': return { severity: 'success', text: t('dao.ns_state_owned') };
      case 'owned_alias': return { severity: 'error', text: t('dao.ns_err_alias') };
      case 'owned_expired': return { severity: 'error', text: t('dao.ns_err_expired') };
      case 'root': return { severity: 'info', text: t('dao.ns_state_root') };
      case 'child': return { severity: 'info', text: t('dao.ns_state_child', { parent: lookup.parentName }) };
      case 'taken': return { severity: 'error', text: t('dao.ns_err_taken') };
      case 'no_parent': return { severity: 'error', text: t('dao.ns_err_no_parent') };
      case 'parent_other': return { severity: 'error', text: t('dao.ns_err_parent_other') };
      default: return null;
    }
  };
  const st = status();

  return (
    <SectionCard title={`${label} — ${t('dao.ns_link')}`}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('dao.ns_lead')}</Typography>
      <Typography variant="caption" sx={{ ...mono, color: 'text.secondary', display: 'block', mb: 1.5 }}>{mosaicId}</Typography>
      {current && <Alert severity="info" sx={{ mb: 1.5 }}>{t('dao.ns_current', { name: current })}</Alert>}
      {current && <Box sx={{ mb: 1.5, mt: -0.5 }}><LinkedNamespaceWarning linked={current} /></Box>}
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!signer || target === null}
        prepare={async () => {
          const plan = await planLinkNamespace(actor, dao, signer!, mosaicId, target!);
          return {
            plans: [plan],
            rows: [
              { label: t('dao.row_mosaic'), value: `${label}\n${mosaicId}`, big: true },
              { label: t('dao.ns_row_name'), value: name, big: true },
              { label: t('dao.ns_row_action'), value: t(`dao.ns_action_${target!.kind}`) },
              ...(plan.rental > 0n ? [{ label: t('dao.ns_row_rental'), value: xymText(plan.rental) }] : []),
            ],
          };
        }}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        {free.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.ns_owned_free')}</Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
              {free.map((n) => <Chip key={n.id} size="small" variant={name === n.name ? 'filled' : 'outlined'} label={n.name} onClick={() => setNameText(n.name)} />)}
            </Box>
          </Box>
        )}
        <FormRow label={t('dao.ns_f_name')} hint={t('dao.ns_hint_name')}>
          <Field ariaLabel={t('dao.ns_f_name')} value={nameText} onChange={(e) => setNameText(e.target.value)} error={st?.severity === 'error'} htmlInput={{ autoCapitalize: 'none', spellCheck: false }} />
        </FormRow>
        {lookup?.kind === 'root' && (
          <FormRow label={t('dao.ns_f_days')} hint={t('dao.ns_hint_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })}>
            <Field ariaLabel={t('dao.ns_f_days')} value={daysText} onChange={(e) => setDaysText(e.target.value)} error={!daysOk} htmlInput={{ inputMode: 'numeric' }} />
          </FormRow>
        )}
        {st && (
          <Alert
            severity={st.severity}
            sx={{ mt: 1 }}
            action={lookup?.kind === 'owned_expired' ? <Button color="inherit" size="small" onClick={() => navigate(daoPath(dao.id, 'namespace'))}>{t('dao.nsx_go')}</Button> : undefined}
          >
            {st.text}
          </Alert>
        )}
        {lookup?.kind === 'root' && rentalRoot !== null && <Typography variant="body2" sx={{ mt: 1 }}>{t('dao.ns_rental', { fee: xymText(rentalRoot) })}</Typography>}
        {lookup?.kind === 'child' && fees && <Typography variant="body2" sx={{ mt: 1 }}>{t('dao.ns_rental', { fee: xymText(fees.childFee) })}</Typography>}
        {(lookup?.kind === 'root' || lookup?.kind === 'child') && !fees && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.ns_err_fee')}</Alert>}
        {failed && <Alert severity="warning" sx={{ mt: 1 }}>{t('dao.err_load_failed')}</Alert>}
      </DaoAction>
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});

export default LinkNamespace;
