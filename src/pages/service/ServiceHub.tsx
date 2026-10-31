import { Box, Typography } from '@mui/material';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PetsOutlinedIcon from '@mui/icons-material/PetsOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import DrawOutlinedIcon from '@mui/icons-material/DrawOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import HowToVoteOutlinedIcon from '@mui/icons-material/HowToVoteOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import CollectionsOutlinedIcon from '@mui/icons-material/CollectionsOutlined';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ChoiceCard, { choiceGridSx } from '../../components/ChoiceCard';
import { useAppStore } from '../../store/appStore';
import { useLedgerProfile, useNoKey, useSssProfile } from '../../hooks/useWatchOnly';

// 「サービス」: the NEM extras (SuperNode Program, Apostille, Signed message, NEMonster, Voting) gathered behind one menu entry, as tiles. Symbol has Apostille, DNS and NEMonster.
export default function ServiceHub() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const chain = useAppStore((st) => st.chain);
  // 閲覧用 / Ledger のプロファイルは、ほかのサービス（署名に秘密鍵が要るもの）が使えないので、NFTビューアーとコンソールだけ出す。
  const keyless = useNoKey(true);
  // SSS Extension のプロファイルは、トランザクションの署名で足りるサービス（DNS・NEMonster・投票）と、NFTビューアー・コンソールが使える。
  // アポスティーユ（署名つき）と署名付きメッセージは、文章やハッシュそのものへの署名が要るので、SSS では使えない（出さない）。
  const sss = useSssProfile();
  // Ledger のプロファイルは、サービスの中では NFTビューアー（Symbol のみ）だけ使える。NEM には出すものが無い（メニューの「サービス」も出さない）。
  const ledger = useLedgerProfile();
  // NEMonster is on both chains; the others are NEM only.
  const nemonsterTile = {
    icon: PetsOutlinedIcon,
    // Symbol 版は「NEMonster」の下に改行して「for Symbol」
    title: chain === 'symbol' ? `${t('home.nav_nemonster')}\nfor Symbol` : t('home.nav_nemonster'),
    desc: t('service.nemonster_desc', { context: chain === 'symbol' ? 'symbol' : undefined }),
    to: '/nemonster',
  };
  // Apostille (notarization) is on both chains; the text says which blockchain the hash goes to.
  const apostilleTile = { icon: VerifiedOutlinedIcon, title: t('home.nav_apostille'), desc: t('service.apostille_desc', { context: chain === 'symbol' ? 'symbol' : undefined }), to: '/apostille' };
  // DNS (a namespace's website and contacts) is on both chains.
  const dnsTile = { icon: LanguageOutlinedIcon, title: t('home.nav_dns'), desc: t('service.dns_desc'), to: '/dns' };
  // 署名付きメッセージ (a text signed with an account's key) is on both chains.
  const signmsgTile = { icon: DrawOutlinedIcon, title: t('home.nav_signmsg'), desc: t('service.signmsg_desc'), to: '/signed-message' };
  // 投票 (polls written as 0-coin transfers) is on both chains, with the same mechanism.
  const votingTile = { icon: HowToVoteOutlinedIcon, title: t('home.nav_voting'), desc: t('service.voting_desc'), to: '/voting' };
  // コンソール (コードを打ち込んで動かす)。Symbol / NEM どちらでも（中身はチェーンに合わせて切り替わる）。
  const consoleTile = { icon: TerminalOutlinedIcon, title: t('home.nav_console'), desc: t('service.console_desc'), to: '/console' };
  // NFTビューアー (モザイクに紐づけられた画像を見る) は Symbol だけ。
  const nftViewerTile = { icon: CollectionsOutlinedIcon, title: t('home.nav_nftviewer'), desc: t('service.nftviewer_desc'), to: '/nft-viewer' };
  const nemTiles = [
    { icon: DnsOutlinedIcon, title: t('home.nav_supernode'), desc: t('service.supernode_desc'), to: '/supernode' },
    apostilleTile,
    dnsTile,
    signmsgTile,
    nemonsterTile,
    votingTile,
    consoleTile,
    // Symbol 事前オプトイン（NEM Wallet 2.5.0 当時の画面）の体験。実際の送信はしない。
    { icon: SwapHorizOutlinedIcon, title: t('home.nav_optin'), desc: t('service.optin_desc'), to: '/optin' },
    // Symbol 事後オプトイン（NEM Wallet 2.5.1 当時の画面）の体験。実際の送信はしない。パスワードは画面の中で聞く（事前オプトインも、確定のところで聞く）。
    { icon: SwapHorizOutlinedIcon, title: t('home.nav_post_optin'), desc: t('service.post_optin_desc'), to: '/post-optin' },
  ];
  // Ledger のコンソールは、診断ログだけ開ける（コードの実行は署名できないので出さない）。
  const tiles = ledger ? [nftViewerTile]
    : keyless ? (chain === 'symbol' ? [nftViewerTile, consoleTile] : [consoleTile])
    : sss ? (chain === 'symbol' ? [dnsTile, nemonsterTile, votingTile, nftViewerTile, consoleTile] : [consoleTile])
    : chain === 'symbol' ? [apostilleTile, dnsTile, signmsgTile, nemonsterTile, votingTile, nftViewerTile, consoleTile] : nemTiles;
  // NEM の Ledger は、サービスに出せるものが無い（メニューにも出さない）。URL を直接開かれても、ホームに戻す。
  if (ledger && chain !== 'symbol') return <Navigate to="/top" replace />;
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
