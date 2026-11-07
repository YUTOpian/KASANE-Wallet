import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, ButtonBase, Chip, Typography, alpha } from '@mui/material';
import type { Theme } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import TollOutlinedIcon from '@mui/icons-material/TollOutlined';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import NotesOutlinedIcon from '@mui/icons-material/NotesOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import LockClockOutlinedIcon from '@mui/icons-material/LockClockOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAppStore } from '../../store/appStore';
import { useAddressBook, useOwnAddresses } from '../../hooks/useAddressBook';
import { findEntry, plainAddress, trustOf } from '../../lib/addressBook';
import { fetchAddressAliasNames, resolveAliasRecipients } from '../../lib/symbol/namespaceNames';
import { prettyChainAddress } from '../../lib/chainApi';
import { isExpired } from '../../lib/symbol/history';
import type { HistoryCategory, HistoryItem } from '../../lib/symbol/history';

type Tone = 'in' | 'out' | 'neutral';

const CATEGORY_ICON: Record<HistoryCategory, typeof DescriptionOutlinedIcon> = {
  transfer: DescriptionOutlinedIcon,
  aggregate: LayersOutlinedIcon,
  mosaic: TollOutlinedIcon,
  namespace: LabelOutlinedIcon,
  metadata: NotesOutlinedIcon,
  multisig: GroupsOutlinedIcon,
  restriction: BlockOutlinedIcon,
  lock: LockClockOutlinedIcon,
  link: LinkOutlinedIcon,
  other: DescriptionOutlinedIcon,
};

function toneOf(item: HistoryItem): Tone {
  if (item.isReception) return 'in';
  if (item.category === 'transfer') return 'out';
  return 'neutral';
}

function toneColor(theme: Theme, tone: Tone): string {
  if (tone === 'in') return theme.palette.success.main;
  if (tone === 'out') return theme.palette.error.main;
  return theme.palette.primary.main;
}

/** The headline amount of a row: "+10,000 XYM (+1)", or '' when the transaction moves nothing to or from this account. */
function amountOf(item: HistoryItem): { text: string; extra: string } | null {
  const first = item.category === 'transfer' ? item.mosaics[0] : item.isReception ? item.received[0] : undefined;
  if (!first) return null;
  const count = item.category === 'transfer' ? item.mosaics.length : item.received.length;
  return {
    text: `${item.isReception ? '+' : '-'}${first.amount} ${first.symbol}`,
    extra: count > 1 ? `+${count - 1}` : '',
  };
}

