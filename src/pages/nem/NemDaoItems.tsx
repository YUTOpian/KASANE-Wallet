import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Chip, MenuItem, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useTranslation } from 'react-i18next';
import { fetchNemMosaicDefinition, fetchNemMosaicHolding, fetchNemMosaicSupply, fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import { isValidNemAddress } from '../../lib/nem/crypto';
import {
  DaoDistributeError, changeItemSupplyFromDao, checkSupplyChange, createDaoItem, daoXemShortfall, distributeGovernanceTokens, distributeItemsFromDao, fetchDaoItems, fetchExchangeRequests, fetchMyExchanges,
  fulfilExchange, inspectItemCreation, newItemMosaicId, requestExchange,
} from '../../lib/nem/dao';
import type { DaoItem, ExchangeRequest, MyExchange, NemDao, NewDaoItem } from '../../lib/nem/dao';
import {
  DAO_ITEM_CREATE_STEPS, DAO_SEND_FEE_MARGIN, NEM_DAO_ITEM_NAMESPACE_MAX_LENGTH, NEM_DAO_SUPPLY, checkNewItem, daoNamespaceOf, exchangeCost, isValidItemNamespacePart,
  itemDepositTopUp, itemMosaicId, itemNamespace, parseRecipients, parseTokenAmount,
} from '../../lib/nem/daoCore';
import type { DaoItemCreateStep, DaoItemKind } from '../../lib/nem/daoCore';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { showTxNotice } from '../../store/txNoticeStore';
import { ConfirmScreen, Field, FormRow, SectionCard, mono } from '../multisig/parts';
import type { ConfirmRow } from '../multisig/parts';
import { nemXem } from './parts';
import { LoadingBox, groupDigits, shortAddress, unlockNemKey } from './NemDaoUi';

/** 作成のときに管理者のアカウントが払う分の余裕（DAO への入金の手数料と、DAO の名前の取引の外側の手数料 2 回）。 */
const ITEM_ADMIN_FEE_MARGIN = 1_000_000n;

interface PendingConfirm {
  rows: ConfirmRow[];
  run: (key: { privateKey: string; publicKey: string }) => Promise<string[]>; // 送ったトランザクションのハッシュ
  after?: () => void;
}

/** 確認画面（パスワード）→ 送信 → 結果の通知。 */
export function useConfirm(noticeKey: string, reload: () => void) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const screen = confirm && (
    <ConfirmScreen
      rows={confirm.rows}
      onBack={() => setConfirm(null)}
      onPassword={async (password) => {
        const key = await unlockNemKey(password);
        const hashes = await confirm.run(key);
        showTxNotice({
          lines: t(noticeKey, { returnObjects: true }) as string[],
          explorerUrl: hashes.length > 0 ? nemExplorerTxUrl(hashes[hashes.length - 1]) : undefined,
          explorerLabel: t('nemmosaic.view_explorer'),
        });
        confirm.after?.();
        setConfirm(null);
        reload();
      }}
    />
  );
  return { setConfirm, screen, confirming: confirm !== null };
}

// --- トークン・ポイント・特典を配る（管理者が自分のアカウントから送る） ---------------------------------------
/**
 * `dao` を渡すと、DAO アカウントから（管理者が DAO の名前で、マルチシグ経由で）送る。ポイント・特典用: 転送不可で、作成者（DAO アカウント）からしか動かせないため。
 * 渡さなければ、管理者が自分のアカウントから送る（ガバナンストークン用）。
 */
