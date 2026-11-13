import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planCreateMosaic, planRevokeBatches, planSendMosaicBatches } from '../../lib/dao/daoActions';
import { MAX_DAO_ITEMS, submitDaoBatches } from '../../lib/dao/daoBatch';
import { fetchGovernanceToken, fetchHolders, fetchMembers } from '../../lib/dao/daoApi';
import type { DaoMosaic, Holder } from '../../lib/dao/daoApi';
import { DESCRIPTION_MAX_BYTES, MOSAIC_NAME_MAX_BYTES, byteLength } from '../../lib/dao/daoCore';
import type { DaoMosaicKind } from '../../lib/dao/daoCore';
import { MAX_DAO_INNER } from '../../lib/dao/daoTx';
import { getNetworkConfig } from '../../lib/symbol/network';
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { withFormReset } from '../../lib/withFormReset';
import LinkNamespace from './DaoNamespace';
import LinkedNamespaceWarning from './DaoNamespaceWarning';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';
import { DaoAction, LoadingBox, parseAmount, shortAddress, useDao } from './daoUi';

type Mode = { type: 'list' } | { type: 'create' } | { type: 'send'; mosaic: DaoMosaic } | { type: 'revoke'; mosaic: DaoMosaic } | { type: 'govSend'; gov: GovToken } | { type: 'govRevoke'; gov: GovToken } | { type: 'ns'; mosaicId: string; label: string; current: string };
type GovToken = { id: string; supply: bigint; held: bigint; namespace: string };

// 「特典管理」「ポイント管理」（管理者）: DAO が発行したモザイクの一覧・新規作成・配布、ポイントは回収も。
// DAO アカウントが署名者になるので、管理者が 1 人なら 1 回の署名で完了し、複数なら他の管理者の連署を待つ。
export default function DaoMosaics({ kind }: { kind: DaoMosaicKind }) {
  const { t } = useTranslation();
  const { isAdmin, signer, mosaics } = useDao();
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const list = mosaics.filter((m) => m.kind === kind);

  if (!isAdmin) return <Alert severity="warning">{t('dao.admin_only')}</Alert>;
  if (!signer) return <Alert severity="error">{t('dao.err_invalid_signer')}</Alert>;

  if (mode.type === 'create') return <Create kind={kind} onBack={() => setMode({ type: 'list' })} />;
  if (mode.type === 'send') return <Distribute kind={kind} mosaic={mode.mosaic} revoke={false} onBack={() => setMode({ type: 'list' })} />;
  if (mode.type === 'revoke') return <Distribute kind={kind} mosaic={mode.mosaic} revoke onBack={() => setMode({ type: 'list' })} />;
  if (mode.type === 'ns') return <LinkNamespace mosaicId={mode.mosaicId} label={mode.label} current={mode.current} onBack={() => setMode({ type: 'list' })} />;
  if (mode.type === 'govSend') return <GovernanceSend gov={mode.gov} onBack={() => setMode({ type: 'list' })} />;
  if (mode.type === 'govRevoke') return <Distribute kind={kind} mosaic={govAsMosaic(mode.gov, t('dao.governance_token'))} revoke onBack={() => setMode({ type: 'list' })} />;

  return (
    <>
    {kind === 'point' && <GovernanceCard onSend={(gov) => setMode({ type: 'govSend', gov })} onRevoke={(gov) => setMode({ type: 'govRevoke', gov })} onLink={(gov) => setMode({ type: 'ns', mosaicId: gov.id, label: t('dao.governance_token'), current: gov.namespace })} />}
    <SectionCard title={t(`dao.${kind}_list`)}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t(`dao.${kind}_lead`)}</Typography>
      {list.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t(`dao.${kind}_none`)}</Typography>}
      {list.map((m) => (
        <Box key={m.id} sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{m.name}</Typography>
              {m.namespace && <Typography variant="body2" sx={{ ...mono, color: 'primary.main' }}>{m.namespace}</Typography>}
              <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{m.id}</Typography>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="body2">{t('dao.supply')}: {m.supply.toString()}</Typography>
              <Typography variant="body2">{t('dao.held_by_dao')}: {m.held.toString()}</Typography>
              {m.exchange && <Chip size="small" color="primary" variant="outlined" label={t('dao.exchangeable')} />}
            </Box>
          </Box>
          <LinkedNamespaceWarning linked={m.namespace} />
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={() => setMode({ type: 'send', mosaic: m })}>{t('dao.action_send')}</Button>
            {kind === 'point' && <Button size="small" variant="outlined" onClick={() => setMode({ type: 'revoke', mosaic: m })}>{t('dao.action_revoke')}</Button>}
            <Button size="small" variant="outlined" onClick={() => setMode({ type: 'ns', mosaicId: m.id, label: m.name, current: m.namespace })}>{t('dao.ns_link')}</Button>
          </Box>
        </Box>
      ))}
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" onClick={() => setMode({ type: 'create' })}>{t(`dao.${kind}_create`)}</Button>
      </Box>
    </SectionCard>
    </>
  );
}

