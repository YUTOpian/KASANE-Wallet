import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planSendMosaicBatches } from '../../lib/dao/daoActions';
import { MAX_DAO_ITEMS, submitDaoBatches } from '../../lib/dao/daoBatch';
import { fetchHeld } from '../../lib/dao/daoApi';
import { DESCRIPTION_MAX_BYTES, byteLength } from '../../lib/dao/daoCore';
import { MAX_DAO_INNER } from '../../lib/dao/daoTx';
import { getMosaicInfos } from '../../lib/symbol/api';
import type { MosaicInfo } from '../../lib/symbol/api';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { getNetworkConfig } from '../../lib/symbol/network';
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, mono } from '../multisig/parts';
import { DaoAction, LoadingBox, useDao } from './daoUi';

/** DAO アカウントが持っているモザイク 1 種類ぶん。 */
interface Holding {
  id: string;
  amount: bigint;
  divisibility: number;
  /** 表示名（XYM・ガバナンストークン・ポイント/特典の名前・ネームスペース名。無ければモザイク ID）。 */
  label: string;
  /** 名前の由来（印を付けるため）。 */
  kind: 'currency' | 'governance' | 'point' | 'reward' | 'other';
  transferable: boolean;
  /** DAO が作ったモザイク（譲渡不可でも、作成者の DAO からは送れる）。 */
  own: boolean;
}

/** 確認画面に出す宛先の数（多いときは先頭だけ出して「ほか N 件」と添える）。 */
const ADDRESS_ROWS_SHOWN = 20;
const addressList = (addresses: string[], more: string): string =>
  (addresses.length <= ADDRESS_ROWS_SHOWN ? addresses : [...addresses.slice(0, ADDRESS_ROWS_SHOWN), more]).join('\n');

