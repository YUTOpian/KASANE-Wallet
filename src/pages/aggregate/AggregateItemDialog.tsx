import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Switch, TextField, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { fetchBalances } from '../../lib/symbol/api';
import type { MosaicBalance, OwnedMosaic, OwnedNamespace } from '../../lib/symbol/api';
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import {
  aggregateMosaicId, aggregateNamespaceId, namespaceFullName, validateItem,
} from '../../lib/symbol/aggregate';
import type { AggregateItem, AggregateItemKind, AggregateSigner } from '../../lib/symbol/aggregate';
import { resolveSignerByKey } from '../../lib/symbol/aggregateApi';
import {
  BLOCKS_PER_DAY, MAX_MESSAGE_BYTES, MAX_MOSAIC_DIVISIBILITY, MAX_MOSAIC_SUPPLY, MAX_NAMESPACE_DAYS, MAX_NAMESPACE_DEPTH,
  MAX_NAMESPACE_NAME_LENGTH, MIN_NAMESPACE_DAYS, MOSAIC_FLAG_SUPPLY_MUTABLE, MOSAIC_FLAG_TRANSFERABLE, isValidNamespaceName,
  messageByteLength, newMosaicNonce,
} from '../../lib/symbol/tx';
import { getNetworkConfig } from '../../lib/symbol/network';
import { MOSAIC_FLAG_LABELS } from '../mosaic/mosaicFlags';

const MAX_MOSAIC_DAYS = 3650;

// What the dialogs need to know about the wallet and the draft.
export interface AggregateContext {
  address: string;
  items: AggregateItem[]; // already in the draft (mosaics / namespaces they create can be used by later items)
  balances: MosaicBalance[];
  ownedMosaics: OwnedMosaic[];
  ownedNamespaces: OwnedNamespace[];
  signers: AggregateSigner[]; // multisig accounts the wallet cosigns for (candidates for the sender of a transfer)
}

