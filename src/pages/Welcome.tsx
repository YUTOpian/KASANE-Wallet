import { useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KASANE } from '../theme/kasaneTheme';
import { KasaneMark, KasaneWordmark, KasaneWalletWord } from '../components/kasane/KasaneLogo';
import { LanguageThemeButtons } from '../components/LanguageThemeControls';
import OfficialProfileImportDialog from '../components/OfficialProfileImportDialog';
import { dismissOfficialProfiles, findNewOfficialProfiles } from '../lib/officialProfile/detect';
import type { OfficialFound } from '../lib/officialProfile/detect';

// アプリを一番最初に起動したとき、またはウォレットが1件も無いときに表示するウェルカム画面。
// KASANEのロゴ（六角形に重なった屋根）をそのまま主役にした、くすんだ紫グレーの舞台。
// ここでの唯一のアクションは「GET STARTED」で、ウォレット選択画面（/wallet/select）へ進む。
// GET STARTEDの下に、言語ボタンとテーマボタンを横に並べる。押すとそれぞれ選択メニューが開く（SettingsTop.tsxと同じstoreを使う）。
const glow = keyframes`0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.06); }`;
const reducedMotion = '@media (prefers-reduced-motion: reduce)';

export default function Welcome() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  // このブラウザに Symbol 公式ウォレットのプロファイルがあるかは、起動時ではなく GET STARTED を押したときに確かめる。
  // 見つかればパスワード入力のポップアップを出し、閉じたあとにプロファイル選択画面へ進む。見つからなければそのまま進む。
  const [found, setFound] = useState<OfficialFound | null>(null);
  const [checking, setChecking] = useState(false);
  const onGetStarted = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const result = await findNewOfficialProfiles();
      if (result) {
        setFound(result);
        return;
      }
    } catch {
      // 探せなかったときは、ポップアップなしで先へ進む。
    } finally {
      setChecking(false);
    }
    navigate('/wallet/select');
  };
  const foundNames = found ? found.profiles.map((p) => p.profileName) : [];
  return (
    <Box
      sx={{
        position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '100svh', width: '100%', boxSizing: 'border-box', color: 'text.primary', textAlign: 'center',
        px: 3, py: { xs: 5, md: 8 }, overflow: 'hidden', background: (t) => t.kasane.stageBg,
      }}
    >
      {/* スマホは縦1列。デスクトップ（900px以上）は、左にロゴ・右に文言とボタンの2カラム。 */}
      <Box
        sx={{
          position: 'relative', display: 'flex', width: '100%', maxWidth: { md: 1120 }, boxSizing: 'border-box',
          flexDirection: { xs: 'column', md: 'row' }, alignItems: 'center', justifyContent: 'center',
          gap: { xs: 0, md: 10, lg: 14 }, px: { md: 4 },
        }}
      >
        {/* logo: the hexagon mark with a soft glow, then the wordmark */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: { md: '1 1 0' }, minWidth: 0 }}>
          <Box sx={{ position: 'relative', mb: { xs: 3.5, md: 5 } }}>
            <Box
              aria-hidden
              sx={{
                position: 'absolute', inset: { xs: -40, md: -70 }, borderRadius: '50%',
                background: `radial-gradient(circle, ${KASANE.pink}66 0%, ${KASANE.lavender}22 45%, transparent 70%)`,
                animation: `${glow} 5s ease-in-out infinite`, [reducedMotion]: { animation: 'none' },
              }}
            />
            <Box sx={{ position: 'relative', width: { xs: 'min(230px, 58vw)', md: 340 } }}>
              <Box sx={{ display: { xs: 'block', md: 'none' } }}><KasaneMark size={230} /></Box>
              <Box sx={{ display: { xs: 'none', md: 'block' } }}><KasaneMark size={340} /></Box>
            </Box>
          </Box>
          <Box sx={{ maxWidth: '78vw' }}>
            <Box sx={{ display: { xs: 'block', md: 'none' } }}><KasaneWordmark width={300} /></Box>
            <Box sx={{ display: { xs: 'none', md: 'block' } }}><KasaneWordmark width={340} /></Box>
          </Box>
          <Box sx={{ mt: { xs: 2.5, md: 3 }, display: 'flex', justifyContent: 'center' }}>
            <Box sx={{ display: { xs: 'block', md: 'none' } }}><KasaneWalletWord width={150} /></Box>
            <Box sx={{ display: { xs: 'none', md: 'block' } }}><KasaneWalletWord width={170} /></Box>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: { xs: 'center', md: 'flex-start' }, textAlign: { xs: 'center', md: 'left' }, flex: { md: '1 1 0' }, minWidth: 0, mt: { xs: 4, md: 0 }, width: { xs: '100%', md: 'auto' } }}>
          <Typography variant="h4" sx={{ fontWeight: 300, lineHeight: 1.3, mb: { xs: 2, md: 3 }, letterSpacing: { xs: 6, md: 8 }, color: (t) => t.kasane.wordmark, fontSize: { xs: 24, sm: 28, md: 40 } }}>
            {t('wallet.welcome_title_2')}
          </Typography>

          <Typography variant="body2" sx={{ color: 'text.secondary', mb: { xs: 5, md: 6 }, maxWidth: { xs: 420, md: 480 }, lineHeight: 1.9, fontSize: { md: 17 } }}>
            {t('wallet.welcome_subtitle')}
          </Typography>

          <Button
            variant="contained"
            onClick={() => void onGetStarted()}
            disabled={checking}
            sx={{ width: '100%', maxWidth: { xs: 320, md: 380 }, py: { xs: 1.5, md: 2 }, fontWeight: 700, letterSpacing: 3, fontSize: { md: 17 } }}
          >
            {checking ? <CircularProgress size={22} color="inherit" /> : t('wallet.welcome_get_started')}
          </Button>

          <LanguageThemeButtons align="start" />
        </Box>
      </Box>
      {found && (
        <OfficialProfileImportDialog
          open
          onClose={() => { setFound(null); navigate('/wallet/select'); }}
          auto={{ text: found.text, profiles: foundNames, onNever: () => dismissOfficialProfiles(found.text, foundNames) }}
        />
      )}
    </Box>
  );
}
