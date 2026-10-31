import { Box, ButtonBase, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

export type AccountTab = 'accounts' | 'addressbook';

/**
 * 「マイアカウント | マイ連絡先」: 左のカードの見出しで、アカウントとアドレス帳を切り替える（公式のSymbolウォレットと同じ作り）。
 * 選んでいるほうは濃く、もう一方は薄く出す。
 */
export default function ProfileSwitch({ value, onChange }: { value: AccountTab; onChange: (tab: AccountTab) => void }) {
  const { t } = useTranslation();
  const item = (tab: AccountTab, label: string) => (
    <ButtonBase
      onClick={() => onChange(tab)}
      aria-pressed={value === tab}
      sx={{ borderRadius: 1, px: 0.5, py: 0.25 }}
    >
      <Typography sx={{ fontSize: '1.15rem', fontWeight: value === tab ? 700 : 400, color: value === tab ? 'text.primary' : 'text.disabled' }}>
        {label}
      </Typography>
    </ButtonBase>
  );
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, px: 1 }}>
      {item('accounts', t('account.my_accounts'))}
      <Box aria-hidden sx={{ width: '2px', height: 24, bgcolor: 'text.primary' }} />
      {item('addressbook', t('addressbook.my_contacts'))}
    </Box>
  );
}
