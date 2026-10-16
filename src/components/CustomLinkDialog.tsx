import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { ChainKey } from '../lib/chain';
import { CUSTOM_LINK_LIMITS, LINK_SCOPES } from '../lib/customLinks';
import type { CustomLink, LinkScope } from '../lib/customLinks';
import { useCustomLinksStore } from '../store/customLinksStore';
import type { CustomLinkError } from '../store/customLinksStore';

interface CustomLinkDialogProps {
  open: boolean;
  onClose: () => void;
  chain: ChainKey;
  /** The link being edited; none = a new link. */
  link?: CustomLink | null;
}

/** Add / edit / delete one of the person's own links. */
export default function CustomLinkDialog({ open, onClose, chain, link }: CustomLinkDialogProps) {
  const { t } = useTranslation();
  const addLink = useCustomLinksStore((s) => s.addLink);
  const updateLink = useCustomLinksStore((s) => s.updateLink);
  const removeLink = useCustomLinksStore((s) => s.removeLink);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [scope, setScope] = useState<LinkScope>(chain);
  const [error, setError] = useState<CustomLinkError | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(link?.title ?? '');
    setUrl(link?.url ?? '');
    setScope(link?.scope ?? chain);
    setError(null);
  }, [open, link, chain]);

  const save = () => {
    const result = link ? updateLink(link.id, scope, title, url) : addLink(scope, title, url);
    if (result) { setError(result); return; }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t(link ? 'guide.custom_edit' : 'guide.custom_add')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField
          label={t('guide.custom_name')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          slotProps={{ htmlInput: { maxLength: CUSTOM_LINK_LIMITS.title } }}
          fullWidth
        />
        <TextField
          label={t('guide.custom_url')}
          placeholder="https://"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          error={error !== null}
          helperText={error === 'url' ? t('guide.custom_url_invalid') : error === 'limit' ? t('guide.custom_limit', { max: CUSTOM_LINK_LIMITS.max }) : undefined}
          slotProps={{ htmlInput: { maxLength: CUSTOM_LINK_LIMITS.url, inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          fullWidth
          autoFocus
        />
        <div>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 0.5 }}>{t('guide.custom_scope')}</Typography>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            color="primary"
            value={scope}
            onChange={(_, v: LinkScope | null) => { if (v) { setScope(v); setError(null); } }}
          >
            {LINK_SCOPES.map((s) => <ToggleButton key={s} value={s}>{t(`guide.custom_scope_${s}`)}</ToggleButton>)}
          </ToggleButtonGroup>
        </div>
      </DialogContent>
      <DialogActions sx={{ justifyContent: link ? 'space-between' : 'flex-end', px: 3, pb: 2 }}>
        {link && <Button color="error" onClick={() => { removeLink(link.id); onClose(); }}>{t('common.delete')}</Button>}
        <span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={save} disabled={url.trim() === ''}>{t('guide.custom_save')}</Button>
        </span>
      </DialogActions>
    </Dialog>
  );
}
