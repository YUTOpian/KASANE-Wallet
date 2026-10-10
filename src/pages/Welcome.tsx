import { Box, Button, Typography, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { keyframes } from '@mui/system';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import type { AppLanguage } from '../store/appStore';
import { KASANE } from '../theme/kasaneTheme';
import { KasaneMark, KasaneWordmark } from '../components/kasane/KasaneLogo';

// アプリを一番最初に起動したとき、またはウォレットが1件も無いときに表示するウェルカム画面。
// KASANEのロゴ（六角形に重なった屋根）をそのまま主役にした、くすんだ紫グレーの舞台。
// ここでの唯一のアクションは「GET STARTED」で、ウォレット選択画面（/wallet/select）へ進む。
// 言語切替トグル（日本語／English）はSettingsTop.tsxと同じsetLanguageを使う。
const rise = keyframes`from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); }`;
const glow = keyframes`0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.06); }`;
const reducedMotion = '@media (prefers-reduced-motion: reduce)';

export default function Welcome() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  const onChangeLanguage = (_: React.MouseEvent<HTMLElement>, value: AppLanguage | null) => {
    if (value) setLanguage(value);
  };

  return (
    <Box
      sx={{
        position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '100svh', width: '100%', boxSizing: 'border-box', color: 'text.primary', textAlign: 'center',
        px: 3, py: 5, overflow: 'hidden', background: (t) => t.kasane.stageBg,
      }}
    >
      <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        {/* logo: the hexagon mark with a soft glow, then the wordmark */}
        <Box sx={{ position: 'relative', mb: 3.5, animation: `${rise} 0.8s ease-out both`, [reducedMotion]: { animation: 'none' } }}>
          <Box
            aria-hidden
            sx={{
              position: 'absolute', inset: -40, borderRadius: '50%',
              background: `radial-gradient(circle, ${KASANE.pink}66 0%, ${KASANE.lavender}22 45%, transparent 70%)`,
              animation: `${glow} 5s ease-in-out infinite`, [reducedMotion]: { animation: 'none' },
            }}
          />
          <Box sx={{ position: 'relative', width: 'min(230px, 58vw)' }}>
            <KasaneMark size={230} />
          </Box>
        </Box>
        <Box sx={{ mb: 4, animation: `${rise} 0.8s ease-out 0.25s both`, [reducedMotion]: { animation: 'none' }, maxWidth: '78vw' }}>
          <KasaneWordmark width={300} />
        </Box>

        <Typography variant="h4" sx={{ fontWeight: 300, lineHeight: 1.25, mb: 2, letterSpacing: 6, color: (t) => t.kasane.wordmark, fontSize: { xs: 24, sm: 28 } }}>
          {t('wallet.welcome_title_2')}
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 5, maxWidth: 420, lineHeight: 1.8 }}>
          {t('wallet.welcome_subtitle')}
        </Typography>

        <Button
          variant="contained"
          onClick={() => navigate('/wallet/select')}
          sx={{ width: '100%', maxWidth: 320, py: 1.5, fontWeight: 700, letterSpacing: 3 }}
        >
          {t('wallet.welcome_get_started')}
        </Button>

        <ToggleButtonGroup
          value={language}
          exclusive
          onChange={onChangeLanguage}
          size="small"
          sx={{
            mt: 3, bgcolor: (t) => alpha(t.palette.text.primary, 0.07), borderRadius: 999, p: 0.5,
            '& .MuiToggleButton-root': {
              border: 'none', borderRadius: 999, px: 2.5, py: 0.5, color: 'text.secondary', fontWeight: 600, textTransform: 'none',
              '&.Mui-selected': { '&:hover': { filter: 'brightness(1.08)' } },
            },
          }}
        >
          <ToggleButton value="ja">{t('settings.language_name_ja')}</ToggleButton>
          <ToggleButton value="en">{t('settings.language_name_en')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
    </Box>
  );
}
