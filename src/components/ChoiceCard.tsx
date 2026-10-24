import type { ElementType, ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

// プロファイルの新規作成／選択で共通の、大きなカード（アイコン・タイトル・ひとこと説明・補足）。
// hintFloating: hint をカードの下端に浮かせて置き、カードの高さを増やさない（ほかのカードと高さをそろえたいとき）。
// badge: 右上の小さな札（「はじめての方」「使用中」など） / action: 左上の操作（歯車など） / dashed: 「新規」を示す点線の枠。
export interface ChoiceCardProps {
  icon: ElementType;
  title: string; // a \n in it is a line break (e.g. "NEMonster\nfor Symbol")
  desc?: string;
  hint?: string;
  hintFloating?: boolean;
  badge?: string;
  action?: ReactNode;
  selected?: boolean;
  dashed?: boolean;
  onClick: () => void;
}

export default function ChoiceCard({ icon: Icon, title, desc, hint, hintFloating, badge, action, selected, dashed, onClick }: ChoiceCardProps) {
  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
      }}
      sx={{
        position: 'relative', cursor: 'pointer', outline: 'none', textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        px: { xs: 2, md: 3.5 }, py: { xs: 2.5, sm: 3.5, md: 5 }, gap: { xs: 1, md: 1.5 }, minHeight: { md: 250 }, height: '100%', boxSizing: 'border-box',
        bgcolor: 'background.paper', borderRadius: { xs: '20px', md: '24px' }, border: 2, borderStyle: dashed ? 'dashed' : 'solid',
        borderColor: selected ? (t) => t.kasane.accent : (t) => t.kasane.line,
        boxShadow: (t) => t.kasane.cardShadow,
        transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
        '&:hover': { boxShadow: (t) => t.kasane.cardShadowHover, borderColor: (t) => t.kasane.accent },
        '&:active': { transform: 'scale(0.99)' },
        '&:focus-visible': { boxShadow: (t) => `0 0 0 3px ${t.kasane.accent}` },
      }}
    >
      {action && <Box onClick={(e) => e.stopPropagation()} sx={{ position: 'absolute', top: { xs: 6, md: 12 }, left: { xs: 8, md: 14 } }}>{action}</Box>}
      {badge && (
        <Box sx={{ position: 'absolute', top: { xs: 10, md: 16 }, right: { xs: 12, md: 18 }, px: { xs: 1, md: 1.5 }, py: { xs: 0.25, md: 0.4 }, borderRadius: 10, bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: { xs: 11, md: 12.5 }, fontWeight: 700 }}>
          {badge}
        </Box>
      )}
      <Icon sx={{ fontSize: { xs: 44, sm: 56, md: 68 }, color: 'primary.main', mb: { xs: 0.5, md: 1 } }} />
      <Typography sx={{ fontWeight: 800, fontSize: { xs: 17, sm: 19, md: 21 }, color: 'text.primary', wordBreak: 'break-word', whiteSpace: 'pre-line' }}>{title}</Typography>
      {desc && <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: { xs: 1.7, md: 1.8 }, fontSize: { md: 15 } }}>{desc}</Typography>}
      {hint && !hintFloating && <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.8, mt: 'auto', pt: { xs: 1, md: 2 }, fontSize: { md: 13 }, lineHeight: 1.6 }}>{hint}</Typography>}
      {hint && hintFloating && (
        <Typography variant="caption" sx={{ position: 'absolute', left: 0, right: 0, bottom: { xs: 2, sm: 6, md: 14 }, color: 'text.secondary', opacity: 0.8, fontSize: { xs: 11, md: 13 }, lineHeight: 1.4 }}>{hint}</Typography>
      )}
    </Box>
  );
}

/** 3 columns on a wide screen, 1 on a phone. */
export const choiceGridSx = {
  display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(230px, 260px))' }, justifyContent: 'center', gap: { xs: 2, md: 3 }, mt: { xs: 3, md: 5 }, mb: { xs: 2, md: 4 },
} as const;
