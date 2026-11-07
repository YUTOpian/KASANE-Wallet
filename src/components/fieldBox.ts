import type { Theme } from '@mui/material/styles';

// 入力欄・プルダウン（OutlinedInput）と同じ見た目の枠。費用などの情報ボックスの sx に展開して使う。
// 枠線の色・背景・角丸は、テーマの kasane.field（= MuiOutlinedInput と同じ値）から取る。
export const fieldBoxSx = {
  bgcolor: (t: Theme) => t.kasane.field.bg,
  border: (t: Theme) => `1px solid ${t.kasane.field.line}`,
  borderRadius: (t: Theme) => `${t.kasane.field.radius}px`,
  px: 2,
  py: 1.5,
};
