import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planRenewNamespace } from '../../lib/dao/daoActions';
import { canRenewRow, namespaceRowState, sortByRootExpiry } from '../../lib/dao/daoNamespaceExpiry';
import type { NamespaceRowState } from '../../lib/dao/daoNamespaceExpiry';
import type { OwnedNamespace } from '../../lib/dao/daoApi';
import { fetchNamespaceRentalFees } from '../../lib/symbol/api';
import type { NamespaceRentalFees } from '../../lib/symbol/api';
import { extendedExpiryMs, isMaxedOut, maxExtensionDays, remainingDays, validateRenewDays } from '../../lib/symbol/namespaceRenew';
import { BLOCKS_PER_DAY, MAX_NAMESPACE_DAYS, MIN_NAMESPACE_DAYS } from '../../lib/symbol/tx';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, mono, xymText } from '../multisig/parts';
import { DaoAction, shortAddress, useDao } from './daoUi';

const DEFAULT_DAYS = 365;

// 「ネームスペース」タブ（管理者）: DAO アカウントが持つネームスペースを、有効期限つきで一覧にする。
// ルートは「更新」で期間を延ばせる。署名は DAO、レンタル料は DAO アカウントが払い、足りなければ同じアグリゲートでウォレットから入金する。
// サブネームスペースの期限は親（ルート）と同じなので、更新ボタンは親の行だけにある。
type Mode = { type: 'list' } | { type: 'renew'; id: string };

export default function DaoNamespaces() {
  const { t } = useTranslation();
  const { isAdmin, signer, namespaces } = useDao();
  const [mode, setMode] = useState<Mode>({ type: 'list' });

  if (!isAdmin) return <Alert severity="warning">{t('dao.admin_only')}</Alert>;
  if (namespaces === null) return <Alert severity="error">{t('dao.err_load_failed')}</Alert>;

  if (mode.type === 'renew') {
    const ns = namespaces.find((n) => n.id === mode.id);
    if (ns && signer) return <RenewNamespace ns={ns} onBack={() => setMode({ type: 'list' })} />;
  }
  return <NamespaceList rows={namespaces} canSign={signer !== null} onRenew={(id) => setMode({ type: 'renew', id })} />;
}

