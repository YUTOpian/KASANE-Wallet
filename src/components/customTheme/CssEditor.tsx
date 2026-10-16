import { useRef } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import { useTranslation } from 'react-i18next';
import { createKasaneTheme } from '../../theme/kasaneTheme';
import { IMAGE_SLOTS, MAX_CSS_BYTES, buildTemplateCss, decodeCssBytes, parseCustomThemeCss } from '../../theme/customTheme';
import type { CustomImages, CustomMode, ThemeParseResult } from '../../theme/customTheme';
import { processImage } from '../../theme/imageProcessing';
import { applyCssToEditor } from '../../theme/themeDraft';
import type { EditorTheme } from '../../theme/themeDraft';
import { saveTextFile } from '../../lib/saveTextFile';

const MAX_SHOWN_WARNINGS = 10;
const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';

interface Props {
  ed: EditorTheme;
  result: ThemeParseResult | null;
  setResult: (r: ThemeParseResult | null) => void;
  update: (fn: (ed: EditorTheme) => EditorTheme) => void;
}

// CSS（上級）：編集中のテーマを CSS にして書き出し → エディタで磨く → アップロードで編集中のテーマに戻す。
export default function CssEditor({ ed, result, setResult, update }: Props) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const title = ed.name.trim() || t('settings.theme_custom');

  // いまの設定（かんたんで作ったもの）を、全項目の説明つきで書き出す。画像も入る。
  const downloadCurrent = () => {
    const mode: CustomMode = ed.root.mode ?? 'dark';
    const look = { ...createKasaneTheme(mode, 'symbol').kasane.look, ...ed.root };
    saveTextFile(buildTemplateCss(look, title, ed.images, ed.chains), `kasane-theme-${safeFileName(ed.name)}.css`, 'text/css;charset=utf-8', true);
  };
  const downloadTemplate = () => {
    saveTextFile(buildTemplateCss(createKasaneTheme('dark', 'symbol').kasane.look, t('settings.theme_dark')), 'kasane-theme-dark.css', 'text/css;charset=utf-8', true);
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // the same file can be picked again after editing it
    if (!file) return;
    if (file.size > MAX_CSS_BYTES) {
      setResult({ theme: null, applied: 0, warnings: [{ code: 'too_large' }], clearedImages: [] });
      return;
    }
    let parsed = parseCustomThemeCss(decodeCssBytes(await file.arrayBuffer()), file.name.replace(/\.css$/i, ''));
    // Images written in the CSS are redrawn (processImage) before they are kept; the ones that cannot be read are dropped.
    if (parsed.theme?.images) {
      const warnings = [...parsed.warnings];
      const redrawn: CustomImages = {};
      for (const slot of IMAGE_SLOTS) {
        const uri = parsed.theme.images[slot.key];
        if (!uri) continue;
        try {
          redrawn[slot.key] = await processImage(uri, slot);
        } catch {
          warnings.push({ code: 'bad_image', detail: slot.css });
        }
      }
      const theme = { ...parsed.theme, images: redrawn };
      if (Object.keys(redrawn).length === 0) delete (theme as { images?: CustomImages }).images;
      parsed = { ...parsed, theme, warnings };
    }
    setResult(parsed);
    if (parsed.theme) update((cur) => applyCssToEditor(cur, parsed));
  };

  const warnings = result?.warnings.filter((w) => w.code !== 'empty') ?? [];
  const shown = warnings.slice(0, MAX_SHOWN_WARNINGS);
  const warnText = (w: ThemeParseResult['warnings'][number]) => t(`settings.custom_theme_warn_${w.code}`, { line: w.line ?? '', detail: w.detail ?? '' });
  const hasChains = Object.values(ed.chains).some((v) => v && Object.keys(v).length > 0);

  return (
    <Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('settings.custom_theme_css_intro')}</Typography>

      <Typography sx={{ fontWeight: 'bold', mb: 0.75 }}>{t('settings.custom_theme_css_get')}</Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 0.75 }}>
        <Button variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={downloadCurrent}>{t('settings.custom_theme_css_download_current')}</Button>
        <Button variant="text" onClick={downloadTemplate}>{t('settings.custom_theme_css_download_template')}</Button>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2.5 }}>{t('settings.custom_theme_css_get_hint')}</Typography>

      <Typography sx={{ fontWeight: 'bold', mb: 0.75 }}>{t('settings.custom_theme_css_put')}</Typography>
      <input ref={fileRef} type="file" accept=".css,text/css" hidden onChange={onFile} />
      <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} onClick={() => fileRef.current?.click()}>{t('settings.custom_theme_upload')}</Button>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.75, mb: 1.5 }}>{t('settings.custom_theme_css_put_hint')}</Typography>

      {result && (
        <Box sx={{ mb: 1.5 }}>
          {result.theme
            ? <Alert severity="success" sx={{ mb: 1 }}>{t('settings.custom_theme_result_ok', { count: result.applied })}</Alert>
            : <Alert severity="error" sx={{ mb: 1 }}>{t('settings.custom_theme_warn_empty')}</Alert>}
          {shown.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('settings.custom_theme_warnings', { count: warnings.length })}</Typography>
              {shown.map((w, i) => <Typography key={i} variant="caption" sx={{ display: 'block', wordBreak: 'break-all' }}>{warnText(w)}</Typography>)}
              {warnings.length > shown.length && <Typography variant="caption" sx={{ display: 'block' }}>{t('settings.custom_theme_more', { count: warnings.length - shown.length })}</Typography>}
            </Alert>
          )}
        </Box>
      )}
      {hasChains && <Alert severity="info" sx={{ mb: 1.5 }}>{t('settings.custom_theme_css_chains_note')}</Alert>}
      <Alert severity="info" variant="outlined">{t('settings.custom_theme_safety')}</Alert>
    </Box>
  );
}
