import { Box, List, ListItemButton, ListItemText, Divider, Typography, Card, CardActionArea, CardContent } from '@mui/material';
import { useTranslation } from 'react-i18next';
import iconLink from '../../assets/icon_link.png';

const DISCORD_URL = 'https://discord.com/invite/NMA9YQ55td';

const openLink = (url: string) => window.open(url, '_blank', 'noopener');

export default function About() {
  const { t } = useTranslation();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Typography sx={{ m: 1, mt: 3 }}>KASANE Wallet for Symbol</Typography>
      <List>
        <ListItemButton onClick={() => openLink(DISCORD_URL)}>
          <ListItemText primary={t('about.discord')} />
          <Box component="img" src={iconLink} sx={{ width: 24 }} />
        </ListItemButton>
        <Divider />
      </List>

      <Card variant="outlined" sx={{ border: 0 }}>
        <CardActionArea onClick={() => openLink('https://raccoonwallet.com/tos_pp/')}>
          <CardContent>
            <Typography align="center" sx={{ color: 'primary.main', textDecoration: 'underline' }}>
              {t('common.privacy_policy')}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Box>
  );
}