export function DistributeForm({ mosaicId, title, actorAddress, dao, reload, onConfirming }: { mosaicId: string; title: string; actorAddress: string; dao?: NemDao; reload: () => void; onConfirming?: (b: boolean) => void }) {
  const { t } = useTranslation();
  const netCfg = getNemNetworkConfig();
  const [recipientsText, setRecipientsText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setConfirm, screen, confirming } = useConfirm('nemdao.done_distribute', reload);
  useEffect(() => onConfirming?.(confirming), [confirming, onConfirming]);

  const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);
  const invalid = recipients.filter((a) => !isValidNemAddress(a, netCfg.networkByte));
  const amount = parseTokenAmount(amountText, NEM_DAO_SUPPLY * 1000n);

  const toConfirm = async () => {
    setError('');
    if (recipients.length === 0 || invalid.length > 0 || amount === null) return;
    setBusy(true);
    try {
      const sender = dao ? dao.address : actorAddress;
      const held = await fetchNemMosaicHolding(sender, mosaicId);
      const need = amount * BigInt(recipients.length);
      if (held !== null && held < need) {
        setError(t('nemdao.err_tokens', { need: groupDigits(need), have: groupDigits(held) }));
        return;
      }
      if (dao) {
        const short = await daoXemShortfall(dao, recipients.length);
        if (short > 0n) {
          setError(t('nemdao.err_dao_xem', { need: nemXem(DAO_SEND_FEE_MARGIN * BigInt(recipients.length)), address: dao.address }));
          return;
        }
      }
      setConfirm({
        rows: [
          { label: t('nemdao.row_token'), value: mosaicId, big: true },
          { label: t('nemdao.row_recipients'), value: t('nemdao.row_recipients_value', { count: recipients.length }) },
          { label: t('nemdao.row_each'), value: groupDigits(amount) },
          { label: t('nemdao.row_total'), value: groupDigits(need) },
          { label: t('nemdao.row_from'), value: sender },
          { label: t('nemdao.row_fee'), value: t(dao ? 'nemdao.row_fee_value_dao' : 'nemdao.row_fee_value') },
          ...(dao && dao.admins.length > 1 ? [{ label: t('nemdao.row_cosign'), value: t('nemdao.row_cosign_value') }] : []),
        ],
        run: async (key) => {
          try {
            if (dao) return await distributeItemsFromDao(key.privateKey, key.publicKey, dao, mosaicId, recipients, amount);
            return await distributeGovernanceTokens(key.privateKey, key.publicKey, mosaicId, recipients, amount);
          } catch (e) {
            if (e instanceof DaoDistributeError) throw new Error(t('nemdao.err_partial', { sent: e.sent, total: recipients.length, detail: e.message }));
            throw e;
          }
        },
        after: () => { setRecipientsText(''); setAmountText(''); },
      });
    } finally {
      setBusy(false);
    }
  };

  if (screen) return screen;
  return (
    <SectionCard title={title}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t(dao ? 'nemdao.distribute_lead_dao' : 'nemdao.distribute_lead', { id: mosaicId })}</Typography>
      <TextField
        label={t('nemdao.f_recipients')}
        helperText={invalid.length > 0 ? t('nemdao.err_recipient_invalid', { address: invalid[0] }) : t('nemdao.hint_recipients')}
        error={invalid.length > 0}
        value={recipientsText}
        onChange={(e) => setRecipientsText(e.target.value)}
        multiline
        minRows={3}
        fullWidth
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
        sx={{ mb: 2 }}
      />
      <TextField label={t('nemdao.f_amount_each')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={amountText !== '' && amount === null} fullWidth sx={{ mb: 1 }} />
      {error && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" size="large" fullWidth disabled={busy || recipients.length === 0 || invalid.length > 0 || amount === null} onClick={toConfirm} sx={{ py: 1.25 }}>
          {t('nemdao.go_confirm')}
        </Button>
      </Box>
    </SectionCard>
  );
}

