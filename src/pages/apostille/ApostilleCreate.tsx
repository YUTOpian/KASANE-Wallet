import { useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { announceNemPayload, nemExplorerTxUrl } from '../../lib/nem/api';
import {
  APOSTILLE_CREATE_HASHINGS, APOSTILLE_HASHINGS, apostilleFee, apostilleFileName, apostilleSink, buildApostilleMessage, dedicatedAccount,
} from '../../lib/nem/apostille';
import type { ApostilleHashName } from '../../lib/nem/apostille';
import { addApostilles, loadApostilles } from '../../lib/nem/apostilleStore';
import { serializeNty } from '../../lib/nem/apostilleNty';
import type { ApostilleRecord } from '../../lib/nem/apostilleNty';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { signNemTransfer } from '../../lib/nem/tx';
import { drawApostilleCertificate } from '../../lib/apostilleCertificate';
import { saveFile } from '../../lib/paperWalletExport';
import { buildZip } from '../../lib/zipStore';
import type { ZipEntry } from '../../lib/zipStore';
import { shortDate } from '../../lib/nem/apostille';
import { getNetwork } from '../../lib/symbol/network';
import { classifyNemError, nemXem } from '../nem/parts';

const MAX_ITEMS = 25;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

interface Item {
  key: number;
  name: string;
  /** The file (or text) content, read when the person pressed the button. */
  file?: File;
  text?: string;
}

export interface UpdateTarget {
  /** Dedicated account of the apostille that is being updated. */
  address: string;
  tags: string;
  filename: string;
}

interface Props {
  update: UpdateTarget | null;
  onCancelUpdate: () => void;
  onCreated: () => void;
}

interface Outcome {
  name: string;
  ok: boolean;
  hash?: string;
  detail?: string;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// 「作成」: ファイルのハッシュ（公開）または署名つきハッシュ（非公開）を、0 XEM の送金のメッセージとして NEM に記録する。
export default function ApostilleCreate({ update, onCancelUpdate, onCreated }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [type, setType] = useState<'public' | 'signed'>('signed');
  const [hashName, setHashName] = useState<ApostilleHashName>('SHA256');
  const [tags, setTags] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [textTitle, setTextTitle] = useState('');
  const [textContent, setTextContent] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [zipFailed, setZipFailed] = useState(false);
  const nextKey = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);

  // An update always sends a signed hash to the dedicated account it already has.
  const effectiveType = update ? 'signed' : type;
  const hashing = APOSTILLE_HASHINGS[hashName];
  const signed = effectiveType === 'signed';
  // Message = 5 bytes of checksum + hash (public) or signature (signed, 64 bytes).
  const hashBytes = hashName === 'SHA256' || hashName === 'SHA3-256' ? 32 : 64;
  const messageLength = 5 + (signed ? 64 : hashBytes);
  const feePerItem = apostilleFee(new Uint8Array(messageLength));

  const textName = `${textTitle.trim()}.txt`;
  const candidates: Item[] = mode === 'file'
    ? items
    : textTitle.trim() !== '' && textContent !== '' ? [{ key: 0, name: textName, text: textContent }] : [];
  const tooBig = candidates.some((i) => (i.file?.size ?? 0) > MAX_FILE_BYTES);
  const canSend = candidates.length > 0 && !tooBig && busy === '';
  const totalFee = feePerItem * BigInt(candidates.length);

  const onPick = (list: FileList | null) => {
    if (!list) return;
    const added: Item[] = [];
    for (const file of Array.from(list)) {
      if (items.length + added.length >= MAX_ITEMS) break;
      added.push({ key: nextKey.current++, name: file.name, file });
    }
    setItems((prev) => [...prev, ...added]);
    if (fileInput.current) fileInput.current.value = '';
  };

  const onPassed = async (password: string) => {
    setBusy(t('apostille.working'));
    setOutcomes(null);
    setZipFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setError(t('wallet.invalid_key'));
        return;
      }
      const netCfg = getNemNetworkConfig();
      const results: Outcome[] = [];
      const entries: ZipEntry[] = [];
      const records: ApostilleRecord[] = [];
      let index = 0;
      for (const item of candidates) {
        index += 1;
        setBusy(t('apostille.sending', { done: index, total: candidates.length }));
        try {
          const bytes = item.file ? new Uint8Array(await item.file.arrayBuffer()) : new TextEncoder().encode(item.text ?? '');
          const built = buildApostilleMessage(bytes, hashing, signed, signed ? privateKey : undefined);
          const recipient = !signed ? apostilleSink(netCfg.networkByte) : update?.address ?? dedicatedAccount(privateKey, item.name, netCfg.networkByte).address;
          const payload = signNemTransfer(privateKey, {
            publicKey: wallet.publicKey, networkByte: netCfg.networkByte, recipient, amount: 0n, messageBytes: built.message, fee: apostilleFee(built.message),
          });
          const sent = await announceNemPayload(payload);
          const date = new Date();
          const txHash = sent.hash.toUpperCase();
          results.push({ name: item.name, ok: true, hash: txHash });
          records.push({
            filename: item.name, tags: tags.trim(), fileHash: built.messageHex, owner: wallet.address, fromMultisig: '',
            dedicatedAccount: recipient, txHash, txMultisigHash: '', timeStamp: date.toUTCString(),
          });
          entries.push({ name: apostilleFileName(item.name, txHash, date), data: bytes });
          try {
            const png = await drawApostilleCertificate({
              fileName: item.name, date, owner: wallet.address, tags: tags.trim(), signed, hashName: hashing.name, dedicatedAccount: recipient,
              txHash, messageHex: built.messageHex, explorerUrl: nemExplorerTxUrl(txHash), network: getNetwork() === 'testnet' ? 'testnet' : 'mainnet',
            });
            entries.push({ name: `Certificate of ${item.name.replace(/\.[^.]*$/, '')} -- TX ${txHash} -- Date ${shortDate(date)}.png`, data: png });
          } catch (e) {
            console.error('Failed to draw the apostille certificate', e);
          }
        } catch (e) {
          const c = classifyNemError(e, 'NONE');
          results.push({ name: item.name, ok: false, detail: `${t(`apostille.error_${c.kind}`)} (${c.detail})` });
        }
      }
      // Whatever went through is on the chain: keep its record first, then hand over the files.
      if (records.length > 0) {
        await addApostilles(records);
        try {
          const all = await loadApostilles();
          entries.push({ name: `Nty-file-${shortDate(new Date())}.nty`, data: new TextEncoder().encode(serializeNty(all)) });
          await saveFile(buildZip(entries), `NEMsigned -- Do not Edit -- ${shortDate(new Date())}.zip`, 'application/zip');
        } catch (e) {
          console.error('Failed to save the apostille archive', e);
          setZipFailed(true);
        }
        onCreated();
      }
      setOutcomes(results);
      if (records.length > 0) {
        setItems([]);
        setTextContent('');
        setTextTitle('');
        if (update) onCancelUpdate();
      }
    } catch (e) {
      const c = classifyNemError(e, 'NONE');
      setError(`${c.kind}: ${c.detail}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('apostille.create_intro')}</Typography>

      {update && (
        <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={onCancelUpdate}>{t('apostille.cancel_update')}</Button>}>
          {t('apostille.update_banner', { name: update.filename })}
        </Alert>
      )}

      {/* Wide screens: the settings on the left, the files / text and the send button on the right (one column on a phone). */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, columnGap: 4, alignItems: 'start' }}>
      <Box>
      {!update && (
        <>
          <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('apostille.type_label')}</Typography>
          <ToggleButtonGroup exclusive fullWidth color="primary" value={type} onChange={(_, v: 'public' | 'signed' | null) => { if (v) setType(v); }} sx={{ mb: 0.5 }}>
            <ToggleButton value="signed">{t('apostille.type_signed')}</ToggleButton>
            <ToggleButton value="public">{t('apostille.type_public')}</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>
            {t(type === 'signed' ? 'apostille.type_signed_hint' : 'apostille.type_public_hint')}
          </Typography>
        </>
      )}

      <TextField select label={t('apostille.hashing_label')} value={hashName} onChange={(e) => setHashName(e.target.value as ApostilleHashName)} fullWidth sx={{ mb: 2 }}>
        {APOSTILLE_CREATE_HASHINGS.map((h) => <MenuItem key={h} value={h}>{h}</MenuItem>)}
      </TextField>

      <TextField label={t('apostille.tags_label')} value={tags} onChange={(e) => setTags(e.target.value)} fullWidth sx={{ mb: 2 }} placeholder={t('apostille.tags_placeholder')} />
      </Box>

      <Box>
      <ToggleButtonGroup exclusive fullWidth color="primary" size="small" value={mode} onChange={(_, v: 'file' | 'text' | null) => { if (v) setMode(v); }} sx={{ mb: 2 }}>
        <ToggleButton value="file">{t('apostille.mode_file')}</ToggleButton>
        <ToggleButton value="text">{t('apostille.mode_text')}</ToggleButton>
      </ToggleButtonGroup>

      {mode === 'file' ? (
        <Box sx={{ mb: 2 }}>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => onPick(e.target.files)} />
          <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} onClick={() => fileInput.current?.click()} disabled={items.length >= MAX_ITEMS}>
            {t('apostille.pick_files')}
          </Button>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('apostille.files_max', { max: MAX_ITEMS })}</Typography>
          {items.map((i) => (
            <Box key={i.key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, px: 1.5, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Typography sx={{ flexGrow: 1, minWidth: 0, wordBreak: 'break-all' }}>{i.name}</Typography>
              <Chip size="small" label={fmtSize(i.file?.size ?? 0)} color={(i.file?.size ?? 0) > MAX_FILE_BYTES ? 'error' : 'default'} />
              <IconButton size="small" aria-label={t('common.delete')} onClick={() => setItems((prev) => prev.filter((x) => x.key !== i.key))}><CloseIcon fontSize="small" /></IconButton>
            </Box>
          ))}
          {tooBig && <Typography sx={{ color: 'error.main', fontSize: 12, mt: 1 }}>{t('apostille.file_too_large', { mb: MAX_FILE_BYTES / 1024 / 1024 })}</Typography>}
        </Box>
      ) : (
        <Box sx={{ mb: 2 }}>
          <TextField label={t('apostille.text_title')} value={textTitle} onChange={(e) => setTextTitle(e.target.value.replace(/[\\/:*?"<>|]/g, ''))} fullWidth sx={{ mb: 2 }} helperText={t('apostille.text_title_hint')} />
          <TextField label={t('apostille.text_content')} value={textContent} onChange={(e) => setTextContent(e.target.value)} fullWidth multiline minRows={4} />
        </Box>
      )}

      <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5, mb: 2 }}>
        <Typography variant="body2">{t('apostille.fee_each')}: {nemXem(feePerItem)}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('apostille.total_fee')}: {nemXem(totalFee)}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('apostille.fee_hint')}</Typography>
      </Box>

      <Button
        variant="contained" color="primary" size="large" fullWidth sx={{ py: 1.5 }}
        disabled={!canSend}
        startIcon={busy ? <CircularProgress size={18} color="inherit" /> : <LockOutlinedIcon />}
        onClick={() => setPasswordOpen(true)}
      >
        {busy || t('apostille.submit', { count: candidates.length })}
      </Button>
      </Box>
      </Box>

      {outcomes && (
        <Box sx={{ mt: 3 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('apostille.result_title')}</Typography>
          {outcomes.map((o, i) => (
            <Alert key={i} severity={o.ok ? 'success' : 'error'} sx={{ mb: 1, wordBreak: 'break-all' }}>
              {o.name}
              {o.ok && o.hash && <> — <a href={nemExplorerTxUrl(o.hash)} target="_blank" rel="noopener noreferrer">{t('nemns.view_explorer')}</a></>}
              {!o.ok && o.detail && <><br />{o.detail}</>}
            </Alert>
          ))}
          {outcomes.some((o) => o.ok) && !zipFailed && <Alert severity="info" sx={{ mb: 1 }}>{t('apostille.zip_saved')}</Alert>}
          {zipFailed && <Alert severity="warning" sx={{ mb: 1 }}>{t('apostille.zip_failed')}</Alert>}
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('apostille.keep_note')}</Typography>
        </Box>
      )}

      <PasswordDialog open={passwordOpen} mode="check" popup onClose={() => setPasswordOpen(false)} onPass={(pw) => { setPasswordOpen(false); void onPassed(pw); }} />
      <ErrorSnackbar message={error} onClose={() => setError('')} />
    </Box>
  );
}
