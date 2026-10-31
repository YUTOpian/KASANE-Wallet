import { useEffect, useState } from 'react';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { parseWatchAddress } from '../lib/watchAddress';
import { LIMITS } from '../lib/addressBook';
import { useAddressBookStore } from '../store/addressBookStore';

interface SaveContactDialogProps {
  open: boolean;
  /** 送金した相手のアドレス。 */
  address: string;
  onClose: () => void;
}

/** 送金のあとに出す「新しいアドレスを保存しますか」。名前をつけて連絡先に入れる / 入れない（次から聞かない）。 */
export default function SaveContactDialog({ open, address, onClose }: SaveContactDialogProps) {
  const { t } = useTranslation();
  const addContact = useAddressBookStore((s) => s.addContact);
  const dismissSavePrompt = useAddressBookStore((s) => s.dismissSavePrompt);
  const [name, setName] = useState('');
  const [never, setNever] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setNever(false);
    setBusy(false);
    setFailed(false);
  }, [open]);

  const onSave = async () => {
    setBusy(true);
    try {
      const result = await addContact({ name, address });
      // 名前が空・重複など：保存できなかったときはそのまま入力を続けてもらう。
      if (!result.ok) { setFailed(true); return; }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onSkip = async () => {
    const parsed = parseWatchAddress(address);
    if (never && parsed) await dismissSavePrompt(parsed.chain, parsed.network, parsed.address);
    onClose();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : () => { void onSkip(); }} fullWidth maxWidth="xs">
      <DialogTitle>{t('addressbook.save_prompt_title')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>{t('addressbook.save_prompt_message')}</Typography>
        <Box sx={{ p: 1.5, mb: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
          <Typography sx={{ wordBreak: 'break-all', fontSize: '0.9rem' }}>{address}</Typography>
        </Box>
        <TextField
          label={t('addressbook.field_name')}
          value={name}
          onChange={(e) => { setName(e.target.value); setFailed(false); }}
          error={failed}
          helperText={failed ? t('addressbook.error_name_required') : ' '}
          slotProps={{ htmlInput: { maxLength: LIMITS.name, autoComplete: 'off' } }}
          fullWidth
          autoFocus
        />
        <FormControlLabel
          control={<Checkbox checked={never} onChange={(e) => setNever(e.target.checked)} />}
          label={<Typography variant="body2">{t('addressbook.save_prompt_never')}</Typography>}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { void onSkip(); }} disabled={busy}>{t('addressbook.save_prompt_skip')}</Button>
        <Button variant="contained" onClick={onSave} disabled={busy || name.trim() === ''}>{t('addressbook.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}
