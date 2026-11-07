import { useRef, useState } from 'react';
import NetworkMismatchDialog from '../../components/NetworkMismatchDialog';
import type { SymbolNetwork } from '../../lib/symbol/constants';
import { Scanner } from '@yudiel/react-qr-scanner';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { applyScannedText, scanFailureMessage } from '../../lib/applyScanned';
import { Box } from '@mui/material';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import QrImageButton from '../../components/QrImageButton';

interface ScanProps {
  isActive: boolean;
  // Called after a successful scan has filled in the recipient / amount / mosaic in the store.
  // The send screen passes this to close its scanner dialog; when omitted the scan navigates to
  // the recipient / amount screen itself.
  onScanned?: () => void;
}

// Reads Symbol address QR codes, transaction-request QR codes and web+symbol:// payment / transaction URIs
// (see lib/symbol/qr.ts) as well as plain addresses.
export default function Scan({ isActive, onScanned }: ScanProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState('');
  // 警告モーダル: the code is for the other network.
  const [mismatch, setMismatch] = useState<{ other: SymbolNetwork | null } | null>(null);
  // Guards against the scanner firing onDecode again for the same code while an earlier decode
  // is still awaiting a node call below.
  const processingRef = useRef(false);

  const goNext = () => {
    if (onScanned) onScanned();
    else navigate('/top');
  };

  const onDecode = async (decoded: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      const result = await applyScannedText(decoded);
      if (!result.ok) {
        if (result.reason === 'wrong_network') setMismatch({ other: result.scannedNetwork ?? null });
        else setErrorMessage(scanFailureMessage(result.reason, t));
        return;
      }
      goNext();
    } finally {
      processingRef.current = false;
    }
  };

  const onError = (error: unknown) => {
    setErrorMessage('Camera is not available: ' + (error instanceof Error ? error.message : 'Unknown'));
  };

  if (!isActive) {
    return null;
  }

  return (
    <>
      <Scanner
        onScan={(results) => { if (results[0]) void onDecode(results[0].rawValue); }}
        onError={onError}
      />
      <Box sx={{ px: 3, py: 2 }}>
        <QrImageButton onDecoded={(text) => { void onDecode(text); }} onNotFound={() => setErrorMessage(t('signqr.image_not_found'))} />
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <NetworkMismatchDialog open={mismatch !== null} otherNetwork={mismatch?.other ?? null} onClose={() => setMismatch(null)} />
    </>
  );
}
