import { useState } from 'react';
import { Box, Button, IconButton, ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import { alpha } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';
import TranslateIcon from '@mui/icons-material/Translate';
import Brightness4OutlinedIcon from '@mui/icons-material/Brightness4Outlined';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import type { AppLanguage } from '../store/appStore';
import { applyThemeChoice, useThemeChoice, useThemeChoices } from '../theme/useThemeChoices';
import { LANGUAGES } from '../i18n/languages';

// 言語選択・テーマ選択。設定 > 言語選択 / テーマ と同じ store（setLanguage / setThemeMode）を使う。
//   LanguageThemeMenus  : プロファイル選択画面の右上用。アイコンを押すとメニューが開く小さな2ボタン。
//   LanguageThemeButtons: ウェルカム画面（GET STARTED の下）用。言語ボタンとテーマボタンを横に並べる。押すとメニューが開く。

function PickerButton<T extends string>({ icon, label, value, options, onSelect, showValue }: {
  icon: React.ReactNode;
  label: string;
  // true: a pill button that shows the current choice next to the icon (title screen); false: a small icon button.
  showValue?: boolean;
  value: T;
  options: { code: T; label: string }[];
  onSelect: (code: T) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      {showValue ? (
        <Button
          aria-label={label}
          title={label}
          startIcon={icon}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            color: 'text.secondary', bgcolor: (th) => alpha(th.palette.text.primary, 0.07), borderRadius: 999,
            px: { xs: 1.5, sm: 2.5 }, py: 0.75, fontWeight: 600, textTransform: 'none', whiteSpace: 'nowrap',
            '&:hover': { bgcolor: (th) => alpha(th.palette.text.primary, 0.12) },
          }}
        >
          {options.find((o) => o.code === value)?.label}
        </Button>
      ) : (
        <IconButton
          size="small"
          aria-label={label}
          title={label}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ color: 'text.secondary', width: { xs: 30, sm: 34 }, height: { xs: 30, sm: 34 }, bgcolor: (th) => alpha(th.palette.text.primary, 0.07) }}
        >
          {icon}
        </IconButton>
      )}
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {options.map((option) => (
          <MenuItem
            key={option.code}
            selected={option.code === value}
            onClick={() => { onSelect(option.code); setAnchor(null); }}
          >
            <ListItemText>{option.label}</ListItemText>
            {option.code === value && <ListItemIcon sx={{ minWidth: 0, ml: 2 }}><CheckIcon fontSize="small" /></ListItemIcon>}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function LanguageThemeMenus() {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const themeChoice = useThemeChoice();
  const themeOptions = useThemeChoices(); // the built-in themes and every saved カスタムテーマ
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <PickerButton<AppLanguage>
        icon={<TranslateIcon fontSize="small" />}
        label={t('settings.language_select')}
        value={language}
        options={LANGUAGES.map(({ code, label }) => ({ code, label }))}
        onSelect={setLanguage}
      />
      <PickerButton<string>
        icon={<Brightness4OutlinedIcon fontSize="small" />}
        label={t('settings.theme_select')}
        value={themeChoice}
        options={themeOptions}
        onSelect={applyThemeChoice}
      />
    </Box>
  );
}

// align="start": デスクトップの2カラムのウェルカム画面で、ボタンを左寄せ（スマホは中央のまま）。
export function LanguageThemeButtons({ align }: { align?: 'start' } = {}) {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const themeChoice = useThemeChoice();
  const themeOptions = useThemeChoices(); // the built-in themes and every saved カスタムテーマ
  return (
    <Box sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: align === 'start' ? { xs: 'center', md: 'flex-start' } : 'center', alignItems: 'center', gap: { xs: 1, sm: 1.5 }, mt: { xs: 3, md: 4 } }}>
      <PickerButton<AppLanguage>
        showValue
        icon={<TranslateIcon fontSize="small" />}
        label={t('settings.language_select')}
        value={language}
        options={LANGUAGES.map(({ code, label }) => ({ code, label }))}
        onSelect={setLanguage}
      />
      <PickerButton<string>
        showValue
        icon={<Brightness4OutlinedIcon fontSize="small" />}
        label={t('settings.theme_select')}
        value={themeChoice}
        options={themeOptions}
        onSelect={applyThemeChoice}
      />
    </Box>
  );
}
