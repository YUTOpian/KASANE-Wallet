import { useState, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import {
  Box, TextField, Button, Typography, Link as MuiLink,
  Dialog, IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Scanner } from '@yudiel/react-qr-scanner';
import KasaneStage from '../../components/kasane/KasaneStage';
import PasswordDialog from '../../components/PasswordDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { MnemonicHelper } from '../../lib/symbol/hd';
import { profileAccounts } from '../../lib/accounts';
import ChainPicker from '../../components/ChainPicker';
import { useAppStore } from '../../store/appStore';
import type { ChainKey } from '../../lib/chain';

const IMPORTED_WALLET_NAME = 'Imported';
// Symbol wallets use 24-word phrases; a 12-word phrase is accepted too (leave the rest blank).
const MNEMONIC_LENGTH = 24;

export default function WalletLoginImport() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const currentChain = useAppStore((s) => s.chain);
  const setAppChain = useAppStore((s) => s.setChain);
  // インポートしたプロファイルで最初に開くチェーン（Symbol / NEM）。
  const [selectedChain, setSelectedChain] = useState<ChainKey>(currentChain);
  const [words, setWords] = useState<string[]>(Array(MNEMONIC_LENGTH).fill(''));
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const wordRefs = useRef<(HTMLInputElement | null)[]>([]);

  // インポートできるのはリカバリーフレーズ（ニーモニック）のみ。
  // 秘密鍵は、メニューの「ウォレット切替」から現在のプロファイルに追加する。
  const key = words.join(' ').trim();
  const isValidInput = key.length > 0 && MnemonicHelper.isValid(key);

  // Distributes a run of whitespace-separated words across the 12 boxes, starting at
  // startIndex. Used both for typing a space/enter to move on, and for pasting a full
  // phrase into any one of the boxes.
  const distributeWords = (tokens: string[], startIndex: number) => {
    setWords((prev) => {
      const next = [...prev];
      tokens.forEach((word, i) => {
        if (startIndex + i < MNEMONIC_LENGTH) {
          next[startIndex + i] = word;
        }
      });
      return next;
    });
    const lastIndex = Math.min(startIndex + tokens.length, MNEMONIC_LENGTH - 1);
    wordRefs.current[lastIndex]?.focus();
  };

  const onWordChange = (index: number, value: string) => {
    if (/\s/.test(value)) {
      const tokens = value.split(/\s+/).filter((w) => w.length > 0);
      distributeWords(tokens, index);
      return;
    }
    setWords((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const onWordKeyDown = (index: number, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && index < MNEMONIC_LENGTH - 1) {
      e.preventDefault();
      wordRefs.current[index + 1]?.focus();
    } else if (e.key === 'Backspace' && words[index] === '' && index > 0) {
      e.preventDefault();
      wordRefs.current[index - 1]?.focus();
    }
  };

  const onWordPaste = (index: number, e: ClipboardEvent<HTMLDivElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (/\s/.test(pasted.trim())) {
      e.preventDefault();
      distributeWords(pasted.trim().split(/\s+/), index);
    }
  };

  const onDecodeQr = (decoded: string) => {
    const tokens = decoded.trim().split(/\s+/).filter((w) => w.length > 0);
    setShowScanner(false);
    if (tokens.length >= 12) {
      setWords(tokens.slice(0, MNEMONIC_LENGTH));
    } else {
      setErrorMessage(t('wallet.invalid_mnemonic'));
    }
  };

  const createWalletWithPin = async (pinCode: string) => {
    try {
      if (!MnemonicHelper.isValid(key)) {
        throw new Error('invalid mnemonic');
      }
      // 取り込んだニーモニックは、そのまま1つのプロファイルになる（新規作成と同じく、
      // インデックス 0〜N-1 のアカウントをあらかじめ導出しておく）。
      setAppChain(selectedChain);
      const phrase = MnemonicHelper.normalize(key);
      const accounts = profileAccounts(phrase); // Symbol and NEM accounts of the same phrase
      const wallets = await WalletsHelper.createProfileWithMnemonic(IMPORTED_WALLET_NAME, phrase, pinCode, accounts);
      await WalletsHelper.addProfile(wallets, wallets[0].id, pinCode);
      navigate('/wallet/login/name');
    } catch {
      setErrorMessage(t('wallet.invalid_mnemonic'));
    }
  };

  // インポートしたニーモニックは新しいプロファイルになる。パスワードはプロファイルごとなので、
  // ほかのプロファイルとは別に、ここで新しいパスワードを設定する（'register'：2回入力）。
  const createWallet = () => {
    setShowPinDialog(true);
  };

  return (
    <KasaneStage back="/wallet/new" title={t('wallet.import_title')} maxWidth={640}>
      <Box>
        <Typography align="center" sx={{ mx: 2 }}>
          {(
            t('wallet.import_message', { returnObjects: true }) as string[]
          ).map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Typography>

        <Box sx={{ mx: 1, mt: 2 }}>
          <ChainPicker value={selectedChain} onChange={setSelectedChain} />
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mx: 1, mt: 2 }}>
            {words.map((word, i) => {
              const invalid = !MnemonicHelper.isValidWord(word);
              return (
                <TextField
                  key={i}
                  inputRef={(el) => { wordRefs.current[i] = el; }}
                  label={t('wallet.import_mnemonic_word_label', { index: i + 1 })}
                  value={word}
                  onChange={(e) => onWordChange(i, e.target.value)}
                  onKeyDown={(e) => onWordKeyDown(i, e)}
                  onPaste={(e) => onWordPaste(i, e)}
                  size="small"
                  error={invalid}
                  sx={invalid ? { '& .MuiInputBase-input': { color: 'error.main' } } : undefined}
                  slotProps={{ input: { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } }}
                />
              );
            })}
          </Box>

        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
          <Button startIcon={<QrCodeScannerIcon />} onClick={() => setShowScanner(true)}>
            {t('wallet.import_scan_qr')}
          </Button>
        </Box>

        {key.length > 0 && !isValidInput && (
          <Typography align="center" sx={{ color: 'error.main', fontSize: 12 }}>{t('wallet.invalid_mnemonic')}</Typography>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 2 }}>
          <Button variant="contained" color="primary" disabled={!isValidInput} onClick={createWallet}>OK</Button>
        </Box>

        <Typography align="center" variant="caption" sx={{ display: 'block', mt: 4 }}>
          {t('common.privacy_policy_caution')}<br />
          <MuiLink component={Link} to="/" underline="always">{t('common.privacy_policy')}</MuiLink>
        </Typography>
      </Box>

      <PasswordDialog
        open={showPinDialog}
        mode="register"
        // Left as a no-op deliberately, same reasoning as WalletCreationName: onClose
        // fires the instant the PIN is confirmed, right before createWalletWithPin's
        // several awaited storage calls (create/add/setActive/unlock) and its navigate()
        // run - closing the dialog there would expose this import screen underneath for
        // that whole stretch. Only a genuine cancel (onCancel below) should dismiss it.
        onClose={() => {}}
        onCancel={() => setShowPinDialog(false)}
        onPass={createWalletWithPin}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />

      <Dialog fullScreen open={showScanner} onClose={() => setShowScanner(false)}>
        <Box sx={{ position: 'relative', height: '100%', bgcolor: 'black' }}>
          <IconButton
            onClick={() => setShowScanner(false)}
            sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, color: 'white' }}
          >
            <CloseIcon />
          </IconButton>
          <Typography align="center" sx={{ color: 'white', position: 'absolute', top: 12, left: 0, right: 0, zIndex: 1 }}>
            {t('wallet.import_scan_title')}
          </Typography>
          {showScanner && (
            <Scanner
              onScan={(results) => { if (results[0]) onDecodeQr(results[0].rawValue); }}
              onError={(error) => setErrorMessage(error instanceof Error ? error.message : String(error))}
            />
          )}
        </Box>
      </Dialog>
    </KasaneStage>
  );
}
