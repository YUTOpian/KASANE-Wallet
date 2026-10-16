import { useEffect, useRef, useState } from 'react';
import { Box, Button, Grid, Card, Typography } from '@mui/material';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import MnemonicQrExport from '../../components/MnemonicQrExport';
import PaperWalletButton from '../../components/PaperWalletButton';
import KeystoreButton from '../../components/KeystoreButton';
import OfficialProfileExportButton from '../../components/OfficialProfileExportButton';
import PasswordDialog from '../../components/PasswordDialog';
import { PinCodeHelper, WalletsHelper } from '../../lib/storage';
import { SYMBOL_TESTNET_COIN_TYPE } from '../../lib/symbol/hd';
import { markBackupDone } from '../../lib/onboarding';
import { Environment } from '../../lib/environment';
import cautionIcon from '../../assets/icon_caution.png';
import { getChain } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';

export default function WalletBackup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // The password already typed in the popup of WalletBackupCaution (router state, not the URL).
  const passedPin = useRef((location.state as { pin?: string } | null)?.pin);
  const id = searchParams.get('id') || '';
  // See WalletBackupCaution's matching `back` param - carried forward here so the "完了"
  // button lands in the right place even when this screen was reached from somewhere other
  // than a specific wallet's own settings screen.
  const back = searchParams.get('back') || '';
  // 'mnemonic' when reached from the app-wide Settings screen's バックアップ item (no wallet
  // id, `back=/settings/top`) - shows the recovery phrase for the active wallet. 'key' when
  // reached from a specific wallet's own settings screen (WalletSettings, has `id`) - shows
  // that wallet's private key. See WalletBackupCaution, which sets this same param.
  const mode = searchParams.get('mode') === 'mnemonic' ? 'mnemonic' : 'key';

  const [key, setKey] = useState('');
  const [hasMnemonic, setHasMnemonic] = useState(true);
  // テストネットで公式互換の鍵（コイン種別 1）を使っているプロファイルのとき 1（ペーパーウォレットの導出に合わせる）。
  const [symbolCoinType, setSymbolCoinType] = useState<number | undefined>(undefined);
  const [walletNotFound, setWalletNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  // バックアップするウォレットのプロファイル（パスワードはプロファイルごと）。
  const [profileKey, setProfileKey] = useState('');
  // 「公式ウォレット用に書き出す」で、どのプロファイルかを指すウォレット（そのプロファイルのアカウントのどれか）。
  const [profileWalletId, setProfileWalletId] = useState<string | null>(null);
  // Chain + public key of the wallet whose private key is shown (the paper wallet needs them in 'key' mode).
  const [keyWallet, setKeyWallet] = useState<{ chain: ChainKey; publicKey: string } | null>(null);
  const getWallet = async () => {
    const base = id.length === 0 ? await WalletsHelper.getActive() : await WalletsHelper.get(id);
    // ニーモニックはプロファイルに1つ。開いているアカウントが秘密鍵インポート分などで
    // ニーモニックを持たなくても、同じプロファイルのニーモニックを持つアカウントから取り出す。
    if (base && mode === 'mnemonic' && !base.hasMnemonic()) {
      return (await WalletsHelper.getProfileMnemonicWallet(base.id)) ?? base;
    }
    return base;
  };

  useEffect(() => {
    (async () => {
      setWalletNotFound(false);
      setLoadError(false);
      try {
        const wallet = await getWallet();
        if (wallet == null) {
          setKey('');
          setWalletNotFound(true);
          return;
        }
        setProfileWalletId(wallet.id);
        setSymbolCoinType(wallet.usesTestnetKeys ? SYMBOL_TESTNET_COIN_TYPE : undefined);
        if (mode === 'mnemonic' && !wallet.hasMnemonic()) {
          // Imported by private key - there is no recovery phrase to show.
          setHasMnemonic(false);
          setKey('');
          return;
        }
        setHasMnemonic(true);
        setProfileKey(wallet.profileKey);
        setKeyWallet({ chain: wallet.chain, publicKey: wallet.publicKey });
        if (!(await PinCodeHelper.hasSavedCode(wallet.profileKey))) {
          // No PIN has ever been set on this device, so there is nothing to check the
          // person against - this only happens for a wallet left over from a pre-fix
          // installation that was still encrypted with the old default placeholder PIN
          // (see PinCodeHelper.defaultPin's comment); every wallet created since always
          // has a real PIN behind it before it's ever persisted.
          const secret = mode === 'mnemonic'
            ? await WalletsHelper.decryptMnemonic(wallet.id, PinCodeHelper.defaultPin)
            : await WalletsHelper.decryptKey(wallet.id, PinCodeHelper.defaultPin);
          // Treat a blank result the same as a failed decryption - a real private key or
          // recovery phrase is never empty, so an empty/whitespace-only string here means
          // something upstream (stored ciphertext, PIN) is wrong, not that the secret
          // legitimately "is" blank.
          if (secret == null || secret.trim().length === 0) {
            setLoadError(true);
          }
          setKey(secret || '');
        } else if (passedPin.current) {
          // Already verified in the popup of the previous screen. Drop it from the history entry
          // so a reload asks for the password again.
          const pin = passedPin.current;
          navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
          await onPassed(pin);
        } else {
          setShowPinDialog(true);
        }
      } catch (e) {
        console.error('WalletBackup: failed to load/decrypt wallet secret', e);
        setLoadError(true);
        setKey('');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode]);

  const onPassed = async (pin: string) => {
    try {
      const wallet = await getWallet();
      if (wallet != null) {
        const secret = mode === 'mnemonic'
          ? await WalletsHelper.decryptMnemonic(wallet.id, pin)
          : await WalletsHelper.decryptKey(wallet.id, pin);
        setLoadError(secret == null || secret.trim().length === 0);
        setKey(secret || '');
      }
    } catch (e) {
      console.error('WalletBackup: failed to decrypt wallet secret after PIN entry', e);
      setLoadError(true);
      setKey('');
    }
  };

  const goBackSettings = async () => {
    // Having seen the recovery phrase and pressed 完了 counts as backed up (the reminder stops).
    if (mode === 'mnemonic' && key) {
      try { markBackupDone((await getWallet())?.profileKey ?? ''); } catch { /* the reminder just stays */ }
    }
    if (Environment.isIos() && Environment.isInStandaloneMode()) {
      navigate(back || `/wallet/settings?id=${id}`);
    } else {
      navigate(-2 as any);
    }
  };

  const backParam = back ? `&back=${encodeURIComponent(back)}` : '';
  const modeParam = mode === 'mnemonic' ? '&mode=mnemonic' : '';

  const words = mode === 'mnemonic' && key.length > 0 ? key.split(' ') : [];

  return (
    <KasaneStage
      back={`/wallet/backup_caution?id=${id}${backParam}${modeParam}`}
      title={mode === 'mnemonic' ? t('wallet.mnemonic_title') : t('wallet.private_key_backup_title')}
      maxWidth={560}
    >
      <Box sx={{ mb: 5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', mt: 2, gap: 1 }}>
          <Box component="img" src={cautionIcon} sx={{ width: 16, height: 16 }} />
          <span>{t('wallet.key_backup_title')}</span>
        </Box>

        <Typography align="center" sx={{ mt: 2, mx: 2 }}>{t('wallet.key_backup_message')}</Typography>

        {walletNotFound ? (
          <Typography align="center" sx={{ mt: 2, mx: 2, color: 'error.main' }}>{t('wallet.backup_wallet_not_found')}</Typography>
        ) : loadError ? (
          <Typography align="center" sx={{ mt: 2, mx: 2, color: 'error.main' }}>{t('wallet.backup_decrypt_failed')}</Typography>
        ) : mode === 'mnemonic' && !hasMnemonic ? (
          <>
            <Typography align="center" sx={{ mt: 2, mx: 2 }}>{t('wallet.mnemonic_unavailable')}</Typography>
            <OfficialProfileExportButton walletId={profileWalletId} />
          </>
        ) : mode === 'mnemonic' ? (
          <>
            <Typography align="center" sx={{ mt: 2, color: 'error.main' }}>{t('wallet.mnemonic_title')}</Typography>
            <Typography align="center" sx={{ mt: 1, mx: 2, color: 'text.secondary', fontSize: 13 }}>
              {(t(getChain() === 'nem' ? 'wallet.mnemonic_interop_notice_nem' : 'wallet.mnemonic_interop_notice', { returnObjects: true }) as string[]).map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </Typography>
            <Grid container spacing={0.5} sx={{ justifyContent: 'center', mt: 1, px: 2 }}>
              {words.map((word, index) => (
                <Grid key={index} size={4} sx={{ p: 0.5 }}>
                  <Card variant="outlined" sx={{ bgcolor: 'grey.100', borderColor: 'divider', borderRadius: '12px', p: 1, position: 'relative' }}>
                    <Typography component="span" sx={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'text.secondary', fontSize: 12 }}>{index + 1}</Typography>
                    <Typography align="center" sx={{ fontSize: 'inherit' }}>{word}</Typography>
                  </Card>
                </Grid>
              ))}
            </Grid>
            <MnemonicQrExport mnemonic={key} />
            <PaperWalletButton source={key.length > 0 ? { kind: 'mnemonic', mnemonic: key, symbolCoinType } : null} />
            {key.length > 0 && <OfficialProfileExportButton walletId={profileWalletId} />}
          </>
        ) : (
          <>
            <Typography align="center" sx={{ mt: 2, color: 'error.main' }}>{t('wallet.private_key_title')}</Typography>
            <Typography align="center" sx={{ mt: 2, mx: 2, wordBreak: 'break-all' }}>{key}</Typography>
            <PaperWalletButton
              source={key.length > 0 && keyWallet ? { kind: 'key', chain: keyWallet.chain, privateKey: key, publicKey: keyWallet.publicKey } : null}
            />
            <KeystoreButton
              source={key.length > 0 && keyWallet ? { chain: keyWallet.chain, privateKey: key, publicKey: keyWallet.publicKey } : null}
            />
          </>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pb: 4 }}>
        <Button
          variant="contained" color="primary" size="large" sx={{ minWidth: 200 }}
          onClick={goBackSettings}
        >
          {t('common.done')}
        </Button>
      </Box>

      <PasswordDialog open={showPinDialog} mode="check" popup profileKey={profileKey} onClose={() => setShowPinDialog(false)} onPass={onPassed} />
    </KasaneStage>
  );
}
