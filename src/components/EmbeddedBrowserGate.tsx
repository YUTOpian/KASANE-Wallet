import { useMemo, useState, type FocusEvent, type ReactNode } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, FormControlLabel, TextField, Typography } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTranslation } from 'react-i18next';
import { addressForOtherBrowser, detectEmbeddedBrowser, readEmbeddedSignals } from '../lib/embeddedBrowser';

// 警告の本文（起動時の画面と、あとから開き直すダイアログで共通）。
function GateBody({ fileProtocol }: { fileProtocol: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const address = addressForOtherBrowser(window.location.href);
  const reasons = t('embedded.reasons', { returnObjects: true }) as string[];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // コピーできない環境（内蔵ブラウザなど）では、下の欄から手で選んでコピーしてもらう。
      setCopied(false);
    }
  };

  return (
    <Box>
      <Typography sx={{ lineHeight: 1.8 }}>{t('embedded.lead')}</Typography>
      <Box component="ul" sx={{ m: 0, mt: 1.5, pl: 3, lineHeight: 1.8 }}>
        {reasons.map((line, i) => (
          <Typography key={i} component="li" sx={{ mb: 1 }}>{line}</Typography>
        ))}
      </Box>
      {fileProtocol ? <Alert severity="warning" sx={{ mt: 1.5 }}>{t('embedded.file_note')}</Alert> : null}
      <Typography sx={{ mt: 2.5, fontWeight: 700 }}>{t('embedded.address_title')}</Typography>
      <Typography sx={{ mt: 0.5, lineHeight: 1.8 }}>{t('embedded.address_body')}</Typography>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center' }}>
        <TextField
          value={address}
          size="small"
          fullWidth
          slotProps={{ htmlInput: { readOnly: true, onFocus: (e: FocusEvent<HTMLInputElement>) => e.currentTarget.select(), 'aria-label': t('embedded.address_title') } }}
        />
        <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={copy} sx={{ flexShrink: 0 }}>
          {copied ? t('embedded.copied') : t('embedded.copy')}
        </Button>
      </Box>
    </Box>
  );
}

/**
 * AIコーディングツールの内蔵ブラウザ（Codex・Claude Desktop・VS Code・Cursor・GitHub Copilot など）や、
 * AIが操作しているブラウザの中で開かれたとき、アプリ本体を出す前に警告を出す。
 *
 * - 見つけたら、本体（children）を描画しない。ストレージの読み取りもルーターの画面も、同意するまで動かない。
 * - 「このまま続ける」を選んだ場合も、その起動の間だけ（記憶しない。次に開いたらまた聞く）。続けたあとは、
 *   画面の左下に小さな「内蔵ブラウザ」の印を出し続け、押すと同じ警告を開き直せる。
 * - 見つけられるのはユーザーエージェントなどから分かるものだけ（lib/embeddedBrowser.ts）。見つけられない場合もある。
 */
export default function EmbeddedBrowserGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const result = useMemo(() => detectEmbeddedBrowser(readEmbeddedSignals()), []);
  const fileProtocol = window.location.protocol === 'file:';
  const [agreed, setAgreed] = useState(false);
  const [proceeded, setProceeded] = useState(false);
  const [reopened, setReopened] = useState(false);

  if (!result.embedded) return <>{children}</>;

  if (!proceeded) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2, bgcolor: 'background.default' }}>
        <Box sx={{ width: '100%', maxWidth: 640, p: { xs: 2, sm: 4 }, borderRadius: 2, bgcolor: 'background.paper', border: 1, borderColor: 'warning.main' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <WarningAmberIcon color="warning" />
            <Typography variant="h6" component="h1" sx={{ fontWeight: 700 }}>{t('embedded.title')}</Typography>
          </Box>
          <GateBody fileProtocol={fileProtocol} />
          <FormControlLabel
            sx={{ mt: 2.5, alignItems: 'flex-start' }}
            control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />}
            label={<Typography component="span">{t('embedded.ack')}</Typography>}
          />
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
            <Button variant="contained" size="large" disabled={!agreed} onClick={() => setProceeded(true)} sx={{ minWidth: 120 }}>
              {t('embedded.continue')}
            </Button>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <>
      {children}
      <Chip
        size="small"
        color="warning"
        icon={<WarningAmberIcon />}
        label={t('embedded.chip')}
        onClick={() => setReopened(true)}
        sx={{ position: 'fixed', left: 8, bottom: 8, zIndex: (theme) => theme.zIndex.modal - 1 }}
      />
      <Dialog open={reopened} onClose={() => setReopened(false)} maxWidth="sm" fullWidth>
        <DialogContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <WarningAmberIcon color="warning" />
            <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>{t('embedded.title')}</Typography>
          </Box>
          <GateBody fileProtocol={fileProtocol} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReopened(false)}>{t('embedded.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