function NamespaceList({ rows, canSign, onRenew }: { rows: OwnedNamespace[]; canSign: boolean; onRenew: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { dao, mosaics } = useDao();
  const [nowMs] = useState(() => Date.now());
  const sorted = sortByRootExpiry(rows);
  const date = (ms: number | null) => (ms === null ? '-' : new Date(ms).toLocaleDateString(i18n.language));

  // 紐付き先の表示: DAO のモザイクなら名前、ガバナンストークンならその名前、どちらでもなければ ID（アドレスは短く）。
  const aliasText = (n: OwnedNamespace): string => {
    if (n.aliasType === 'mosaic') {
      if (n.alias === dao.governanceTokenId.toUpperCase()) return t('dao.governance_token');
      return mosaics.find((m) => m.id.toUpperCase() === n.alias)?.name ?? n.alias;
    }
    if (n.aliasType === 'address') return shortAddress(n.alias);
    return '';
  };

  const stateChip = (s: NamespaceRowState) => {
    if (s === 'expired') return <Chip size="small" color="error" variant="outlined" label={t('namespace.expired')} />;
    if (s === 'soon') return <Chip size="small" color="warning" variant="outlined" label={t('namespace.renew_soon')} />;
    return null;
  };

  return (
    <SectionCard title={t('dao.nsx_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('dao.nsx_lead')}</Typography>
      {!canSign && <Alert severity="error" sx={{ mb: 1.5 }}>{t('dao.err_invalid_signer')}</Alert>}
      {sorted.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.nsx_none')}</Typography>}
      {sorted.map((n) => {
        const child = n.depth > 1;
        const state = namespaceRowState(n, nowMs);
        const left = remainingDays(n, nowMs);
        const alias = aliasText(n);
        return (
          <Box key={n.id} sx={{ py: 1.25, pl: child ? 3 : 0, borderBottom: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography sx={{ ...mono, fontWeight: child ? 'normal' : 'bold' }}>{n.name}</Typography>
                  {!child && stateChip(state)}
                </Box>
                {child ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.nsx_child_follow')}</Typography>
                ) : (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t('namespace.table_expiry')}: {n.eternal ? t('dao.nsx_eternal') : date(n.expiresAtMs)}
                    {left !== null && `（${t('namespace.renew_left', { days: left })}）`}
                  </Typography>
                )}
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                  {t('dao.nsx_alias')}: {alias === '' ? t('dao.nsx_alias_none') : alias}
                </Typography>
              </Box>
              {canRenewRow(n) && (
                <Button size="small" variant={state === 'ok' ? 'outlined' : 'contained'} disabled={!canSign} onClick={() => onRenew(n.id)}>{t('dao.nsx_renew')}</Button>
              )}
            </Box>
          </Box>
        );
      })}
    </SectionCard>
  );
}

const RenewNamespace = withFormReset<{ ns: OwnedNamespace; onBack: () => void }>(function RenewNamespace({ ns, onBack, onSent }: { ns: OwnedNamespace; onBack: () => void } & SentProps) {
  const { t, i18n } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const [nowMs] = useState(() => Date.now());
  const maxed = isMaxedOut(ns, nowMs);
  const maxDays = maxExtensionDays(ns, nowMs);
  const [daysText, setDaysText] = useState(maxed ? '' : String(Math.min(DEFAULT_DAYS, maxDays)));
  const [fees, setFees] = useState<NamespaceRentalFees | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchNamespaceRentalFees().then((f) => { if (!cancelled) setFees(f); }).catch(() => { if (!cancelled) setFees(null); });
    return () => { cancelled = true; };
  }, []);

  const problem = !maxed && daysText !== '' ? validateRenewDays(ns, daysText, nowMs) : null;
  const daysOk = !maxed && daysText !== '' && problem === null;
  const days = daysOk ? Number(daysText) : 0;
  const rental = fees !== 'loading' && fees !== null && daysOk ? fees.rootFeePerBlock * BigInt(days) * BigInt(BLOCKS_PER_DAY) : null;
  const afterMs = daysOk ? extendedExpiryMs(ns, days) : null;
  const left = remainingDays(ns, nowMs);
  const date = (ms: number | null) => (ms === null ? '-' : new Date(ms).toLocaleDateString(i18n.language));
  const problemText = problem === null ? ''
    : problem === 'invalid' ? t('namespace.renew_invalid_days')
      : problem === 'range' ? t('namespace.renew_range_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })
        : t('namespace.renew_over_max', { limit: MAX_NAMESPACE_DAYS, max: maxDays });

  return (
    <SectionCard title={t('dao.nsx_renew_title', { name: ns.name })}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('dao.nsx_renew_lead')}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', overflowWrap: 'anywhere', columnGap: 3, rowGap: 0.75, mb: 1.5, fontSize: 14, alignItems: 'center' }}>
        <Box sx={{ color: 'text.secondary' }}>{t('namespace.renew_current_expiry')}</Box>
        <Box sx={{ fontWeight: 'bold' }}>
          {date(ns.expiresAtMs)}
          {ns.expired && <Chip size="small" color="error" variant="outlined" label={t('namespace.expired')} sx={{ ml: 1 }} />}
        </Box>
        {left !== null && (
          <>
            <Box />
            <Box sx={{ color: 'text.secondary' }}>{t('namespace.renew_left', { days: left })}</Box>
          </>
        )}
      </Box>
      {ns.expired && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('namespace.renew_expired_warning')}</Alert>}
      {maxed && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('namespace.renew_maxed')}</Alert>}
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!signer || !daysOk}
        prepare={async () => {
          const plan = await planRenewNamespace(actor, dao, signer!, ns, days);
          return {
            plans: [plan],
            rows: [
              { label: t('dao.ns_row_name'), value: ns.name, big: true },
              { label: t('dao.ns_row_action'), value: t('dao.nsx_action') },
              { label: t('namespace.renew_current_expiry'), value: date(ns.expiresAtMs) },
              { label: t('namespace.renew_days_label'), value: t('namespace.days_value', { days }) },
              ...(afterMs !== null ? [{ label: t('namespace.renew_after_expiry'), value: date(afterMs) }] : []),
              { label: t('dao.ns_row_rental'), value: xymText(plan.rental) },
            ],
          };
        }}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        <FormRow label={t('namespace.renew_days_label')} hint={problemText === '' ? t('namespace.renew_days_hint', { min: MIN_NAMESPACE_DAYS, max: Math.max(maxDays, MIN_NAMESPACE_DAYS) }) : undefined}>
          <Field ariaLabel={t('namespace.renew_days_label')} value={daysText} onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))} error={problemText !== ''} helperText={problemText || undefined} htmlInput={{ inputMode: 'numeric', disabled: maxed }} />
        </FormRow>
        {afterMs !== null && (
          <Typography variant="body2" sx={{ mt: 1 }}>{t('namespace.renew_after_expiry')}: <strong>{date(afterMs)}</strong></Typography>
        )}
        {rental !== null && <Typography variant="body2" sx={{ mt: 1 }}>{t('dao.ns_rental', { fee: xymText(rental) })}</Typography>}
        {fees === null && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.ns_err_fee')}</Alert>}
      </DaoAction>
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});
