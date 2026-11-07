import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { models as nemModels } from 'symbol-sdk/nem';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import SignRiskNotice from '../../components/SignRiskNotice';
import { WalletsHelper } from '../../lib/storage';
import { SssError, signWithSss, sssErrorKey } from '../../lib/sss';
import type { ChainKey } from '../../lib/chain';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_NATIVE_ID } from '../../lib/nem/constants';
import { nemAddressFromPublicKey, signNemData, verifyNemSignature } from '../../lib/nem/crypto';
import { decryptNemBytes, encryptNemBytes } from '../../lib/nem/message';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { nemHexToBytes, readNemTransfer } from '../../lib/nem/offline';
import type { NemTransferSummary } from '../../lib/nem/offline';
import { addressFromPublicKey, bytesToHex, decryptBytes, encryptBytes, signData, verifySignature } from '../../lib/symbol/crypto';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { getNetworkConfig } from '../../lib/symbol/network';
import { summarizePayload } from '../../lib/symbol/payloadSummary';
import type { PayloadSummary } from '../../lib/symbol/payloadSummary';
import type { SignRequest } from '../../lib/console/env';
import { ItemView } from '../multisig/parts';

// コンソールのコードが、ウォレットの鍵を使う処理（署名・メッセージの暗号化・復号）を求めたときの確認。
// 何に署名するか / 何を暗号化・復号するかを（バイト列から読み直して）見せ、「署名する」などを押したあとにパスワードを聞く。
// 秘密鍵が開かれるのは、ここでパスワードが通った一瞬だけ。コードの側には、結果（署名の64バイト・暗号文・復号した中身）しか返らない。
interface Props {
  /** どちらのチェーンのアカウントか。省略は Symbol。NEM は、署名・暗号化に NEM の方式（Keccak-512 の Ed25519 / NEM ウォレットが読める暗号文）を使う。 */
  chain?: ChainKey;
  request: SignRequest | null;
  signerId: string;
  /** 署名するアカウントのプロファイル（Wallet.profileKey）。パスワードはプロファイルごとなので、確認はこのプロファイルのパスワードで行う。 */
  signerProfileKey: string;
  signerPublicKey: string;
  signerAddress: string;
  /** SSS Extension / Ledger のアカウント（秘密鍵が端末に無い）。コンソールでは署名・暗号化・復号ができない。 */
  signerKeyless?: boolean;
  /** SSS Extension のアカウント（Symbol）。トランザクションへの署名だけ、拡張に頼める。 */
  signerSss?: boolean;
  onCancel: () => void;
  /** 署名 / 暗号文 / 復号した中身。復号できなかったときだけ null。 */
  onSigned: (result: Uint8Array | null) => void;
}

function previewText(data: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch { return null; }
}

/** NEM のトランザクションの種類（NIS1 の type 値）。分からないものは「種類 0x…」と出す。 */
const NEM_TYPE_KEYS: Record<number, string> = {
  0x101: 'console.nem_type_transfer', 0x801: 'console.nem_type_importance', 0x1001: 'console.nem_type_multisig_modification',
  0x1002: 'console.nem_type_multisig_signature', 0x1004: 'console.nem_type_multisig', 0x2001: 'console.nem_type_namespace',
  0x4001: 'console.nem_type_mosaic_definition', 0x4002: 'console.nem_type_mosaic_supply',
};

/** 署名するバイト列（NEM では、署名欄を含まないトランザクションそのもの）から読み取った、確認ダイアログに見せる内容。 */
interface NemView { summary: NemTransferSummary; hash: string; detail: string }

function readNemView(payloadHex: string): NemView {
  const summary = readNemTransfer(payloadHex);
  const bytes = nemHexToBytes(payloadHex);
  let detail = '';
  // 送金以外（ネームスペース・モザイクなど）は、SDK に読み直させた全項目をそのまま見せる。
  if (summary.transfer === null) {
    try { detail = nemModels.NonVerifiableTransactionFactory.deserialize(bytes).toString(); } catch { detail = ''; }
  }
  return { summary, hash: Array.from(keccak_256(bytes), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), detail };
}

