import { useCallback, useEffect, useState } from 'react';
import { Box, CircularProgress, Divider, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchChainBalances, nativeAssetId } from '../../lib/chainApi';
import type { MosaicBalance } from '../../lib/symbol/api';
import { useAppStore } from '../../store/appStore';

// 「保有モザイク」: Home の同名リボンを押すと下に展開される、このアカウントが持っているモザイクの一覧。
// ネイティブ通貨（XYM / XEM）は残高0でも先頭に出し、そのほかは残高のあるものだけを出す。
export default function MosaicsPanel() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const liveTick = useAppStore((s) => s.liveTick);
  const [list, setList] = useState<MosaicBalance[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) { setList([]); return; }
      const all = await fetchChainBalances(wallet.address);
      setList(all.filter((m) => m.id.toUpperCase() === nativeAssetId().toUpperCase() || m.amount > 0n));
      setFailed(false);
    } catch (e) {
      console.error('Failed to load the mosaics', e);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    setList(null);
    void load();
  }, [load, network, chain]);

  // The node reported something for this account: reload quietly.
  useEffect(() => {
    if (liveTick > 0) void load();
  }, [liveTick, load]);

  if (list === null && !failed) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>;
  }
  if (list === null) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_failed')}</Typography>;
  }
  if (list.length === 0) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_empty')}</Typography>;
  }

  return (
    <Box sx={{ textAlign: 'left' }}>
      {list.map((m, i) => {
        return (
          <Box key={m.id}>
            {i > 0 && <Divider />}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1.5 }}>
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{m.symbol}</Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', wordBreak: 'break-all' }}>
                  {m.id}
                </Typography>
              </Box>
              <Typography sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                {Number(m.balance).toLocaleString(undefined, { maximumFractionDigits: m.divisibility })}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
