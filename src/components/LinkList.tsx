import { useMemo, useState } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useTranslation } from 'react-i18next';
import InfoCard, { tileGridSx } from './InfoCard';
import { faucetLink, officialLinks } from '../lib/links';
import { useAppStore } from '../store/appStore';
import { useCustomLinksStore } from '../store/customLinksStore';
import { linkShownOn } from '../lib/customLinks';
import type { CustomLink } from '../lib/customLinks';
import CustomLinkDialog from './CustomLinkDialog';

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
