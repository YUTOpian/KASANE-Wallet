import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Avatar, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import PersonIcon from '@mui/icons-material/Person';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { cachedSocialMetadata, loadSocialImage, loadSocialMetadata, safeHttpUrl } from '../lib/symbol/socialMetadata';
import type { SocialMetadata } from '../lib/symbol/socialMetadata';
import { prettyChainAddress } from '../lib/chainApi';

// ソーシャルメタデータの表示部品。履歴・取引の詳細・送金先の情報で共通に使う。
// 値は他人が書いたものなので、文字は React が必ずエスケープして出し、URL は http(s) のときだけリンクにする。
// 「本人の申告」であって、本人確認ではない。URL の先で、アドレス・ネームスペースが合っているかを人が確かめる。

/** そのアドレスのソーシャルメタデータ。無い・取れないときは null、読み込み中は 'loading'。Symbol 以外・@エイリアスは null。 */
export function useSocialMetadata(address: string | null | undefined): SocialMetadata | null | 'loading' {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const usable = chain === 'symbol' && !!address && !address.startsWith('@');
  const [state, setState] = useState<{ key: string; value: SocialMetadata | null } | null>(null);
  const key = usable ? `${network}:${address}` : '';

  useEffect(() => {
    if (!usable || !address) return undefined;
    let cancelled = false;
    loadSocialMetadata(address).then((value) => { if (!cancelled) setState({ key, value }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!usable || !address) return null;
  const cached = cachedSocialMetadata(address);
  if (cached !== undefined) return cached;
  return state !== null && state.key === key ? state.value : 'loading';
}

/** アイコン。画像が使えない（読み込まない設定・取れない）ときは名前の頭文字の丸。 */
export function SocialAvatar({ meta, size = 40, loadImage = true, personFallback = false }: { meta: SocialMetadata; size?: number; loadImage?: boolean; personFallback?: boolean }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!loadImage || meta.imageUrl === '') return undefined;
    let cancelled = false;
    loadSocialImage(meta.imageUrl).then((url) => { if (!cancelled) setSrc(url); });
    return () => { cancelled = true; };
  }, [meta.imageUrl, loadImage]);
  const initial = Array.from(meta.name.trim())[0] ?? '?';
  return (
    <Avatar src={src ?? undefined} alt="" slotProps={{ img: { referrerPolicy: 'no-referrer' } }} sx={{ width: size, height: size, fontSize: size * 0.45, flexShrink: 0 }}>
      {personFallback ? <PersonIcon sx={{ fontSize: size * 0.85 }} /> : initial}
    </Avatar>
  );
}

/** URL を開く前の確認。飛んだ先で、アドレス・ネームスペースが合っているかを確かめてもらう。 */
export function SocialOpenDialog({ open, address, meta, onClose }: { open: boolean; address: string; meta: SocialMetadata; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const href = safeHttpUrl(meta.url);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 'bold' }}>{t('social.open_title')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>{t('social.open_lead')}</Typography>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1, mb: 1.5 }}>
          <Typography variant="caption" color="text.secondary">{t('social.open_address')}</Typography>
          <Typography sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.9rem' }}>{prettyChainAddress(address)}</Typography>
          {meta.namespace !== '' && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{t('social.field_namespace')}</Typography>
              <Typography sx={{ wordBreak: 'break-all' }}>{meta.namespace}</Typography>
            </>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{t('social.open_url')}</Typography>
          <Typography sx={{ wordBreak: 'break-all' }}>{href ?? meta.url}</Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">{t('social.open_note')}</Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">{t('common.cancel')}</Button>
        <Button
          variant="contained"
          disabled={href === null}
          startIcon={<OpenInNewIcon />}
          onClick={() => { if (href) window.open(href, '_blank', 'noopener,noreferrer'); onClose(); }}
        >
          {t('social.open_go')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 履歴の行に入れる、小さな表示: アイコン＋名前（押すと URL の確認）。行全体が押せるボタンなので、ここは role="link" の span。 */
export function SocialInline({ address, loadImage }: { address: string; loadImage: boolean }): ReactElement | null {
  const meta = useSocialMetadata(address);
  const [open, setOpen] = useState(false);
  if (meta === null || meta === 'loading') return null;
  const canOpen = safeHttpUrl(meta.url) !== null;
  return (
    <>
      <Box
        component="span"
        role={canOpen ? 'link' : undefined}
        tabIndex={canOpen ? 0 : undefined}
        title={t_title(meta)}
        onClick={canOpen ? (e) => { e.stopPropagation(); setOpen(true); } : undefined}
        onKeyDown={canOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(true); } } : undefined}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, maxWidth: '100%', cursor: canOpen ? 'pointer' : 'default', verticalAlign: 'middle' }}
      >
        <SocialAvatar meta={meta} size={22} loadImage={loadImage} />
        <Box component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere', color: 'text.primary', textDecoration: canOpen ? 'underline dotted' : 'none', textUnderlineOffset: 3 }}>{meta.name || meta.namespace}</Box>
      </Box>
      <Box onClick={(e) => e.stopPropagation()} sx={{ display: 'contents' }}>
        {open && <SocialOpenDialog open address={address} meta={meta} onClose={() => setOpen(false)} />}
      </Box>
    </>
  );
}

const t_title = (meta: SocialMetadata) => [meta.name, meta.namespace ? `@${meta.namespace}` : '', meta.url].filter(Boolean).join(' / ');

/** 取引の詳細・送金先の情報に出すカード。メタデータが無いアドレスでは何も出さない。 */
export default function SocialMetadataCard({ address, label, loadImage = false }: { address: string; label?: string; loadImage?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const meta = useSocialMetadata(address);
  const [open, setOpen] = useState(false);
  const [imageOn, setImageOn] = useState(loadImage);
  if (meta === null || meta === 'loading') return null;
  const href = safeHttpUrl(meta.url);
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, my: 1.5, bgcolor: 'background.paper', textAlign: 'left' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1, color: 'primary.main' }}>
        <VerifiedUserOutlinedIcon sx={{ fontSize: 18 }} />
        <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{label ?? t('social.card_title')}</Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
        <SocialAvatar meta={meta} size={52} loadImage={imageOn} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 'bold', overflowWrap: 'anywhere' }}>{meta.name || '-'}</Typography>
          {meta.namespace !== '' && <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{t('social.field_namespace')}: {meta.namespace}</Typography>}
          {href !== null && (
            <Link component="button" type="button" underline="always" onClick={() => setOpen(true)} sx={{ textAlign: 'left', overflowWrap: 'anywhere', fontSize: '0.85rem' }}>
              {href}
            </Link>
          )}
        </Box>
      </Box>
      {!imageOn && meta.imageUrl !== '' && (
        <Button size="small" onClick={() => setImageOn(true)} sx={{ mt: 1, px: 0 }}>{t('social.load_image')}</Button>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{t('social.card_note')}</Typography>
      {open && <SocialOpenDialog open address={address} meta={meta} onClose={() => setOpen(false)} />}
    </Box>
  );
}