interface Props {
  kind: AggregateItemKind | null; // null = closed
  ctx: AggregateContext;
  onClose: () => void;
  onAdd: (items: AggregateItem[]) => void;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Keep only what a decimal amount can contain: digits and a single '.', limited to `decimals` places.
function sanitizeAmount(raw: string, decimals: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = s.split('.');
  if (frac !== undefined) s = decimals > 0 ? `${whole}.${frac.slice(0, decimals)}` : whole;
  return s;
}

interface MosaicOption { id: string; symbol: string; divisibility: number; balance?: bigint; local: boolean }

// 一つのダイアログで4種類のトランザクション（送金・モザイク定義・供給量変更・ネームスペース）を追加する。
export default function AggregateItemDialog({ kind, ctx, onClose, onAdd }: Props) {
  const { t } = useTranslation();
  const networkByte = getNetworkConfig().networkByte;
  const open = kind !== null;

  // Mosaics created earlier in this draft (their ids are known already, so later items can use them).
  const draftMosaics: MosaicOption[] = useMemo(() => ctx.items.flatMap((i) => (i.kind === 'mosaic_definition'
    ? [{ id: aggregateMosaicId(ctx.address, i.nonce), symbol: aggregateMosaicId(ctx.address, i.nonce), divisibility: i.divisibility, local: true }]
    : [])), [ctx.items, ctx.address]);
  const draftDefs = useMemo(() => new Map(ctx.items.flatMap((i) => (i.kind === 'mosaic_definition' ? [[aggregateMosaicId(ctx.address, i.nonce), i] as const] : []))), [ctx.items, ctx.address]);

  // ---- shared state, reset each time the dialog opens ----
  const [recipient, setRecipient] = useState('');
  const [assetId, setAssetId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const [divisibility, setDivisibility] = useState(0);
  const [flags, setFlags] = useState(MOSAIC_FLAG_TRANSFERABLE);
  const [unlimited, setUnlimited] = useState(true);
  const [daysText, setDaysText] = useState('');
  const [initialSupply, setInitialSupply] = useState('');
  const [action, setAction] = useState<'increase' | 'decrease'>('increase');
  const [nsType, setNsType] = useState<'root' | 'child'>('root');
  const [nsName, setNsName] = useState('');
  const [nsDays, setNsDays] = useState('365');
  const [parentId, setParentId] = useState('');
  // Sender of a transfer: the wallet itself ('self'), one of the multisig accounts it cosigns for (its address) or an
  // account given by public key ('custom'). Any sender other than the wallet needs that account's signature.
  const [senderChoice, setSenderChoice] = useState('self');
  const [customKey, setCustomKey] = useState('');
  const [customSigner, setCustomSigner] = useState<AggregateSigner | null | 'loading'>(null);
  const [senderBalances, setSenderBalances] = useState<MosaicBalance[] | 'loading'>([]);

  useEffect(() => {
    if (!open) return;
    setRecipient(''); setAssetId(''); setAmountText(''); setMessage(''); setDivisibility(0); setFlags(MOSAIC_FLAG_TRANSFERABLE);
    setUnlimited(true); setDaysText(''); setInitialSupply(''); setAction('increase'); setNsType('root'); setNsName(''); setNsDays('365'); setParentId('');
    setSenderChoice('self'); setCustomKey(''); setCustomSigner(null);
  }, [open, kind]);

  // ---- sender of a transfer ----
  useEffect(() => {
    if (senderChoice !== 'custom') { setCustomSigner(null); return undefined; }
    if (!/^[0-9a-fA-F]{64}$/.test(customKey.trim())) { setCustomSigner(null); return undefined; }
    let cancelled = false;
    setCustomSigner('loading');
    resolveSignerByKey(ctx.address, customKey)
      .then((signer) => { if (!cancelled) setCustomSigner(signer); })
      .catch(() => { if (!cancelled) setCustomSigner(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderChoice, customKey]);
  const signer: AggregateSigner | undefined = senderChoice === 'self' ? undefined
    : senderChoice === 'custom' ? (customSigner === 'loading' ? undefined : customSigner ?? undefined)
      : ctx.signers.find((x) => x.address === senderChoice);
  const senderPending = kind === 'transfer' && (senderChoice === 'custom' ? signer === undefined : false);

  // What the chosen sender holds (the wallet's own balances are already in ctx).
  useEffect(() => {
    if (!signer) { setSenderBalances([]); return undefined; }
    let cancelled = false;
    setSenderBalances('loading');
    fetchBalances(signer.address)
      .then((b) => { if (!cancelled) setSenderBalances(b); })
      .catch(() => { if (!cancelled) setSenderBalances([]); });
    return () => { cancelled = true; };
  }, [signer?.address]);

  // ---- transfer ----
  const transferAssets: MosaicOption[] = useMemo(() => [
    ...(signer ? (senderBalances === 'loading' ? [] : senderBalances) : ctx.balances).filter((b) => b.amount > 0n && b.transferable !== false)
      .map((b) => ({ id: b.id, symbol: b.symbol, divisibility: b.divisibility, balance: b.amount, local: false })),
    // Mosaics created in this aggregate belong to the wallet, so only the wallet can send them.
    ...(signer ? [] : draftMosaics.filter((m) => ((draftDefs.get(m.id)?.flags ?? 0) & MOSAIC_FLAG_TRANSFERABLE) !== 0)),
  ], [ctx.balances, senderBalances, signer, draftMosaics, draftDefs]);

  // ---- supply change ----
  const supplyTargets: MosaicOption[] = useMemo(() => [
    ...ctx.ownedMosaics.filter((m) => (m.flags & MOSAIC_FLAG_SUPPLY_MUTABLE) !== 0)
      .map((m) => ({ id: m.id, symbol: m.symbol, divisibility: m.divisibility, local: false })),
    ...draftMosaics.filter((m) => ((draftDefs.get(m.id)?.flags ?? 0) & MOSAIC_FLAG_SUPPLY_MUTABLE) !== 0),
  ], [ctx.ownedMosaics, draftMosaics, draftDefs]);

  const options = kind === 'transfer' ? transferAssets : supplyTargets;
  const selected = options.find((o) => o.id === assetId) ?? options[0];
  const selectedDiv = selected?.divisibility ?? 0;

  // ---- namespace parents ----
  const parents = useMemo(() => {
    const owned = ctx.ownedNamespaces.filter((n) => n.depth < MAX_NAMESPACE_DEPTH && !n.expired).map((n) => ({ id: n.id, name: n.name }));
    const inDraft = ctx.items.flatMap((i) => {
      if (i.kind !== 'namespace') return [];
      const full = namespaceFullName(i);
      return full.split('.').length < MAX_NAMESPACE_DEPTH ? [{ id: aggregateNamespaceId(i.name, i.parent?.id), name: full }] : [];
    });
    return [...owned, ...inDraft];
  }, [ctx.ownedNamespaces, ctx.items]);
  const parent = parents.find((p) => p.id === parentId) ?? parents[0];

  const xym = (v: bigint, d: number) => formatAtomic(v, d);

  // Builds the item(s) for the current inputs, or the reason why it cannot be built yet ('' = just incomplete).
  const built = (() => {
    if (kind === 'transfer') {
      const to = normalizeAddress(recipient);
      if (!isValidAddress(to, networkByte)) return { error: recipient === '' ? '' : t('common.invalid_address') };
      if (senderPending) return { error: customKey.trim() === '' ? '' : t('aggregate.sender_invalid') };
      if (!selected) return { error: '' };
      const amount = amountText === '' ? 0n : parseDecimal(amountText, selectedDiv);
      if (amount === null) return { error: t('aggregate.invalid_amount') };
      if (selected.balance !== undefined && amount > selected.balance) return { error: t('aggregate.amount_exceeds', { balance: xym(selected.balance, selectedDiv) }) };
      if (messageByteLength(message) > MAX_MESSAGE_BYTES) return { error: t('aggregate.item_message_too_long') };
      const item: AggregateItem = { uid: uid(), kind: 'transfer', signer, recipient: to, mosaicId: selected.id, mosaicSymbol: selected.symbol, divisibility: selectedDiv, amount, message };
      const why = validateItem(item);
      return why ? { error: amountText === '' && message === '' ? '' : t(`aggregate.${why}`) } : { items: [item] };
    }
    if (kind === 'mosaic_definition') {
      const days = /^\d+$/.test(daysText) ? Number(daysText) : NaN;
      if (!unlimited && !(days >= 1 && days <= MAX_MOSAIC_DAYS)) return { error: daysText === '' ? '' : t('mosaic.invalid_days') };
      const supply = initialSupply === '' ? null : parseDecimal(initialSupply, divisibility);
      if (initialSupply !== '' && (supply === null || supply <= 0n || supply > MAX_MOSAIC_SUPPLY)) return { error: t('mosaic.invalid_supply') };
      const def: AggregateItem = { uid: uid(), kind: 'mosaic_definition', nonce: newMosaicNonce(), divisibility, flags, durationBlocks: unlimited ? 0n : BigInt(days) * BigInt(BLOCKS_PER_DAY) };
      const list: AggregateItem[] = [def];
      if (supply !== null) {
        const id = aggregateMosaicId(ctx.address, def.nonce);
        list.push({ uid: uid(), kind: 'mosaic_supply', mosaicId: id, mosaicSymbol: id, divisibility, action: 'increase', delta: supply });
      }
      return { items: list };
    }
    if (kind === 'mosaic_supply') {
      if (!selected) return { error: '' };
      const delta = amountText === '' ? null : parseDecimal(amountText, selectedDiv);
      if (amountText === '') return { error: '' };
      if (delta === null || delta <= 0n || delta > MAX_MOSAIC_SUPPLY) return { error: t('aggregate.invalid_amount') };
      return { items: [{ uid: uid(), kind: 'mosaic_supply', mosaicId: selected.id, mosaicSymbol: selected.symbol, divisibility: selectedDiv, action, delta } as AggregateItem] };
    }
    if (kind === 'namespace') {
      if (!isValidNamespaceName(nsName)) return { error: nsName === '' ? '' : t('namespace.invalid_name') };
      if (nsType === 'child') {
        if (!parent) return { error: '' };
        return { items: [{ uid: uid(), kind: 'namespace', name: nsName, parent, durationBlocks: 0n } as AggregateItem] };
      }
      const days = /^\d+$/.test(nsDays) ? Number(nsDays) : NaN;
      if (!(days >= MIN_NAMESPACE_DAYS && days <= MAX_NAMESPACE_DAYS)) return { error: t('namespace.invalid_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS }) };
      return { items: [{ uid: uid(), kind: 'namespace', name: nsName, durationBlocks: BigInt(days) * BigInt(BLOCKS_PER_DAY) } as AggregateItem] };
    }
    return { error: '' };
  })();

  const title = kind ? t(`aggregate.add_${kind}`) : '';
  const noTarget = (kind === 'transfer' || kind === 'mosaic_supply') && options.length === 0;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        {kind === 'transfer' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField select label={t('aggregate.sender')} value={senderChoice} onChange={(e) => { setSenderChoice(e.target.value); setAssetId(''); setAmountText(''); }} fullWidth
              helperText={senderChoice === 'self' ? undefined : t('aggregate.sender_cosign_hint')}>
              <MenuItem value="self">{t('aggregate.sender_self')}</MenuItem>
              {ctx.signers.map((x) => (
                <MenuItem key={x.address} value={x.address} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>
                  {t('aggregate.sender_multisig')} {x.address}
                </MenuItem>
              ))}
              <MenuItem value="custom">{t('aggregate.sender_custom')}</MenuItem>
            </TextField>
            {senderChoice === 'custom' && (
              <TextField label={t('aggregate.sender_public_key')} value={customKey} onChange={(e) => setCustomKey(e.target.value.trim())} fullWidth
                error={customKey !== '' && customSigner === null} helperText={customSigner === 'loading' ? t('aggregate.cost_loading') : customSigner ? customSigner.address : t('aggregate.sender_public_key_hint')}
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace' }, autoCapitalize: 'characters', spellCheck: false } }} />
            )}
            <TextField label={t('common.destination')} value={recipient} onChange={(e) => setRecipient(e.target.value)} fullWidth
              error={recipient !== '' && !isValidAddress(normalizeAddress(recipient), networkByte)}
              helperText={recipient !== '' && !isValidAddress(normalizeAddress(recipient), networkByte) ? t('common.invalid_address') : undefined}
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }} />
            {noTarget ? <Alert severity="info">{t('aggregate.no_asset')}</Alert> : (
              <>
                <TextField select label={t('aggregate.asset')} value={selected?.id ?? ''} onChange={(e) => { setAssetId(e.target.value); setAmountText(''); }} fullWidth
                  helperText={selected?.balance !== undefined ? t('aggregate.balance', { balance: xym(selected.balance, selectedDiv) }) : selected?.local ? t('aggregate.new_mosaic_hint') : undefined}>
                  {options.map((o) => <MenuItem key={o.id} value={o.id}>{o.local ? `${o.id} ${t('aggregate.new_mosaic_tag')}` : o.symbol}</MenuItem>)}
                </TextField>
                <TextField label={t('common.amount')} value={amountText} onChange={(e) => setAmountText(sanitizeAmount(e.target.value, selectedDiv))} fullWidth
                  slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
              </>
            )}
            <TextField label={t('send.message_label')} value={message} onChange={(e) => setMessage(e.target.value)} fullWidth multiline minRows={2}
              helperText={`${messageByteLength(message)} / ${MAX_MESSAGE_BYTES} bytes`} />
          </Box>
        )}

        {kind === 'mosaic_definition' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 1 }}>
            <Alert severity="info">{t('aggregate.mosaic_hint')}</Alert>
            <TextField select label={t('mosaic.divisibility')} value={divisibility} onChange={(e) => setDivisibility(Number(e.target.value))} helperText={t('mosaic.divisibility_hint')} fullWidth sx={{ mt: 1 }}>
              {Array.from({ length: MAX_MOSAIC_DIVISIBILITY + 1 }, (_, d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </TextField>
            {MOSAIC_FLAG_LABELS.map((f) => (
              <FormControlLabel key={f.mask} label={t(f.labelKey)}
                control={<Switch checked={(flags & f.mask) !== 0} onChange={(e) => setFlags(e.target.checked ? flags | f.mask : flags & ~f.mask)} />} />
            ))}
            <FormControlLabel label={t('mosaic.unlimited_label')} control={<Switch checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />} />
            {!unlimited && (
              <TextField label={t('mosaic.days_label')} value={daysText} onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))} helperText={t('mosaic.days_hint')} fullWidth
                slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
            )}
            <TextField label={t('aggregate.initial_supply_optional')} value={initialSupply} onChange={(e) => setInitialSupply(sanitizeAmount(e.target.value, divisibility))} fullWidth
              helperText={t('aggregate.initial_supply_hint')} slotProps={{ htmlInput: { inputMode: 'decimal' } }} sx={{ mt: 1 }} />
          </Box>
        )}

        {kind === 'mosaic_supply' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            {noTarget ? <Alert severity="info">{t('aggregate.no_supply_target')}</Alert> : (
              <>
                <TextField select label={t('aggregate.asset')} value={selected?.id ?? ''} onChange={(e) => { setAssetId(e.target.value); setAmountText(''); }} fullWidth>
                  {options.map((o) => <MenuItem key={o.id} value={o.id}>{o.local ? `${o.id} ${t('aggregate.new_mosaic_tag')}` : o.symbol}</MenuItem>)}
                </TextField>
                <TextField select label={t('aggregate.action')} value={action} onChange={(e) => setAction(e.target.value as 'increase' | 'decrease')} fullWidth>
                  <MenuItem value="increase">{t('aggregate.action_increase')}</MenuItem>
                  <MenuItem value="decrease">{t('aggregate.action_decrease')}</MenuItem>
                </TextField>
                <TextField label={t('aggregate.delta')} value={amountText} onChange={(e) => setAmountText(sanitizeAmount(e.target.value, selectedDiv))} fullWidth
                  helperText={t('aggregate.supply_hint')} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
              </>
            )}
          </Box>
        )}

