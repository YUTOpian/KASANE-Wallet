import { useId } from 'react';
import { Box, TextField as MuiTextField, Typography } from '@mui/material';
import type { TextFieldProps } from '@mui/material';

// 入力欄の共通部品。MUI の TextField と同じ使い方で、label を渡すと
// 「枠線に乗るラベル」ではなく「欄の上の太字の見出し」として出す（中は placeholder の薄い文字だけ）。
// プルダウン（select）も同じ形。枠にラベルを乗せたい場所（履歴の絞り込みなど）は MUI の TextField をそのまま使う。label が無い欄は何も変えない。
export default function TextField(props: TextFieldProps) {
  const { label, sx, fullWidth, id, required, ...rest } = props;
  const autoId = useId();
  if (label === undefined || label === null || label === '') return <MuiTextField {...props} />;
  const fieldId = id ?? autoId;
  return (
    <Box
      sx={[
        { display: fullWidth ? 'block' : 'inline-block', width: fullWidth ? '100%' : undefined, minWidth: 0, textAlign: 'left' },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Typography component="label" htmlFor={fieldId} sx={{ display: 'block', fontWeight: 'bold', mb: 1 }}>
        {label}{required ? ' *' : ''}
      </Typography>
      <MuiTextField {...(rest as TextFieldProps)} id={fieldId} required={required} fullWidth />
    </Box>
  );
}
