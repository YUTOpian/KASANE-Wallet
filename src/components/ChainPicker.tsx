import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import InfoCard from './InfoCard';
import { CHAINS, CHAIN_ORDER } from '../lib/chain';
import type { ChainKey } from '../lib/chain';
import { CHAIN_LOGOS } from '../lib/chainIcons';

// 新規作成・インポート画面に置く、Symbol / NEM の選択タイル。
// 選んだチェーンは、プロファイルを作ったあとにアプリの現在のチェーンになる
// （同じリカバリーフレーズから両チェーンのアカウントが作られるので、あとでメニューから切り替え可能）。
interface ChainPickerProps {
  value: ChainKey;
  onChange: (chain: ChainKey) => void;
}

export default function ChainPicker({ value, onChange }: ChainPickerProps) {
  const { t } = useTranslation();
  return (
    <Box>
      <Typography variant="subtitle1" align="center" sx={{ fontWeight: 700 }}>
        {t('chain.new_profile_title')}
      </Typography>
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mt: 0.5 }}>
        {t('chain.new_profile_desc')}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 2, mt: 2 }}>
        {CHAIN_ORDER.map((key) => (
          <InfoCard
            key={key}
            title={CHAINS[key].name}
            caption={CHAINS[key].currencySymbol}
            selected={key === value}
            onClick={() => onChange(key)}
            action={<Box component="img" src={CHAIN_LOGOS[key]} alt="" sx={{ height: 28, width: 28, objectFit: 'contain' }} />}
          />
        ))}
      </Box>
    </Box>
  );
}
