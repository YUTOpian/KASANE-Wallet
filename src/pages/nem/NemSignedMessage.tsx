import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Collapse, MenuItem, Tab, Tabs, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { WalletsHelper } from '../../lib/storage';
import { isValidNemAddress, nemAddressFromPublicKey, normalizeNemAddress, prettyNemAddress, signNemData, verifyNemSignature, verifyNemText } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  NEM_SIGNED_MESSAGE_MAX_BYTES, buildNanoWalletSignedMessage, buildNemSignedMessage, isNemPublicKeyHex, isNemSignatureHex, nemMessageBytes, parseNemSignedMessage,
} from '../../lib/nem/signedMessage';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import { accountLabel, useSigningAccounts } from '../offline/signingAccounts';

// 「署名付きメッセージ」(NEM): a text is signed with an account's key, and anyone with the text, the public key and the
// signature can check it. Nothing is sent to the network: it is not a transaction. The text is signed as typed, byte for
// byte (UTF-8), so a different space or line break gives a different result. NanoWallet's signed messages are read and
// written too (see lib/nem/signedMessage.ts).
//
// Laid out like NanoWallet's two screens: the inputs on the left, the outcome on the right (a signed message to copy /
// the account, public key, message and signature that were checked).

type TabKey = 'sign' | 'verify';
type ShareFormat = 'kasane' | 'nanowallet';

const hexToBytes = (hex: string) => Uint8Array.from((hex.trim().match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));

// Two columns on a wide screen (inputs | outcome), one column on a phone.
const columnsSx = { display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, columnGap: 3, alignItems: 'start' } as const;

/** A small note under a field. (FormRow's own hint column needs the full page width; these cards are half of it.) */
function Hint({ children }: { children: ReactNode }) {
  return <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontStyle: 'italic', lineHeight: 1.6, mt: 0.75 }}>{children}</Typography>;
}

/** A labelled, grey, read-only value (empty until there is something to show). */
function Result({ label, children, pre = false }: { label: string; children?: ReactNode; pre?: boolean }) {
  return (
    <Box sx={{ py: 0.75 }}>
      <Typography sx={{ color: 'primary.main', fontSize: '0.8rem', mb: 0.25 }}>{label}</Typography>
      <ValueBox>
        <Box component="span" sx={{ display: 'block', minHeight: '1.4em', whiteSpace: pre ? 'pre-wrap' : 'normal', wordBreak: 'break-all' }}>{children}</Box>
      </ValueBox>
    </Box>
  );
}

