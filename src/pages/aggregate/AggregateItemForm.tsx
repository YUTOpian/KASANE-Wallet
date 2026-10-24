import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, InputAdornment, MenuItem, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { formatAtomic, parseDecimal } from '../../lib/symbol/amount';
import { fetchBalances, resolveRecipientInput } from '../../lib/symbol/api';
import type { MosaicBalance, OwnedMosaic, OwnedNamespace, RecipientResolution } from '../../lib/symbol/api';
import { classifyRecipientInput } from '../../lib/symbol/recipientInput';
import type { RecipientInput } from '../../lib/symbol/recipientInput';
import { isValidAddress, normalizeAddress, prettyAddress } from '../../lib/symbol/crypto';
import {
  aggregateMosaicId, aggregateNamespaceId, namespaceFullName, validateItem,
} from '../../lib/symbol/aggregate';
import type { AggregateItem, AggregateItemKind, AggregateSigner } from '../../lib/symbol/aggregate';
import { quoteRental, resolveSignerByKey } from '../../lib/symbol/aggregateApi';
import {
  BLOCKS_PER_DAY, MAX_MESSAGE_BYTES, MAX_MOSAIC_DIVISIBILITY, MAX_MOSAIC_SUPPLY, MAX_NAMESPACE_DAYS, MAX_NAMESPACE_DEPTH,
  MAX_NAMESPACE_NAME_LENGTH, MIN_NAMESPACE_DAYS, MOSAIC_FLAG_SUPPLY_MUTABLE, MOSAIC_FLAG_TRANSFERABLE, isValidNamespaceName,
  messageByteLength, newMosaicNonce,
} from '../../lib/symbol/tx';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { getNetworkConfig } from '../../lib/symbol/network';
import { MOSAIC_FLAG_LABELS } from '../mosaic/mosaicFlags';
import { Field, FormRow } from '../multisig/parts';

const MAX_MOSAIC_DAYS = 3650;

// What the forms need to know about the wallet and the draft.
export interface AggregateContext {
  address: string;
  items: AggregateItem[]; // already in the draft (mosaics / namespaces they create can be used by later items)
  balances: MosaicBalance[];
  ownedMosaics: OwnedMosaic[];
  ownedNamespaces: OwnedNamespace[];
  signers: AggregateSigner[]; // multisig accounts the wallet cosigns for (candidates for the sender of a transfer)
}

