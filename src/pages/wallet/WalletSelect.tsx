import { useEffect, useState } from 'react';
import { Box, Typography, IconButton } from '@mui/material';
import KasaneStage from '../../components/kasane/KasaneStage';
import SettingsIcon from '@mui/icons-material/Settings';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper, compareAccounts } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { useAppStore } from '../../store/appStore';
import InfoCard, { tileGridSx } from '../../components/InfoCard';
import { getChain } from '../../lib/chain';

// プロファイル = 1つのニーモニック。画面には1プロファイルにつき1行だけ出す。
// `representative` は、行を選んだときに開くアカウント：そのプロファイルのアカウントが今アクティブなら
// それ、そうでなければインデックスが一番小さいもの。
interface ProfileRow {
  key: string;
  name: string;
  representative: Wallet;
  createdAt: number;
  selected: boolean;
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
      representative: active ?? ofChain.find((wallet) => !wallet.hidden) ?? ofChain[0] ?? sorted[0],
      createdAt: Math.min(...sorted.map((wallet) => wallet.createdAtMs).filter((ms) => ms > 0), Number.MAX_SAFE_INTEGER),
      selected: active !== undefined,
    };
  });
}

// 最初のGET STARTEDで開く「プロファイル選択」画面。
// ここでは「新規プロファイルの作成」か「作成済みプロファイルの選択」だけを行う。
// プロファイル内の別インデックスのアカウントへの切り替えは、メニューの「ウォレット切替」(/wallet/switch)。
// プロファイルの削除は、歯車マーク →「プロファイルの設定」から行う。
export default function WalletSelect() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const language = useAppStore((st) => st.language);
  const formatCreated = (ms: number) => {
    if (ms === Number.MAX_SAFE_INTEGER) return '';
    const date = new Date(ms).toLocaleDateString(language === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
    return t('wallet.profile_created', { date });
  };
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = async () => {
    const allWallets = await WalletsHelper.gets();
    const active = await WalletsHelper.getActiveAny();
    setProfiles(groupProfiles(allWallets, active?.id ?? null));
    setLoaded(true);
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
    // No top bar and no side menu on this screen. With no profile yet, the back arrow returns to the
    // welcome screen (the only way out); once a profile exists it is not needed.
    <KasaneStage
      title={t('wallet.profile_select_title')}
      showBack={loaded && profiles.length === 0}
      onBack={() => navigate('/welcome')}
      maxWidth={760}
    >
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mx: 1, mt: 1, lineHeight: 1.8 }}>
        {t('wallet.profile_select_message')}
      </Typography>

      <Box sx={{ ...tileGridSx, mx: 0 }}>
        <InfoCard
          title={t('wallet.new_profile')}
          caption={t('wallet.new_profile_desc')}
          action={<AddIcon sx={{ color: 'text.secondary' }} />}
          onClick={() => navigate('/wallet/new')}
        />

        {profiles.map((profile) => (
          <InfoCard
            key={profile.key}
            title={profile.name}
            caption={formatCreated(profile.createdAt)}
            selected={profile.selected}
            onClick={() => selectProfile(profile)}
            action={(
              <IconButton
                edge="end"
                size="small"
                onClick={(e) => { e.stopPropagation(); navigate(`/wallet/settings?id=${profile.representative.id}`); }}
              >
                <SettingsIcon sx={{ color: 'text.secondary' }} />
              </IconButton>
            )}
          />
        ))}
      </Box>
    </KasaneStage>
  );
}
