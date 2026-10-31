import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Collapse, MenuItem, Tab, Tabs, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import QrTextPanel from '../../components/QrTextPanel';
import { WalletsHelper } from '../../lib/storage';
import { addressFromPublicKey, bytesToHex, hexToBytes, isValidAddress, normalizeAddress, prettyAddress, signData, verifySignature } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  SYMBOL_SIGNED_MESSAGE_MAX_BYTES, buildSymbolSignedMessage, detectOtherChainSignedMessage, isSymbolPublicKeyHex, isSymbolSignatureHex, parseSymbolSignedMessage, symbolMessageBytes,
} from '../../lib/symbol/signedMessage';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';
import { accountLabel, useSigningAccounts } from '../offline/signingAccounts';

// 「署名付きメッセージ」(Symbol): a text is signed with an account's key, and anyone with the text, the public key and the
// signature can check it. Nothing is sent to the network: it is not a transaction. The text is signed as typed, byte for
// byte (UTF-8), so a different space or line break gives a different result. Same screens and same shared format as the NEM
// one (pages/nem/NemSignedMessage.tsx); the signature scheme is Symbol's (Ed25519 / SHA-512), so a NEM signature never
// verifies here and vice versa. There is no NanoWallet format on this side.
//
// Laid out like the NEM screens: the inputs on the left, the outcome on the right.

type TabKey = 'sign' | 'verify';

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
  // The Symbol Ledger app signs transactions, not arbitrary bytes, so Ledger accounts are not offered.
  const { accounts, setSignerId, signer } = useSigningAccounts('symbol', { noLedger: true });
  const [message, setMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<{ message: string; signature: string; publicKey: string; address: string; share: string } | null>(null);

  const bytes = symbolMessageBytes(message).length;
  const tooLong = bytes > SYMBOL_SIGNED_MESSAGE_MAX_BYTES;
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
      const data = symbolMessageBytes(message);
      const signatureBytes = signData(privateKey, data);
      const signature = bytesToHex(signatureBytes);
      const publicKey = signer.publicKey.toUpperCase();
      // Checked before it is shown: a signature that does not verify is never handed out.
      if (!verifySignature(publicKey, data, signatureBytes)) throw new Error('the signature did not verify');
      setResult({ message, signature, publicKey, address: signer.address, share: buildSymbolSignedMessage({ message, publicKey, signature }) });
    } catch (e) {
      console.error('Failed to sign the message', e);
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
              helperText={accounts.length === 0 ? t('signmsg.symbol_signer_none') : ''}
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
              helperText={tooLong ? t('signmsg.message_too_long', { max: SYMBOL_SIGNED_MESSAGE_MAX_BYTES }) : ''}
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
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('signmsg.share_hint')}</Typography>
              <QrTextPanel text={result.share} file={{ text: result.share, name: `kasane-symbol-signed-message-${result.signature.slice(0, 8).toLowerCase()}.json` }} />
            </>
          )}
        </SectionCard>
        {result !== null && (
          <SectionCard title={t('signmsg.result_title')}>
            <Result label={t('signmsg.signer_address')}>{prettyAddress(result.address)}</Result>
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
type Verdict = { kind: 'valid' } | { kind: 'invalid' } | { kind: 'address_mismatch'; address: string };
interface Checked { address: string; publicKey: string; message: string; signature: string }

/** The signature check itself. A malformed key or signature makes the SDK throw: that is "not valid", not a crash. */
function signatureHolds(publicKey: string, message: string, signature: string): boolean {
  try {
    return verifySignature(publicKey, symbolMessageBytes(message), hexToBytes(signature));
  } catch {
    return false;
  }
}

function VerifyPanel() {
  const { t } = useTranslation();
  const cfg = getNetworkConfig();
  const [pasted, setPasted] = useState('');
  // 'unreadable': not a signed message at all. 'nem': a NEM signed message, which cannot be checked on this chain.
  const [pasteError, setPasteError] = useState<'unreadable' | 'nem' | null>(null);
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [signature, setSignature] = useState('');
  const [address, setAddress] = useState('');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);

  const pkOk = isSymbolPublicKeyHex(publicKey);
  const sigOk = isSymbolSignatureHex(signature);
  const addressGiven = address.trim() !== '';
  const addressOk = !addressGiven || isValidAddress(normalizeAddress(address));
  const manualReady = message !== '' && pkOk && sigOk && addressOk;
  // The pasted text wins when there is one; otherwise the three fields below.
  const canVerify = pasted.trim() !== '' ? addressOk : manualReady;

  // Any change of the inputs withdraws an earlier answer.
  const edit = (apply: () => void) => { apply(); setVerdict(null); setChecked(null); };

  const check = (msg: string, pk: string, sig: string) => {
    let derived = '';
    try { derived = addressFromPublicKey(pk, cfg.networkByte); } catch { derived = ''; }
    setChecked({ address: derived, publicKey: pk.toUpperCase(), message: msg, signature: sig.toUpperCase() });
    if (derived === '' || !signatureHolds(pk, msg, sig)) { setVerdict({ kind: 'invalid' }); return; }
    // An address that was typed in must be this key's address on the network in use (N… on mainnet, T… on testnet).
    if (addressGiven && normalizeAddress(address) !== derived) { setVerdict({ kind: 'address_mismatch', address: derived }); return; }
    setVerdict({ kind: 'valid' });
  };

  const onVerify = () => {
    if (pasted.trim() !== '') {
      const parsed = parseSymbolSignedMessage(pasted);
      if (parsed === null) {
        setPasteError(detectOtherChainSignedMessage(pasted) === 'nem' ? 'nem' : 'unreadable');
        setVerdict(null);
        setChecked(null);
        return;
      }
      setPasteError(null);
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
            onChange={(e) => { setPasted(e.target.value); setPasteError(null); setVerdict(null); setChecked(null); }}
            error={pasteError !== null}
            helperText={pasteError === 'nem' ? t('signmsg.paste_is_nem') : pasteError === 'unreadable' ? t('signmsg.paste_invalid') : t('signmsg.paste_hint_symbol')}
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
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>{t('signmsg.valid_note', { address: prettyAddress(checked?.address ?? '') })}</Typography>
            </Alert>
          )}
          {verdict?.kind === 'address_mismatch' && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('signmsg.mismatch_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>{t('signmsg.mismatch_note', { address: prettyAddress(verdict.address) })}</Typography>
            </Alert>
          )}
          {verdict?.kind === 'invalid' && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('signmsg.invalid_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>{t('signmsg.invalid_note')}</Typography>
            </Alert>
          )}
          <Result label={t('signmsg.signer_address')}>{checked ? prettyAddress(checked.address) : ''}</Result>
          <Result label={t('signmsg.public_key')}>{checked?.publicKey ?? ''}</Result>
          <Result label={t('signmsg.message')} pre>{checked?.message ?? ''}</Result>
          <Result label={t('signmsg.signature')}>{checked?.signature ?? ''}</Result>
        </SectionCard>
      </Box>
    </Box>
  );
}

export default function SymbolSignedMessage() {
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