// 「DAOウォレット」（管理者と、多段マルチシグの連署者）: DAO アカウントが持っているモザイクを全部並べて、好きなアドレスへ送る。
// これまでの「ポイント管理」「特典管理」は DAO が発行したものだけだった。ここは XYM や他で発行されたモザイクも含む。
// 署名者は DAO（管理者が 1 人なら 1 回の署名で完了、複数なら他の管理者の連署待ち）。
export default function DaoWallet() {
  const { t } = useTranslation();
  const { dao, canSign, signer, mosaics } = useDao();
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState<Holding | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHoldings(null);
    setFailed(false);
    (async () => {
      try {
        const held = await fetchHeld(dao.address);
        const ids = [...held.keys()];
        const infos: Record<string, MosaicInfo> = ids.length > 0 ? await getMosaicInfos(ids) : {};
        const currencyId = getNetworkConfig().currencyMosaicId.toUpperCase();
        const rows: Holding[] = ids.filter((id) => (held.get(id) ?? 0n) > 0n).map((id) => {
          const info = infos[id];
          const daoMosaic = mosaics.find((m) => m.id === id);
          const kind: Holding['kind'] = id === currencyId ? 'currency' : id === dao.governanceTokenId ? 'governance' : daoMosaic ? daoMosaic.kind : 'other';
          const label = kind === 'governance' ? t('dao.governance_token') : daoMosaic?.name ?? info?.name ?? (id === currencyId ? info?.symbol ?? 'XYM' : id);
          return {
            id,
            amount: held.get(id) ?? 0n,
            divisibility: info?.divisibility ?? 0,
            label,
            kind,
            transferable: info?.transferable ?? true,
            own: kind === 'governance' || kind === 'point' || kind === 'reward',
          };
        });
        const order = { currency: 0, governance: 1, point: 2, reward: 3, other: 4 } as const;
        rows.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
        if (!cancelled) setHoldings(rows);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [dao, mosaics, t]);

  if (!canSign) return <Alert severity="warning">{t('dao.admin_only')}</Alert>;
  if (!signer) return <Alert severity="error">{t('dao.err_invalid_signer')}</Alert>;

  if (sending) return <WalletSend holding={sending} onBack={() => setSending(null)} />;

  return (
    <SectionCard title={t('dao.wallet_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('dao.wallet_lead')}</Typography>
      {failed && <Alert severity="error">{t('dao.err_load_failed')}</Alert>}
      {!failed && holdings === null && <LoadingBox />}
      {holdings !== null && holdings.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('dao.wallet_none')}</Typography>}
      {holdings !== null && holdings.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 }}>
          {holdings.map((h) => (
            <Box key={h.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{h.label}</Typography>
                {h.kind !== 'other' && <Chip size="small" variant="outlined" color={h.kind === 'governance' ? 'secondary' : 'primary'} label={t(`dao.wallet_kind_${h.kind}`)} />}
              </Box>
              <Typography variant="caption" sx={{ ...mono, color: 'text.secondary', wordBreak: 'break-all' }}>{h.id}</Typography>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{t('dao.wallet_balance')}</Typography>
                <Typography sx={{ fontSize: '1.5rem', fontWeight: 'bold', lineHeight: 1.2, wordBreak: 'break-all' }}>{formatAtomic(h.amount, h.divisibility)}</Typography>
              </Box>
              <Button variant="outlined" fullWidth onClick={() => setSending(h)}>{t('dao.action_send')}</Button>
            </Box>
          ))}
        </Box>
      )}
    </SectionCard>
  );
}

// 選んだモザイクを、DAO の名義で 1 件以上のアドレスへ同じ量ずつ送る（100 件ずつに分けて、最大 1000 件）。
const WalletSend = withFormReset<{ holding: Holding; onBack: () => void }>(function WalletSend({ holding, onBack, onSent }: { holding: Holding; onBack: () => void } & SentProps) {
  const { t } = useTranslation();
  const { dao, actor, signer, reload } = useDao();
  const [addressText, setAddressText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const networkByte = getNetworkConfig().networkByte;
  const parsed = parseDecimal(amountText, holding.divisibility);
  const amount = parsed !== null && parsed > 0n ? parsed : null;
  const entries = addressText.split(/[\s,;、]+/).map((a) => a.trim()).filter(Boolean);
  const badOnes = entries.filter((a) => !isValidAddress(a, networkByte));
  const addresses = badOnes.length === 0 ? Array.from(new Set(entries.map(normalizeAddress))) : [];
  const tooMany = addresses.length > MAX_DAO_ITEMS;
  const shortStock = amount !== null && amount * BigInt(Math.max(addresses.length, 1)) > holding.amount;
  const msgOk = byteLength(message) <= 1000;
  const valid = addresses.length > 0 && badOnes.length === 0 && !tooMany && amount !== null && !shortStock && msgOk;
  const held = formatAtomic(holding.amount, holding.divisibility);
  const currencyId = getNetworkConfig().currencyMosaicId.toUpperCase();

  return (
    <SectionCard title={`${holding.label} — ${t('dao.action_send')}`}>
      <DaoAction
        label={t('multisig.go_confirm')}
        disabled={!valid}
        prepare={async () => {
          const plans = planSendMosaicBatches(actor, dao, signer!, holding.id, addresses, amount!, message);
          return {
            plans,
            unit: MAX_DAO_INNER,
            execute: (privateKey, keyless, onProgress) => submitDaoBatches(privateKey, plans.map((p) => p.input), keyless, onProgress),
            rows: [
              { label: t('dao.row_mosaic'), value: `${holding.label}\n${holding.id}`, big: true },
              { label: t('dao.wallet_row_send_to', { count: addresses.length }), value: addressList(addresses, t('dao.row_more', { count: addresses.length - ADDRESS_ROWS_SHOWN })) },
              { label: t('dao.wallet_row_amount'), value: formatAtomic(amount!, holding.divisibility) },
              ...(addresses.length > 1 ? [{ label: t('dao.wallet_row_total'), value: formatAtomic(amount! * BigInt(addresses.length), holding.divisibility) }] : []),
              ...(message ? [{ label: t('dao.row_message'), value: message }] : []),
            ],
          };
        }}
        onSent={() => { reload(); onSent(); onBack(); }}
      >
        <Alert severity="info" sx={{ mb: 1 }}>{t('dao.wallet_send_note')}</Alert>
        {holding.id === currencyId && <Alert severity="warning" sx={{ mb: 1 }}>{t('dao.wallet_xym_note')}</Alert>}
        {!holding.transferable && !holding.own && <Alert severity="warning" sx={{ mb: 1 }}>{t('dao.wallet_nontransferable')}</Alert>}
        <FormRow label={t('dao.wallet_f_addresses')} hint={t('dao.gov_hint_addresses', { max: MAX_DAO_ITEMS, per: MAX_DAO_INNER })} top>
          <Field ariaLabel={t('dao.wallet_f_addresses')} multiline minRows={3} value={addressText} onChange={(e) => setAddressText(e.target.value)} error={badOnes.length > 0 || tooMany} helperText={`${addresses.length}`} htmlInput={{ style: { fontFamily: 'monospace' } }} />
        </FormRow>
        <FormRow label={t('dao.wallet_f_amount')} hint={t('dao.wallet_hint_amount', { held, div: holding.divisibility })}>
          <Field ariaLabel={t('dao.wallet_f_amount')} value={amountText} onChange={(e) => setAmountText(e.target.value)} error={(amountText !== '' && amount === null) || shortStock} htmlInput={{ inputMode: 'decimal' }} />
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