// Distribute / 確認画面で DaoMosaic として扱うための見かけ（ガバナンストークンはメタデータの印が無いので自前で作る）。
const govAsMosaic = (gov: GovToken, name: string): DaoMosaic => ({ id: gov.id, name, kind: 'point', supply: gov.supply, held: gov.held, namespace: gov.namespace, exchange: null });

// ポイントと取り違えないよう、色の違う枠・「ガバナンス」の印・説明を付けて、ポイント一覧とは別に出す。
function GovernanceCard({ onSend, onRevoke, onLink }: { onSend: (gov: GovToken) => void; onRevoke: (gov: GovToken) => void; onLink: (gov: GovToken) => void }) {
  const { t } = useTranslation();
  const { dao } = useDao();
  const [gov, setGov] = useState<GovToken | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchGovernanceToken(dao).then((g) => { if (!cancelled) setGov(g); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [dao]);
  return (
    <SectionCard title={t('dao.gov_title')} sx={{ borderColor: 'secondary.main', borderWidth: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Chip size="small" color="secondary" label={t('dao.kind_governance')} />
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.gov_lead')}</Typography>
      </Box>
      {failed && <Alert severity="error">{t('dao.err_load_failed')}</Alert>}
      {!failed && !gov && <LoadingBox />}
      {gov && (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 0 }}>
              {gov.namespace && <Typography sx={{ ...mono, fontWeight: 'bold', color: 'primary.main' }}>{gov.namespace}</Typography>}
              <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{gov.id}</Typography>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="body2">{t('dao.supply')}: {gov.supply.toString()}</Typography>
              <Typography variant="body2">{t('dao.held_by_dao')}: {gov.held.toString()}</Typography>
            </Box>
          </Box>
          <LinkedNamespaceWarning linked={gov.namespace} />
          <Alert severity="info" sx={{ mt: 1.5 }}>{t('dao.gov_note')}</Alert>
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" color="secondary" onClick={() => onSend(gov)}>{t('dao.gov_send')}</Button>
            <Button size="small" variant="outlined" color="secondary" onClick={() => onRevoke(gov)}>{t('dao.gov_revoke')}</Button>
            <Button size="small" variant="outlined" color="secondary" onClick={() => onLink(gov)}>{t('dao.ns_link')}</Button>
          </Box>
        </>
      )}
    </SectionCard>
  );
}

/** 確認画面に出す宛先の数（多いときは先頭だけ出して「ほか N 件」と添える。確認画面が縦に長くなりすぎないように）。 */
const ADDRESS_ROWS_SHOWN = 20;
const addressList = (addresses: string[], more: string): string =>
  (addresses.length <= ADDRESS_ROWS_SHOWN ? addresses : [...addresses.slice(0, ADDRESS_ROWS_SHOWN), more]).join('\n');

// ガバナンストークンを新しい会員へ送る。会員はまだ 0 人かもしれないので、宛先は一覧から選ばずアドレスを入力する。
const GovernanceSend = withFormReset<{ gov: GovToken; onBack: () => void }>(function GovernanceSend({ gov, onBack, onSent }: { gov: GovToken; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const [addressText, setAddressText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const amount = parseAmount(amountText);
  const networkByte = getNetworkConfig().networkByte;
  const entries = addressText.split(/[\s,;、]+/).map((a) => a.trim()).filter(Boolean);
  const addresses = Array.from(new Set(entries.map(normalizeAddress)));
  const badOnes = entries.filter((a) => !isValidAddress(a, networkByte));
  const tooMany = addresses.length > MAX_DAO_ITEMS;
  const shortStock = amount !== null && amount * BigInt(addresses.length) > gov.held;
  const msgOk = byteLength(message) <= 1000;
  const valid = addresses.length > 0 && badOnes.length === 0 && !tooMany && amount !== null && !shortStock && msgOk;
  return (
    <SectionCard title={`${t('dao.governance_token')} — ${t('dao.gov_send')}`}>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!valid}
        prepare={async () => {
          const plans = planSendMosaicBatches(actor, dao, signer!, gov.id, addresses, amount!, message);
          return {
            plans,
            unit: MAX_DAO_INNER,
            execute: (privateKey, keyless, onProgress) => submitDaoBatches(privateKey, plans.map((p) => p.input), keyless, onProgress),
            rows: [
              { label: t('dao.row_mosaic'), value: `${t('dao.governance_token')}\n${gov.id}`, big: true },
              { label: t('dao.row_send_to', { count: addresses.length }), value: addressList(addresses, t('dao.row_more', { count: addresses.length - ADDRESS_ROWS_SHOWN })) },
              { label: t('dao.row_amount_each'), value: amount!.toString() },
              ...(message ? [{ label: t('dao.row_message'), value: message }] : []),
            ],
          };
        }}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        <Alert severity="info" sx={{ mb: 1 }}>{t('dao.gov_send_note')}</Alert>
        <FormRow label={t('dao.gov_f_addresses')} hint={t('dao.gov_hint_addresses', { max: MAX_DAO_ITEMS, per: MAX_DAO_INNER })} top>
          <Field ariaLabel={t('dao.gov_f_addresses')} multiline minRows={3} value={addressText} onChange={(e) => setAddressText(e.target.value)} error={badOnes.length > 0 || tooMany} helperText={`${addresses.length}`} htmlInput={{ style: { fontFamily: 'monospace' } }} />
        </FormRow>
        <FormRow label={t('dao.f_amount_each')} hint={t('dao.hint_stock', { held: gov.held.toString() })}>
          <Field ariaLabel={t('dao.f_amount_each')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={(amountText !== '' && amount === null) || shortStock} htmlInput={{ inputMode: 'numeric' }} />
        </FormRow>
        <FormRow label={t('dao.f_message')}>
          <Field ariaLabel={t('dao.f_message')} value={message} onChange={(e) => setMessage(e.target.value)} error={!msgOk} helperText={`${byteLength(message)} / ${DESCRIPTION_MAX_BYTES * 5} bytes`} />
        </FormRow>
        {badOnes.length > 0 && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.gov_err_address', { address: badOnes[0] })}</Alert>}
        {shortStock && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_stock')}</Alert>}
        {tooMany && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_too_many_items')}</Alert>}
      </DaoAction>
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});

const Create = withFormReset<{ kind: DaoMosaicKind; onBack: () => void }>(function Create({ kind, onBack, onSent }: { kind: DaoMosaicKind; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const [name, setName] = useState('');
  const [amountText, setAmountText] = useState('');
  const amount = parseAmount(amountText);
  const nameOk = name.trim() !== '' && byteLength(name.trim()) <= MOSAIC_NAME_MAX_BYTES;
  return (
    <SectionCard title={t(`dao.${kind}_create`)}>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!nameOk || amount === null}
        prepare={async () => {
          const plan = await planCreateMosaic(actor, dao, signer!, kind, name.trim(), amount!);
          return {
            plans: [plan],
            rows: [
              { label: t(`dao.${kind}_name`), value: name.trim(), big: true },
              { label: t('dao.supply'), value: amount!.toString() },
              { label: t('dao.row_mosaic_id'), value: plan.mosaicId },
              { label: t('dao.row_flags'), value: t(`dao.flags_${kind}`) },
            ],
          };
        }}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        <FormRow label={t(`dao.${kind}_name`)}><Field ariaLabel={t(`dao.${kind}_name`)} value={name} onChange={(e) => setName(e.target.value)} helperText={`${byteLength(name.trim())} / ${MOSAIC_NAME_MAX_BYTES} bytes`} error={name !== '' && !nameOk} /></FormRow>
        <FormRow label={t('dao.f_supply')} hint={t('dao.hint_supply')}><Field ariaLabel={t('dao.f_supply')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={amountText !== '' && amount === null} htmlInput={{ inputMode: 'numeric' }} /></FormRow>
        <Alert severity="info" sx={{ mt: 1.5 }}>{t(`dao.${kind}_create_note`)}</Alert>
      </DaoAction>
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});

// 会員（ガバナンストークンの保有者）を選んで、同じ量を配る / 回収する。
const Distribute = withFormReset<{ kind: DaoMosaicKind; mosaic: DaoMosaic; revoke: boolean; onBack: () => void }>(function Distribute({ mosaic, revoke, onBack, onSent }: { kind: DaoMosaicKind; mosaic: DaoMosaic; revoke: boolean; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const [members, setMembers] = useState<Holder[] | null>(null);
  const [held, setHeld] = useState<Map<string, bigint>>(new Map());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const amount = parseAmount(amountText);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMembers(dao), fetchHolders(mosaic.id, dao.address)])
      .then(([m, h]) => { if (!cancelled) { setMembers(m); setHeld(new Map(h.map((x) => [x.address, x.amount]))); } })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [dao, mosaic.id]);

  const rows = useMemo(() => (members ?? []).filter((m) => !revoke || (held.get(m.address) ?? 0n) > 0n), [members, held, revoke]);
  const chosen = rows.filter((r) => picked.has(r.address)).map((r) => r.address);
  const tooMany = chosen.length > MAX_DAO_ITEMS;
  const shortStock = !revoke && amount !== null && amount * BigInt(chosen.length) > mosaic.held;
  const overRevoke = revoke && amount !== null && chosen.some((a) => (held.get(a) ?? 0n) < amount);
  const msgOk = byteLength(message) <= 1000;
  const valid = chosen.length > 0 && !tooMany && amount !== null && !shortStock && !overRevoke && msgOk;
  const toggle = (a: string) => setPicked((s) => { const n = new Set(s); if (n.has(a)) n.delete(a); else n.add(a); return n; });

  return (
    <SectionCard title={`${mosaic.name} — ${t(revoke ? 'dao.action_revoke' : 'dao.action_send')}`}>
      {members === null ? <LoadingBox /> : (
        <DaoAction
          label={t('multisig.go_confirm')}
          disabled={!valid}
          prepare={async () => {
            const plans = revoke ? planRevokeBatches(actor, dao, signer!, mosaic.id, chosen, amount!) : planSendMosaicBatches(actor, dao, signer!, mosaic.id, chosen, amount!, message);
            return {
              plans,
              unit: MAX_DAO_INNER,
              execute: (privateKey, keyless, onProgress) => submitDaoBatches(privateKey, plans.map((p) => p.input), keyless, onProgress),
              rows: [
                { label: t('dao.row_mosaic'), value: `${mosaic.name}\n${mosaic.id}`, big: true },
                { label: t(revoke ? 'dao.row_revoke_from' : 'dao.row_send_to', { count: chosen.length }), value: addressList(chosen, t('dao.row_more', { count: chosen.length - ADDRESS_ROWS_SHOWN })) },
                { label: t('dao.row_amount_each'), value: amount!.toString() },
                ...(!revoke && message ? [{ label: t('dao.row_message'), value: message }] : []),
              ],
            };
          }}
          onSent={() => { reload(); onSent(); onBack(); }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Checkbox checked={rows.length > 0 && chosen.length === rows.length} indeterminate={chosen.length > 0 && chosen.length < rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.address)) : new Set())} />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.members_count', { count: rows.length })}</Typography>
          </Box>
          {rows.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t(revoke ? 'dao.revoke_none' : 'dao.members_none')}</Typography>}
          <Box sx={{ maxHeight: 280, overflowY: 'auto', mb: 1.5 }}>
            {rows.map((r) => (
              <Box key={r.address} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
                <Checkbox checked={picked.has(r.address)} onChange={() => toggle(r.address)} />
                <Typography variant="body2" sx={{ ...mono, flexGrow: 1 }} title={r.address}>{shortAddress(r.address)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.col_governance')} {r.amount.toString()}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 70, textAlign: 'right' }}>{mosaic.name} {(held.get(r.address) ?? 0n).toString()}</Typography>
              </Box>
            ))}
          </Box>
          <FormRow label={t('dao.f_amount_each')} hint={revoke ? undefined : t('dao.hint_stock', { held: mosaic.held.toString() })}>
            <Field ariaLabel={t('dao.f_amount_each')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={(amountText !== '' && amount === null) || shortStock || overRevoke} htmlInput={{ inputMode: 'numeric' }} />
          </FormRow>
          {!revoke && (
            <FormRow label={t('dao.f_message')}>
              <Field ariaLabel={t('dao.f_message')} value={message} onChange={(e) => setMessage(e.target.value)} error={!msgOk} helperText={`${byteLength(message)} / ${DESCRIPTION_MAX_BYTES * 5} bytes`} />
            </FormRow>
          )}
          {shortStock && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_stock')}</Alert>}
          {overRevoke && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_revoke_over')}</Alert>}
          {tooMany && <Alert severity="error" sx={{ mt: 1 }}>{t('dao.err_too_many_items')}</Alert>}
        </DaoAction>
      )}
      <Box sx={{ mt: 1 }}><Button onClick={onBack}>{t('common.back')}</Button></Box>
    </SectionCard>
  );
});