// --- 作成 ----------------------------------------------------------------------------------------------
function SignPanel() {
  const { t } = useTranslation();
  const { accounts, setSignerId, signer } = useSigningAccounts('nem');
  const [message, setMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [format, setFormat] = useState<ShareFormat>('kasane');
  const [result, setResult] = useState<{ message: string; signature: string; publicKey: string; address: string; share: string; nanoShare: string } | null>(null);

  const bytes = nemMessageBytes(message).length;
  const tooLong = bytes > NEM_SIGNED_MESSAGE_MAX_BYTES;
  const canSign = signer !== null && message !== '' && !tooLong && !busy;

  const onPassed = async (password: string) => {
    if (signer === null) return;
    setBusy(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(signer.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const signature = signNemData(privateKey, nemMessageBytes(message));
      const publicKey = signer.publicKey.toUpperCase();
      // Checked before it is shown: a signature that does not verify is never handed out.
      if (!verifyNemSignature(publicKey, nemMessageBytes(message), hexToBytes(signature))) throw new Error('the signature did not verify');
      setResult({
        message, signature, publicKey, address: signer.address,
        share: buildNemSignedMessage({ message, publicKey, signature }),
        nanoShare: buildNanoWalletSignedMessage({ publicKey, signature }, nemMessageBytes(message)),
      });
    } catch (e) {
      console.error('Failed to sign the message', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shared = result === null ? '' : format === 'kasane' ? result.share : result.nanoShare;
  const fileName = result === null ? '' : format === 'kasane'
    ? `kasane-nem-signed-message-${result.signature.slice(0, 8).toLowerCase()}.json`
    : `nanowallet-signed-message-${result.signature.slice(0, 8).toLowerCase()}.json`;

  return (
    <Box sx={columnsSx}>
      {/* 左: 入力 */}
      <Box>
        <SectionCard title={t('signmsg.tab_sign')}>
          <Alert severity="warning" sx={{ mb: 2 }}>{t('signmsg.warning')}</Alert>
          <FormRow label={t('signmsg.signer')} top>
            <Field
              select
              ariaLabel={t('signmsg.signer')}
              value={signer ? signer.id : ''}
              onChange={(e) => { setSignerId(e.target.value); setResult(null); }}
              error={accounts.length === 0}
              helperText={accounts.length === 0 ? t('offline.nem_sender_none') : ''}
            >
              {accounts.map((w) => <MenuItem key={w.id} value={w.id}>{accountLabel(w, t('wallet.account_imported'))}</MenuItem>)}
            </Field>
            {signer && <Box sx={{ mt: 0.75 }}><ValueBox>{signer.address}</ValueBox></Box>}
          </FormRow>
          <FormRow label={t('signmsg.message')} top>
            <Field
              ariaLabel={t('signmsg.message')}
              multiline
              minRows={4}
              value={message}
              onChange={(e) => { setMessage(e.target.value); setResult(null); }}
              error={tooLong}
              helperText={tooLong ? t('signmsg.message_too_long', { max: NEM_SIGNED_MESSAGE_MAX_BYTES }) : ''}
            />
            <Hint>{t('signmsg.message_hint')}</Hint>
          </FormRow>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canSign} onClick={() => setShowPassword(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.25, mt: 1 }}>
            {busy ? t('signmsg.signing') : t('signmsg.sign_button')}
          </Button>
        </SectionCard>
      </Box>

      {/* 右: 署名付きメッセージ */}
      <Box>
        <SectionCard title={t('signmsg.signed_title')}>
          {result === null ? (
            <Box sx={{ bgcolor: 'action.hover', borderRadius: 1.5, px: 2, py: 3, minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8 }}>{t('signmsg.signed_empty')}</Typography>
            </Box>
          ) : (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('signmsg.signed_note')}</Alert>
              <ToggleButtonGroup
                exclusive
                size="small"
                color="primary"
                value={format}
                onChange={(_, v: ShareFormat | null) => { if (v !== null) setFormat(v); }}
                aria-label={t('signmsg.signed_title')}
                sx={{ mb: 1 }}
              >
                <ToggleButton value="kasane" sx={{ textTransform: 'none', px: 2 }}>KASANE</ToggleButton>
                <ToggleButton value="nanowallet" sx={{ textTransform: 'none', px: 2 }}>NanoWallet</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{format === 'kasane' ? t('signmsg.share_hint') : t('signmsg.share_nano_hint')}</Typography>
              <QrTextPanel text={shared} file={{ text: shared, name: fileName }} />
            </>
          )}
        </SectionCard>
        {result !== null && (
          <SectionCard title={t('signmsg.result_title')}>
            <Result label={t('signmsg.signer_address')}>{prettyNemAddress(result.address)}</Result>
            <Result label={t('signmsg.public_key')}>{result.publicKey}</Result>
            <Result label={t('signmsg.message')} pre>{result.message}</Result>
            <Result label={t('signmsg.signature')}>{result.signature}</Result>
            <Button onClick={() => { setResult(null); setMessage(''); }} sx={{ mt: 1 }}>{t('signmsg.another')}</Button>
          </SectionCard>
        )}
      </Box>
      <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={(password) => { setShowPassword(false); void onPassed(password); }} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}

// --- 検証 ----------------------------------------------------------------------------------------------
type Verdict = { kind: 'valid'; nanoEncoding: boolean } | { kind: 'invalid' } | { kind: 'address_mismatch'; address: string };
interface Checked { address: string; publicKey: string; message: string; signature: string }

function VerifyPanel() {
  const { t } = useTranslation();
  const cfg = getNemNetworkConfig();
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState(false);
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [signature, setSignature] = useState('');
  const [address, setAddress] = useState('');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);

  const pkOk = isNemPublicKeyHex(publicKey);
  const sigOk = isNemSignatureHex(signature);
  const addressGiven = address.trim() !== '';
  const addressOk = !addressGiven || isValidNemAddress(normalizeNemAddress(address));
  const manualReady = message !== '' && pkOk && sigOk && addressOk;
  // The pasted text wins when there is one; otherwise the three fields below.
  const canVerify = pasted.trim() !== '' ? addressOk : manualReady;

  // Any change of the inputs withdraws an earlier answer.
  const edit = (apply: () => void) => { apply(); setVerdict(null); setChecked(null); };

  const check = (msg: string, pk: string, sig: string) => {
    // Text as KASANE signs it (UTF-8), or as NanoWallet encodes it (emoji and other characters outside the BMP differ).
    let matched: 'utf8' | 'nanowallet' | null = null;
    try { matched = verifyNemText(pk, msg, sig); } catch { matched = null; }
    const derived = nemAddressFromPublicKey(pk, cfg.networkByte);
    setChecked({ address: derived, publicKey: pk.toUpperCase(), message: msg, signature: sig.toUpperCase() });
    if (matched === null) { setVerdict({ kind: 'invalid' }); return; }
    // An address that was typed in must be this key's address on the network in use (N… on mainnet, T… on testnet).
    if (addressGiven && normalizeNemAddress(address) !== derived) { setVerdict({ kind: 'address_mismatch', address: derived }); return; }
    setVerdict({ kind: 'valid', nanoEncoding: matched === 'nanowallet' });
  };

  const onVerify = () => {
    if (pasted.trim() !== '') {
      const parsed = parseNemSignedMessage(pasted);
      if (parsed === null) { setPasteError(true); setVerdict(null); setChecked(null); return; }
      setPasteError(false);
      // Shown in the three fields too, so they can be looked at or corrected.
      setMessage(parsed.message);
      setPublicKey(parsed.publicKey);
      setSignature(parsed.signature);
      check(parsed.message, parsed.publicKey, parsed.signature);
      return;
    }
    check(message, publicKey.trim(), signature.trim());
  };

  return (
    <Box sx={columnsSx}>
      {/* 左: 入力 */}
      <Box>
        <SectionCard title={t('signmsg.signed_title')}>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5, lineHeight: 1.8 }}>{t('signmsg.verify_intro')}</Typography>
          <Field
            ariaLabel={t('signmsg.paste_label')}
            multiline
            minRows={6}
            placeholder={t('signmsg.paste_label')}
            value={pasted}
            onChange={(e) => { setPasted(e.target.value); setPasteError(false); setVerdict(null); setChecked(null); }}
            error={pasteError}
            helperText={pasteError ? t('signmsg.paste_invalid') : t('signmsg.paste_hint')}
          />
          <Button size="small" onClick={() => setManual((v) => !v)} sx={{ mt: 1 }}>{t('signmsg.manual_toggle')}</Button>
          <Collapse in={manual} unmountOnExit>
            <Box sx={{ pt: 1 }}>
              <FormRow label={t('signmsg.message')} top>
                <Field ariaLabel={t('signmsg.message')} multiline minRows={3} value={message} onChange={(e) => edit(() => { setMessage(e.target.value); setPasted(''); })} />
              </FormRow>
              <FormRow label={t('signmsg.public_key')} top>
                <Field
                  ariaLabel={t('signmsg.public_key')}
                  value={publicKey}
                  onChange={(e) => edit(() => { setPublicKey(e.target.value.trim()); setPasted(''); })}
                  error={publicKey !== '' && !pkOk}
                  helperText={publicKey !== '' && !pkOk ? t('signmsg.public_key_invalid') : ''}
                  htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                />
              </FormRow>
              <FormRow label={t('signmsg.signature')} top>
                <Field
                  ariaLabel={t('signmsg.signature')}
                  value={signature}
                  onChange={(e) => edit(() => { setSignature(e.target.value.trim()); setPasted(''); })}
                  error={signature !== '' && !sigOk}
                  helperText={signature !== '' && !sigOk ? t('signmsg.signature_invalid') : ''}
                  htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                />
              </FormRow>
              <FormRow label={t('signmsg.address_optional')} top>
                <Field
                  ariaLabel={t('signmsg.address_optional')}
                  value={address}
                  onChange={(e) => edit(() => setAddress(e.target.value))}
                  error={addressGiven && !addressOk}
                  helperText={addressGiven && !addressOk ? t('offline.recipient_invalid') : ''}
                  htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                />
                <Hint>{t('signmsg.address_hint')}</Hint>
              </FormRow>
            </Box>
          </Collapse>
          <Button variant="contained" color="primary" size="large" fullWidth disabled={!canVerify} onClick={onVerify} sx={{ py: 1.25, mt: 1.5 }}>{t('signmsg.verify_button')}</Button>
        </SectionCard>
      </Box>

      {/* 右: 結果 */}
      <Box>
        <SectionCard title={t('signmsg.result_title')}>
          {verdict === null && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1, lineHeight: 1.8 }}>{t('signmsg.result_empty')}</Typography>}
          {verdict?.kind === 'valid' && (
            <Alert severity="success" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('signmsg.valid_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>{t('signmsg.valid_note', { address: prettyNemAddress(checked?.address ?? '') })}</Typography>
              {verdict.nanoEncoding && <Typography variant="body2" sx={{ mt: 0.5 }}>{t('signmsg.valid_nano_encoding')}</Typography>}
            </Alert>
          )}
          {verdict?.kind === 'address_mismatch' && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('signmsg.mismatch_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>{t('signmsg.mismatch_note', { address: prettyNemAddress(verdict.address) })}</Typography>
            </Alert>
          )}
          {verdict?.kind === 'invalid' && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('signmsg.invalid_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>{t('signmsg.invalid_note')}</Typography>
            </Alert>
          )}
          <Result label={t('signmsg.signer_address')}>{checked ? prettyNemAddress(checked.address) : ''}</Result>
          <Result label={t('signmsg.public_key')}>{checked?.publicKey ?? ''}</Result>
          <Result label={t('signmsg.message')} pre>{checked?.message ?? ''}</Result>
          <Result label={t('signmsg.signature')}>{checked?.signature ?? ''}</Result>
        </SectionCard>
      </Box>
    </Box>
  );
}

export default function NemSignedMessage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('sign');
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.6rem', fontWeight: 300, mb: 0.5 }}>{tab === 'sign' ? t('signmsg.create_title') : t('signmsg.verify_title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('signmsg.about')}</Typography>
        <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="sign" label={t('signmsg.tab_sign')} />
          <Tab value="verify" label={t('signmsg.tab_verify')} />
        </Tabs>
        {tab === 'sign' ? <SignPanel /> : <VerifyPanel />}
      </Box>
    </Box>
  );
}
