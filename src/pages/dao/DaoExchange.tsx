import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, MenuItem, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planExchangeItem, planRequestExchange } from '../../lib/dao/daoActions';
import { fetchHeld } from '../../lib/dao/daoApi';
import type { DaoMosaic } from '../../lib/dao/daoApi';
import { DESCRIPTION_MAX_BYTES, byteLength } from '../../lib/dao/daoCore';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';
import { DaoAction, parseAmount, useDao } from './daoUi';

// 「ポイント交換」: 会員は、ポイントと引き換えに特典をもらう申請を出す（管理者が連署すると成立する）。
// 管理者は、特典を「交換アイテム」にする（何のポイントを何ポイントで）。
export default function DaoExchange() {
  const { t } = useTranslation();
  const { isAdmin, mosaics } = useDao();
  const [picked, setPicked] = useState<DaoMosaic | null>(null);
  const items = mosaics.filter((m) => m.exchange !== null && m.held > 0n);

  if (picked) return <Request item={picked} onBack={() => setPicked(null)} />;
  return (
    <>
      <SectionCard title={t('dao.exchange_items')}>
        {items.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.exchange_none')}</Typography>}
        {items.map((m) => (
          <Box key={m.id} sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{m.name}</Typography>
              {m.namespace && <Typography variant="caption" sx={{ ...mono, color: 'primary.main' }}>{m.namespace}</Typography>}
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>{m.exchange!.description}</Typography>
              <Box sx={{ mt: 0.5, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                <Chip size="small" variant="outlined" label={t('dao.exchange_cost', { cost: m.exchange!.cost.toString(), point: m.exchange!.pointMosaicName })} />
                <Chip size="small" variant="outlined" label={t('dao.exchange_stock', { count: m.held.toString() })} />
              </Box>
            </Box>
            <Button variant="contained" onClick={() => setPicked(m)}>{t('dao.exchange_do')}</Button>
          </Box>
        ))}
      </SectionCard>
      {isAdmin && <SetItem />}
    </>
  );
}

const Request = withFormReset<{ item: DaoMosaic; onBack: () => void }>(function Request({ item, onBack, onSent }: { item: DaoMosaic; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const ex = item.exchange!;
  const [mine, setMine] = useState<bigint | null>(null);
  const [qtyText, setQtyText] = useState('');
  const qty = parseAmount(qtyText);

  useEffect(() => {
    let cancelled = false;
    fetchHeld(actor.address).then((h) => { if (!cancelled) setMine(h.get(ex.pointMosaicId) ?? 0n); }).catch(() => { if (!cancelled) setMine(0n); });
    return () => { cancelled = true; };
  }, [actor.address, ex.pointMosaicId]);

  const total = qty !== null ? qty * ex.cost : null;
  const overStock = qty !== null && qty > item.held;
  const overPoints = total !== null && mine !== null && total > mine;
  return (
    <SectionCard title={`${item.name} — ${t('dao.exchange_do')}`}>
      <Typography variant="body2" sx={{ mb: 1 }}>{item.exchange!.description}</Typography>
      <Typography variant="body2" sx={{ mb: 1.5, color: 'text.secondary' }}>
        {t('dao.exchange_my_points', { point: ex.pointMosaicName, amount: mine === null ? '…' : mine.toString() })}
      </Typography>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!signer || qty === null || overStock || overPoints || mine === null}
        prepare={async () => ({
          plans: [planRequestExchange(actor, dao, signer!, item.id, qty!, ex.pointMosaicId, ex.cost)],
          rows: [
            { label: t('dao.row_mosaic'), value: `${item.name}\n${item.id}`, big: true },
            { label: t('dao.f_quantity'), value: qty!.toString() },
            { label: t('dao.row_points_used'), value: `${total!.toString()} ${ex.pointMosaicName}` },
          ],
        })}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        <FormRow label={t('dao.f_quantity')}>
          <Field ariaLabel={t('dao.f_quantity')} value={qtyText} onChange={(e) => setQtyText(e.target.value)} error={(qtyText !== '' && qty === null) || overStock || overPoints} htmlInput={{ inputMode: 'numeric' }} />
        </FormRow>
        {overStock && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_exchange_stock')}</Alert>}
        {overPoints && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_exchange_points')}</Alert>}
        <Alert severity="info" sx={{ mt: 1.5 }}>{t('dao.exchange_request_note')}</Alert>
      </DaoAction>
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});

const SetItem = withFormReset<object>(function SetItem({ onSent }: SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, mosaics, reload } = useDao();
  const rewards = mosaics.filter((m) => m.kind === 'reward');
  const points = mosaics.filter((m) => m.kind === 'point');
  const [rewardId, setRewardId] = useState('');
  const [pointId, setPointId] = useState('');
  const [costText, setCostText] = useState('');
  const [description, setDescription] = useState('');
  const cost = parseAmount(costText);
  const reward = rewards.find((m) => m.id === rewardId);
  const point = points.find((m) => m.id === pointId);
  const descOk = description.trim() !== '' && byteLength(description) <= DESCRIPTION_MAX_BYTES;
  return (
    <SectionCard title={t('dao.exchange_set')}>
      {rewards.length === 0 || points.length === 0 ? <Alert severity="info">{t('dao.exchange_set_need')}</Alert> : (
        <DaoAction
          label={t('multisig.go_confirm')}
          disabled={!signer || !reward || !point || cost === null || !descOk}
          prepare={async () => ({
            plans: [await planExchangeItem(actor, dao, signer!, { rewardMosaicId: reward!.id, description: description.trim(), pointMosaicId: point!.id, pointMosaicName: point!.name, cost: cost! })],
            rows: [
              { label: t('dao.exchange_reward'), value: `${reward!.name}\n${reward!.namespace || reward!.id}`, big: true },
              { label: t('dao.exchange_point'), value: `${point!.name}\n${point!.namespace || point!.id}` },
              { label: t('dao.f_cost'), value: cost!.toString() },
              { label: t('dao.f_description'), value: description.trim() },
            ],
          })}
          onSent={() => { reload(); onSent(); }}
        >
          <FormRow label={t('dao.exchange_reward')}>
            <Field select ariaLabel={t('dao.exchange_reward')} value={rewardId} onChange={(e) => setRewardId(e.target.value)}>
              {rewards.map((m) => <MenuItem key={m.id} value={m.id}>{m.name} <Typography component="span" variant="caption" sx={{ ml: 1, ...mono }}>{m.namespace || m.id}</Typography></MenuItem>)}
            </Field>
          </FormRow>
          <FormRow label={t('dao.exchange_point')}>
            <Field select ariaLabel={t('dao.exchange_point')} value={pointId} onChange={(e) => setPointId(e.target.value)}>
              {points.map((m) => <MenuItem key={m.id} value={m.id}>{m.name} <Typography component="span" variant="caption" sx={{ ml: 1, ...mono }}>{m.namespace || m.id}</Typography></MenuItem>)}
            </Field>
          </FormRow>
          <FormRow label={t('dao.f_cost')} hint={t('dao.hint_cost')}>
            <Field ariaLabel={t('dao.f_cost')} value={costText} onChange={(e) => setCostText(e.target.value)} error={costText !== '' && cost === null} htmlInput={{ inputMode: 'numeric' }} />
          </FormRow>
          <FormRow label={t('dao.f_description')}>
            <Field ariaLabel={t('dao.f_description')} value={description} onChange={(e) => setDescription(e.target.value)} error={description !== '' && !descOk} helperText={`${byteLength(description)} / ${DESCRIPTION_MAX_BYTES} bytes`} />
          </FormRow>
        </DaoAction>
      )}
    </SectionCard>
  );
});
