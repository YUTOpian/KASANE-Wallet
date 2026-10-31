import { useState, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import {
  Box, TextField, Button, Typography,
  Dialog, IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Scanner } from '@yudiel/react-qr-scanner';
import KasaneStage from '../../components/kasane/KasaneStage';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MnemonicQrPasswordDialog from '../../components/MnemonicQrPasswordDialog';
import KeystoreImportButton from '../../components/KeystoreImportButton';
import QrImageButton from '../../components/QrImageButton';
import { setPendingImport, setPendingKeyImport } from '../../lib/pendingImport';
import type { KeystoreAccount } from '../../lib/keystore';
import { MnemonicHelper } from '../../lib/symbol/hd';
import { parseMnemonicQr } from '../../lib/symbol/mnemonicQr';
import ChainPicker from '../../components/ChainPicker';
import { useAppStore } from '../../store/appStore';
import type { ChainKey } from '../../lib/chain';

// Symbol wallets use 24-word phrases; a 12-word phrase is accepted too (leave the rest blank).
const MNEMONIC_LENGTH = 24;

export default function WalletLoginImport() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const currentChain = useAppStore((s) => s.chain);
  const appNetwork = useAppStore((s) => s.network);
  // インポートしたプロファイルで最初に開くチェーン（Symbol / NEM）。
  const [selectedChain, setSelectedChain] = useState<ChainKey>(currentChain);
  const [words, setWords] = useState<string[]>(Array(MNEMONIC_LENGTH).fill(''));
  const [showScanner, setShowScanner] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // An encrypted mnemonic QR that was read and is waiting for its password.
  const [encryptedQr, setEncryptedQr] = useState<{ ciphertext: string; salt: string } | null>(null);
  const wordRefs = useRef<(HTMLInputElement | null)[]>([]);

  // ここで新しいプロファイルにできるのは、ニーモニックフレーズか、キーストアファイル（秘密鍵1本）。
  // 秘密鍵そのものの入力は、メニューの「アカウント」から現在のプロファイルに追加する。
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

  const fillWords = (phrase: string) => {
    const tokens = phrase.trim().split(/\s+/).filter((w) => w.length > 0);
    if (tokens.length >= 12) setWords(tokens.slice(0, MNEMONIC_LENGTH));
    else setErrorMessage(t('wallet.invalid_mnemonic'));
  };

  // The QR is the mnemonic QR of the Symbol wallets: password-encrypted (asks for the password), or the plain one
  // of a paper wallet. A plain list of words is still accepted.
  const onDecodeQr = (decoded: string) => {
    setShowScanner(false);
    const qr = parseMnemonicQr(decoded);
    if (qr?.encrypted) setEncryptedQr({ ciphertext: qr.ciphertext, salt: qr.salt });
    else fillWords(qr ? qr.mnemonic : decoded);
  };

  // OK: hand the phrase to the next screen, where the accounts to show are picked (from the addresses
  // that are in use on the network); after that the profile name and password are set and the profile is created.
  const createWallet = () => {
    if (!MnemonicHelper.isValid(key)) {
      setErrorMessage(t('wallet.invalid_mnemonic'));
      return;
    }
    setPendingImport(MnemonicHelper.normalize(key), selectedChain);
    navigate('/wallet/login/accounts');
  };

  // キーストアファイル: 鍵を次の画面（プロファイル名とパスワード）に渡して、秘密鍵1本だけのプロファイルを作る。
  // mijin v2 のファイルは、mijin のノードの設定（生成ハッシュなど）が要るので、すでに mijin のノードに接続している（ネットワークが mijin になっている）ときだけ受け付ける。
  // mijin はネットワークの選択肢にないので、先にノードを接続するよう案内する。
  const onKeystoreLoaded = (account: KeystoreAccount) => {
    if (account.network === 'mijin' && appNetwork !== 'mijin') {
      setErrorMessage(t('wallet.keystore_mijin_node_first'));
      return;
    }
    setPendingKeyImport(account);
    navigate('/wallet/login/name');
  };

  return (
    <KasaneStage onBack={() => navigate('/wallet/new', { replace: true })} back="/wallet/new" title={t('wallet.import_title')} maxWidth={640} panel>
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

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(3, 1fr)', md: 'repeat(4, 1fr)' }, gap: { xs: 1, md: 1.5 }, mx: 1, mt: 2 }}>
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

        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', columnGap: 2, mt: 1.5 }}>
          <Button startIcon={<QrCodeScannerIcon />} onClick={() => setShowScanner(true)}>
            {t('wallet.import_scan_qr')}
          </Button>
          <QrImageButton variant="text" size="medium" fullWidth={false} startIcon={<ImageOutlinedIcon />} onDecoded={onDecodeQr} onNotFound={() => setErrorMessage(t('signqr.image_not_found'))} />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}>
          <KeystoreImportButton variant="text" onLoaded={onKeystoreLoaded} />
        </Box>

        {key.length > 0 && !isValidInput && (
          <Typography align="center" sx={{ color: 'error.main', fontSize: 12 }}>{t('wallet.invalid_mnemonic')}</Typography>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 2 }}>
          <Button variant="contained" color="primary" disabled={!isValidInput} onClick={createWallet}>OK</Button>
        </Box>

      </Box>

      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MnemonicQrPasswordDialog qr={encryptedQr} onClose={() => setEncryptedQr(null)} onDecrypted={(phrase) => { setEncryptedQr(null); fillWords(phrase); }} />

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
          <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1, px: 3, py: 2, bgcolor: 'rgba(0,0,0,0.6)' }}>
            <QrImageButton onDecoded={onDecodeQr} onNotFound={() => setErrorMessage(t('signqr.image_not_found'))} sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.paper' } }} />
          </Box>
        </Box>
      </Dialog>
    </KasaneStage>
  );
}
