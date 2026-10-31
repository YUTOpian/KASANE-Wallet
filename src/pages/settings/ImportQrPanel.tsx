import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SignQrReader } from '../signqr/SignQrPage';
import { applyScannedText, scanFailureMessage } from '../../lib/applyScanned';
import { useAppStore } from '../../store/appStore';

// 「QRコードのインポート」 (設定 > QRコードのインポート): the reader of signing QR codes (signed transaction / cosign request / cosignature /
// template; also pasted payloads, JSON files and QR images). A code that is not one of those is tried as an address /
// payment-request code; when that works the recipient, amount, mosaic and message are in the send form's store and Home
// opens with the 送る section and them.
export default function ImportQrPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setHomePanel = useAppStore((s) => s.setHomePanel);

  const onOther = async (raw: string): Promise<string | null> => {
    const result = await applyScannedText(raw);
    if (result.ok) {
      setHomePanel('send');
      navigate('/top');
      return null;
    }
    // 'signing_qr' only comes back for a signing QR that could not be read above, so it is just an unreadable code here.
    if (result.reason === 'invalid' || result.reason === 'signing_qr') return t('home.import_qr_invalid');
    return scanFailureMessage(result.reason, t);
  };

  return <SignQrReader onOther={onOther} compact={compact} />;
}
