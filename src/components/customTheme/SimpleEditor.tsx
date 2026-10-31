import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, FormControlLabel, IconButton, Slider, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useTranslation } from 'react-i18next';
import { createKasaneTheme } from '../../theme/kasaneTheme';
import { MAX_TOTAL_IMAGE_CHARS, imageCharsOf } from '../../theme/customTheme';
import type { CustomMode, LookValues, SavedCustomTheme } from '../../theme/customTheme';
import { COLOR_ITEMS, colorOfItem, isItemSet, resetColor, setColor, setValues } from '../../theme/themeDraft';
import type { EditorTheme } from '../../theme/themeDraft';
import { ICON_SLOTS, ImageRow, imageSlotsOf, useImagePicker } from './ImageRows';

interface Props {
  ed: EditorTheme;
  themes: SavedCustomTheme[];
  update: (fn: (ed: EditorTheme) => EditorTheme) => void;
  // ロゴの行を出さない（プロファイルだけのテーマ。ロゴはスタート画面で使うもの）。
  hideLogos?: boolean;
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <Box sx={{ mb: 3 }}>
    <Typography sx={{ fontWeight: 'bold' }}>{title}</Typography>
    {hint && <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>{hint}</Typography>}
    <Box sx={{ mt: 1 }}>{children}</Box>
  </Box>
);

// かんたん：CSS の知識がなくても、色・丸み・画像を選ぶだけで作れる。
export default function SimpleEditor({ ed, themes, update, hideLogos = false }: Props) {
  const { t } = useTranslation();
  const picker = useImagePicker(ed, themes, update);
  const mode: CustomMode = ed.root.mode ?? 'dark';
  const defaults: LookValues = createKasaneTheme(mode, 'symbol').kasane.look; // the standard colours of this base: what a colour shows until it is changed
  const value = <K extends keyof LookValues>(key: K): LookValues[K] => (ed.root[key] ?? defaults[key]) as LookValues[K];
  const round = Number(value('buttonRadius')) >= 999;
  const usage = Math.round((imageCharsOf({ images: ed.images }) / MAX_TOTAL_IMAGE_CHARS) * 100);

  return (
    <Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2.5 }}>{t('settings.custom_theme_simple_intro')}</Typography>

      <Section title={t('settings.custom_theme_section_base')} hint={t('settings.custom_theme_mode_hint')}>
        <ToggleButtonGroup exclusive size="small" value={mode} onChange={(_, v: CustomMode | null) => v && update((cur) => setValues(cur, { mode: v }))}>
          <ToggleButton value="dark" sx={{ px: 2.5 }}>{t('settings.custom_theme_mode_dark')}</ToggleButton>
          <ToggleButton value="light" sx={{ px: 2.5 }}>{t('settings.custom_theme_mode_light')}</ToggleButton>
        </ToggleButtonGroup>
      </Section>

      <Section title={t('settings.custom_theme_section_colors')}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 3, rowGap: 1 }}>
          {COLOR_ITEMS.map((item) => (
            <Box key={item.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                component="input" type="color" value={colorOfItem(ed, item, defaults)}
                aria-label={t(`settings.custom_theme_color_${item.id}`)}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => update((cur) => setColor(cur, item, e.target.value))}
                sx={{ width: 40, height: 32, p: 0, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'transparent', cursor: 'pointer', flexShrink: 0 }}
              />
              <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>{t(`settings.custom_theme_color_${item.id}`)}</Typography>
              {isItemSet(ed, item) && (
                <IconButton size="small" aria-label={t('settings.custom_theme_color_reset')} title={t('settings.custom_theme_color_reset')} onClick={() => update((cur) => resetColor(cur, item))}>
                  <RestartAltIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
          ))}
        </Box>
      </Section>

      <Section title={t('settings.custom_theme_section_shape')}>
        <Typography variant="body2">{t('settings.custom_theme_radius_card')}: {Number(value('radius'))}</Typography>
        <Slider size="small" min={0} max={48} step={1} value={Math.min(48, Number(value('radius')))} onChange={(_, v) => update((cur) => setValues(cur, { radius: v as number }))} sx={{ maxWidth: 360, display: 'block', mb: 1 }} />
        <Typography variant="body2">{t('settings.custom_theme_radius_button')}{round ? '' : `: ${Number(value('buttonRadius'))}`}</Typography>
        <Slider size="small" min={0} max={48} step={1} disabled={round} value={Math.min(48, Number(value('buttonRadius')))} onChange={(_, v) => update((cur) => setValues(cur, { buttonRadius: v as number }))} sx={{ maxWidth: 360, display: 'block' }} />
        <FormControlLabel control={<Switch size="small" checked={round} onChange={(_, on) => update((cur) => setValues(cur, { buttonRadius: on ? 999 : 12 }))} />} label={<Typography variant="body2">{t('settings.custom_theme_radius_round')}</Typography>} />
      </Section>

      <Section title={t('settings.custom_theme_section_images')} hint={t('settings.custom_theme_images_intro')}>
        {picker.input}
        {picker.error && <Alert severity="error" sx={{ mb: 1 }} onClose={picker.clearError}>{picker.error}</Alert>}

        {!hideLogos && (
          <>
            <Typography variant="body2" sx={{ fontWeight: 'bold', mt: 1 }}>{t('settings.custom_theme_group_logo')}</Typography>
            {imageSlotsOf(['logoMark', 'logoWordmark']).map((slot) => <ImageRow key={slot.key} slot={slot} ed={ed} picker={picker} />)}
          </>
        )}

        <Typography variant="body2" sx={{ fontWeight: 'bold', mt: hideLogos ? 1 : 1.5 }}>{t('settings.custom_theme_group_backdrop')}</Typography>
        {imageSlotsOf(['background', 'hero']).map((slot) => <ImageRow key={slot.key} slot={slot} ed={ed} picker={picker} />)}
        {(ed.images.background || ed.images.hero) && (
          <Box sx={{ pl: 7, mb: 1 }}>
            {ed.images.background && (
              <>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_dim_background')}</Typography>
                <Slider size="small" min={0} max={1} step={0.05} value={Number(value('backgroundDim'))} onChange={(_, v) => update((cur) => setValues(cur, { backgroundDim: v as number }))} sx={{ maxWidth: 320, display: 'block' }} />
              </>
            )}
            {ed.images.hero && (
              <>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_dim_hero')}</Typography>
                <Slider size="small" min={0} max={1} step={0.05} value={Number(value('heroDim'))} onChange={(_, v) => update((cur) => setValues(cur, { heroDim: v as number }))} sx={{ maxWidth: 320, display: 'block' }} />
              </>
            )}
          </Box>
        )}

        <Accordion disableGutters variant="outlined" sx={{ mt: 1.5 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('settings.custom_theme_group_icons', { count: ICON_SLOTS.length })}</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0 }}>
            {ICON_SLOTS.map((slot) => <ImageRow key={slot.key} slot={slot} ed={ed} picker={picker} />)}
          </AccordionDetails>
        </Accordion>

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_images_usage', { percent: usage })}</Typography>
          {Object.keys(ed.images).length > 0 && (
            <Button size="small" color="error" onClick={() => update((cur) => ({ ...cur, images: {} }))}>{t('settings.custom_theme_images_clear')}</Button>
          )}
        </Box>
      </Section>
    </Box>
  );
}
