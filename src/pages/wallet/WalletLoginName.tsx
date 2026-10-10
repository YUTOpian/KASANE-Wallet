import { useState } from 'react';
import { Box, TextField, Button, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import { WalletsHelper } from '../../lib/storage';

export default function WalletLoginName() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState('');

  const onClickedOk = async () => {
    const wallets = await WalletsHelper.gets();
    const id = wallets[wallets.length - 1].id;
    await WalletsHelper.setName(id, name);
    navigate('/wallet/login/end');
  };

  return (
    <KasaneStage showBack={false} title={t('wallet.login_name_title')} maxWidth={440}>
      <Box sx={{ mt: 2 }}>
        <Typography align="center" sx={{ mx: 2 }}>
          {(t('wallet.login_name_message', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <TextField id="name" label={t('wallet.name_input')} value={name} onChange={(e) => setName(e.target.value)} sx={{ width: '100%' }} />
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 2 }}>
          <Button variant="contained" color="primary" disabled={name.length === 0} onClick={onClickedOk}>OK</Button>
        </Box>
      </Box>
    </KasaneStage>
  );
}
