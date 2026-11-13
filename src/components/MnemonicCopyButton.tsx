import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Snackbar, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTranslation } from 'react-i18next';
import { copySecretToClipboard } from '../lib/clipboardSecret';

interface MnemonicCopyButtonProps {
  // The recovery phrase (words separated by spaces). Nothing is rendered until it is on screen.
  mnemonic: string;
}

// 「ニーモニックをまとめてコピー」: 押すと確認のポップアップを出し、OK のときだけクリップボードに
// 24 単語を 1 行（スペース区切り）で入れる。クリップボードは他のアプリからも読めるため、先に注意を伝える。
export default function MnemonicCopyButton({ mnemonic }: MnemonicCopyButtonProps) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<'' | 'done' | 'failed'>('');

  if (mnemonic.length === 0) return null;

  const copy = async () => {
    setConfirmOpen(false);
    try {
      await copySecretToClipboard(mnemonic);
      setResult('done');
    } catch {
      // Never log the phrase itself.
      setResult('failed');
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, mx: 2 }}>
      <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => setConfirmOpen(true)}>
        {t('wallet.mnemonic_copy_button')}
      </Button>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('wallet.mnemonic_copy_title')}</DialogTitle>
        <DialogContent>
          <Typography>{t('wallet.mnemonic_copy_message')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" color="primary" onClick={() => { void copy(); }}>OK</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={result !== ''}
        autoHideDuration={3000}
        onClose={() => setResult('')}
        message={result === 'failed' ? t('wallet.mnemonic_copy_failed') : t('wallet.mnemonic_copy_done')}
      />
    </Box>
  );
}