interface Props {
  kind: AggregateItemKind;
  ctx: AggregateContext;
  /** Number of this kind already in the draft + 1: shown in the heading ("モザイクトランザクション1"). */
  index: number;
  /** The draft is full: nothing more can be saved. */
  full: boolean;
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

// One form per kind of transaction (transfer / mosaic definition / supply change / namespace), laid out like the official
// Symbol wallet: a heading, then rows with the label on the left and the field next to it, and a 「保存」 button that
// stacks the transaction into the aggregate. The parent remounts it (key) after each save, so it starts empty again.
export default function AggregateItemForm({ kind, ctx, index, full, onAdd }: Props) {
  const { t } = useTranslation();
  const networkByte = getNetworkConfig().networkByte;

  // Mosaics created earlier in this draft (their ids are known already, so later items can use them).
  const draftMosaics: MosaicOption[] = useMemo(() => ctx.items.flatMap((i) => (i.kind === 'mosaic_definition'
    ? [{ id: aggregateMosaicId(ctx.address, i.nonce), symbol: aggregateMosaicId(ctx.address, i.nonce), divisibility: i.divisibility, local: true }]
    : [])), [ctx.items, ctx.address]);
  const draftDefs = useMemo(() => new Map(ctx.items.flatMap((i) => (i.kind === 'mosaic_definition' ? [[aggregateMosaicId(ctx.address, i.nonce), i] as const] : []))), [ctx.items, ctx.address]);

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

  // ---- recipient of a transfer ----
  // The field takes an address, a namespace alias ("nem.group" / "@nem.group") or a 64-hex public key. An alias or key is
  // looked up (debounced) and turned into the address it stands for; that address is what goes into the aggregate, the
  // same way the send form handles it, so a later re-link of the alias can never change where the XYM goes.
  const typedRecipient = normalizeAddress(recipient);
  const typedRecipientValid = isValidAddress(typedRecipient, networkByte);
  const recipientInput: RecipientInput = kind === 'transfer' && !typedRecipientValid ? classifyRecipientInput(recipient) : { kind: 'other' };
  const lookupKey = recipientInput.kind === 'alias' ? `a:${recipientInput.name}` : recipientInput.kind === 'publicKey' ? `k:${recipientInput.publicKey}` : '';
  const [resolution, setResolution] = useState<{ key: string; result: RecipientResolution | 'loading' | 'failed' } | null>(null);
  useEffect(() => {
    if (lookupKey === '') { setResolution(null); return undefined; }
    let cancelled = false;
    setResolution({ key: lookupKey, result: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const result = await resolveRecipientInput(recipientInput, networkByte);
        if (!cancelled) setResolution({ key: lookupKey, result });
      } catch (e) {
        console.error('Failed to resolve recipient', e);
        if (!cancelled) setResolution({ key: lookupKey, result: 'failed' });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, networkByte]);
  // The answer only counts for the text it was asked for.
  const resolved = lookupKey !== '' && resolution?.key === lookupKey ? resolution.result : null;
  const resolvedOk = resolved !== null && resolved !== 'loading' && resolved !== 'failed' && resolved.ok ? resolved : null;
  const toAddress = typedRecipientValid ? typedRecipient : resolvedOk ? resolvedOk.address : '';
  const recipientAlias = resolvedOk?.via === 'alias' && recipientInput.kind === 'alias' ? recipientInput.name : undefined;
  let recipientError = '';
  let recipientNote = '';
  if (lookupKey !== '') {
    if (resolved === null || resolved === 'loading') recipientNote = t('send.alias_resolving');
    else if (resolved === 'failed') recipientError = t('send.alias_lookup_failed');
    else if (!resolved.ok) recipientError = t(`send.alias_${resolved.reason}`);
    else recipientNote = t(resolved.via === 'alias' ? 'send.alias_resolved' : 'send.publickey_resolved', { address: prettyAddress(resolved.address) });
  } else if (recipient !== '' && !typedRecipientValid) {
    recipientError = t('common.invalid_address');
  }

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

  const fmt = (v: bigint, d: number) => formatAtomic(v, d);

  // Builds the item(s) for the current inputs, or the reason why it cannot be built yet ('' = just incomplete).
  const built = (() => {
    if (kind === 'transfer') {
      // An alias / public key that is still being looked up (or failed) is reported under the field, not here.
      if (toAddress === '') return { error: lookupKey !== '' ? '' : recipient === '' ? '' : t('common.invalid_address') };
      if (senderPending) return { error: customKey.trim() === '' ? '' : t('aggregate.sender_invalid') };
      if (!selected) return { error: '' };
      const amount = amountText === '' ? 0n : parseDecimal(amountText, selectedDiv);
      if (amount === null) return { error: t('aggregate.invalid_amount') };
      if (selected.balance !== undefined && amount > selected.balance) return { error: t('aggregate.amount_exceeds', { balance: fmt(selected.balance, selectedDiv) }) };
      if (messageByteLength(message) > MAX_MESSAGE_BYTES) return { error: t('aggregate.item_message_too_long') };
      const item: AggregateItem = { uid: uid(), kind: 'transfer', signer, recipient: toAddress, recipientAlias, mosaicId: selected.id, mosaicSymbol: selected.symbol, divisibility: selectedDiv, amount, message };
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
    if (!isValidNamespaceName(nsName)) return { error: nsName === '' ? '' : t('namespace.invalid_name') };
    if (nsType === 'child') {
      if (!parent) return { error: '' };
      return { items: [{ uid: uid(), kind: 'namespace', name: nsName, parent, durationBlocks: 0n } as AggregateItem] };
    }
    const days = /^\d+$/.test(nsDays) ? Number(nsDays) : NaN;
    if (!(days >= MIN_NAMESPACE_DAYS && days <= MAX_NAMESPACE_DAYS)) return { error: t('namespace.invalid_days', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS }) };
    return { items: [{ uid: uid(), kind: 'namespace', name: nsName, durationBlocks: BigInt(days) * BigInt(BLOCKS_PER_DAY) } as AggregateItem] };
  })();

  const noTarget = (kind === 'transfer' || kind === 'mosaic_supply') && options.length === 0;
  const builtItems = 'items' in built ? built.items : undefined;

  // ---- 推定レンタル手数料 (mosaic definition / namespace only): what the transaction being filled in costs to rent ----
  const builtRef = useRef(builtItems);
  builtRef.current = builtItems;
  const rentalKey = kind === 'mosaic_definition' ? 'm' : kind === 'namespace' && builtItems ? `${nsType}:${nsDays}` : '';
  const [rental, setRental] = useState<bigint | null | 'loading' | 'none'>('none');
  useEffect(() => {
    const target = builtRef.current;
    if (rentalKey === '' || !target) { setRental('none'); return undefined; }
    let cancelled = false;
    setRental('loading');
    quoteRental(target)
      .then((v) => { if (!cancelled) setRental(v); })
      .catch(() => { if (!cancelled) setRental(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rentalKey]);
  const showRental = kind === 'mosaic_definition' || kind === 'namespace';
  const rentalText = rental === 'none' ? '-' : rental === 'loading' ? t('aggregate.cost_loading') : rental === null ? t('aggregate.cost_unavailable') : `${formatAtomic(rental, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;

  const assetMenu = options.map((o) => <MenuItem key={o.id} value={o.id}>{o.local ? `${o.id} ${t('aggregate.new_mosaic_tag')}` : o.symbol}</MenuItem>);
  const address = { style: { fontFamily: 'monospace' }, autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false } as const;
  // An alias is typed in lower case, so the recipient field must not capitalise what is typed.
  const recipientField = { style: { fontFamily: 'monospace' }, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

  return (
    <Box>
      <Typography sx={{ fontWeight: 'bold', fontSize: '1.15rem', color: 'primary.main', mt: 1, mb: 2 }}>
        {t('aggregate.form_heading', { name: t(`aggregate.tab_${kind}`), n: index })}
      </Typography>

      {kind === 'transfer' && (
        <>
          <FormRow label={t('aggregate.sender')} hint={senderChoice === 'self' ? undefined : t('aggregate.sender_cosign_hint')}>
            <Field select ariaLabel={t('aggregate.sender')} value={senderChoice} onChange={(e) => { setSenderChoice(e.target.value); setAssetId(''); setAmountText(''); }}>
              <MenuItem value="self">{t('aggregate.sender_self')}</MenuItem>
              {ctx.signers.map((x) => (
                <MenuItem key={x.address} value={x.address} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>
                  {t('aggregate.sender_multisig')} {x.address}
                </MenuItem>
              ))}
              <MenuItem value="custom">{t('aggregate.sender_custom')}</MenuItem>
            </Field>
          </FormRow>
          {senderChoice === 'custom' && (
            <FormRow label={t('aggregate.sender_public_key')}>
              <Field ariaLabel={t('aggregate.sender_public_key')} value={customKey} onChange={(e) => setCustomKey(e.target.value.trim())}
                error={customKey !== '' && customSigner === null}
                helperText={customSigner === 'loading' ? t('aggregate.cost_loading') : customSigner ? customSigner.address : t('aggregate.sender_public_key_hint')}
                htmlInput={address} />
            </FormRow>
          )}
          <FormRow label={t('common.destination')}>
            <Field ariaLabel={t('common.destination')} placeholder={t('aggregate.recipient_placeholder')} value={recipient} onChange={(e) => setRecipient(e.target.value)}
              error={recipientError !== ''}
              helperText={recipientError !== '' ? recipientError : recipientNote !== '' ? recipientNote : t('send.input_address_hint')}
              htmlInput={recipientField} />
          </FormRow>
          {noTarget ? <Alert severity="info" sx={{ my: 1 }}>{t('aggregate.no_asset')}</Alert> : (
            <>
              <FormRow label={t('aggregate.asset')}>
                <Field select ariaLabel={t('aggregate.asset')} value={selected?.id ?? ''} onChange={(e) => { setAssetId(e.target.value); setAmountText(''); }}
                  helperText={selected?.local ? t('aggregate.new_mosaic_hint') : undefined}>
                  {assetMenu}
                </Field>
              </FormRow>
              {/* the amount has its own row: label 「数量」, the mosaic's symbol at the end of the field, the balance under it */}
              <FormRow label={t('aggregate.amount_label')}>
                <Field ariaLabel={t('common.amount')} placeholder="0" value={amountText} onChange={(e) => setAmountText(sanitizeAmount(e.target.value, selectedDiv))}
                  helperText={selected?.balance !== undefined ? t('aggregate.balance', { balance: fmt(selected.balance, selectedDiv) }) : undefined}
                  endAdornment={selected ? <InputAdornment position="end">{selected.symbol}</InputAdornment> : undefined}
                  htmlInput={{ inputMode: 'decimal' }} />
              </FormRow>
            </>
          )}
          <FormRow label={t('send.message_optional')}>
            <Field ariaLabel={t('send.message_optional')} placeholder={t('aggregate.message_placeholder')} value={message} onChange={(e) => setMessage(e.target.value)} multiline minRows={3}
              error={messageByteLength(message) > MAX_MESSAGE_BYTES}
              helperText={message === '' ? undefined : `${messageByteLength(message)} / ${MAX_MESSAGE_BYTES} bytes`} />
          </FormRow>
        </>
      )}

      {kind === 'mosaic_definition' && (
        <>
          <Alert severity="info" sx={{ mb: 1 }}>{t('aggregate.mosaic_hint')}</Alert>
          <FormRow label={t('mosaic.divisibility_label')} hint={t('mosaic.divisibility_hint')}>
            <Field select ariaLabel={t('mosaic.divisibility_label')} value={divisibility} onChange={(e) => setDivisibility(Number(e.target.value))}>
              {Array.from({ length: MAX_MOSAIC_DIVISIBILITY + 1 }, (_, d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </Field>
          </FormRow>
          <FormRow label={t('mosaic.duration_label')} hint={unlimited ? undefined : t('mosaic.days_hint')} top>
            <Field ariaLabel={t('mosaic.days_label')} value={unlimited ? '' : daysText} placeholder={unlimited ? t('mosaic.duration_unlimited') : t('mosaic.days_label')}
              onChange={(e) => setDaysText(e.target.value.replace(/[^0-9]/g, ''))} htmlInput={{ inputMode: 'numeric', disabled: unlimited }} />
            <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, mt: 0.5 }}>
              <FormControlLabel label={t('mosaic.unlimited_label')} control={<Checkbox size="small" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />} />
              {MOSAIC_FLAG_LABELS.map((f) => (
                <FormControlLabel key={f.mask} label={t(f.labelKey)}
                  control={<Checkbox size="small" checked={(flags & f.mask) !== 0} onChange={(e) => setFlags(e.target.checked ? flags | f.mask : flags & ~f.mask)} />} />
              ))}
            </Box>
          </FormRow>
          <FormRow label={t('aggregate.initial_supply_optional')} hint={t('aggregate.initial_supply_hint')}>
            <Field ariaLabel={t('aggregate.initial_supply_optional')} value={initialSupply} onChange={(e) => setInitialSupply(sanitizeAmount(e.target.value, divisibility))} htmlInput={{ inputMode: 'decimal' }} />
          </FormRow>
        </>
      )}

      {kind === 'mosaic_supply' && (
        noTarget ? <Alert severity="info" sx={{ my: 1 }}>{t('aggregate.no_supply_target')}</Alert> : (
          <>
            <FormRow label={t('aggregate.asset')}>
              <Field select ariaLabel={t('aggregate.asset')} value={selected?.id ?? ''} onChange={(e) => { setAssetId(e.target.value); setAmountText(''); }}>{assetMenu}</Field>
            </FormRow>
            <FormRow label={t('aggregate.action')}>
              <Field select ariaLabel={t('aggregate.action')} value={action} onChange={(e) => setAction(e.target.value as 'increase' | 'decrease')}>
                <MenuItem value="increase">{t('aggregate.action_increase')}</MenuItem>
                <MenuItem value="decrease">{t('aggregate.action_decrease')}</MenuItem>
              </Field>
            </FormRow>
            <FormRow label={t('aggregate.delta')} hint={t('aggregate.supply_hint')}>
              <Field ariaLabel={t('aggregate.delta')} value={amountText} onChange={(e) => setAmountText(sanitizeAmount(e.target.value, selectedDiv))} htmlInput={{ inputMode: 'decimal' }} />
            </FormRow>
          </>
        )
      )}

      {kind === 'namespace' && (
        <>
          <FormRow label={t('namespace.type_label')}>
            <Field select ariaLabel={t('namespace.type_label')} value={nsType} onChange={(e) => setNsType(e.target.value as 'root' | 'child')}>
              <MenuItem value="root">{t('namespace.type_root')}</MenuItem>
              <MenuItem value="child">{t('namespace.type_child')}</MenuItem>
            </Field>
          </FormRow>
          {nsType === 'child' && (parents.length === 0
            ? <Alert severity="info" sx={{ my: 1 }}>{t('namespace.no_parent')}</Alert>
            : (
              <FormRow label={t('namespace.parent_label')}>
                <Field select ariaLabel={t('namespace.parent_label')} value={parent?.id ?? ''} onChange={(e) => setParentId(e.target.value)}>
                  {parents.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
                </Field>
              </FormRow>
            ))}
          <FormRow label={t('namespace.name_label')} hint={t('namespace.name_hint')}>
            <Field ariaLabel={t('namespace.name_label')} placeholder={t('namespace.name_placeholder')} value={nsName} onChange={(e) => setNsName(e.target.value.toLowerCase())}
              error={nsName !== '' && !isValidNamespaceName(nsName)} htmlInput={{ maxLength: MAX_NAMESPACE_NAME_LENGTH, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }} />
          </FormRow>
          {nsType === 'root' && (
            <FormRow label={t('namespace.days_label')} hint={t('namespace.days_hint', { min: MIN_NAMESPACE_DAYS, max: MAX_NAMESPACE_DAYS })}>
              <Field ariaLabel={t('namespace.days_label')} value={nsDays} onChange={(e) => setNsDays(e.target.value.replace(/[^0-9]/g, ''))} htmlInput={{ inputMode: 'numeric' }} />
            </FormRow>
          )}
        </>
      )}

      {showRental && (
        <FormRow label={t('aggregate.est_rental')}>
          <Typography sx={{ color: rental === 'none' || rental === 'loading' ? 'text.secondary' : 'error.main' }}>{rentalText}</Typography>
        </FormRow>
      )}

      {'error' in built && built.error !== '' && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{built.error}</Typography>}
      {full && <Alert severity="warning" sx={{ mt: 1 }}>{t('aggregate.full_notice')}</Alert>}

      <Box sx={{ display: 'flex', justifyContent: { xs: 'stretch', md: 'flex-end' }, mt: 2, mb: 1 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!builtItems || noTarget || full}
          onClick={() => { if (builtItems) onAdd(builtItems); }} sx={{ py: 1.25, width: { md: 'auto' }, px: { md: 6 } }}>
          {t('aggregate.save')}
        </Button>
      </Box>
    </Box>
  );
}
