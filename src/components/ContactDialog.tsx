import { useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormHelperText, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { parseWatchAddress } from '../lib/watchAddress';
import { CHAINS } from '../lib/chain';
import { CONTACT_LISTS, LIMITS } from '../lib/addressBook';
import type { AddressBookEntry, ContactError, ContactList } from '../lib/addressBook';
import { useAddressBookStore } from '../store/addressBookStore';

interface ContactDialogProps {
  open: boolean;
  onClose: () => void;
  /** 編集する連絡先。無ければ新規追加。 */
  entry?: AddressBookEntry | null;
  /** 新規追加のときの初期値（署名依頼の送信者を追加する、など）。 */
  initial?: { address?: string; name?: string; list?: ContactList };
  onSaved?: (entry: AddressBookEntry) => void;
}

/** 連絡先の追加・編集（名前・アドレス・メール・電話・メモ、ホワイトリスト / ブラックリスト）。 */
export default function ContactDialog({ open, onClose, entry, initial, onSaved }: ContactDialogProps) {
  const { t } = useTranslation();
  const addContact = useAddressBookStore((s) => s.addContact);
  const updateContact = useAddressBookStore((s) => s.updateContact);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [memo, setMemo] = useState('');
  const [list, setList] = useState<ContactList>('white');
  const [error, setError] = useState<ContactError | null>(null);
  const [busy, setBusy] = useState(false);

  // 開くたびに、編集する連絡先（または初期値）で入れ直す。
  useEffect(() => {
    if (!open) return;
    setName(entry?.name ?? initial?.name ?? '');
    setAddress(entry?.address ?? initial?.address ?? '');
    setEmail(entry?.email ?? '');
    setPhone(entry?.phone ?? '');
    setMemo(entry?.memo ?? '');
    setList(entry?.list ?? initial?.list ?? 'white');
    setError(null);
    setBusy(false);
    // 開いた瞬間の値だけを使う（親が毎回新しい initial を渡しても、入力中の内容を巻き戻さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const detected = address.trim() === '' ? null : parseWatchAddress(address.trim());

  const onSave = async () => {
    setBusy(true);
    try {
      const input = { name, address, email, phone, memo, list };
      const result = entry ? await updateContact(entry.id, input) : await addContact(input);
      if (!result.ok) { setError(result.error); return; }
      onSaved?.(result.entry);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const errorFor = (...kinds: ContactError[]) => (error !== null && kinds.includes(error) ? t(`addressbook.error_${error}`) : '');

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{entry ? t('addressbook.edit_title') : t('addressbook.add_title')}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField
            label={t('addressbook.field_name')}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            error={errorFor('name_required') !== ''}
            helperText={errorFor('name_required')}
            slotProps={{ htmlInput: { maxLength: LIMITS.name, autoComplete: 'off' } }}
            fullWidth
            autoFocus={!entry && !initial?.name}
          />
          <TextField
            label={t('addressbook.field_address')}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(null); }}
            error={errorFor('invalid_address', 'duplicate', 'limit') !== ''}
            helperText={errorFor('invalid_address', 'duplicate', 'limit') || (detected ? `${CHAINS[detected.chain].name} ${t(`addressbook.network_${detected.network}`)}` : t('addressbook.field_address_hint'))}
            slotProps={{
              htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false },
              formHelperText: { sx: { wordBreak: 'break-all' } },
            }}
            fullWidth
            multiline
          />
          <TextField
            label={t('addressbook.field_email')}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            error={errorFor('invalid_email') !== ''}
            helperText={errorFor('invalid_email')}
            type="email"
            slotProps={{ htmlInput: { maxLength: LIMITS.email, autoComplete: 'off' } }}
            fullWidth
          />
          <TextField
            label={t('addressbook.field_phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            slotProps={{ htmlInput: { maxLength: LIMITS.phone, autoComplete: 'off' } }}
            fullWidth
          />
          <TextField
            label={t('addressbook.field_memo')}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            slotProps={{ htmlInput: { maxLength: LIMITS.memo } }}
            fullWidth
            multiline
            minRows={2}
            maxRows={6}
          />
          <Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 0.75 }}>{t('addressbook.field_list')}</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color={list === 'black' ? 'error' : 'primary'}
              value={list}
              onChange={(_, v: ContactList | null) => { if (v) setList(v); }}
            >
              {CONTACT_LISTS.map((l) => (
                <ToggleButton key={l} value={l} sx={{ textTransform: 'none' }}>{t(`addressbook.list_${l}`)}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            <FormHelperText>{t(`addressbook.list_${list}_hint`)}</FormHelperText>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={onSave} disabled={busy}>{t('addressbook.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}