function shortAddress(address: string): string {
  if (address.startsWith('@')) return address;
  const plain = prettyChainAddress(address).replace(/-/g, '');
  return plain.length > 14 ? `${plain.slice(0, 6)}…${plain.slice(-4)}` : plain;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms: number, t: TFunction): string {
  const now = Date.now();
  if (dayKey(ms) === dayKey(now)) return t('history.today');
  if (dayKey(ms) === dayKey(now - 86_400_000)) return t('history.yesterday');
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function timeText(item: HistoryItem): string {
  if (item.timestampMs !== null) return new Date(item.timestampMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return '';
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
// icon | other party + type | amount | block height | date  (wide screens; narrow screens stack everything beside the icon)
const ROW_COLUMNS = '40px minmax(0, 1fr) minmax(130px, 200px) 110px 180px';

function HistoryRow({ item, onOpen, trust, peerName, t }: {
  item: HistoryItem;
  onOpen: (item: HistoryItem) => void;
  trust: string;
  peerName: string | null;
  t: TFunction;
}): ReactElement {
  const tone = toneOf(item);
  const amount = amountOf(item);
  const isTransfer = item.category === 'transfer';
  const Icon = item.isReception ? ArrowDownwardIcon : isTransfer ? ArrowUpwardIcon : CATEGORY_ICON[item.category];
  const peer = isTransfer ? (item.isReception ? item.signerAddress : item.recipient) : item.isOutgoing ? '' : item.signerAddress;
  const peerLabel = peerName ?? (peer ? shortAddress(peer) : '');
  const title = t(`history.type.${isTransfer ? (item.isReception ? 'transfer_received' : 'transfer_sent') : item.typeKey}`);
  const encryptedOnly = isTransfer && item.encryptedMessage && item.mosaics.length === 0;
  const time = timeText(item);
  const deadline = item.timestampMs === null && item.deadlineMs !== null
    ? `${t('history.deadline')} ${new Date(item.deadlineMs).toLocaleString()}`
    : '';
  const chips: ReactElement[] = [];
  if (isExpired(item)) chips.push(<Chip key="expired" size="small" color="error" label={t('history.expired')} />);
  if (item.viaAccount) {
    chips.push(<Chip key="via" size="small" color="primary" variant="outlined" label={t('history.multisig_account', { address: `${item.viaAccount.slice(0, 6)}…${item.viaAccount.slice(-4)}` })} />);
  }
  if (!isTransfer && !item.isOutgoing && !item.isReception && !item.viaAccount) chips.push(<Chip key="involved" size="small" label={t('history.involved')} />);
  if (item.status === 'partial' && trust === 'unknown') chips.push(<Chip key="unknown" size="small" color="warning" label={t('addressbook.chip_unknown_signer')} />);
  if (item.status === 'partial' && trust === 'black') chips.push(<Chip key="black" size="small" color="error" label={t('addressbook.chip_blacklisted_signer')} />);

  const fullDate = item.timestampMs !== null ? new Date(item.timestampMs).toLocaleString() : deadline;
  const height = item.status === 'confirmed' && item.height ? item.height : '';
  const peerFull = peer ? (peer.startsWith('@') ? peer : prettyChainAddress(peer)) : '';
  const lockIcon = isTransfer && item.encryptedMessage
    ? <LockOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary', alignSelf: 'center' }} titleAccess={t('transaction.message_is_encrypted')} />
    : null;
  const amountNode = amount ? (
    <>
      <Typography component="span" sx={(theme) => ({ fontWeight: 700, color: toneColor(theme, tone), overflowWrap: 'anywhere' })}>{amount.text}</Typography>
      {amount.extra && <Typography component="span" variant="caption" color="text.secondary">{amount.extra}</Typography>}
      {lockIcon}
    </>
  ) : encryptedOnly ? (
    <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      <LockOutlinedIcon sx={{ fontSize: 16 }} />{t('transaction.message_is_encrypted')}
    </Typography>
  ) : null;
  const fromTo = isTransfer ? `${item.isReception ? t('history.from') : t('history.to')}  ` : '';

  return (
    <ButtonBase
      onClick={() => onOpen(item)}
      sx={(theme) => ({
        display: 'grid', width: '100%', textAlign: 'left', alignItems: 'center', columnGap: 1.5, px: 1.5, py: 1.25,
        gridTemplateColumns: { xs: '40px minmax(0, 1fr)', md: ROW_COLUMNS },
        borderBottom: `1px solid ${theme.palette.divider}`,
      })}
    >
      <Box
        sx={(theme) => ({
          width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: toneColor(theme, tone), bgcolor: alpha(toneColor(theme, tone), 0.14),
        })}
      >
        <Icon fontSize="small" />
      </Box>

      {/* Wide screens: the other party on top, the type under it. Narrow screens: type, amount, party, time. */}
      <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography sx={{ fontWeight: 600, lineHeight: 1.35, order: { xs: 1, md: 2 }, fontSize: { md: '0.9rem' }, color: { md: 'text.secondary' } }}>{title}</Typography>
        <Box sx={{ display: { xs: 'flex', md: 'none' }, alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, mt: 0.25, fontSize: '1.25rem', order: 1.5 }}>
          {amountNode}
        </Box>
        {peerLabel && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', order: { xs: 2, md: 1 } }}>
            {fromTo}
            <Box component="span" sx={{ color: 'text.primary', display: { xs: 'inline', md: 'none' }, fontFamily: peerName ? undefined : MONO, fontSize: peerName ? undefined : '0.85em' }}>{peerLabel}</Box>
            <Box component="span" sx={{ color: 'text.primary', display: { xs: 'none', md: 'inline' }, fontFamily: peerName ? undefined : MONO, fontSize: peerName ? undefined : '0.85em' }}>{peerName ?? peerFull}</Box>
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25, display: { xs: 'block', md: 'none' }, order: 3 }}>
          {[time || deadline, height ? `${t('history.block')} ${height}` : ''].filter(Boolean).join(' · ')}
        </Typography>
        {chips.length > 0 && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75, order: 4 }}>{chips}</Box>}
      </Box>

      <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, fontSize: '1.05rem' }}>
        {amountNode ?? <Typography component="span" color="text.disabled">—</Typography>}
      </Box>
      <Typography sx={{ display: { xs: 'none', md: 'block' }, fontVariantNumeric: 'tabular-nums' }}>{height || '—'}</Typography>
      <Typography variant="body2" sx={{ display: { xs: 'none', md: 'block' }, fontVariantNumeric: 'tabular-nums' }}>{fullDate || '—'}</Typography>
    </ButtonBase>
  );
}

