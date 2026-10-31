import { useEffect, useState } from 'react';
import { Avatar, Box, Button, Card, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import { CHAINS } from '../../lib/chain';
import { chainLogo } from '../../lib/chainIcons';
import { WalletsHelper } from '../../lib/storage';
import WatchAddressDialog from '../../components/WatchAddressDialog';

interface Props {
  // アドレスを追加できたら呼ぶ（Home が読み込み直す）。
  onDone: () => void;
}

// 閲覧用プロファイルで、選んだチェーン（Symbol / NEM）のアドレスがまだ無いときに Home に出す案内。
// 通常のプロファイルの「NEMを使えるようにする」（NemSetup）に当たるもので、こちらはアドレスを追加する。
export default function WatchAddressEmpty({ onDone }: Props) {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState('');

  useEffect(() => {
    WalletsHelper.getActiveAny().then((wallet) => setProfileId(wallet?.id ?? ''));
  }, []);

  const name = CHAINS[chain].name;
  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, mt: 4 }}>
      <Card sx={{ px: 3, py: 4, textAlign: 'center' }}>
        <Avatar src={chainLogo(chain, network)} sx={{ width: 72, height: 72, mx: 'auto', bgcolor: 'transparent' }} />
        <Typography variant="h6" sx={{ fontWeight: 700, mt: 2 }}>{t('watch.empty_title', { chain: name })}</Typography>
        <Typography color="text.secondary" sx={{ mt: 1.5, lineHeight: 1.7 }}>{t('watch.empty_message', { chain: name })}</Typography>
        <Button variant="contained" size="large" disabled={profileId === ''} onClick={() => setOpen(true)} sx={{ mt: 3 }}>
          {t('watch.empty_button', { chain: name })}
        </Button>
      </Card>
      <WatchAddressDialog open={open} profileWalletId={profileId} onClose={() => setOpen(false)} onAdded={() => { setOpen(false); onDone(); }} />
    </Box>
  );
}