        {kind === 'namespace' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField select label={t('namespace.type_label')} value={nsType} onChange={(e) => setNsType(e.target.value as 'root' | 'child')} fullWidth>
              <MenuItem value="root">{t('namespace.type_root')}</MenuItem>
              <MenuItem value="child">{t('namespace.type_child')}</MenuItem>
            </TextField>
            {nsType === 'child' && (parents.length === 0
              ? <Alert severity="info">{t('namespace.no_parent')}</Alert>
              : (
                <TextField select label={t('namespace.parent_label')} value={parent?.id ?? ''} onChange={(e) => setParentId(e.target.value)} fullWidth>
                  {parents.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
                </TextField>
              ))}
            <TextField label={t('namespace.name_label')} placeholder={t('namespace.name_placeholder')} value={nsName} onChange={(e) => setNsName(e.target.value.toLowerCase())} fullWidth
              error={nsName !== '' && !isValidNamespaceName(nsName)} helperText={t('namespace.name_hint')} slotProps={{ htmlInput: { maxLength: MAX_NAMESPACE_NAME_LENGTH } }} />
            {nsType === 'root' && (
              <TextField label={t('namespace.days_label')} value={nsDays} onChange={(e) => setNsDays(e.target.value.replace(/[^0-9]/g, ''))} fullWidth
                helperText={t('namespace.days_hint', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
            )}
          </Box>
        )}

        {'error' in built && built.error !== '' && <Typography color="error" variant="body2" sx={{ mt: 2 }}>{built.error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!('items' in built) || noTarget} onClick={() => { if ('items' in built && built.items) { onAdd(built.items); onClose(); } }}>
          {t('common.add')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
