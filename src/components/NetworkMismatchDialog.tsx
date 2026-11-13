import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { CHAINS } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { NETWORKS } from '../lib/symbol/constants';
import type { SymbolNetwork } from '../lib/symbol/constants';
import { useAppStore } from '../store/appStore';

interface Props {
  open: boolean;
  /** Network the scanned / typed address belongs to (null when it cannot be told). */
  otherNetwork: SymbolNetwork | null;
  onClose: () => void;
}

/**
 * 警告モーダル: the address or code is for the other network (mainnet vs testnet) than the one the app is
 * using. Sending to it would be refused, so say so plainly and offer to switch the app to that network.
 */
export default function NetworkMismatchDialog({ open, otherNetwork, onClose }: Props) {
  const { t } = useTranslation();
  const chain: ChainKey = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const setNetwork = useAppStore((s) => s.setNetwork);
  const chainName = CHAINS[chain].name;
  const current = NETWORKS[network].label;
  const other = otherNetwork ? NETWORKS[otherNetwork].label : null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ color: 'error.main' }}>{t('guide.mismatch_title')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {other
            ? t('guide.mismatch_message_known', { chain: chainName, other, current })
            : t('guide.mismatch_message_unknown', { chain: chainName, current })}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('guide.mismatch_hint')}</Typography>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'center', pb: 2, gap: 1 }}>
        {otherNetwork && (
          <Button variant="outlined" onClick={() => { setNetwork(otherNetwork); onClose(); }}>
            {t('guide.mismatch_switch', { network: other })}
          </Button>
        )}
        <Button variant="contained" onClick={onClose}>{t('guide.mismatch_close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
