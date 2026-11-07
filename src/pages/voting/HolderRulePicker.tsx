import { Alert, Box, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

// 「モザイク保有者による投票」を作るときの、対象にできるモザイクの条件の選択（NEM・Symbol 共通）。
//   ・移転できないモザイクのみ: 第三者に渡せないモザイクだけを指定できる。持っている人を、モザイクを作った人が決められる。
//   ・移転できるモザイクでもよい: 渡せるモザイクも指定できる。ただし、モザイクを渡すだけで投票できる人が増える。
interface Props {
  nonTransferableOnly: boolean;
  onChange: (nonTransferableOnly: boolean) => void;
  /** 「移転できないモザイクのみ」なのに、指定したモザイクが移転できる設定。 */
  conflict: boolean;
}

export default function HolderRulePicker({ nonTransferableOnly, onChange, conflict }: Props) {
  const { t } = useTranslation();
  return (
    <Box sx={{ mb: 2 }}>
      <FormControl fullWidth>
        <FormLabel sx={{ fontWeight: 'bold', color: 'text.primary', mb: 0.5 }}>{t('symbolvoting.holder_rule_label')}</FormLabel>
        <RadioGroup value={nonTransferableOnly ? 'nt' : 'any'} onChange={(e) => onChange(e.target.value === 'nt')}>
          <FormControlLabel
            value="nt"
            control={<Radio />}
            label={
              <Box>
                <Typography>{t('symbolvoting.holder_rule_nt')}</Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('symbolvoting.holder_rule_nt_desc')}</Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', mb: 1 }}
          />
          <FormControlLabel
            value="any"
            control={<Radio />}
            label={
              <Box>
                <Typography>{t('symbolvoting.holder_rule_any')}</Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('symbolvoting.holder_rule_any_desc')}</Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start' }}
          />
        </RadioGroup>
      </FormControl>
      {!nonTransferableOnly && <Alert severity="warning" sx={{ mt: 1 }}>{t('symbolvoting.holder_rule_any_warning')}</Alert>}
      {conflict && <Alert severity="error" sx={{ mt: 1 }}>{t('symbolvoting.holder_nt_required_error')}</Alert>}
    </Box>
  );
}
