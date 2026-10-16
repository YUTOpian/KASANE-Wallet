import { useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { useTranslation } from 'react-i18next';
import { downloadPaperWallet } from '../lib/paperWalletExport';
import type { PaperWalletSource } from '../lib/paperWalletExport';

interface PaperWalletButtonProps {
  // What goes on the sheet. Nothing is rendered until the secret has been loaded (source = null).
  source: PaperWalletSource | null;
}

// "Download paper wallet": a KASANE-designed A4 PDF with the recovery phrase / private key, the
// matching QR codes and the account's address, built on this device (see lib/paperWallet.ts).
export default function PaperWalletButton({ source }: PaperWalletButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (source == null) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await downloadPaperWallet(source);
    } catch (e) {
      // Never log the secret itself - only that something went wrong.
      console.error('PaperWalletButton: failed to build the paper wallet', e instanceof Error ? e.message : 'unknown error');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 3, mx: 2 }}>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>
        {t(source.kind === 'mnemonic' ? 'wallet.paper_wallet_hint_mnemonic' : 'wallet.paper_wallet_hint_key')}
      </Typography>
      <Button
        variant="outlined"
        color="primary"
        disabled={busy}
        onClick={onClick}
        startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <FileDownloadOutlinedIcon />}
        sx={{ minWidth: 260 }}
      >
        {busy ? t('wallet.paper_wallet_creating') : t('wallet.paper_wallet_download')}
      </Button>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 12, mt: 1 }}>
        {t('wallet.paper_wallet_caution')}
      </Typography>
      {failed && (
        <Typography align="center" sx={{ color: 'error.main', fontSize: 13, mt: 1 }}>
          {t('wallet.paper_wallet_failed')}
        </Typography>
      )}
    </Box>
  );
}
