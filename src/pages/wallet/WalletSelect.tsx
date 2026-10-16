import { useEffect, useState } from 'react';
import { Box, Button, Typography, IconButton } from '@mui/material';
import KasaneStage from '../../components/kasane/KasaneStage';
import SettingsIcon from '@mui/icons-material/Settings';
import AddIcon from '@mui/icons-material/Add';
import WifiOffOutlinedIcon from '@mui/icons-material/WifiOffOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper, compareAccounts } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { useAppStore } from '../../store/appStore';
import ChoiceCard, { choiceGridSx } from '../../components/ChoiceCard';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlineOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { CHAINS, CHAIN_ORDER, getChain } from '../../lib/chain';
import { localeOf } from '../../i18n/languages';
import { LanguageThemeMenus } from '../../components/LanguageThemeControls';

// プロファイル = 1つのニーモニック。画面には1プロファイルにつき1行だけ出す。
// `representative` は、行を選んだときに開くアカウント：そのプロファイルのアカウントが今アクティブなら
// それ、そうでなければインデックスが一番小さいもの。
interface ProfileRow {
  key: string;
  name: string;
  representative: Wallet;
  createdAt: number;
  selected: boolean;
  // 閲覧用（アドレスだけ）のプロファイルか。
  watchOnly: boolean;
  // 閲覧用プロファイルが見ているチェーン（Symbol / NEM）の名前。
  chainNames: string;
}

function groupProfiles(wallets: Wallet[], activeId: string | null): ProfileRow[] {
  const groups = new Map<string, Wallet[]>();
  for (const wallet of wallets) {
    const list = groups.get(wallet.profileKey) ?? [];
    list.push(wallet);
    groups.set(wallet.profileKey, list);
  }
  const chain = getChain();
  return Array.from(groups.entries()).map(([key, list]) => {
    const sorted = list.slice().sort(compareAccounts);
    // The row opens an account of the selected chain (Symbol / NEM); a profile with none on this
    // chain yet opens its first account, and Home then offers to set the chain up.
    const ofChain = sorted.filter((wallet) => wallet.chain === chain);
    const active = ofChain.find((wallet) => wallet.id === activeId);
    return {
      key,
      name: sorted[0].name,
      representative: active ?? ofChain.find((wallet) => wallet.isDefault) ?? ofChain.find((wallet) => !wallet.hidden) ?? ofChain[0] ?? sorted[0],
      createdAt: Math.min(...sorted.map((wallet) => wallet.createdAtMs).filter((ms) => ms > 0), Number.MAX_SAFE_INTEGER),
      selected: active !== undefined,
      watchOnly: sorted.every((wallet) => wallet.watchOnly),
      chainNames: CHAIN_ORDER.filter((c) => sorted.some((wallet) => wallet.chain === c)).map((c) => CHAINS[c].name).join(' / '),
    };
  });
}

// 最初のGET STARTEDで開く「プロファイル選択」画面。
// ここでは「新規プロファイルの作成」か「作成済みプロファイルの選択」だけを行う。
// プロファイル内の別インデックスのアカウントへの切り替えは、メニューの「アカウント」(/account)。
// プロファイルの削除は、歯車マーク →「プロファイルの設定」から行う。
export default function WalletSelect() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const language = useAppStore((st) => st.language);
  const formatCreated = (ms: number) => {
    if (ms === Number.MAX_SAFE_INTEGER) return '';
    const date = new Date(ms).toLocaleDateString(localeOf(language), { year: 'numeric', month: '2-digit', day: '2-digit' });
    return t('wallet.profile_created', { date });
  };
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const load = async () => {
    const allWallets = await WalletsHelper.gets();
    const active = await WalletsHelper.getActiveAny();
    setProfiles(groupProfiles(allWallets, active?.id ?? null));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProfile = async (row: ProfileRow) => {
    await WalletsHelper.setActive(row.representative.id);
    navigate('/top');
  };

  return (
    // No top bar and no side menu on this screen. The back arrow always returns to the title (welcome) screen.
    <KasaneStage
      title={t('wallet.profile_select_title')}
      showBack
      onBack={() => navigate('/welcome')}
      maxWidth={760}
      topRight={(
        // In the corner, apart from the profile tiles: they are not profiles. Language / theme pickers sit to the
        // left of the offline button (an outlined button so it is easy to see; a short label on a phone, where
        // the full one would run into the logo).
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 } }}>
        <LanguageThemeMenus />
        <Button
          size="small"
          variant="outlined"
          color="primary"
          startIcon={<WifiOffOutlinedIcon />}
          onClick={() => navigate('/offline')}
          sx={{ fontSize: { xs: 11, sm: 13, md: 14 }, whiteSpace: 'nowrap', textTransform: 'none', px: { xs: 1, sm: 1.5, md: 2.5 }, py: { xs: 0.25, md: 0.75 }, borderRadius: 5, bgcolor: 'rgba(0,0,0,0.15)' }}
        >
          <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{t('offline.hub_title')}</Box>
          <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>{t('wallet.offline_short')}</Box>
        </Button>
        </Box>
      )}
    >
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mx: 1, mt: { xs: 1, md: 2 }, lineHeight: 1.8, fontSize: { md: 16 } }}>
        {t('wallet.profile_select_message')}
      </Typography>

      {/* 1行3枚まで。4枚目以降は下の行に折り返す（行が3枚に満たないときは中央寄せ）。スマホは1列。 */}
      <Box
        sx={{
          ...choiceGridSx,
          display: 'flex',
          flexWrap: 'wrap',
          mt: { xs: 2, md: 4 },
          // gap は xs/sm が16px、md以上が24px（choiceGridSx）。スマホ〜タブレットは1〜3枚、デスクトップは3枚。
          '& > *': {
            boxSizing: 'border-box',
            width: { xs: '100%', sm: 'calc((100% - 32px) / 3)', md: 'calc((100% - 48px) / 3)' },
          },
        }}
      >
        {profiles.map((profile) => (
          <ChoiceCard
            key={profile.key}
            icon={profile.watchOnly ? VisibilityOutlinedIcon : PersonOutlineIcon}
            title={profile.name}
            desc={formatCreated(profile.createdAt)}
            hint={profile.watchOnly ? `${t('watch.badge')} · ${profile.chainNames}` : undefined}
            hintFloating
            badge={profile.selected ? t('wallet.profile_in_use') : undefined}
            selected={profile.selected}
            onClick={() => selectProfile(profile)}
            action={(
              <IconButton
                size="small"
                aria-label={t('wallet.profile_settings')}
                onClick={() => navigate(`/wallet/settings?id=${profile.representative.id}`)}
              >
                <SettingsIcon sx={{ color: 'text.secondary' }} />
              </IconButton>
            )}
          />
        ))}

        {/* 新規プロファイル: 点線の枠で「追加」だと分かるように、一覧の最後に置く */}
        <ChoiceCard
          dashed
          icon={AddIcon}
          title={t('wallet.new_profile')}
          desc={t('wallet.new_profile_desc')}
          onClick={() => navigate('/wallet/new')}
        />
      </Box>
    </KasaneStage>
  );
}
