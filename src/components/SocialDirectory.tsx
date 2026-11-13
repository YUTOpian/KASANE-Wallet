import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Alert, Box, Button, ButtonBase, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import TextField from '@mui/material/TextField';
import PersonAddAltOutlinedIcon from '@mui/icons-material/PersonAddAltOutlined';
import SearchIcon from '@mui/icons-material/Search';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import SocialMetadataCard, { SocialAvatar } from './SocialMetadataView';
import { prettyChainAddress } from '../lib/chainApi';
import { findEntry } from '../lib/addressBook';
import type { ContactList } from '../lib/addressBook';
import { parseWatchAddress } from '../lib/watchAddress';
import { useAddressBook } from '../hooks/useAddressBook';
import ContactDialog from './ContactDialog';
import { useAppStore } from '../store/appStore';
import { useSocialHiddenStore } from '../store/socialHiddenStore';
import { fetchSocialDirectoryPage, matchesSocialQuery } from '../lib/symbol/socialMetadata';
import type { SocialDirectoryItem, SocialDirectoryPage } from '../lib/symbol/socialMetadata';

// 「サービス」の「ソーシャルメタデータ」: S.M.D（実際に登録されているものを見る・検索する）と、登録（自分のアドレスに登録する）の2択。

const MAX_PAGES = 1000; // 100件 × 1,000ページ。登録数の上限ではなく、終わらないときの安全装置（最後のページまで読む）
const PAGE_TRIES = 3; // 1ページあたりの試行回数（一時的な失敗で、以降の登録が丸ごと読み込まれなくなるのを防ぐ）
const RETRY_WAIT_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 1ページ分を読む。通信の一時的な失敗（混雑・制限など）は、少し待ってやり直す。 */
async function fetchPageWithRetry(page: number, isCancelled: () => boolean): Promise<SocialDirectoryPage> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchSocialDirectoryPage(page);
    } catch (e) {
      if (attempt >= PAGE_TRIES || isCancelled()) throw e;
      await sleep(RETRY_WAIT_MS * attempt);
    }
  }
}

const SHOW_STEP = 60; // 一度に並べる数（アイコンを取りに行く数を抑える）

function BigTile({ icon, label, onClick }: { icon: ReactElement; label: string; onClick: () => void }): ReactElement {
  return (
    <ButtonBase
      onClick={onClick}
      sx={{
        width: 78, height: 78, borderRadius: '18px', bgcolor: 'primary.main', color: 'primary.contrastText',
        display: 'flex', flexDirection: 'column', gap: 0.5, fontWeight: 'bold', fontSize: '0.8rem',
      }}
    >
      {icon}
      {label}
    </ButtonBase>
  );
}

