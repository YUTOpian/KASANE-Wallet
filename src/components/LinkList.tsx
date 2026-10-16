import { useMemo, useState } from 'react';
import { Box, IconButton, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useTranslation } from 'react-i18next';
import InfoCard, { tileGridSx } from './InfoCard';
import { faucetLink, officialLinks } from '../lib/links';
import { CHAINS } from '../lib/chain';
import { NETWORKS } from '../lib/symbol/constants';
import { useAppStore } from '../store/appStore';
import { useCustomLinksStore } from '../store/customLinksStore';
import { linkShownOn } from '../lib/customLinks';
import type { CustomLink } from '../lib/customLinks';
import CustomLinkDialog from './CustomLinkDialog';

/** Faucet (testnet only) and official links of the chain / network the app is on. */
export default function LinkList() {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const faucet = faucetLink(chain, network);
  const links = officialLinks(chain, network);
  const allCustom = useCustomLinksStore((s) => s.links);
  const custom = useMemo(() => allCustom.filter((l) => linkShownOn(l, chain)), [allCustom, chain]);
  const open = (url: string) => window.open(url, '_blank', 'noopener');

  const row = (key: string, label: string, url: string, caption?: string) => (
    <ListItemButton key={key} onClick={() => open(url)} sx={{ borderRadius: 2 }}>
      <ListItemText primary={label} secondary={caption ?? url.replace(/^https?:\/\//, '')} slotProps={{ secondary: { sx: { wordBreak: 'break-all' } } }} />
      <OpenInNewIcon fontSize="small" sx={{ opacity: 0.6 }} />
    </ListItemButton>
  );

  return (
    <Box>
      {faucet && (
        <>
          <Typography sx={{ fontWeight: 700, mt: 1, mx: 1 }}>{t('guide.faucet_title', { chain: CHAINS[chain].name, network: NETWORKS[network].label })}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mx: 1, mb: 0.5 }}>{t('guide.faucet_hint')}</Typography>
          <List disablePadding>{row('faucet', t(faucet.labelKey), faucet.url)}</List>
        </>
      )}
      <Typography sx={{ fontWeight: 700, mt: 2, mx: 1 }}>{t('guide.links_title')}</Typography>
      <List disablePadding>{links.map((l) => row(l.labelKey, t(l.labelKey), l.url))}</List>
      {custom.length > 0 && (
        <>
          <Typography sx={{ fontWeight: 700, mt: 2, mx: 1 }}>{t('guide.custom_title')}</Typography>
          <List disablePadding>{custom.map((l) => row(l.id, l.title, l.url))}</List>
        </>
      )}
    </Box>
  );
}

/** The same links as tiles (like the Settings screen), for the Links screen - plus the person's own links, which can be added, edited and deleted here. */
export function LinkTiles() {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const faucet = faucetLink(chain, network);
  const items = [...(faucet ? [faucet] : []), ...officialLinks(chain, network)];
  const allCustom = useCustomLinksStore((s) => s.links);
  const custom = useMemo(() => allCustom.filter((l) => linkShownOn(l, chain)), [allCustom, chain]);
  // null = closed; 'new' = adding; a link = editing it.
  const [editing, setEditing] = useState<CustomLink | 'new' | null>(null);
  const gridSx = { ...tileGridSx, mx: 0, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))' };
  const shown = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const open = (url: string) => window.open(url, '_blank', 'noopener');

  return (
    <>
      <Box sx={gridSx}>
        {items.map((l) => (
          <InfoCard
            key={l.labelKey}
            title={t(l.labelKey)}
            caption={shown(l.url)}
            action={<OpenInNewIcon fontSize="small" sx={{ opacity: 0.6 }} />}
            onClick={() => open(l.url)}
          />
        ))}
      </Box>

      <Typography sx={{ m: 1, mt: 3, fontWeight: 700 }}>{t('guide.custom_title')}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mx: 1 }}>{t('guide.custom_hint')}</Typography>
      <Box sx={gridSx}>
        {custom.map((l) => (
          <InfoCard
            key={l.id}
            title={l.title}
            caption={shown(l.url)}
            action={(
              <IconButton
                size="small"
                aria-label={t('common.edit')}
                onClick={(e) => { e.stopPropagation(); setEditing(l); }}
                sx={{ mr: -0.5 }}
              >
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            )}
            onClick={() => open(l.url)}
          />
        ))}
        <InfoCard
          title={t('guide.custom_add')}
          action={<AddIcon fontSize="small" sx={{ opacity: 0.6 }} />}
          onClick={() => setEditing('new')}
        />
      </Box>

      <CustomLinkDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        chain={chain}
        link={editing === 'new' ? null : editing}
      />
    </>
  );
}