const nemRow = (label: string, value: string) => (
  <Box sx={{ mb: 1 }}>
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{label}</Typography>
    <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>{value}</Typography>
  </Box>
);

export default function ConsoleSignDialog({ chain = 'symbol', request, signerId, signerProfileKey, signerPublicKey, signerAddress, signerKeyless = false, signerSss = false, onCancel, onSigned }: Props) {
  const { t } = useTranslation();
  const isNem = chain === 'nem';
  const networkByte = isNem ? getNemNetworkConfig().networkByte : getNetworkConfig().networkByte;
  const [summary, setSummary] = useState<PayloadSummary | null>(null);
  const [nemView, setNemView] = useState<NemView | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSummary(null);
    setNemView(null);
    setUnreadable(false);
    setAskPassword(false);
    if (request === null || request.payloadHex === undefined) return; // payloadHex が無い連署（ハッシュだけ）は、読み直せないので、下で警告を出して見せる
    if (isNem) {
      try { setNemView(readNemView(request.payloadHex)); } catch { setUnreadable(true); }
      return;
    }
    let cancelled = false;
    summarizePayload(request.payloadHex).then(
      (s) => { if (!cancelled) setSummary(s); },
      () => { if (!cancelled) setUnreadable(true); },
    );
    return () => { cancelled = true; };
  }, [request, isNem]);

  // SSS Extension: トランザクションへの署名だけは拡張に頼める（パスワードは聞かない）。署名は検算してから返す。
  const onSssSign = async () => {
    if (request === null || request.payloadHex === undefined) return;
    try {
      const hex = request.payloadHex;
      const signature = await signWithSss({
        expectedPublicKey: signerPublicKey,
        networkByte,
        serializedTx: Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)),
        signingPayload: request.data,
      });
      onSigned(signature);
    } catch (e) {
      console.error('Failed to sign with SSS for the console', e);
      setError(e instanceof SssError ? t(sssErrorKey(e)) : e instanceof Error ? e.message : String(e));
    }
  };

  const onPass = async (password: string) => {
    setAskPassword(false);
    if (request === null) return;
    try {
      const privateKey = await WalletsHelper.decryptKey(signerId, password);
      if (privateKey == null) { setError(t('wallet.invalid_key')); return; }
      if (request.kind === 'encrypt' || request.kind === 'decrypt') {
        if (request.otherPublicKey === undefined) throw new Error('the other side\'s public key is missing');
        if (isNem) {
          onSigned(request.kind === 'encrypt'
            ? encryptNemBytes(privateKey, request.otherPublicKey, request.data)
            : decryptNemBytes(privateKey, request.otherPublicKey, request.data));
          return;
        }
        onSigned(request.kind === 'encrypt'
          ? encryptBytes(privateKey, request.otherPublicKey, request.data)
          : decryptBytes(privateKey, request.otherPublicKey, request.data));
        return;
      }
      if (isNem) {
        const nemSignature = nemHexToBytes(signNemData(privateKey, request.data));
        if (!verifyNemSignature(signerPublicKey.toUpperCase(), request.data, nemSignature)) throw new Error('the signature did not verify');
        onSigned(nemSignature);
        return;
      }
      const signature = signData(privateKey, request.data);
      if (!verifySignature(signerPublicKey.toUpperCase(), request.data, signature)) throw new Error('the signature did not verify');
      onSigned(signature);
    } catch (e) {
      console.error('Failed to sign for the console', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const open = request !== null;
  const sssCanSign = signerSss && !isNem && request?.kind === 'transaction' && request.payloadHex !== undefined;
  const keylessBlocked = signerKeyless && !sssCanSign;
  const isCrypt = request?.kind === 'encrypt' || request?.kind === 'decrypt';
  const isTx = request?.kind === 'transaction' || request?.kind === 'cosignature';
  /** 連署（transaction hash だけ）。中身を読み直す材料が無いので、ハッシュと警告だけを見せる。 */
  const hashOnly = request?.kind === 'cosignature' && request.payloadHex === undefined;
  const text = request?.kind === 'data' || request?.kind === 'encrypt' ? previewText(request.data) : null;
  const otherAddress = (() => {
    if (request?.otherPublicKey === undefined) return '';
    try { return isNem ? nemAddressFromPublicKey(request.otherPublicKey, networkByte) : addressFromPublicKey(request.otherPublicKey, networkByte); } catch { return ''; }
  })();
  const wrongNetwork = (summary !== null && summary.networkByte !== networkByte) || (nemView !== null && nemView.summary.networkByte !== networkByte);
  return (
    <>
      <Dialog open={open && !askPassword} onClose={onCancel} fullWidth maxWidth="sm">
        <DialogTitle>{t(request?.kind === 'encrypt' ? 'console.crypt_title_encrypt' : request?.kind === 'decrypt' ? 'console.crypt_title_decrypt' : 'console.sign_title')}</DialogTitle>
        <DialogContent>
          {keylessBlocked && <Alert severity="error" sx={{ mb: 2 }}>{t(signerSss ? 'console.sss_tx_only' : 'console.keyless_unsupported')}</Alert>}
          {sssCanSign && <Alert severity="info" sx={{ mb: 2 }}>{t('console.sss_sign_note')}</Alert>}
          <Alert severity="warning" sx={{ mb: 2 }}>{t(request?.kind === 'encrypt' ? 'console.crypt_warning_encrypt' : request?.kind === 'decrypt' ? 'console.crypt_warning_decrypt' : 'console.sign_warning')}</Alert>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('console.sign_signer')}</Typography>
          <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all', mb: 2 }}>{signerAddress}</Typography>

          {request?.kind === 'data' && (
            <>
              <Alert severity="error" sx={{ mb: 1.5 }}>{t('console.sign_data_warning')}</Alert>
              {request.looksLikeHash === true && <Alert severity="error" sx={{ mb: 1.5 }}>{t('console.sign_data_hash32_warning')}</Alert>}
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{text !== null ? t('console.sign_data_text') : t('console.sign_data_hex', { bytes: request.data.length })}</Typography>
              <Box sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 1 }}>
                {text !== null ? text : bytesToHex(request.data)}
              </Box>
            </>
          )}

          {request !== null && isCrypt && (
            <>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('console.crypt_other')}</Typography>
              <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{otherAddress}</Typography>
              <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '0.8rem', color: 'text.secondary', mb: 2 }}>{request.otherPublicKey}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {request.kind === 'decrypt' ? t('console.crypt_cipher_hex', { bytes: request.data.length })
                  : text !== null ? t('console.crypt_plain_text') : t('console.crypt_plain_hex', { bytes: request.data.length })}
              </Typography>
              <Box sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 1 }}>
                {request.kind === 'encrypt' && text !== null ? text : bytesToHex(request.data)}
              </Box>
            </>
          )}

          {request !== null && isTx && (
            <>
              {request.kind === 'cosignature' && <Alert severity="info" sx={{ mb: 1.5 }}>{t('console.sign_cosign_note')}</Alert>}
              {request.viaRawSign === true && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('console.sign_via_raw_warning')}</Alert>}
              {hashOnly && (
                <>
                  <Alert severity="error" sx={{ mb: 1.5 }}>{t('console.sign_hash_only_warning')}</Alert>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('console.sign_hash')}</Typography>
                  <Box sx={{ fontFamily: 'monospace', wordBreak: 'break-all', bgcolor: 'action.hover', borderRadius: 1, p: 1, mb: 1.5 }}>{bytesToHex(request.data)}</Box>
                </>
              )}
              {!hashOnly && summary === null && nemView === null && !unreadable && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('console.sign_reading')}</Typography>}
              {unreadable && (
                <>
                  <Alert severity="error" sx={{ mb: 1.5 }}>{t('console.sign_unreadable')}</Alert>
                  <Box sx={{ fontFamily: 'monospace', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 1 }}>{bytesToHex(request.data)}</Box>
                </>
              )}
              {nemView !== null && (
                <>
                  {wrongNetwork && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('console.sign_wrong_network')}</Alert>}
                  {nemRow(t('signqr.label_type'), NEM_TYPE_KEYS[nemView.summary.typeValue] ? t(NEM_TYPE_KEYS[nemView.summary.typeValue]) : t('console.nem_type_unknown', { type: `0x${nemView.summary.typeValue.toString(16)}` }))}
                  {nemView.summary.transfer !== null && (
                    <>
                      {nemRow(t('signqr.label_recipient'), nemView.summary.transfer.recipient)}
                      {nemRow(t('signqr.label_mosaic'), nemView.summary.transfer.mosaics
                        .map((m) => (m.id === NEM_NATIVE_ID
                          ? `${formatAtomic(m.quantity, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`
                          // XEM 以外のモザイクの可分性は、ここでは調べない（通信しない）。最小単位のまま見せる。
                          : `${m.quantity.toString()} ${m.id} (${t('signqr.nem_raw_units')})`)).join('\n') || '-')}
                      {nemView.summary.transfer.message !== null && nemRow(t('signqr.label_message'),
                        nemView.summary.transfer.message.encrypted ? t('signqr.nem_message_encrypted') : nemView.summary.transfer.message.text ?? t('signqr.nem_message_unreadable'))}
                    </>
                  )}
                  {nemView.detail !== '' && (
                    <>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('console.nem_sign_detail')}</Typography>
                      <Box sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontSize: '0.8rem', maxHeight: 200, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 1, mb: 1.5 }}>{nemView.detail}</Box>
                    </>
                  )}
                  <Typography variant="body2">{t('console.sign_fee')}: {formatAtomic(nemView.summary.fee, NEM_CURRENCY_DIVISIBILITY)} {NEM_CURRENCY_SYMBOL}</Typography>
                  <Typography variant="body2">{t('signqr.label_deadline')}: {new Date(nemView.summary.deadlineMs).toLocaleString()}</Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{t('console.sign_hash')}: {nemView.hash}</Typography>
                </>
              )}
              {summary !== null && (
                <>
                  {wrongNetwork && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('console.sign_wrong_network')}</Alert>}
                  {!summary.contentsMatchHash && <Alert severity="error" sx={{ mb: 1.5 }}>{t('console.sign_hash_mismatch')}</Alert>}
                  <SignRiskNotice items={summary.items} sx={{ mb: 1.5 }} />
                  <Box sx={{ mb: 1.5 }}>{summary.items.map((item, i) => <ItemView key={i} item={item} />)}</Box>
                  <Typography variant="body2">{t('console.sign_fee')}: {formatAtomic(summary.fee, CURRENCY_DIVISIBILITY)} {CURRENCY_SYMBOL}</Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{t('console.sign_hash')}: {summary.hash}</Typography>
                </>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} autoFocus>{t('common.cancel')}</Button>
          <Button color="primary" variant="contained" onClick={() => { if (sssCanSign) void onSssSign(); else setAskPassword(true); }} disabled={keylessBlocked || isTx && !hashOnly && summary === null && nemView === null && !unreadable}>{t(request?.kind === 'encrypt' ? 'console.crypt_button_encrypt' : request?.kind === 'decrypt' ? 'console.crypt_button_decrypt' : 'console.sign_button')}</Button>
        </DialogActions>
      </Dialog>
      <PasswordDialog open={open && askPassword} popup profileKey={signerProfileKey} onClose={() => setAskPassword(false)} onCancel={onCancel} onPass={onPass} />
      <ErrorSnackbar message={error} onClose={() => setError('')} />
    </>
  );
}
