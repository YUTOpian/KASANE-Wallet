import { useEffect, useState } from 'react';
import { Avatar, Box, Typography } from '@mui/material';
import { QRCodeSVG } from 'qrcode.react';
import { WalletsHelper } from '../../lib/storage';
import { chainMeta } from '../../lib/chain';
import { activeNetworkLabel, chainAddressQr, nativeIcon } from '../../lib/chainApi';
import { useAppStore } from '../../store/appStore';
import InvoiceCard from './InvoiceCard';

// 「受け取る」: Home の受け取りリボンを押すと下に展開される画面。
// Only the QR is shown (no address text underneath). Symbol: the standard address QR (v3, type 0) readable by the official Symbol wallets; NEM: the NEM wallets' account QR.
export default function ReceivePanel() {
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    (async () => {
      const wallet = await WalletsHelper.getActive();
      setAddress(wallet?.address ?? '');
      setName(wallet?.name ?? '');
    })();
  }, [network, chain]);

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', px: 2, py: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, bgcolor: 'grey.100', borderRadius: 3, px: 2, py: 1.5 }}>
          <Avatar src={nativeIcon()} sx={{ width: 32, height: 32 }} />
          <Typography sx={{ fontWeight: 'bold' }}>{chainMeta(chain).name} {activeNetworkLabel()}</Typography>
        </Box>

        <Box sx={{ mt: 3, p: 1.5, bgcolor: '#fff', borderRadius: 2 }}>
          {address.length > 0 && <QRCodeSVG value={chainAddressQr(address, name)} size={240} />}
        </Box>

        {/* Symbol: a payment request (amount / mosaics / message) in the official wallets' QR format. */}
        {chain !== 'nem' && address.length > 0 && <InvoiceCard address={address} />}
      </Box>
    </>
  );
}
