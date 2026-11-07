import { Box, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useTranslation } from 'react-i18next';
import type { CheckItem, CheckState } from '../../lib/symbol/harvestEligibility';

const ICON: Record<CheckState, { icon: typeof CheckCircleOutlineIcon; color: string }> = {
  ok: { icon: CheckCircleOutlineIcon, color: 'success.main' },
  warn: { icon: WarningAmberIcon, color: 'warning.main' },
  ng: { icon: ErrorOutlineIcon, color: 'error.main' },
  unknown: { icon: HelpOutlineIcon, color: 'text.disabled' },
};

/** The result of the checks before starting: one line per item, with a mark for ok / warning / ng / not checked. */
export default function EligibilityList({ title, items, values }: { title: string; items: CheckItem[]; values: Record<string, string> }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 1, mb: 2 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', mb: 0.5 }}>{title}</Typography>
      {items.map((item) => {
        const { icon: Icon, color } = ICON[item.state];
        return (
          <Box key={item.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, py: 0.25 }}>
            <Icon sx={{ fontSize: 18, color, mt: '2px', flexShrink: 0 }} />
            <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
              {t(`harvest.check_${item.id}_${item.state}`, { ...values, blocks: item.blocks ?? 0 })}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}
