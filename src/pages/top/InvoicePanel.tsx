import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { WalletsHelper } from '../../lib/storage';
import { useAppStore } from '../../store/appStore';
import InvoiceCard from './InvoiceCard';
import NemInvoiceCard from './NemInvoiceCard';

// 「インボイス」: Home の同名リボンを押すと下に展開される画面。請求書QR（金額・モザイク・メッセージ入りの
// 支払いリクエスト。Symbol は公式のSymbol Walletsの形式、NEM はNEMウォレット（NanoWallet等）の請求書QR）だけを表示する。
export default function InvoicePanel() {
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const [address, setAddress] = useState('');

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActive();
      setAddress(wallet?.address ?? '');
    })();
  }, [network, chain]);

  return <Box sx={{ width: '100%' }}>{address.length > 0 && (chain === 'nem' ? <NemInvoiceCard address={address} /> : <InvoiceCard address={address} />)}</Box>;
}
