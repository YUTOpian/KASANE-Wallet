import { useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import KasaneStage from './kasane/KasaneStage';
import OfficialProfileExportButton from './OfficialProfileExportButton';
import { DisclaimerBox } from './Disclaimer';

interface Props {
  // 完了: leaves for Home. Only enabled once the terms are accepted.
  onDone: () => void;
  // 戻る: only shown when there is a sensible screen to go back to.
  onBack?: () => void;
  // 渡すと、このプロファイルを公式Symbolウォレット用に書き出す導線を出す。
  exportWalletId?: string | null;
}

// 「安全な保管の知識」: the last screen after creating or importing a profile (before Home) - how to keep the
// recovery phrase safe; the person confirms they understood it.
export default function SafeStorageNotice({ onDone, onBack, exportWalletId }: Props) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  // 免責事項（ノンカストディアンのため、資金が流出しても開発者は責任を負わない）への同意。
  const [disclaimerAgreed, setDisclaimerAgreed] = useState(false);
  const points = t('wallet.safe_points', { returnObjects: true }) as string[];

  return (
    <KasaneStage showBack={false} title={t('wallet.safe_title')} maxWidth={560}>
      <Box sx={{ mt: 2, px: 1 }}>
        <Box component="ul" sx={{ m: 0, pl: 3, lineHeight: 1.9 }}>
          {points.map((line, i) => (
            <Typography key={i} component="li" sx={{ mb: 1.5 }}>{line}</Typography>
          ))}
        </Box>

        {exportWalletId ? <OfficialProfileExportButton walletId={exportWalletId} /> : null}

        <DisclaimerBox />

        <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column' }}>
          <FormControlLabel
            control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />}
            label={
              <Typography component="span">{t('wallet.safe_understood')}</Typography>
            }
          />
          <FormControlLabel
            control={<Checkbox checked={disclaimerAgreed} onChange={(e) => setDisclaimerAgreed(e.target.checked)} />}
            label={
              <Typography component="span">{t('wallet.disclaimer_agree')}</Typography>
            }
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5, mt: 4 }}>
          {onBack && (
            <Button variant="outlined" color="primary" size="large" onClick={onBack} sx={{ minWidth: 120 }}>
              {t('common.back')}
            </Button>
          )}
          <Button variant="contained" color="primary" size="large" disabled={!agreed || !disclaimerAgreed} onClick={onDone} sx={{ minWidth: 120 }}>
            {t('common.done')}
          </Button>
        </Box>
      </Box>
    </KasaneStage>
  );
}
