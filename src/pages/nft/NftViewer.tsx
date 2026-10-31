import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Dialog, LinearProgress, Link as MuiLink, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { explorerMosaicUrl, fetchBalances } from '../../lib/symbol/api';
import { findNftImage } from '../../lib/symbol/nftImage';
import type { NftImage } from '../../lib/symbol/nftImage';
import { getNetworkConfig } from '../../lib/symbol/network';
import { useAppStore } from '../../store/appStore';

// Symbol の「NFTビューアー」: モザイクに紐づけられた画像（COMSA・NFT-Drive・ウクライナNFT・NEMber ART の形式）を一覧で見る。読むだけで、署名は要らない。
// ・持っているモザイクを順に調べて、画像が紐づいているものをカードで出す。
// ・モザイクID（16桁）を入れて、持っていないモザイクの画像を見ることもできる。
// 取り出しの仕組みは lib/symbol/nftImage.ts。

const SCAN_CONCURRENCY = 3;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };

interface Item { id: string; label: string; image: NftImage }

function NftCard({ item, onOpen }: { item: Item; onOpen: (item: Item) => void }) {
  const { t } = useTranslation();
  const { id, label, image } = item;
  return (
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box
        onClick={() => onOpen(item)}
        sx={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover', cursor: 'zoom-in' }}
      >
        <img src={image.url} alt={label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </Box>
      <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{label}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Chip size="small" label={t(`nftviewer.kind_${image.kind}`)} />
          <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{image.mime.replace('image/', '').toUpperCase()} · {Math.max(1, Math.round(image.bytes / 1024))} KB</Typography>
        </Box>
        <Typography sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary', wordBreak: 'break-all' }}>{id}</Typography>
        <Box sx={{ display: 'flex', gap: 2, fontSize: '0.85rem' }}>
          <MuiLink href={explorerMosaicUrl(id)} target="_blank" rel="noopener noreferrer">{t('nftviewer.open_explorer')}</MuiLink>
          <MuiLink href={image.url} download={`${id}.${EXT[image.mime] ?? 'img'}`}>{t('nftviewer.save')}</MuiLink>
        </Box>
      </Box>
    </Card>
  );
}

export default function NftViewer() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [checked, setChecked] = useState(0);
  const [failed, setFailed] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<Item | null>(null);
  const runRef = useRef(0);

  const [lookupText, setLookupText] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupItem, setLookupItem] = useState<Item | null>(null);

  const scan = useCallback(async () => {
    runRef.current += 1;
    const run = runRef.current;
    setItems([]); setTotal(0); setChecked(0); setFailed(0); setError(''); setScanning(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) { setScanning(false); return; }
      const currency = getNetworkConfig().currencyMosaicId;
      const targets = (await fetchBalances(wallet.address)).filter((b) => b.amount > 0n && b.id !== currency);
      if (run !== runRef.current) return;
      setTotal(targets.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const b = targets[next];
          next += 1;
          if (!b) return;
          try {
            const image = await findNftImage(b.id);
            if (run !== runRef.current) return;
            if (image) setItems((cur) => [...cur, { id: b.id, label: b.name ?? b.id, image }]);
          } catch (e) {
            console.warn('NFT image lookup failed', b.id, e);
            if (run === runRef.current) setFailed((n) => n + 1);
          }
          if (run === runRef.current) setChecked((n) => n + 1);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length) }, worker));
    } catch (e) {
      console.warn('NFT scan failed', e);
      if (run === runRef.current) setError(t('nftviewer.load_error'));
    } finally {
      if (run === runRef.current) setScanning(false);
    }
  }, [t]);

  // 開いたとき、ネットワークを切り替えたときに調べ直す。
  useEffect(() => {
    void scan();
    setLookupItem(null); setLookupError('');
    return () => { runRef.current += 1; };
  }, [scan, network]);

  const lookup = async () => {
    const id = lookupText.trim().toUpperCase();
    setLookupItem(null); setLookupError('');
    if (!/^[0-9A-F]{16}$/.test(id)) { setLookupError(t('nftviewer.lookup_invalid')); return; }
    setLookupBusy(true);
    try {
      const image = await findNftImage(id);
      if (image) setLookupItem({ id, label: id, image });
      else setLookupError(t('nftviewer.lookup_none'));
    } catch (e) {
      console.warn('NFT lookup failed', e);
      setLookupError(t('nftviewer.load_error'));
    } finally {
      setLookupBusy(false);
    }
  };

  const sorted = useMemo(() => [...items].sort((a, b) => a.label.localeCompare(b.label)), [items]);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 2, mt: 2 } as const;

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 300 }}>{t('nftviewer.title')}</Typography>
        <Typography sx={{ mt: 1, color: 'text.secondary' }}>{t('nftviewer.lead')}</Typography>
        <Alert severity="info" sx={{ mt: 2 }}>{t('nftviewer.caution')}</Alert>

        <Box sx={{ mt: 3, display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small" label={t('nftviewer.lookup_label')} value={lookupText} sx={{ width: { xs: '100%', sm: 360 } }}
            onChange={(e) => setLookupText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void lookup(); }}
            error={lookupError !== ''} helperText={lookupError || ' '}
            slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'characters', maxLength: 16 } }}
          />
          <Button variant="outlined" startIcon={lookupBusy ? <CircularProgress size={16} /> : <SearchIcon />} disabled={lookupBusy} onClick={() => void lookup()} sx={{ height: 40 }}>
            {t('nftviewer.lookup_button')}
          </Button>
        </Box>
        {lookupItem && <Box sx={{ ...grid, mt: 0 }}><NftCard item={lookupItem} onOpen={setOpened} /></Box>}

        <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: '1.05rem', fontWeight: 500 }}>{t('nftviewer.mine')}</Typography>
          <Button size="small" startIcon={<RefreshIcon />} disabled={scanning} onClick={() => void scan()}>{t('nftviewer.refresh')}</Button>
        </Box>
        {scanning && (
          <Box sx={{ mt: 1.5 }}>
            <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary' }}>{t('nftviewer.scanning', { done: checked, total })}</Typography>
            <LinearProgress variant={total > 0 ? 'determinate' : 'indeterminate'} value={total > 0 ? (checked / total) * 100 : 0} sx={{ mt: 0.75 }} />
          </Box>
        )}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        {!scanning && !error && items.length === 0 && <Typography sx={{ mt: 2, color: 'text.secondary' }}>{t('nftviewer.none')}</Typography>}
        {!scanning && failed > 0 && <Alert severity="warning" sx={{ mt: 2 }}>{t('nftviewer.failed_some', { count: failed })}</Alert>}
        {sorted.length > 0 && <Box sx={grid}>{sorted.map((it) => <NftCard key={it.id} item={it} onOpen={setOpened} />)}</Box>}
      </Box>

      <Dialog open={opened !== null} onClose={() => setOpened(null)} maxWidth="lg">
        {opened && (
          <Box onClick={() => setOpened(null)} sx={{ p: 1, bgcolor: 'action.hover', cursor: 'zoom-out', display: 'flex', justifyContent: 'center' }}>
            <img src={opened.image.url} alt={opened.label} style={{ maxWidth: '100%', maxHeight: '85vh', objectFit: 'contain' }} />
          </Box>
        )}
      </Dialog>
    </Box>
  );
}
