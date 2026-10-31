import { useState } from 'react';
import { Box, Link as MuiLink, Typography } from '@mui/material';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import ChoiceCard, { choiceGridSx } from '../../components/ChoiceCard';
import OfficialProfileImportDialog from '../../components/OfficialProfileImportDialog';
import { useSssAccount } from '../../hooks/useSssAccount';

// プロファイル選択の「新規プロファイル」から開く画面。
// 3つの大きなカード（アイコン・タイトル・ひとこと説明・「こんな人向け」）から選ぶ：
//   新規作成：新しいニーモニックを生成 / インポート：既存のニーモニックを入力 / 閲覧用：アドレスだけ（秘密鍵は持たない） / Ledger：デバイスの公開鍵だけ（秘密鍵は持たない）。
// 保存済みのプロファイル一覧（/wallet/select）へは、左上の戻る矢印で戻る。
// Symbol / NEM の選択は、それぞれの遷移先で行う。閲覧用はアドレスから自動判定する。

export default function WalletNew() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [officialOpen, setOfficialOpen] = useState(false);
  // SSS Extension と連携できているとき（入っていて、このページが許可されているとき）だけ、SSS のカードを出す。
  const sssLinked = useSssAccount().state === 'ready';

  return (
    <KasaneStage onBack={() => navigate('/wallet/select', { replace: true })} back="/wallet/select" title={t('wallet.new_heading')} maxWidth={sssLinked ? 1100 : 900}>
      <Typography variant="body2" align="center" color="text.secondary" sx={{ mx: 1, mt: { xs: 1, md: 2 }, lineHeight: 1.8, fontSize: { md: 16 } }}>
        {t('wallet.new_choice_message')}
      </Typography>

      <Box sx={{ ...choiceGridSx, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: `repeat(${sssLinked ? 5 : 4}, minmax(0, 1fr))` } }}>
        <ChoiceCard
          icon={MenuBookOutlinedIcon}
          title={t('wallet.new_create_title')}
          desc={t('wallet.new_create_desc')}
          hint={t('wallet.new_create_hint')}
          badge={t('wallet.new_recommended')}
          onClick={() => navigate('/wallet/creation/name')}
        />
        <ChoiceCard
          icon={FileDownloadOutlinedIcon}
          title={t('wallet.new_import_title')}
          desc={t('wallet.new_import_desc')}
          hint={t('wallet.new_import_hint')}
          onClick={() => navigate('/wallet/login/import')}
        />
        <ChoiceCard
          icon={VisibilityOutlinedIcon}
          title={t('watch.new_title')}
          desc={t('watch.new_desc')}
          hint={t('wallet.new_watch_hint')}
          onClick={() => navigate('/wallet/watch')}
        />
        <ChoiceCard
          icon={UsbOutlinedIcon}
          title={t('ledger.new_title')}
          desc={t('ledger.new_desc')}
          hint={t('ledger.new_hint')}
          onClick={() => navigate('/wallet/ledger')}
        />
        {sssLinked && (
          <ChoiceCard
            icon={ExtensionOutlinedIcon}
            title={t('sss.new_title')}
            desc={t('sss.new_desc')}
            hint={t('sss.new_hint')}
            onClick={() => navigate('/wallet/sss')}
          />
        )}
      </Box>

      {/* Symbol 公式ウォレットのプロファイルを読み込む（公式ウォレット ⇔ KASANE のプロファイル互換） */}
      <Typography variant="body2" align="center" sx={{ mx: 1, mb: 2, fontSize: { md: 15 } }}>
        <MuiLink component="button" type="button" underline="always" onClick={() => setOfficialOpen(true)} sx={{ verticalAlign: 'baseline' }}>
          {t('wallet.official_import_link')}
        </MuiLink>
      </Typography>
      <OfficialProfileImportDialog open={officialOpen} onClose={() => setOfficialOpen(false)} />
    </KasaneStage>
  );
}
