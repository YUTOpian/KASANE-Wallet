import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Grid, Card, Typography, Checkbox, FormControlLabel, Button } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { alpha } from '@mui/material/styles';
import { getPendingCreation } from '../../lib/pendingCreation';
import KasaneStage from '../../components/kasane/KasaneStage';
import MnemonicQuiz from '../../components/MnemonicQuiz';
import PaperWalletButton from '../../components/PaperWalletButton';
import MnemonicKeystoreButton from '../../components/MnemonicKeystoreButton';
import cautionIcon from '../../assets/icon_caution.png';
import { getChain } from '../../lib/chain';
import { getNetwork } from '../../lib/symbol/network';
import { SYMBOL_TESTNET_COIN_TYPE } from '../../lib/symbol/hd';

export default function WalletCreationMnemonic() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The phrase was generated on the name screen and only lives in memory; nothing is on the device yet.
  const pending = getPendingCreation();
  const mnemonic = pending?.phrase ?? '';

  const [confirmed, setConfirmed] = useState(false);
  // 'show': the phrase is on screen. 'verify': the person picks words by position to prove it was copied correctly.
  const [stage, setStage] = useState<'show' | 'verify'>('show');
  // Bumped each time the person returns to the phrase, so the next test asks different positions.
  const [quizRound, setQuizRound] = useState(0);

  // After a reload (or when opened directly) the pending profile is gone: start over at the name screen.
  useEffect(() => {
    if (!pending) navigate('/wallet/creation/name', { replace: true });
  }, [pending, navigate]);

  // Back (arrow, browser button, swipe) always returns to the "ウォレットの作成" screen.
  const backToName = () => navigate('/wallet/creation/name', { replace: true });

  const words = useMemo(() => (mnemonic.length === 0 ? [] : mnemonic.split(' ')), [mnemonic]);

  // The test was passed: next the person picks which accounts to show; the profile is saved there.
  const goToAccounts = () => navigate('/wallet/creation/accounts');

  if (!pending) return null;

  if (stage === 'verify') {
    return (
      <KasaneStage title={t('wallet.mnemonic_quiz_title')} onBack={() => { setQuizRound((n) => n + 1); setStage('show'); }} maxWidth={560}>
        <MnemonicQuiz
          key={quizRound}
          words={words}
          onPass={goToAccounts}
          onReview={() => { setQuizRound((n) => n + 1); setStage('show'); }}
        />
      </KasaneStage>
    );
  }

  return (
    <KasaneStage title={t('wallet.mnemonic_title')} onBack={backToName} back="/wallet/creation/name" maxWidth={560}>
      <Box sx={{ mb: 5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', mt: 2, gap: 1 }}>
          <Box component="img" src={cautionIcon} sx={{ width: 16, height: 16 }} />
          <span>{t('wallet.mnemonic_caution_title')}</span>
        </Box>

        <Typography align="center" sx={{ mt: 2, mx: 2 }}>{t('wallet.mnemonic_caution_message')}</Typography>

        <Typography align="center" sx={{ mt: 2, mx: 2, color: 'text.secondary', fontSize: 13 }}>
          {(t(getChain() === 'nem' ? 'wallet.mnemonic_interop_notice_nem' : 'wallet.mnemonic_interop_notice', { returnObjects: true }) as string[]).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Grid container spacing={0.5} sx={{ justifyContent: 'center', mt: 3, px: 2 }}>
          {words.map((word, index) => (
            <Grid key={index} size={{ xs: 4, md: 3 }} sx={{ p: 0.5 }}>
              <Card variant="outlined" sx={{ bgcolor: 'grey.100', borderColor: 'divider', borderRadius: '12px', p: 1, position: 'relative' }}>
                <Typography component="span" sx={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'text.secondary', fontSize: 12 }}>{index + 1}</Typography>
                <Typography align="center" sx={{ fontSize: 'inherit' }}>{word}</Typography>
              </Card>
            </Grid>
          ))}
        </Grid>

        <PaperWalletButton source={mnemonic ? { kind: 'mnemonic', mnemonic, symbolCoinType: getNetwork() === 'testnet' ? SYMBOL_TESTNET_COIN_TYPE : undefined } : null} />
        <MnemonicKeystoreButton mnemonic={mnemonic} symbolCoinType={getNetwork() === 'testnet' ? SYMBOL_TESTNET_COIN_TYPE : undefined} />

        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <FormControlLabel
            control={<Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />}
            label={t('wallet.mnemonic_confirm_checkbox')}
          />
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', py: 2, background: (t) => `linear-gradient(180deg, transparent 0%, ${alpha(t.palette.background.default, 0.92)} 40%)` }}>
        <Button variant="contained" color="primary" size="large" disabled={!confirmed || words.length === 0} onClick={() => setStage('verify')} sx={{ minWidth: 200 }}>
          {t('wallet.mnemonic_next_verify')}
        </Button>
      </Box>
    </KasaneStage>
  );
}
