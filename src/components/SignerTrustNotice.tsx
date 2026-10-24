import { useState } from 'react';
import { Alert, Box, Button } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { useTrust } from '../hooks/useAddressBook';
import { displayName } from '../lib/addressBook';
import ContactDialog from './ContactDialog';

interface SignerTrustNoticeProps {
  /** 署名依頼を送ってきた（アグリゲートに署名した）アドレス。 */
  address: string;
  sx?: object;
}

/**
 * 署名依頼の送信者がアドレス帳でどう扱われているかを知らせる。
 * 未登録 → 警告（アドレス帳に追加するボタン付き）。ブラックリスト → 強い警告。ホワイトリスト → 名前を表示。
 * 自分のアカウントからのものは何も出さない。
 */
export default function SignerTrustNotice({ address, sx }: SignerTrustNoticeProps) {
  const { t } = useTranslation();
  const { trust, entry, loaded } = useTrust(address);
  const [adding, setAdding] = useState(false);
  const allowUnknown = useAppStore((s) => s.allowUnknownSigners);
  if (!loaded || trust === 'self' || !address || address.startsWith('@')) return null;

  const who = entry ? displayName(entry) : '';
  return (
    <Box sx={sx}>
      {trust === 'unknown' && (
        <Alert severity={allowUnknown ? 'warning' : 'error'} action={<Button color="inherit" size="small" onClick={() => setAdding(true)}>{t('addressbook.add_short')}</Button>}>
          {t(allowUnknown ? 'addressbook.signer_unknown' : 'addressbook.signer_unknown_denied')}
        </Alert>
      )}
      {trust === 'black' && <Alert severity="error">{t('addressbook.signer_blacklisted', { name: who })}</Alert>}
      {trust === 'white' && <Alert severity="success">{t('addressbook.signer_whitelisted', { name: who })}</Alert>}
      <ContactDialog open={adding} onClose={() => setAdding(false)} initial={{ address }} />
    </Box>
  );
}
