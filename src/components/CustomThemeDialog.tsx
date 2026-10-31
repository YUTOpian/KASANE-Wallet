import { useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Tab, Tabs, TextField, Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { selectActiveCustomTheme } from '../store/appStore';
import { applyProfileThemeChoice, useProfileThemeChoice } from '../theme/useThemeChoices';
import { MAX_ALL_IMAGE_CHARS, MAX_CUSTOM_THEMES, MAX_TOTAL_IMAGE_CHARS, buildThemeCss, imageCharsOf } from '../theme/customTheme';
import type { SavedCustomTheme, ThemeParseResult } from '../theme/customTheme';
import { editorFromSaved, editorHasContent, editorToTheme, emptyEditor } from '../theme/themeDraft';
import type { EditorTheme } from '../theme/themeDraft';
import { saveTextFile } from '../lib/saveTextFile';
import { MAX_THEME_BACKUP_BYTES, buildThemeBackup, parseThemeBackup, planThemeImport } from '../theme/themeBackup';
import SimpleEditor from './customTheme/SimpleEditor';
import CssEditor from './customTheme/CssEditor';

const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';

type Pending = { kind: 'close' } | { kind: 'new' } | { kind: 'stop' } | { kind: 'edit'; theme: SavedCustomTheme };

// カスタムテーマ（10個まで保存）。画面は上から:
//   1. 保存したテーマの一覧（使う・編集・CSSをダウンロード・削除）
//   2. 編集中のテーマ（名前 + 「かんたん」/「CSS（上級）」の2つのタブ）。色・丸み・画像は、どちらで作っても同じ1つのテーマ
//   3. 下のボタン「保存して使う」で、色・フォント・画像をまとめて1つのテーマとして保存
//   scope 'app'（既定）: 「使う」「保存して使う」は共通のテーマ（スタート画面・プロファイル選択画面）に使う。
//   scope 'profile': 開いているプロファイルだけのテーマに使う（共通のテーマは変えない）。
export default function CustomThemeDialog({ open, onClose, scope = 'app' }: { open: boolean; onClose: () => void; scope?: 'app' | 'profile' }) {
  const { t } = useTranslation();
  const muiTheme = useTheme();
  const fullScreen = useMediaQuery(muiTheme.breakpoints.down('sm'));
  const themes = useAppStore((s) => s.customThemes);
  const active = useAppStore(selectActiveCustomTheme);
  const themeMode = useAppStore((s) => s.themeMode);
  const saveCustomTheme = useAppStore((s) => s.saveCustomTheme);
  const selectCustomTheme = useAppStore((s) => s.selectCustomTheme);
  const removeCustomTheme = useAppStore((s) => s.removeCustomTheme);
  const addCustomThemes = useAppStore((s) => s.addCustomThemes);
  const profileChoice = useProfileThemeChoice();
  // 「使う」の行き先。プロファイルのときは、そのプロファイルのテーマにする。
  const applyChosenTheme = (id: string) => { if (scope === 'profile') applyProfileThemeChoice(`custom:${id}`); else selectCustomTheme(id); };

  // The theme being edited. With no saved theme the editor is open from the start; otherwise it opens from 「新しいテーマを作る」 / 「編集」.
  const [editor, setEditor] = useState<EditorTheme | null>(null);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyEditor()));
  const [tab, setTab] = useState<'simple' | 'css'>('simple');
  const [cssResult, setCssResult] = useState<ThemeParseResult | null>(null);
  const [saveError, setSaveError] = useState('');
  const [deleting, setDeleting] = useState<SavedCustomTheme | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const [backupNotice, setBackupNotice] = useState<{ severity: 'success' | 'warning' | 'error'; text: string } | null>(null);

  const ed = editor ?? (themes.length === 0 ? emptyEditor() : null);
  const dirty = ed !== null && JSON.stringify(ed) !== baseline;
  const full = themes.length >= MAX_CUSTOM_THEMES;
  const displayName = (theme: { name: string }) => theme.name || t('settings.theme_custom');
  const defaultName = t('settings.custom_theme_default_name', { n: themes.length + 1 });

  const update = (fn: (cur: EditorTheme) => EditorTheme) => {
    setSaveError('');
    setEditor((cur) => fn(cur ?? emptyEditor()));
  };
  const startEditor = (next: EditorTheme | null) => {
    setEditor(next);
    setBaseline(JSON.stringify(next ?? emptyEditor()));
    setCssResult(null);
    setSaveError('');
    setTab('simple');
  };
  // Leaving the editor with unsaved changes asks first.
  const request = (action: Pending) => {
    if (dirty) { setPending(action); return; }
    run(action);
  };
  const run = (action: Pending) => {
    if (action.kind === 'close') { startEditor(null); onClose(); }
    else if (action.kind === 'new') startEditor(emptyEditor());
    else if (action.kind === 'stop') startEditor(null);
    else startEditor(editorFromSaved(action.theme));
  };

  /** Do these images fit with the other saved themes' images? (`exceptId`: the theme they replace.) */
  const fitsAll = (images: { images?: SavedCustomTheme['images'] }, exceptId?: string | null) => {
    const others = themes.filter((th) => th.id !== exceptId).reduce((sum, th) => sum + imageCharsOf(th), 0);
    return imageCharsOf(images) <= MAX_TOTAL_IMAGE_CHARS && others + imageCharsOf(images) <= MAX_ALL_IMAGE_CHARS;
  };

  // Colours, font, corners and images are saved together: one theme.
  const save = () => {
    if (!ed) return;
    if (!editorHasContent(ed)) { setSaveError(t('settings.custom_theme_save_empty')); return; }
    if (ed.id === null && full) { setSaveError(t('settings.custom_theme_full', { max: MAX_CUSTOM_THEMES })); return; }
    const theme = editorToTheme(ed, defaultName);
    if (!fitsAll(theme, ed.id)) { setSaveError(t('settings.custom_theme_image_error_total')); return; }
    const commonId = useAppStore.getState().customThemeId;
    const id = saveCustomTheme(theme, ed.id ?? undefined);
    // 保存すると、共通のテーマで「カスタム」が表すテーマが保存したものに変わる。プロファイルだけのテーマを作るときは、共通のほうは変えない。
    if (id !== null && scope === 'profile') useAppStore.setState({ customThemeId: commonId });
    if (id === null) { setSaveError(t('settings.custom_theme_full', { max: MAX_CUSTOM_THEMES })); return; }
    applyChosenTheme(id);
    startEditor(null);
    onClose();
  };

  const downloadTheme = (theme: SavedCustomTheme) =>
    saveTextFile(buildThemeCss(theme, displayName(theme)), `kasane-theme-${safeFileName(theme.name)}.css`, 'text/css;charset=utf-8', true);

  // 機種変更などのためのバックアップ: 保存してあるテーマを、画像ごと1つのファイル（JSON）に書き出す / 読み込む。
  const exportAll = () => {
    if (themes.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    saveTextFile(buildThemeBackup(themes), `kasane-themes-${stamp}.json`, 'application/json;charset=utf-8');
    setBackupNotice({ severity: 'success', text: t('settings.custom_theme_export_done', { count: themes.length }) });
  };
  const onBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_THEME_BACKUP_BYTES) { setBackupNotice({ severity: 'error', text: t('settings.custom_theme_import_error_too_large') }); return; }
    const parsed = parseThemeBackup(await file.text().catch(() => ''));
    if (!parsed.ok) { setBackupNotice({ severity: 'error', text: t(`settings.custom_theme_import_error_${parsed.reason}`) }); return; }
    const { add, skipped } = planThemeImport(themes, parsed.themes);
    if (add.length === 0) { setBackupNotice({ severity: 'error', text: t('settings.custom_theme_import_error_full', { max: MAX_CUSTOM_THEMES }) }); return; }
    addCustomThemes(add);
    const left = skipped + parsed.invalid;
    setBackupNotice({
      severity: left > 0 ? 'warning' : 'success',
      text: left > 0 ? t('settings.custom_theme_import_done_partial', { count: add.length, skipped: left }) : t('settings.custom_theme_import_done', { count: add.length }),
    });
  };

  return (
    <>
      <Dialog open={open} onClose={() => request({ kind: 'close' })} fullWidth maxWidth="sm" fullScreen={fullScreen}>
        <DialogTitle>{t(`settings.${scope === 'profile' ? 'profile' : 'common'}_custom_theme_title`)}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('settings.custom_theme_intro', { max: MAX_CUSTOM_THEMES })}</Typography>

          {themes.length > 0 && (
            <Box sx={{ mb: 2.5 }}>
              <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t(`settings.${scope === 'profile' ? 'profile' : 'common'}_custom_theme_list_title`, { count: themes.length, max: MAX_CUSTOM_THEMES })}</Typography>
              {themes.map((theme) => {
                const inUse = scope === 'profile' ? profileChoice === `custom:${theme.id}` : themeMode === 'custom' && theme.id === active?.id;
                const editing = ed?.id === theme.id;
                return (
                  <Box key={theme.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography noWrap sx={{ fontWeight: inUse || editing ? 'bold' : 'normal' }}>{displayName(theme)}</Typography>
                      {inUse && <Chip size="small" color="primary" variant="outlined" label={t('settings.custom_theme_in_use')} />}
                    </Box>
                    {!inUse && <Button size="small" onClick={() => applyChosenTheme(theme.id)}>{t('settings.custom_theme_select')}</Button>}
                    <IconButton size="small" disabled={editing} aria-label={t('settings.custom_theme_edit')} title={t('settings.custom_theme_edit')} onClick={() => request({ kind: 'edit', theme })}><EditOutlinedIcon fontSize="small" /></IconButton>
                    <IconButton size="small" aria-label={t('settings.custom_theme_download_one')} title={t('settings.custom_theme_download_one')} onClick={() => downloadTheme(theme)}><FileDownloadOutlinedIcon fontSize="small" /></IconButton>
                    <IconButton size="small" aria-label={t('settings.custom_theme_delete_one')} title={t('settings.custom_theme_delete_one')} onClick={() => setDeleting(theme)}><DeleteOutlineIcon fontSize="small" /></IconButton>
                  </Box>
                );
              })}
              {!ed && (
                <Button sx={{ mt: 1 }} variant="outlined" startIcon={<AddIcon />} disabled={full} onClick={() => request({ kind: 'new' })}>{t('settings.custom_theme_new')}</Button>
              )}
              {!ed && full && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>{t('settings.custom_theme_full', { max: MAX_CUSTOM_THEMES })}</Typography>}
            </Box>
          )}

          {ed && (
            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1.5 }}>
                <Typography sx={{ fontWeight: 'bold' }}>{ed.id === null ? t('settings.custom_theme_creating') : t('settings.custom_theme_editing')}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {dirty && <Chip size="small" color="warning" variant="outlined" label={t('settings.custom_theme_unsaved')} />}
                  {themes.length > 0 && <Button size="small" onClick={() => request({ kind: 'stop' })}>{t('settings.custom_theme_stop')}</Button>}
                </Box>
              </Box>
              <TextField
                size="small" fullWidth sx={{ mb: 1.5 }}
                label={t('settings.custom_theme_name_label')} placeholder={defaultName}
                value={ed.name} onChange={(e) => update((cur) => ({ ...cur, name: e.target.value.slice(0, 40) }))}
              />
              <Tabs value={tab} onChange={(_, v: 'simple' | 'css') => setTab(v)} variant="fullWidth" sx={{ mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                <Tab value="simple" label={t('settings.custom_theme_tab_simple')} />
                <Tab value="css" label={t('settings.custom_theme_tab_css')} />
              </Tabs>
              {tab === 'simple'
                ? <SimpleEditor ed={ed} themes={themes} update={update} hideLogos={scope === 'profile'} />
                : <CssEditor ed={ed} result={cssResult} setResult={setCssResult} update={update} />}
            </Paper>
          )}
          {saveError && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setSaveError('')}>{saveError}</Alert>}

          <Box sx={{ mt: 3, pt: 2.5, borderTop: 1, borderColor: 'divider' }}>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('settings.custom_theme_backup_title')}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>{t('settings.custom_theme_backup_hint')}</Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Button size="small" variant="outlined" startIcon={<FileUploadOutlinedIcon />} disabled={themes.length === 0} onClick={exportAll}>{t('settings.custom_theme_export_all')}</Button>
              <Button size="small" variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={() => backupFileRef.current?.click()}>{t('settings.custom_theme_import_all')}</Button>
              <input ref={backupFileRef} type="file" accept=".json,application/json" hidden onChange={onBackupFile} />
            </Box>
            {backupNotice && <Alert severity={backupNotice.severity} sx={{ mt: 1 }} onClose={() => setBackupNotice(null)}>{backupNotice.text}</Alert>}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={() => request({ kind: 'close' })}>{t('common.close')}</Button>
          {ed && <Button variant="contained" onClick={save} disabled={!editorHasContent(ed) || (ed.id === null && full)}>{t('settings.custom_theme_save_button')}</Button>}
        </DialogActions>
      </Dialog>

      <Dialog open={pending !== null} onClose={() => setPending(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('settings.custom_theme_discard_title')}</DialogTitle>
        <DialogContent><Typography variant="body2">{t('settings.custom_theme_discard_text')}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => { const p = pending; setPending(null); if (p) run(p); }}>{t('settings.custom_theme_discard_ok')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('settings.custom_theme_delete_title', { name: deleting ? displayName(deleting) : '' })}</DialogTitle>
        <DialogContent><Typography variant="body2">{t('settings.custom_theme_delete_text')}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => {
            if (deleting) {
              if (ed?.id === deleting.id) startEditor(null);
              removeCustomTheme(deleting.id);
            }
            setDeleting(null);
          }}>{t('common.delete')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
