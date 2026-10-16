import { Box, Typography } from '@mui/material';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PetsOutlinedIcon from '@mui/icons-material/PetsOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import DrawOutlinedIcon from '@mui/icons-material/DrawOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import HowToVoteOutlinedIcon from '@mui/icons-material/HowToVoteOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ChoiceCard, { choiceGridSx } from '../../components/ChoiceCard';

// NEM 「サービス」: the NEM-only extras (SuperNode Program, Apostille, Signed message, NEMonster, Voting) gathered behind one menu entry, as tiles.
export default function ServiceHub() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tiles = [
    { icon: DnsOutlinedIcon, title: t('home.nav_supernode'), desc: t('service.supernode_desc'), to: '/supernode' },
    { icon: VerifiedOutlinedIcon, title: t('home.nav_apostille'), desc: t('service.apostille_desc'), to: '/apostille' },
    { icon: LanguageOutlinedIcon, title: t('home.nav_dns'), desc: t('service.dns_desc'), to: '/dns' },
    { icon: DrawOutlinedIcon, title: t('home.nav_signmsg'), desc: t('service.signmsg_desc'), to: '/signed-message' },
    { icon: PetsOutlinedIcon, title: t('home.nav_nemonster'), desc: t('service.nemonster_desc'), to: '/nemonster' },
    { icon: HowToVoteOutlinedIcon, title: t('home.nav_voting'), desc: t('service.voting_desc'), to: '/voting' },
    // Symbol 事前オプトイン（NEM Wallet 2.5.0 当時の画面）の体験。実際の送信はしない。
    { icon: SwapHorizOutlinedIcon, title: t('home.nav_optin'), desc: t('service.optin_desc'), to: '/optin' },
    // Symbol 事後オプトイン（NEM Wallet 2.5.1 当時の画面）の体験。実際の送信はしない。パスワードは画面の中で聞く（事前オプトインも、確定のところで聞く）。
    { icon: SwapHorizOutlinedIcon, title: t('home.nav_post_optin'), desc: t('service.post_optin_desc'), to: '/post-optin' },
  ];
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 300 }}>{t('home.nav_service')}</Typography>
        <Box sx={{ ...choiceGridSx, justifyContent: 'start', mt: 2 }}>
          {tiles.map((s) => <ChoiceCard key={s.to} icon={s.icon} title={s.title} desc={s.desc} onClick={() => navigate(s.to)} />)}
        </Box>
      </Box>
    </Box>
  );
}
