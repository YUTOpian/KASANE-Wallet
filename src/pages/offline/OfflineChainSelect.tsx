import { Box } from '@mui/material';
import { useTranslation } from 'react-i18next';
import OptionSelect, { OptionItem } from '../../components/OptionSelect';
import { CHAINS } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { NETWORKS } from '../../lib/symbol/constants';
import type { SymbolNetwork } from '../../lib/symbol/constants';
import { useAppStore } from '../../store/appStore';
import { Heading } from './OfflineTransferFields';

// 「ブロックチェーンネットワーク」: どのブロックチェーン（Symbol / NEM）の、どのネットワーク（メインネット / テストネット）かを、
// 1つの選択肢にまとめて選ぶ（転送トランザクションの画面と同じ並び。"Symbol メインネット" のように、チェーン名つきで出す）。
// mijin v2 は専用のノードが要るので、オフラインの画面では選べない。選んだネットワークは、アプリ全体のネットワークになる。

const PUBLIC_NETWORKS: SymbolNetwork[] = ['mainnet', 'testnet'];

interface Props {
  /** 選べるブロックチェーン（並べる順）。 */
  chains: ChainKey[];
  chain: ChainKey;
  onChain: (chain: ChainKey) => void;
}

export default function OfflineChainSelect({ chains, chain, onChain }: Props) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const setNetwork = useAppStore((s) => s.setNetwork);
  return (
    <Box sx={{ mb: 3, textAlign: 'left' }}>
      <Heading>{t('offline.chain')}</Heading>
      <OptionSelect
        exclusive
        size="small"
        color="primary"
        value={`${chain}:${network}`}
        onChange={(_, v: string | null) => {
          if (v === null) return;
          const [c, net] = v.split(':') as [ChainKey, SymbolNetwork];
          onChain(c);
          if (net !== network) setNetwork(net);
        }}
        aria-label={t('offline.chain')}
        // 選択肢は短い名前（"Symbol Mainnet" など）なので、幅は画面いっぱいにしない（メニューの幅も、この幅に合う）。
        sx={{ width: { xs: '100%', sm: 280 }, maxWidth: '100%' }}
      >
        {chains.flatMap((key) => PUBLIC_NETWORKS.map((net) => (
          <OptionItem key={`${key}:${net}`} value={`${key}:${net}`}>{CHAINS[key].name} {NETWORKS[net].label}</OptionItem>
        )))}
      </OptionSelect>
    </Box>
  );
}