/** S.M.D の一覧（画面の中身）。登録された順（新しい順）に、ノードから100件ずつ、最後のページまで集める。 */
export function SocialDirectoryView(): ReactElement {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [items, setItems] = useState<SocialDirectoryItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'done' | 'failed'>('loading');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(SHOW_STEP);
  const [selected, setSelected] = useState<SocialDirectoryItem | null>(null);
  // 非表示にした登録（この端末だけ）。初めは一覧に出さず、「非表示にした項目を表示」で、薄く並べて見られる（そこから解除できる）。
  const hidden = useSocialHiddenStore((st) => st.hidden);
  const hide = useSocialHiddenStore((st) => st.hide);
  const unhide = useSocialHiddenStore((st) => st.unhide);
  const [showHidden, setShowHidden] = useState(false);
  // マイ連絡先への追加: 詳細から、登録内容（名前・URL・ネームスペース）を入れた追加ダイアログを開く。保存するかどうかと区分は、その場で選ぶ。
  const { entries: contacts } = useAddressBook();
  const [addingContact, setAddingContact] = useState<ContactList | null>(null); // 開いている追加ダイアログの区分（無ければ閉じている）
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setStatus('loading');
    setShown(SHOW_STEP);
    (async () => {
      const seen = new Set<string>();
      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const res = await fetchPageWithRetry(page, () => cancelled);
          if (cancelled) return;
          const fresh = res.items.filter((i) => !seen.has(i.address) && seen.add(i.address));
          if (fresh.length > 0) setItems((prev) => [...prev, ...fresh]);
          if (!res.hasMore) break;
        }
        if (!cancelled) setStatus('done');
      } catch {
        if (!cancelled) setStatus('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const savedContact = useMemo(() => {
    if (selected === null) return null;
    const parsed = parseWatchAddress(selected.address);
    return parsed ? findEntry(contacts, parsed.chain, parsed.network, parsed.address) : null;
  }, [selected, contacts]);
  const contactMemo = useMemo(() => {
    if (selected === null) return '';
    const { url, namespace } = selected.meta;
    return [t('social.contact_memo_head'), url !== '' ? `URL: ${url}` : '', namespace !== '' ? `${t('social.contact_memo_namespace')}: ${namespace}` : ''].filter((l) => l !== '').join('\n');
  }, [selected, t]);

  const hiddenCount = useMemo(() => items.filter((i) => hiddenSet.has(i.address)).length, [items, hiddenSet]);
  const matched = useMemo(
    () => items.filter((i) => (showHidden || !hiddenSet.has(i.address)) && matchesSocialQuery(i, query)),
    [items, query, showHidden, hiddenSet],
  );
  const visible = matched.slice(0, shown);

  return (
    <>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 400, color: 'primary.main', mb: 2 }}>{t('social.title')}</Typography>
        <TextField
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShown(SHOW_STEP); }}
          placeholder={t('social.search')}
          fullWidth
          size="small"
          slotProps={{
            input: { startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />, sx: { borderRadius: 6 } },
            htmlInput: { 'aria-label': t('social.search'), autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false },
          }}
          sx={{ mb: 2, maxWidth: 560 }}
        />
        {hiddenCount > 0 && (
          <Box sx={{ mb: 2 }}>
            <Button
              size="small"
              startIcon={showHidden ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
              onClick={() => { setShowHidden((v) => !v); setShown(SHOW_STEP); }}
            >
              {showHidden ? t('social.hidden_hide') : t('social.hidden_show', { count: hiddenCount })}
            </Button>
          </Box>
        )}
        {status === 'failed' && <Alert severity="error" sx={{ mb: 2 }}>{t('social.dir_failed')}</Alert>}
        {status === 'done' && items.length === 0 && <Typography color="text.secondary">{t('social.dir_empty')}</Typography>}
        {status === 'done' && items.length > 0 && matched.length === 0 && <Typography color="text.secondary">{t('social.dir_no_match')}</Typography>}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))', gap: 1.5, justifyItems: 'center' }}>
          {visible.map((item) => (
            <ButtonBase
              key={item.address}
              onClick={() => setSelected(item)}
              title={item.meta.name}
              sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, width: 68, borderRadius: 2, p: 0.5, alignItems: 'center', opacity: hiddenSet.has(item.address) ? 0.45 : 1 }}
            >
              <SocialAvatar meta={item.meta} size={60} personFallback />
              <Typography noWrap sx={{ width: '100%', fontSize: '0.78rem', color: 'primary.main', fontWeight: 600 }}>{item.meta.name || item.meta.namespace}</Typography>
            </ButtonBase>
          ))}
        </Box>
        {matched.length > shown && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button onClick={() => setShown((n) => n + SHOW_STEP)}>{t('social.dir_more', { count: matched.length - shown })}</Button>
          </Box>
        )}
        {status === 'loading' && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>{t('social.dir_note')}</Typography>
      </Box>

      {/* 1件の詳細: アドレス・名前・ネームスペース・URL（押すと、確認のあと URL を開く）。 */}
      <Dialog open={selected !== null} onClose={() => setSelected(null)} maxWidth="xs" fullWidth>
        {selected !== null && (
          <>
            <DialogTitle sx={{ fontWeight: 'bold' }}>{selected.meta.name || t('social.title')}</DialogTitle>
            <DialogContent>
              <Typography variant="caption" color="text.secondary">{t('social.open_address')}</Typography>
              <Typography sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.9rem' }}>{prettyChainAddress(selected.address)}</Typography>
              <SocialMetadataCard address={selected.address} loadImage />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 2 }}>
                {savedContact !== null ? (
                  <Button variant="outlined" fullWidth startIcon={<PersonAddAltOutlinedIcon />} disabled>{t('social.contact_saved')}</Button>
                ) : (
                  <>
                    <Button variant="outlined" fullWidth startIcon={<PersonAddAltOutlinedIcon />} onClick={() => setAddingContact('white')}>{t('social.contact_add')}</Button>
                    <Button variant="outlined" color="error" fullWidth startIcon={<BlockOutlinedIcon />} onClick={() => setAddingContact('black')}>{t('social.contact_add_black')}</Button>
                  </>
                )}
              </Box>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
              {hiddenSet.has(selected.address)
                ? <Button onClick={() => { unhide(selected.address); setSelected(null); }} startIcon={<VisibilityOutlinedIcon />} sx={{ mr: 'auto' }}>{t('social.unhide')}</Button>
                : <Button onClick={() => { hide(selected.address); setSelected(null); }} startIcon={<VisibilityOffOutlinedIcon />} sx={{ mr: 'auto' }}>{t('social.hide')}</Button>}
              <Button onClick={() => setSelected(null)} color="inherit">{t('common.close')}</Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <ContactDialog
        open={addingContact !== null && selected !== null}
        onClose={() => setAddingContact(null)}
        initial={selected === null ? undefined : { address: selected.address, name: selected.meta.name || selected.meta.namespace, memo: contactMemo, list: addingContact ?? 'white' }}
      />
    </>
  );
}

/** 「サービス」のタイルを押したときの、最初のダイアログ: S.M.D（一覧の画面へ）と 登録（登録の画面へ）。 */
export default function SocialMenuDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ color: 'primary.main', fontWeight: 'bold' }}>{t('social.title')}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-around', gap: 2, py: 1 }}>
            <BigTile icon={<SearchIcon />} label={t('social.menu_smd')} onClick={() => { onClose(); navigate('/social-directory'); }} />
            <BigTile icon={<PersonAddAltOutlinedIcon />} label={t('social.menu_register')} onClick={() => { onClose(); navigate('/social-metadata'); }} />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'flex-start' }}>
          <Button variant="outlined" color="inherit" onClick={onClose} sx={{ minWidth: 120, py: 1 }}>{t('common.cancel')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
