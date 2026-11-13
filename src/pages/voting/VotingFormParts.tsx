import type { ReactNode } from 'react';
import { Alert, Box, Button, IconButton, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';

// 「投票を作る」の入力画面（NEM・Symbol 共通）の部品。
// NEMonster の画面と同じ作り: 太字のタイトル、説明バー、角丸のカードを並べる。
// デスクトップでは、左に「投票の内容」、右に「期間と集計方法・手数料」の 2 列にして、1 画面で見渡せるようにする。

/** One rounded card with a bold title (the same card as the NEMonster page). */
export function VotingSection({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ mt: 2.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: { xs: 2, md: 3 }, py: 2 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '1.05rem', mb: description ? 0.5 : 1.5 }}>{title}</Typography>
      {description && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5, lineHeight: 1.7 }}>{description}</Typography>}
      {children}
    </Box>
  );
}

interface FrameProps {
  title: ReactNode;
  intro: ReactNode;
  onBack: () => void;
  back: string;
  /** The left column on a wide screen (the content of the poll). */
  left: ReactNode;
  /** The right column on a wide screen (the rules, then the cost). */
  right: ReactNode;
  /** The button that goes on to the confirm step. */
  action: ReactNode;
}

/** The frame of the create form: back button, title, info bar, two columns of cards, and a bar with the button at the bottom. */
export function VotingFormFrame({ title, intro, onBack, back, left, right, action }: FrameProps) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} back={back} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="h6" component="h1" sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
        <Alert severity="info" sx={{ mb: 0.5 }}>{intro}</Alert>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }, columnGap: 3, alignItems: 'start' }}>
          <Box sx={{ minWidth: 0 }}>{left}</Box>
          <Box sx={{ minWidth: 0 }}>{right}</Box>
        </Box>
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Box sx={{ maxWidth: 640, mx: 'auto' }}>{action}</Box>
      </Box>
    </Box>
  );
}

interface OptionsEditorProps {
  options: string[];
  min: number;
  max: number;
  maxLength: number;
  duplicate: boolean;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

/** The list of choices: one numbered row each, a trash button, and "add" under the list. */
export function OptionsEditor({ options, min, max, maxLength, duplicate, onChange, onRemove, onAdd }: OptionsEditorProps) {
  const { t } = useTranslation();
  const clean = options.map((o) => o.trim());
  return (
    <>
      {options.map((option, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1.25 }}>
          <Typography sx={{ width: 24, pt: 1.2, textAlign: 'right', color: 'text.secondary', fontWeight: 'bold', flexShrink: 0 }}>{i + 1}</Typography>
          <TextField
            size="small"
            fullWidth
            placeholder={t('nemvoting.option_placeholder', { n: i + 1 })}
            value={option}
            onChange={(e) => onChange(i, e.target.value)}
            error={option.length > maxLength || (duplicate && option.trim() !== '' && clean.filter((o) => o === option.trim()).length > 1)}
            helperText={option.length > maxLength ? t('nemvoting.issue_option_long', { max: maxLength }) : undefined}
          />
          <IconButton aria-label={t('nemvoting.remove_option')} disabled={options.length <= min} onClick={() => onRemove(i)}>
            <DeleteOutlinedIcon />
          </IconButton>
        </Box>
      ))}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Button startIcon={<AddIcon />} disabled={options.length >= max} onClick={onAdd}>{t('nemvoting.add_option')}</Button>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{options.length} / {max}</Typography>
      </Box>
      {duplicate && <Typography variant="caption" sx={{ display: 'block', color: 'error.main', mt: 0.5 }}>{t('nemvoting.issue_option_duplicate')}</Typography>}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('nemvoting.options_hint', { min, max })}</Typography>
    </>
  );
}
