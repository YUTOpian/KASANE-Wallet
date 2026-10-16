import type { ReactNode } from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import QrCodeScannerOutlinedIcon from '@mui/icons-material/QrCodeScannerOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { useAppStore } from '../../store/appStore';

// The frame of the offline screens (オフライントランザクション), laid out like the official wallet's offline screen:
//   [ 転送トランザクション | トランザクションに連署 ]      <- what to do (the two screens)
//   [ 1 準備 ]  2 ...  3 ...                                <- where you are in it
// and, at the bottom, the way on to the PC that is online (署名・連署QR), where the result is sent.

export type OfflineTab = 'transfer' | 'cosign';

interface Props {
  tab: OfflineTab;
  steps: string[]; // labels, in order
  step: number; // index of the current step
  children: ReactNode;
}

const TABS: Array<{ key: OfflineTab; path: string; label: string }> = [
  { key: 'transfer', path: '/offline/sign', label: 'offline_ui.tab_transfer' },
  { key: 'cosign', path: '/offline/cosign', label: 'offline_ui.tab_cosign' },
];

export default function OfflineShell({ tab, steps, step, children }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setChain = useAppStore((s) => s.setChain);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton back="/wallet/select" />
      <Box sx={{ width: '100%', maxWidth: 760, mx: 'auto', px: { xs: 2, md: 3 }, py: 1, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography component="h1" sx={{ fontSize: 20, fontWeight: 'bold', mb: 0.5 }}>{t('offline.hub_title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, mb: 2 }}>{t('offline_ui.lead')}</Typography>

        {/* what to do */}
        <Box role="tablist" sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          {TABS.map((x, i) => (
            <Box key={x.key} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {i > 0 && <Box sx={{ width: '1px', height: 18, bgcolor: 'divider' }} />}
              <ButtonBase
                role="tab"
                aria-selected={x.key === tab}
                onClick={() => { if (x.key !== tab) navigate(x.path, { replace: true }); }}
                sx={{
                  py: 1.25, fontSize: '0.95rem', fontWeight: x.key === tab ? 'bold' : 'normal',
                  color: x.key === tab ? 'primary.main' : 'text.secondary',
                  borderBottom: 2, borderColor: x.key === tab ? 'primary.main' : 'transparent', mb: '-1px',
                }}
              >
                {t(x.label)}
              </ButtonBase>
            </Box>
          ))}
        </Box>

        {/* where you are */}
        <Box component="ol" aria-label={t('offline_ui.steps')} sx={{ listStyle: 'none', m: 0, p: 0, mb: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {steps.map((label, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <Box
                component="li"
                key={label}
                aria-current={active ? 'step' : undefined}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderRadius: 1.5, fontSize: '0.9rem',
                  fontWeight: active ? 'bold' : 'normal',
                  background: (th) => (active ? th.kasane.gradient : 'transparent'),
                  color: (th) => (active ? th.kasane.ink : done ? th.palette.text.primary : th.palette.text.disabled),
                  border: 1, borderColor: active ? 'transparent' : 'divider',
                }}
              >
                <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>{done ? '✓' : i + 1}</Box>
                {label}
              </Box>
            );
          })}
        </Box>

        {children}

        {/* the way on */}
        <Box sx={{ mt: 4, pt: 2, borderTop: 1, borderColor: 'divider' }}>
          <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 0.5 }}>{t('offline_ui.send_title')}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, mb: 1 }}>{t('offline_ui.send_desc')}</Typography>
          <ButtonBase
            // The signing QR screen works on the active Symbol account.
            onClick={() => { setChain('symbol'); navigate('/signqr'); }}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, border: 1, borderColor: 'divider', borderRadius: 1.5, color: 'primary.main', fontWeight: 'bold', fontSize: '0.9rem' }}
          >
            <QrCodeScannerOutlinedIcon fontSize="small" />
            {t('offline_ui.send_button')}
          </ButtonBase>
        </Box>
      </Box>
    </Box>
  );
}