// --- ポイント・特典の発行量を増やす・減らす（DAO の名前で。増減した分は DAO アカウントのもの） ---------------------------
function SupplyForm({ dao, item, actorAddress, reload, onConfirming }: { dao: NemDao; item: DaoItem; actorAddress: string; reload: () => void; onConfirming?: (b: boolean) => void }) {
  const { t } = useTranslation();
  const [action, setAction] = useState<'increase' | 'decrease'>('increase');
  const [deltaText, setDeltaText] = useState('');
  const [supply, setSupply] = useState<bigint | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setConfirm, screen, confirming } = useConfirm('nemdao.done_supply', reload);
  useEffect(() => onConfirming?.(confirming), [confirming, onConfirming]);
  useEffect(() => {
    let cancelled = false;
    fetchNemMosaicSupply(item.id).then((v) => { if (!cancelled) setSupply(v); }).catch(() => undefined);
    fetchNemMosaicHolding(dao.address, item.id).then((v) => { if (!cancelled) setHeld(v); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [dao.address, item.id]);

  const delta = parseTokenAmount(deltaText, NEM_DAO_SUPPLY * 1000n);
  const toConfirm = async () => {
    setError('');
    if (delta === null) return;
    setBusy(true);
    try {
      const problem = await checkSupplyChange(dao, item.id, action, delta);
      if (problem) { setError(t(`nemdao.err_supply_${problem}`)); return; }
      const short = await daoXemShortfall(dao, 1);
      if (short > 0n) { setError(t('nemdao.err_dao_xem', { need: nemXem(DAO_SEND_FEE_MARGIN), address: dao.address })); return; }
      const have = await fetchNemXemBalance(actorAddress).catch(() => null);
      if (have !== null && have < ITEM_ADMIN_FEE_MARGIN) { setError(t('nemdao.err_balance', { need: nemXem(ITEM_ADMIN_FEE_MARGIN), have: nemXem(have) })); return; }
      setConfirm({
        rows: [
          { label: t('nemdao.row_token'), value: item.id, big: true },
          { label: t('nemdao.row_supply_change'), value: t(action === 'increase' ? 'nemdao.supply_increase_value' : 'nemdao.supply_decrease_value', { amount: groupDigits(delta) }) },
          ...(supply !== null ? [{ label: t('nemdao.row_supply_after'), value: groupDigits(action === 'increase' ? supply + delta : supply - delta) }] : []),
          { label: t('nemdao.row_by_dao'), value: `${dao.name || daoNamespaceOf(dao.mosaicId)}\n${dao.address}` },
          { label: t('nemdao.row_fee'), value: t('nemdao.row_fee_value_dao') },
          ...(dao.admins.length > 1 ? [{ label: t('nemdao.row_cosign'), value: t('nemdao.row_cosign_value') }] : []),
        ],
        run: async (key) => [(await changeItemSupplyFromDao(key.privateKey, key.publicKey, dao, item.id, action, delta)).hash],
        after: () => setDeltaText(''),
      });
    } finally {
      setBusy(false);
    }
  };

  if (screen) return screen;
  return (
    <SectionCard title={t('nemdao.supply_title', { name: item.name })}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
        {t('nemdao.supply_now', { supply: supply === null ? '…' : groupDigits(supply), held: held === null ? '…' : groupDigits(held) })}
      </Typography>
      <ToggleButtonGroup exclusive size="small" value={action} onChange={(_, v: 'increase' | 'decrease' | null) => { if (v) setAction(v); }} sx={{ mb: 2 }}>
        <ToggleButton value="increase">{t('nemdao.supply_increase')}</ToggleButton>
        <ToggleButton value="decrease">{t('nemdao.supply_decrease')}</ToggleButton>
      </ToggleButtonGroup>
      <TextField label={t('nemdao.f_supply_delta')} helperText={t(action === 'increase' ? 'nemdao.hint_supply_increase' : 'nemdao.hint_supply_decrease')} value={deltaText} onChange={(e) => setDeltaText(e.target.value)} error={deltaText !== '' && delta === null} fullWidth />
      {error && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" size="large" fullWidth disabled={busy || delta === null} onClick={toConfirm} sx={{ py: 1.25 }}>{t('nemdao.go_confirm')}</Button>
      </Box>
    </SectionCard>
  );
}

function useItems(dao: NemDao, version: number) {
  const [items, setItems] = useState<DaoItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    fetchDaoItems(dao).then((list) => { if (!cancelled) setItems(list); }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [dao, version]);
  return items;
}

// --- 管理者: ポイント・特典を作る・配る ---------------------------------------------------------------------
// ポイント・特典は、DAO のネームスペースの子ネームスペース（例 abc.coffee）の中のモザイク（abc.coffee:reward）。作成者は DAO アカウントで、管理者が DAO の名前で作る。
type StepState = 'pending' | 'sending' | 'waiting' | 'done';
interface CreationRun {
  phase: 'running' | 'done' | 'failed';
  steps: Record<DaoItemCreateStep, StepState>;
  error: string;
  mosaicId?: string;
}
const freshSteps = (): Record<DaoItemCreateStep, StepState> => ({ deposit: 'pending', namespace: 'pending', mosaic: 'pending' });

export function ItemsTab({ dao, actorAddress, reload, version }: { dao: NemDao; actorAddress: string; reload: () => void; version: number }) {
  const { t } = useTranslation();
  const items = useItems(dao, version);
  const root = daoNamespaceOf(dao.mosaicId);
  const [kind, setKind] = useState<DaoItemKind>('point');
  const [part, setPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [point, setPoint] = useState('');
  const [costText, setCostText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [distributeId, setDistributeId] = useState('');
  const [supplyId, setSupplyId] = useState('');
  const [hideRest, setHideRest] = useState(false);
  const [createConfirm, setCreateConfirm] = useState<{ rows: ConfirmRow[]; item: NewDaoItem } | null>(null);
  const [run, setRun] = useState<CreationRun | null>(null);

  const myPoints = (items ?? []).filter((i) => i.kind === 'point');
  useEffect(() => {
    const first = (items ?? []).find((i) => i.kind === 'point')?.id ?? '';
    setPoint((cur) => cur || first);
  }, [items]);

  const amount = parseTokenAmount(amountText, NEM_DAO_SUPPLY * 1000n);
  const cost = parseTokenAmount(costText, NEM_DAO_SUPPLY * 1000n);
  const issues = checkNewItem({ kind, name: displayName, part, amount, description, point, cost, dao: dao.id });
  const partOk = isValidItemNamespacePart(part);
  const canCreate = issues.length === 0 && !busy && run?.phase !== 'running';
  const previewId = partOk ? itemMosaicId(root, part, kind) : '';

  const toConfirm = async () => {
    setError('');
    if (!canCreate || amount === null) return;
    setBusy(true);
    try {
      const item: NewDaoItem = {
        kind, part, displayName, amount, description, point: kind === 'reward' ? point : undefined, cost: kind === 'reward' ? cost ?? undefined : undefined,
      };
      const id = newItemMosaicId(dao, item);
      const namespace = itemNamespace(root, part);
      if ((items ?? []).some((i) => i.id === id) || (await fetchNemMosaicDefinition(id).catch(() => null)) !== null) {
        setError(t('nemdao.err_item_exists', { id }));
        return;
      }
      // DAO アカウントで足りない分は、管理者のアカウントから入金する。
      const state = await inspectItemCreation(dao, namespace, id);
      const topUp = itemDepositTopUp(state);
      const have = await fetchNemXemBalance(actorAddress).catch(() => null);
      const need = topUp + ITEM_ADMIN_FEE_MARGIN;
      if (have !== null && have < need) {
        setError(t('nemdao.err_balance', { need: nemXem(need), have: nemXem(have) }));
        return;
      }
      const rows: ConfirmRow[] = [
        { label: t('nemdao.row_kind'), value: t(`nemdao.kind_${kind}`) },
        { label: t('nemdao.f_display_name'), value: displayName.trim(), big: true },
        { label: t('nemdao.row_item_namespace'), value: namespace },
        { label: t('nemdao.row_token'), value: id },
        { label: t('nemdao.row_supply'), value: groupDigits(amount) },
      ];
      if (kind === 'reward' && cost !== null) {
        rows.push({ label: t('nemdao.row_point'), value: point }, { label: t('nemdao.row_cost'), value: groupDigits(cost) });
        if (description.trim() !== '') rows.push({ label: t('nemdao.f_item_description'), value: description.trim() });
      }
      rows.push(
        { label: t('nemdao.row_by_dao'), value: `${dao.name || root}\n${dao.address}` },
        { label: t('nemdao.row_item_fee'), value: t('nemdao.row_item_fee_value', { topup: nemXem(topUp) }) },
      );
      if (dao.admins.length > 1) rows.push({ label: t('nemdao.row_cosign'), value: t('nemdao.row_cosign_value') });
      rows.push({ label: t('nemdao.row_time'), value: t('nemdao.row_time_value') });
      setCreateConfirm({ rows, item });
    } finally {
      setBusy(false);
    }
  };

  const runCreate = async (key: { privateKey: string; publicKey: string }, item: NewDaoItem) => {
    setRun({ phase: 'running', steps: freshSteps(), error: '' });
    try {
      const done = await createDaoItem(key.privateKey, key.publicKey, dao, item, (step, p) => {
        setRun((r) => (r ? { ...r, steps: { ...r.steps, [step]: p === 'sending' ? 'sending' : p === 'waiting' ? 'waiting' : 'done' } } : r));
      });
      setRun((r) => (r ? { ...r, phase: 'done', mosaicId: done.mosaicId } : r));
      setPart(''); setDisplayName(''); setAmountText(''); setDescription(''); setCostText('');
      reload();
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setRun((r) => (r ? { ...r, phase: 'failed', error: code === 'confirm_timeout' || code === 'stuck' ? t(`nemdao.err_${code}`) : t('nemdao.err_item_create', { detail: code }) } : r));
    }
  };

  if (createConfirm) {
    return (
      <ConfirmScreen
        rows={createConfirm.rows}
        onBack={() => setCreateConfirm(null)}
        onPassword={async (password) => {
          const key = await unlockNemKey(password);
          const { item } = createConfirm;
          setCreateConfirm(null);
          // 数分かかる（確定を待つ）ので、待たずに進み具合の表示へ移る。
          void runCreate(key, item);
        }}
      />
    );
  }

  const icon = (state: StepState) => (state === 'done' ? <CheckCircleOutlineIcon color="success" /> : state === 'pending' ? <RadioButtonUncheckedIcon sx={{ color: 'text.disabled' }} /> : <CircularProgress size={22} />);
  const target = (items ?? []).find((i) => i.id === distributeId);
  const supplyTarget = (items ?? []).find((i) => i.id === supplyId);

  return (
    <>
      {!hideRest && (
        <>
          <Alert severity="info" sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>{t('nemdao.items_explain', { namespace: root })}</Alert>

          {run && (
            <SectionCard title={t('nemdao.progress_title')}>
              {DAO_ITEM_CREATE_STEPS.map((step) => (
                <Box key={step} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
                  {icon(run.steps[step])}
                  <Typography>{t(`nemdao.item_step_${step}`)}{run.steps[step] === 'waiting' ? ` — ${t('nemdao.waiting')}` : ''}</Typography>
                </Box>
              ))}
              {run.phase === 'running' && <Alert severity="info" sx={{ mt: 1.5 }}>{t('nemdao.item_running_note')}</Alert>}
              {run.phase === 'done' && <Alert severity="success" sx={{ mt: 1.5 }}>{t('nemdao.item_created_note', { id: run.mosaicId })}</Alert>}
              {run.phase === 'failed' && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{run.error}{'\n'}{t('nemdao.item_resume_note')}</Alert>}
            </SectionCard>
          )}

          <SectionCard title={t('nemdao.items_create')}>
            <FormRow label={t('nemdao.row_kind')}>
              <Field select ariaLabel={t('nemdao.row_kind')} value={kind} onChange={(e) => setKind(e.target.value as DaoItemKind)}>
                <MenuItem value="point">{t('nemdao.kind_point')}</MenuItem>
                <MenuItem value="reward">{t('nemdao.kind_reward')}</MenuItem>
              </Field>
            </FormRow>
            <FormRow label={t('nemdao.f_item_part')} hint={t('nemdao.hint_item_part', { namespace: root })}>
              <Field
                ariaLabel={t('nemdao.f_item_part')}
                value={part}
                onChange={(e) => setPart(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, NEM_DAO_ITEM_NAMESPACE_MAX_LENGTH))}
                error={part !== '' && !partOk}
                helperText={partOk ? t('nemdao.hint_item_id', { namespace: itemNamespace(root, part), id: previewId }) : `${root}.`}
                htmlInput={{ style: { fontFamily: 'monospace' } }}
              />
            </FormRow>
            <FormRow label={t('nemdao.f_display_name')}>
              <Field ariaLabel={t('nemdao.f_display_name')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={displayName !== '' && (issues.includes('name_empty') || issues.includes('name_long'))} />
            </FormRow>
            <FormRow label={t('nemdao.f_item_amount')} hint={t('nemdao.hint_item_amount')}>
              <Field ariaLabel={t('nemdao.f_item_amount')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={amountText !== '' && amount === null} />
            </FormRow>
            {kind === 'reward' && (
              <>
                <FormRow label={t('nemdao.f_item_description')}>
                  <Field ariaLabel={t('nemdao.f_item_description')} value={description} onChange={(e) => setDescription(e.target.value)} error={issues.includes('description_long')} />
                </FormRow>
                <FormRow label={t('nemdao.f_point')} hint={t('nemdao.hint_point')}>
                  {myPoints.length === 0 ? <Alert severity="warning">{t('nemdao.no_point')}</Alert> : (
                    <TextField select fullWidth size="small" value={point} onChange={(e) => setPoint(e.target.value)} slotProps={{ htmlInput: { 'aria-label': t('nemdao.f_point') } }}>
                      {myPoints.map((p) => <MenuItem key={p.id} value={p.id}>{p.name} ({p.id})</MenuItem>)}
                    </TextField>
                  )}
                </FormRow>
                <FormRow label={t('nemdao.f_cost')} hint={t('nemdao.hint_cost')}>
                  <Field ariaLabel={t('nemdao.f_cost')} value={costText} onChange={(e) => setCostText(e.target.value)} error={costText !== '' && cost === null} />
                </FormRow>
              </>
            )}
            {issues.includes('description_too_long') && <Alert severity="error" sx={{ mt: 1 }}>{t('nemdao.err_item_too_long')}</Alert>}
            {error && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
            <Box sx={{ mt: 2 }}>
              <Button variant="contained" size="large" fullWidth disabled={!canCreate} onClick={toConfirm} sx={{ py: 1.25 }}>{t('nemdao.go_confirm')}</Button>
            </Box>
          </SectionCard>

          <SectionCard title={t('nemdao.items_mine')}>
            {items === null ? <LoadingBox /> : items.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.items_none')}</Typography> : items.map((i) => (
              <Box key={i.id} sx={{ py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Chip size="small" label={t(`nemdao.kind_${i.kind}`)} color={i.kind === 'point' ? 'default' : 'primary'} />
                <Typography sx={{ fontWeight: 500 }}>{i.name}</Typography>
                <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{i.id}</Typography>
                {i.kind === 'reward' && <Typography variant="caption">{t('nemdao.cost_value', { cost: i.cost, point: i.point })}</Typography>}
                <Button size="small" variant="outlined" onClick={() => { setSupplyId(''); setDistributeId(i.id); }}>{t('nemdao.hand_out')}</Button>
                <Button size="small" variant="outlined" onClick={() => { setDistributeId(''); setSupplyId(i.id); }}>{t('nemdao.change_supply')}</Button>
              </Box>
            ))}
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemdao.items_supply_hint')}</Typography>
          </SectionCard>
        </>
      )}

      {supplyTarget && <SupplyForm key={supplyTarget.id} dao={dao} item={supplyTarget} actorAddress={actorAddress} reload={reload} onConfirming={setHideRest} />}
      {target && <DistributeForm key={target.id} mosaicId={target.id} title={t('nemdao.hand_out_title', { name: target.name })} actorAddress={actorAddress} dao={dao} reload={reload} onConfirming={setHideRest} />}
    </>
  );
}

// --- 交換: 会員は特典を申請、管理者は申請に応えて渡す ---------------------------------------------------------
export function ExchangeTab({ dao, actorAddress, isAdmin, reload, version }: { dao: NemDao; actorAddress: string; isAdmin: boolean; reload: () => void; version: number }) {
  const { t } = useTranslation();
  const items = useItems(dao, version);
  const [holdings, setHoldings] = useState<Record<string, bigint | null>>({});
  const [requests, setRequests] = useState<ExchangeRequest[] | null>(null);
  const [mine, setMine] = useState<MyExchange[] | null>(null);
  const [pick, setPick] = useState('');
  const [qtyText, setQtyText] = useState('1');
  const { setConfirm, screen } = useConfirm('nemdao.done_exchange', reload);

  const rewards = (items ?? []).filter((i) => i.kind === 'reward');
  const byId = (id: string) => (items ?? []).find((i) => i.id === id);

  useEffect(() => {
    if (!items) return undefined;
    let cancelled = false;
    const points: string[] = Array.from(new Set<string>(rewards.flatMap((r) => (r.point ? [r.point] : []))));
    Promise.all(points.map(async (p: string) => [p, await fetchNemMosaicHolding(actorAddress, p).catch(() => null)] as const))
      .then((list) => { if (!cancelled) setHoldings(Object.fromEntries(list)); });
    setMine(null);
    fetchMyExchanges(actorAddress, items).then((l) => { if (!cancelled) setMine(l); }).catch(() => { if (!cancelled) setMine([]); });
    if (isAdmin) {
      setRequests(null);
      fetchExchangeRequests(dao, items).then((l) => { if (!cancelled) setRequests(l); }).catch(() => { if (!cancelled) setRequests([]); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, actorAddress, isAdmin]);

  const qty = parseTokenAmount(qtyText, 1_000_000n);
  const picked = rewards.find((r) => r.id === pick);

  const toConfirmRequest = () => {
    if (!picked || qty === null || !picked.cost || !picked.point) return;
    const pay = exchangeCost(qty, BigInt(picked.cost));
    setConfirm({
      rows: [
        { label: t('nemdao.row_reward'), value: `${picked.name} × ${groupDigits(qty)}`, big: true },
        { label: t('nemdao.row_pay'), value: `${groupDigits(pay)}  (${picked.point})` },
        { label: t('nemdao.row_to_dao'), value: picked.creator },
        { label: t('nemdao.row_exchange_note'), value: t('nemdao.row_exchange_note_value') },
        { label: t('nemdao.row_fee'), value: t('nemdao.row_fee_value') },
      ],
      run: async (key) => [(await requestExchange(key.privateKey, key.publicKey, picked, qty)).hash],
      after: () => setPick(''),
    });
  };

  const toConfirmFulfil = (req: ExchangeRequest) => {
    const reward = byId(req.rewardId);
    setConfirm({
      rows: [
        { label: t('nemdao.row_reward'), value: `${reward?.name ?? req.rewardId} × ${groupDigits(req.quantity)}`, big: true },
        { label: t('nemdao.row_to_member'), value: req.from },
        { label: t('nemdao.row_request'), value: req.hash },
        { label: t('nemdao.row_from'), value: dao.address },
        { label: t('nemdao.row_fee'), value: t('nemdao.row_fee_value_dao') },
        ...(dao.admins.length > 1 ? [{ label: t('nemdao.row_cosign'), value: t('nemdao.row_cosign_value') }] : []),
      ],
      run: async (key) => {
        if ((await daoXemShortfall(dao, 1)) > 0n) throw new Error(t('nemdao.err_dao_xem', { need: nemXem(DAO_SEND_FEE_MARGIN), address: dao.address }));
        return [(await fulfilExchange(key.privateKey, key.publicKey, dao, req)).hash];
      },
    });
  };

  if (screen) return screen;
  return (
    <>
      <SectionCard title={t('nemdao.exchange_title')}>
        {items === null ? <LoadingBox /> : rewards.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.rewards_none')}</Typography> : rewards.map((r) => {
          const have = r.point ? holdings[r.point] : null;
          return (
            <Box key={r.id} sx={{ py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Typography sx={{ fontWeight: 500 }}>{r.name}</Typography>
              {r.description && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{r.description}</Typography>}
              <Typography variant="body2">{t('nemdao.cost_value', { cost: r.cost, point: r.point })}{have !== null && have !== undefined ? ` / ${t('nemdao.points_held', { amount: groupDigits(have) })}` : ''}</Typography>
              <Button size="small" variant={pick === r.id ? 'contained' : 'outlined'} sx={{ mt: 0.5 }} onClick={() => setPick(pick === r.id ? '' : r.id)}>{t('nemdao.exchange_button')}</Button>
            </Box>
          );
        })}
        {picked && (
          <Box sx={{ mt: 2 }}>
            <TextField label={t('nemdao.f_quantity')} value={qtyText} onChange={(e) => setQtyText(e.target.value)} error={qty === null} fullWidth size="small" sx={{ mb: 1.5 }} />
            {qty !== null && picked.cost && <Typography variant="body2" sx={{ mb: 1 }}>{t('nemdao.row_pay')}: {groupDigits(exchangeCost(qty, BigInt(picked.cost)))}</Typography>}
            <Alert severity="info" sx={{ mb: 1.5 }}>{t('nemdao.exchange_two_step')}</Alert>
            <Button variant="contained" fullWidth disabled={qty === null} onClick={toConfirmRequest} sx={{ py: 1.1 }}>{t('nemdao.go_confirm')}</Button>
          </Box>
        )}
      </SectionCard>

      <SectionCard title={t('nemdao.my_requests')}>
        {mine === null ? <LoadingBox /> : mine.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.my_requests_none')}</Typography> : mine.map((m) => (
          <Box key={m.hash} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="body2">{byId(m.rewardId)?.name ?? m.rewardId} × {groupDigits(m.quantity)}</Typography>
            <Chip size="small" label={t(m.done ? 'nemdao.status_done' : 'nemdao.status_waiting')} color={m.done ? 'success' : 'default'} />
          </Box>
        ))}
      </SectionCard>

      {isAdmin && (
        <SectionCard title={t('nemdao.requests_title')}>
          {requests === null ? <LoadingBox /> : requests.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.requests_none')}</Typography> : requests.map((r) => (
            <Box key={r.hash} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={mono}>{shortAddress(r.from)}</Typography>
              <Typography variant="body2">{byId(r.rewardId)?.name ?? r.rewardId} × {groupDigits(r.quantity)}</Typography>
              <Chip size="small" label={t(`nemdao.req_${r.status}`)} color={r.status === 'ready' ? 'primary' : r.status === 'done' ? 'success' : 'warning'} />
              {r.status === 'ready' && <Button size="small" variant="contained" onClick={() => toConfirmFulfil(r)}>{t('nemdao.fulfil_button')}</Button>}
            </Box>
          ))}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemdao.requests_note')}</Typography>
        </SectionCard>
      )}
    </>
  );
}
