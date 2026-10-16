import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

// プロファイル選択・ウォレット切替で共通に使うカード。
//   タイトル（太字） / 小さな等幅の識別子 / 大きな紫の値 / 補足テキスト
// 角丸のカードに、チェーンの色（Symbol: ピンク系 / NEM: アクア系）のやわらかい影。選択中のものはチェーン色の枠線で示す。
interface InfoCardProps {
  title: string;
  mono?: string;
  value?: string;
  caption?: string;
  selected?: boolean;
  onClick?: () => void;
  action?: ReactNode; // タイトル右側（歯車など）
  footer?: ReactNode; // カード下部のボタン類
}

export default function InfoCard({ title, mono, value, caption, selected, onClick, action, footer }: InfoCardProps) {
  return (
    <Box
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
      } : undefined}
      sx={{
        cursor: onClick ? 'pointer' : 'default',
        outline: 'none',
        transition: 'box-shadow 0.15s ease, transform 0.15s ease',
        ...(onClick && {
          '&:hover': { boxShadow: (t) => t.kasane.cardShadowHover },
          '&:active': { transform: 'scale(0.99)' },
          '&:focus-visible': { boxShadow: (t) => `0 0 0 3px ${t.kasane.accent}` },
        }),
        bgcolor: 'background.paper',
        borderRadius: (t) => `${t.kasane.cardRadius}px`,
        border: 2,
        borderStyle: 'solid',
        borderColor: selected ? (t) => t.kasane.accent : (t) => t.kasane.line,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxShadow: (t) => t.kasane.cardShadow,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{ px: 1.75, py: 1.5 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <Typography sx={{ fontWeight: 800, fontSize: 16, color: 'text.primary', wordBreak: 'break-word' }}>{title}</Typography>
          {action}
        </Box>
        {mono && (
          <Typography sx={{ mt: 1, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5, color: 'text.secondary', wordBreak: 'break-all' }}>
            {mono}
          </Typography>
        )}
        {value !== undefined && (
          <Typography sx={{ mt: 1.25, fontWeight: 800, fontSize: 20, color: 'primary.main', lineHeight: 1.2 }}>{value}</Typography>
        )}
        {caption && (
          <Typography sx={{ mt: 0.25, fontSize: 14, color: 'text.secondary', wordBreak: 'break-all' }}>{caption}</Typography>
        )}
      </Box>
      {footer && <Box onClick={(e) => e.stopPropagation()} sx={{ px: 1, pb: 1, display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 0.5 }}>{footer}</Box>}
    </Box>
  );
}

// タイルを並べるグリッド（スマホは2列、広い画面は自動で増える）
export const tileGridSx = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 150px), 1fr))',
  gap: 2,
  mx: 2,
  mt: 2,
} as const;
