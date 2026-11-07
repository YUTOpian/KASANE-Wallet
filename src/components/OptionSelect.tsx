import { Children, isValidElement } from 'react';
import type { ReactElement, ReactNode, SyntheticEvent } from 'react';
import { MenuItem, Select } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

// 排他の選択肢（以前のトグルボタン）を、プルダウンで出す共通部品。
// 使い方は ToggleButtonGroup / ToggleButton と同じ形（OptionSelect の子に OptionItem を並べる）。

interface OptionItemProps {
  value: string;
  disabled?: boolean;
  /** 以前のトグルボタンとの互換用（プルダウンでは使わない）。 */
  sx?: SxProps<Theme>;
  children?: ReactNode;
}

/** 選択肢 1 つ。OptionSelect の中でだけ使う（単体では何も描かない）。 */
export function OptionItem(_props: OptionItemProps): null {
  return null;
}

interface OptionSelectProps {
  value: string | null;
  /** 選んだ値（文字列）が渡る。呼び出し側は、自分の型（'a' | 'b' など）で受けてよい。 */
  onChange?: (event: SyntheticEvent, value: never) => void;
  /** 以前のトグルボタンとの互換用（常に 1 つだけ選ぶ）。 */
  exclusive?: boolean;
  fullWidth?: boolean;
  size?: 'small' | 'medium';
  color?: 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning' | 'standard';
  disabled?: boolean;
  'aria-label'?: string;
  sx?: SxProps<Theme>;
  children?: ReactNode;
}

export default function OptionSelect({
  value, onChange, fullWidth, size = 'medium', color, disabled, sx, children, 'aria-label': ariaLabel,
}: OptionSelectProps) {
  const items = Children.toArray(children).filter((c): c is ReactElement<OptionItemProps> => isValidElement(c) && c.type === OptionItem);
  const selectColor = color && color !== 'standard' ? color : undefined;
  return (
    <Select
      value={value !== null && items.some((i) => i.props.value === value) ? value : ''}
      onChange={(e) => (onChange as ((event: SyntheticEvent, value: string) => void) | undefined)?.(e as unknown as SyntheticEvent, e.target.value)}
      fullWidth={fullWidth}
      size={size}
      color={selectColor}
      disabled={disabled}
      displayEmpty
      inputProps={{ 'aria-label': ariaLabel }}
      sx={[{ minWidth: 160 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      {items.map((i) => (
        <MenuItem key={i.props.value} value={i.props.value} disabled={i.props.disabled}>{i.props.children}</MenuItem>
      ))}
    </Select>
  );
}
