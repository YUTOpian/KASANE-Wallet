import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import {
  MAX_METADATA_ENTRIES_AT_CREATION, MAX_METADATA_VALUE_BYTES, draftErrors, encodeValue, keyToHex, parseMetadataKey,
} from '../lib/symbol/metadata';
import type { MetadataDraft } from '../lib/symbol/metadata';

interface Props {
  drafts: MetadataDraft[];
  onChange: (drafts: MetadataDraft[]) => void;
}

let nextDraftId = 1;
/** A new empty row for the editor. */
export function newMetadataDraft(): MetadataDraft {
  nextDraftId += 1;
  return { id: nextDraftId, key: '', value: '' };
}

// 「メタデータ（任意）」: key/value rows shown on the mosaic-creation and namespace-registration
// forms. The rows are sent in the same transaction as the creation / registration.
export default function MetadataEntriesEditor({ drafts, onChange }: Props) {
  const { t } = useTranslation();
  const errors = draftErrors(drafts);

  const update = (id: number, patch: Partial<MetadataDraft>) =>
    onChange(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  return (
    <Box sx={{ mt: 3 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('metadata.optional_title')}</Typography>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>
        {t('metadata.optional_hint')}
      </Typography>

      {drafts.map((d, i) => {
        const error = errors[i];
        const key = parseMetadataKey(d.key);
        const bytes = encodeValue(d.value).length;
        return (
          <Box key={d.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 1.5, mb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <TextField
                label={t('metadata.key_label')}
                value={d.key}
                onChange={(e) => update(d.id, { key: e.target.value })}
                error={error === 'key_required' || error === 'duplicate_key'}
                helperText={key !== null ? t('metadata.key_resolved', { hex: keyToHex(key) }) : t('metadata.key_hint')}
                fullWidth
                size="small"
                slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
              />
              <IconButton aria-label={t('metadata.remove_row')} onClick={() => onChange(drafts.filter((x) => x.id !== d.id))}>
                <DeleteOutlineIcon />
              </IconButton>
            </Box>
            <TextField
              label={t('metadata.value_label')}
              value={d.value}
              onChange={(e) => update(d.id, { value: e.target.value })}
              error={error === 'value_required' || error === 'value_too_long'}
              helperText={t('metadata.value_bytes', { bytes, max: MAX_METADATA_VALUE_BYTES })}
              fullWidth
              multiline
              minRows={2}
              size="small"
              sx={{ mt: 1.5 }}
            />
            {error !== null && (
              <Typography variant="caption" sx={{ display: 'block', color: 'error.main', mt: 0.5 }}>
                {t(`metadata.draft_error_${error}`)}
              </Typography>
            )}
          </Box>
        );
      })}

      {drafts.length < MAX_METADATA_ENTRIES_AT_CREATION && (
        <Button startIcon={<AddIcon />} variant="outlined" onClick={() => onChange([...drafts, newMetadataDraft()])}>
          {t('metadata.add_row')}
        </Button>
      )}
    </Box>
  );
}
