import { useEffect, useState } from 'react';
import { Box, ButtonBase, Chip, Divider, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useTranslation } from 'react-i18next';
import type { RecipientInfo, SymbolTransfer } from '../../lib/symbol/api';
import { currencySymbol } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';

interface Props {
  /** Normalized address being looked up; the card resets its expanders when it changes. */
  address: string;
  recipient: RecipientInfo | null | 'loading';
  history: SymbolTransfer[] | null | 'loading';
  ownMatch: { active: boolean; name: string } | null;
}

// 直近のトランザクションは最初に3件、「さらに見る」で6件まで。
const RECENT_FIRST = 3;
const RECENT_MAX = 6;

const shorten = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);

// Small coloured label: red = sent (money out), green = received (money in).
function DirectionBadge({ received, label }: { received: boolean; label: string }) {
  const color = (th: Theme) => (received ? th.palette.success.main : th.palette.error.main);
  return (
    <Box
      component="span"
      sx={(th) => ({
        display: 'inline-block',
        minWidth: 44,
        textAlign: 'center',
        px: 1,
        py: 0.25,
        borderRadius: 1,
        fontSize: 12,
        fontWeight: 'bold',
        color: color(th),
        bgcolor: alpha(color(th), 0.12),
      })}
    >
      {label}
    </Box>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <Typography sx={{ color: 'text.secondary', fontSize: 12, fontWeight: 'bold', letterSpacing: 0.3, mb: 0.75 }}>{children}</Typography>;
}

// 「送信先の情報」: balance, mosaics, namespaces and latest transfers of the typed recipient.
export default function RecipientInfoCard({ address, recipient, history, ownMatch }: Props) {
  const { t } = useTranslation();
  const isNem = useAppStore((st) => st.chain) === 'nem';
  const CURRENCY_SYMBOL = currencySymbol();
  const [mosaicsOpen, setMosaicsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  useEffect(() => { setMosaicsOpen(false); setRecentOpen(false); }, [address]);

  const unused = recipient !== null && recipient !== 'loading' && !recipient.exists;

  return (
    <Box sx={{ mt: 1.5, bgcolor: 'background.paper', border: 1, borderColor: unused ? 'warning.main' : 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ color: 'primary.main', fontWeight: 'bold', fontSize: '0.9rem', mb: 1 }}>{t('send.recipient_info_title')}</Typography>

      {ownMatch !== null && (
        <Box sx={(th) => ({ mb: 1.5, px: 1.5, py: 1, borderRadius: 2, bgcolor: alpha(th.palette.warning.main, 0.12), border: 1, borderColor: 'warning.main' })}>
          <Typography sx={{ color: 'warning.main', fontWeight: 'bold', fontSize: 13 }}>
            {ownMatch.active ? t('send.recipient_is_self_title') : t('send.recipient_is_own_other_title')}
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 0.25 }}>
            {ownMatch.active ? t('send.recipient_is_self') : t('send.recipient_is_own_other', { name: ownMatch.name })}
          </Typography>
        </Box>
      )}

      {recipient === 'loading' && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('send.recipient_info_loading')}</Typography>}
      {recipient === null && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('send.recipient_info_unavailable')}</Typography>}

      {unused && (
        <Box>
          <Typography sx={{ color: 'warning.main', fontWeight: 'bold', fontSize: 14 }}>{t('send.newbie_caution_title')}</Typography>
          {(t('send.newbie_caution_message', { returnObjects: true }) as string[]).map((line, i) => (
            <Typography key={i} sx={{ color: 'text.secondary', fontSize: 12.5, mt: 0.75, lineHeight: 1.6 }}>{line}</Typography>
          ))}
        </Box>
      )}

      {recipient !== null && recipient !== 'loading' && recipient.exists && (
        <>
          {/* Balance */}
          <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1 }}>
            <Typography sx={{ fontSize: 14 }}>{t(isNem ? 'send.recipient_xem' : 'send.recipient_xym')}:</Typography>
            <Typography sx={{ fontWeight: 'bold', fontSize: 20, wordBreak: 'break-all' }}>
              {recipient.xym} <Typography component="span" sx={{ fontWeight: 'bold', fontSize: 14 }}>{CURRENCY_SYMBOL}</Typography>
            </Typography>
          </Box>

          {/* Mosaics held: tap to list them all */}
          <ButtonBase
            onClick={() => setMosaicsOpen((o) => !o)}
            disabled={recipient.mosaics.length === 0}
            aria-expanded={mosaicsOpen}
            sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 0.5, py: 0.5, color: 'primary.main', fontSize: 13 }}
          >
            <span>{t('send.recipient_mosaic_count', { count: recipient.mosaics.length })}</span>
            {recipient.mosaics.length > 0 && (mosaicsOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />)}
          </ButtonBase>
          {mosaicsOpen && (
            <Box sx={{ mt: 0.5, borderRadius: 2, bgcolor: (th) => alpha(th.palette.primary.main, 0.05), px: 1.5, py: 0.5 }}>
              {recipient.mosaics.map((m, i) => (
                <Box key={m.id} sx={{ py: 0.75, borderTop: i === 0 ? 0 : 1, borderColor: 'divider', wordBreak: 'break-all' }}>
                  <Typography sx={{ fontSize: 14 }}>
                    <b>{m.symbol}</b>: {Number(m.balance).toLocaleString(undefined, { maximumFractionDigits: m.divisibility })}
                  </Typography>
                  {m.symbol !== m.id && <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>ID: {m.id}</Typography>}
                </Box>
              ))}
            </Box>
          )}

          <Divider sx={{ my: 1.5 }} />

          {/* Namespaces */}
          <SectionLabel>{t('send.recipient_namespaces')}</SectionLabel>
          {recipient.namespaces.length > 0 ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {recipient.namespaces.map((n) => <Chip key={n} label={n} size="small" variant="outlined" color="primary" />)}
            </Box>
          ) : (
            <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('send.recipient_none')}</Typography>
          )}

          <Divider sx={{ my: 1.5 }} />

          {/* Latest transfers */}
          <SectionLabel>{t('send.recipient_recent_title')}</SectionLabel>
          {recipient.recent.length === 0 && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('send.recipient_none')}</Typography>}
          {recipient.recent.slice(0, recentOpen ? RECENT_MAX : RECENT_FIRST).map((h, i) => {
            const other = h.isReception ? h.senderAddress : h.receiverAddress;
            const amounts = h.mosaics.map((m) => `${m.amount} ${m.symbol}`).join(', ');
            return (
              <Box key={h.hash || h.timestampMs} sx={{ py: 1, borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.25 }}>
                  <DirectionBadge received={h.isReception} label={h.isReception ? t('send.recipient_history_received') : t('send.recipient_history_sent')} />
                  {amounts ? (
                    <Typography sx={{ fontWeight: 'bold', fontSize: 16, wordBreak: 'break-all', color: h.isReception ? 'success.main' : 'error.main' }}>
                      {amounts}
                    </Typography>
                  ) : (
                    <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{t('send.recipient_no_amount')}</Typography>
                  )}
                </Box>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
                  {new Date(h.timestampMs).toLocaleString()}
                  {!h.isConfirmed ? ` (${t('send.recipient_history_unconfirmed')})` : ''}
                </Typography>
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                  {h.isReception ? t('send.recipient_from') : t('send.recipient_to')}: {shorten(other)}
                </Typography>
                {h.message && <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary' }}>{t('common.message')}: {h.message}</Typography>}
              </Box>
            );
          })}
          {recipient.recent.length > RECENT_FIRST && (
            <ButtonBase
              onClick={() => setRecentOpen((o) => !o)}
              aria-expanded={recentOpen}
              sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0.5, py: 0.75, borderTop: 1, borderColor: 'divider', color: 'primary.main', fontSize: 13 }}
            >
              <span>{t(recentOpen ? 'send.recipient_recent_less' : 'send.recipient_recent_more')}</span>
              {recentOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </ButtonBase>
          )}
          <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 0.5 }}>{t('send.recipient_recent_note')}</Typography>

          {/* Has this wallet dealt with the address before? */}
          <Box
            sx={(th) => {
              const dealt = Array.isArray(history) && history.length > 0;
              const c = dealt ? th.palette.success.main : Array.isArray(history) ? th.palette.warning.main : th.palette.text.secondary;
              return { mt: 1.5, px: 1.5, py: 1, borderRadius: 2, bgcolor: alpha(c, 0.1), color: c, fontSize: 13 };
            }}
          >
            {history === 'loading' && t('send.recipient_history_loading')}
            {history === null && t('send.recipient_history_unavailable')}
            {Array.isArray(history) && history.length === 0 && t('send.recipient_history_none')}
            {Array.isArray(history) && history.length > 0 &&
              t('send.recipient_history_summary', { sent: history.filter((h) => !h.isReception).length, received: history.filter((h) => h.isReception).length })}
          </Box>
        </>
      )}
    </Box>
  );
}