/**
 * The rows of Home's 履歴 (Symbol and NEM share it): one row per transaction - a round icon badge (green = received,
 * red = sent, purple = anything else), the type with the other party, the date / block height, and the amount on the
 * right - grouped under a header per day.
 */
export default function HistoryList({ items, onOpen }: { items: HistoryItem[]; onOpen: (item: HistoryItem) => void }) {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { entries } = useAddressBook();
  const own = useOwnAddresses();

  const peerOf = (item: HistoryItem): string => (item.category === 'transfer' ? (item.isReception ? item.signerAddress : item.recipient) : item.isOutgoing ? '' : item.signerAddress);

  // Symbol: a party without an address-book name is shown by its namespace name when it has one (an address with an alias,
  // or a transfer sent to an alias, which the history carries as "@<hex id>"). The address book always comes first.
  const [namespaceNames, setNamespaceNames] = useState<Record<string, string>>({});
  const lookupKey = useMemo(() => {
    if (chain !== 'symbol') return '';
    const wanted = new Set<string>();
    for (const item of items) {
      const peer = peerOf(item);
      if (!peer || (!peer.startsWith('@') && findEntry(entries, chain, network, peer))) continue;
      wanted.add(peer);
    }
    return [...wanted].join(',');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, entries, chain, network]);
  useEffect(() => {
    if (!lookupKey) return undefined;
    let cancelled = false;
    const peers = lookupKey.split(',');
    (async () => {
      try {
        const [byAlias, byAddress] = await Promise.all([
          resolveAliasRecipients(peers.filter((p) => p.startsWith('@'))),
          fetchAddressAliasNames(peers.filter((p) => !p.startsWith('@'))),
        ]);
        if (cancelled) return;
        const next: Record<string, string> = { ...byAlias };
        for (const p of peers) if (!p.startsWith('@') && byAddress[plainAddress(p)]) next[p] = byAddress[plainAddress(p)];
        setNamespaceNames((prev) => ({ ...prev, ...next }));
      } catch (e) {
        console.warn('Could not resolve namespace names', e);
      }
    })();
    return () => { cancelled = true; };
  }, [lookupKey]);

  let lastDay = '';
  return (
    <Box>
      <Box
        sx={(theme) => ({
          display: { xs: 'none', md: 'grid' }, gridTemplateColumns: ROW_COLUMNS, columnGap: 1.5, px: 1.5, py: 1,
          fontWeight: 700, fontSize: '0.85rem', color: 'text.secondary', borderBottom: `1px solid ${theme.palette.divider}`,
        })}
      >
        <span />
        <span>{t('history.col_peer')}</span>
        <span>{t('history.col_amount')}</span>
        <span>{t('history.col_block')}</span>
        <span>{t('history.col_date')}</span>
      </Box>
      {items.map((item) => {
        const peer = peerOf(item);
        const entry = peer && !peer.startsWith('@') ? findEntry(entries, chain, network, peer) : null;
        const nsName = peer && !entry ? namespaceNames[peer] : undefined;
        const trust = item.isOutgoing || !item.signerAddress ? 'self' : trustOf(entries, chain, network, item.signerAddress, own).trust;
        const day = item.timestampMs !== null ? dayKey(item.timestampMs) : '';
        const header = day && day !== lastDay;
        if (day) lastDay = day;
        return (
          <Fragment key={`${item.status}-${item.hash || item.timestampMs}-${item.viaAccount ?? ''}`}>
            {header && item.timestampMs !== null && (
              <Typography
                variant="caption"
                sx={(theme) => ({ display: { xs: 'block', md: 'none' }, px: 1.5, pt: 1.5, pb: 0.5, fontWeight: 700, color: 'text.secondary', bgcolor: alpha(theme.palette.text.primary, 0.04) })}
              >
                {dayLabel(item.timestampMs, t)}
              </Typography>
            )}
            <HistoryRow item={item} onOpen={onOpen} trust={trust} peerName={entry?.name ?? (nsName ? `@${nsName}` : null)} t={t} />
          </Fragment>
        );
      })}
    </Box>
  );
}
