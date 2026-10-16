import { useMemo, useState } from 'react';
import { Box, Button, Dialog, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { CHAINS } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { WalletsHelper } from '../lib/storage';
import { parseWatchAddress } from '../lib/watchAddress';
import { useAppStore } from '../store/appStore';
import ErrorSnackbar from './ErrorSnackbar';

interface Props {
  open: boolean;
  // 追加先の閲覧用プロファイル（そのアカウントのどれか1つのID）。
  profileWalletId: string;
  onClose: () => void;
  // 追加できたとき。引数は追加したアドレスのチェーン。
  onAdded: (chain: ChainKey) => void;
}

// 閲覧用プロファイルに、見るアドレスを追加するダイアログ。いま選んでいるチェーン（Symbol / NEM）のアドレスを受け付ける。
// メインネット / テストネットどちらのアドレスでもよい（同じアカウントのもう一方のネットワークのアドレスは自動で求まる）。
export default function WatchAddressDialog({ open, profileWalletId, onClose, onAdded }: Props) {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const parsed = useMemo(() => (address.trim() === '' ? null : parseWatchAddress(address)), [address]);
  const wrongChain = parsed !== null && parsed.chain !== chain;
  const invalid = address.trim() !== '' && parsed === null;
  const helper = invalid
    ? t('watch.invalid')
    : wrongChain && parsed
      ? t('watch.add_wrong_chain', { chain: CHAINS[chain].name, other: CHAINS[parsed.chain].name })
      : t('watch.add_hint', { chain: CHAINS[chain].name });

  const submit = async () => {
    if (!parsed || wrongChain || busy) return;
    setBusy(true);
    try {
      const result = await WalletsHelper.addWatchAddressToProfile(profileWalletId, parsed.chain, parsed.address);
      if (result === 'exists') {
        setErrorMessage(t('watch.add_exists'));
        return;
      }
      setAddress('');
      onAdded(parsed.chain);
    } catch (e) {
      console.error('Failed to add the address', e);
      setErrorMessage(t('watch.add_failed'));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setAddress(''); onClose(); };

  return (
    <>
      <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>{t('watch.add_title', { chain: CHAINS[chain].name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('watch.add_message')}</Typography>
          <TextField
            fullWidth
            autoFocus
            multiline
            minRows={2}
            label={t('watch.address_label')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            error={invalid || wrongChain}
            helperText={helper}
            slotProps={{ htmlInput: { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } } }}
            sx={{ mt: 1 }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, py: 2 }}>
            <Button variant="contained" color="primary" disabled={!parsed || wrongChain || busy || profileWalletId === ''} onClick={submit}>OK</Button>
            <Button variant="contained" color="secondary" onClick={close}>CANCEL</Button>
          </Box>
        </DialogContent>
      </Dialog>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </>
  );
}
