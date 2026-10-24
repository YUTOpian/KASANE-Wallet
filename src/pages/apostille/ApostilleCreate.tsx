import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { APOSTILLE_CREATE_HASHINGS, APOSTILLE_HASHINGS, apostilleFileName } from '../../lib/nem/apostille';
import type { ApostilleHashName } from '../../lib/nem/apostille';
import { addApostilles, loadApostilles } from '../../lib/nem/apostilleStore';
import { serializeNty } from '../../lib/nem/apostilleNty';
import type { ApostilleRecord } from '../../lib/nem/apostilleNty';
import { apostilleDriver } from '../../lib/apostilleChain';
import { sendSymbolApostille, sendSymbolApostilleFromMultisig, quoteSymbolApostilleFromMultisig } from '../../lib/symbol/apostilleApi';
import { fetchAccountPublicKey, fetchCosignedAccounts, fetchCosignerGraph } from '../../lib/symbol/multisigApi';
import type { CosignedAccount, MultisigCost } from '../../lib/symbol/multisigApi';
import { planApproval } from '../../lib/symbol/multisigTree';
import type { ApprovalPlan } from '../../lib/symbol/multisigTree';
import { LedgerError } from '../../lib/ledger/framing';
import { ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink } from '../../lib/ledger/session';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import { useAppStore } from '../../store/appStore';
import { drawApostilleCertificate } from '../../lib/apostilleCertificate';
import { saveFile } from '../../lib/paperWalletExport';
import { buildZip } from '../../lib/zipStore';
import type { ZipEntry } from '../../lib/zipStore';
import { shortDate } from '../../lib/nem/apostille';

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
  /** Sent in the name of a multisig account that still needs other signatures: it is not on the chain yet. */
  waiting?: boolean;
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
  const chain = useAppStore((st) => st.chain);
  const network = useAppStore((st) => st.network);
  const driver = apostilleDriver(chain);
  const [feePerItem, setFeePerItem] = useState<bigint | null>(null);
  // Symbol only. A Ledger account can send a public apostille (the device signs the transfer; it cannot sign the file's hash, which a signed apostille needs).
  // A multisig account can send a public apostille too, as an aggregate that this wallet signs (the dedicated account of a signed one comes from a key the multisig account does not have).
  const [ledgerWallet, setLedgerWallet] = useState(false);
  const [ledgerIndex, setLedgerIndex] = useState<number | null>(null);
  const [walletAddress, setWalletAddress] = useState('');
  const [multisigAccounts, setMultisigAccounts] = useState<CosignedAccount[]>([]);
  const [from, setFrom] = useState(''); // '' = this account, otherwise a multisig account (address)
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [plan, setPlan] = useState<ApprovalPlan | null>(null);
  const [multisigCost, setMultisigCost] = useState<MultisigCost | null>(null);
  const isSymbol = driver.chain === 'symbol';
  const fromMultisig = isSymbol && from !== '';

  useEffect(() => {
    let live = true;
    setLedgerWallet(false);
    setLedgerIndex(null);
    setMultisigAccounts([]);
    setFrom('');
    WalletsHelper.getActive().then(async (w) => {
      if (!live || !w) return;
      setWalletAddress(w.address);
      if (w.ledger) { setLedgerWallet(true); setLedgerIndex(w.accountIndex ?? null); return; }
      if (w.watchOnly || chain !== 'symbol') return;
      try {
        const cosigned = await fetchCosignedAccounts(w.address);
        if (live) setMultisigAccounts(cosigned);
      } catch (e) {
        console.error('Failed to load multisig accounts', e);
      }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [chain, network]);

  // An update always sends a signed hash to the dedicated account it already has. A Ledger or multisig sender can only send a public apostille.
  const publicOnly = ledgerWallet || fromMultisig;
  const effectiveType = publicOnly ? 'public' : update ? 'signed' : type;
  const hashing = APOSTILLE_HASHINGS[hashName];
  const signed = effectiveType === 'signed';
  // Message = 5 bytes of checksum + hash (public) or signature (signed, 64 bytes).
  const hashBytes = hashName === 'SHA256' || hashName === 'SHA3-256' ? 32 : 64;
  const messageLength = 5 + (signed ? 64 : hashBytes);
  // NEM's fee is a fixed rule; Symbol's depends on the network's current fee level, so it is asked of the node.
  useEffect(() => {
    let live = true;
    setFeePerItem(null);
    driver.fee(messageLength).then((f) => { if (live) setFeePerItem(f); }, () => { if (live) setFeePerItem(null); });
    return () => { live = false; };
  }, [driver, messageLength]);

  // In the name of a multisig account: the public key to send from, what it takes to approve it, and the cost (aggregate + hash lock when others must sign).
  useEffect(() => {
    setFromKey(null);
    setPlan(null);
    setMultisigCost(null);
    if (!fromMultisig || walletAddress === '') return undefined;
    let live = true;
    Promise.all([fetchAccountPublicKey(from), fetchCosignerGraph(from)]).then(([key, graph]) => {
      if (!live) return;
      setFromKey(key);
      setPlan(planApproval(graph, from, walletAddress));
    }, (e) => console.error('Failed to load the multisig account', e));
    return () => { live = false; };
  }, [fromMultisig, from, walletAddress, network]);
  const multisigBonded = plan ? !plan.selfSufficient : true;
  const multisigSignatures = Math.max(plan?.others ?? 1, 1);
  useEffect(() => {
    if (!fromMultisig || !plan) return undefined;
    let live = true;
    quoteSymbolApostilleFromMultisig(new Uint8Array(messageLength), multisigSignatures, multisigBonded)
      .then((c) => { if (live) setMultisigCost(c); }, () => { if (live) setMultisigCost(null); });
    return () => { live = false; };
  }, [fromMultisig, plan, multisigBonded, multisigSignatures, messageLength]);
  const multisigBlocked = fromMultisig && (plan === null || !plan.eligible || fromKey === null);
  const updateBlocked = !!update && publicOnly;

  const textName = `${textTitle.trim()}.txt`;
  const candidates: Item[] = mode === 'file'
    ? items
    : textTitle.trim() !== '' && textContent !== '' ? [{ key: 0, name: textName, text: textContent }] : [];
  const tooBig = candidates.some((i) => (i.file?.size ?? 0) > MAX_FILE_BYTES);
  const shownFee = fromMultisig ? (multisigCost ? multisigCost.aggregateFee.fee + multisigCost.lockFee : null) : feePerItem;
  const canSend = candidates.length > 0 && !tooBig && busy === '' && shownFee !== null && !multisigBlocked && !updateBlocked;
  const totalFee = shownFee === null ? null : shownFee * BigInt(candidates.length);

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

  // `password` = null for a Ledger account: the key stays in the device, which signs each transfer.
  const execute = async (password: string | null) => {
    setBusy(t('apostille.working'));
    setOutcomes(null);
    setZipFailed(false);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      let privateKey = '';
      if (password !== null) {
        const decrypted = await WalletsHelper.decryptKey(wallet.id, password);
        if (decrypted == null) {
          setError(t('wallet.invalid_key'));
          return;
        }
        privateKey = decrypted;
      } else if (ledgerIndex === null) {
        setError(t('ledger.error_unknown'));
        return;
      }
      // Who the apostille belongs to: the wallet, or the multisig account it is sent from.
      const owner = fromMultisig ? from : wallet.address;
      const results: Outcome[] = [];
      const entries: ZipEntry[] = [];
      const records: ApostilleRecord[] = [];
      let index = 0;
      for (const item of candidates) {
        index += 1;
        setBusy(t('apostille.sending', { done: index, total: candidates.length }));
        try {
          const bytes = item.file ? new Uint8Array(await item.file.arrayBuffer()) : new TextEncoder().encode(item.text ?? '');
          const built = driver.build(bytes, hashing, signed, signed ? privateKey : undefined);
          const recipient = !signed ? driver.sink() : update?.address ?? driver.dedicatedAddress(privateKey, item.name);
          let waiting = false;
          let sent: { hash: string };
          if (password === null && ledgerIndex !== null) {
            sent = await sendSymbolApostille({ privateKey: '', ledgerIndex, publicKey: wallet.publicKey, recipient, message: built.message });
          } else if (fromMultisig) {
            if (fromKey === null) throw new Error('multisig account has no public key');
            const out = await sendSymbolApostilleFromMultisig({
              privateKey, publicKey: wallet.publicKey, multisigPublicKey: fromKey, recipient, message: built.message,
              bonded: multisigBonded, cosignatureCount: multisigSignatures,
            });
            sent = out;
            waiting = out.bonded;
          } else {
            sent = await driver.send({ privateKey, publicKey: wallet.publicKey, address: wallet.address }, recipient, built, await driver.fee(built.message.length));
          }
          const date = new Date();
          const txHash = sent.hash.toUpperCase();
          results.push({ name: item.name, ok: true, hash: txHash, waiting });
          records.push({
            filename: item.name, tags: tags.trim(), fileHash: built.messageHex, owner, fromMultisig: fromMultisig ? from : '',
            dedicatedAccount: recipient, txHash, txMultisigHash: '', timeStamp: date.toUTCString(),
          });
          entries.push({ name: apostilleFileName(item.name, txHash, date), data: bytes });
          try {
            const png = await drawApostilleCertificate({
              fileName: item.name, date, owner, tags: tags.trim(), signed, hashName: hashing.name, dedicatedAccount: recipient,
              txHash, messageHex: built.messageHex, explorerUrl: driver.txUrl(txHash), network: driver.network === 'testnet' ? 'testnet' : driver.network === 'mijin' ? 'mijin' : 'mainnet', chainName: driver.name,
            });
            entries.push({ name: `Certificate of ${item.name.replace(/\.[^.]*$/, '')} -- TX ${txHash} -- Date ${shortDate(date)}.png`, data: png });
          } catch (e) {
            console.error('Failed to draw the apostille certificate', e);
          }
        } catch (e) {
          if (e instanceof LedgerError) {
            results.push({ name: item.name, ok: false, detail: t(ledgerErrorKey(e), { chain: 'Symbol' }) });
            continue;
          }
          const c = driver.classifyError(e);
          results.push({ name: item.name, ok: false, detail: `${t(`apostille.error_${c.kind}`, { context: driver.context })} (${c.detail})` });
        }
      }
      // Whatever went through is on the chain: keep its record first, then hand over the files.
      if (records.length > 0) {
        await addApostilles(records);
        try {
          const all = await loadApostilles();
          entries.push({ name: `Nty-file-${shortDate(new Date())}.nty`, data: new TextEncoder().encode(serializeNty(all)) });
          await saveFile(buildZip(entries), `${driver.chain === 'symbol' ? 'Symbolsigned' : 'NEMsigned'} -- Do not Edit -- ${shortDate(new Date())}.zip`, 'application/zip');
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
      const c = driver.classifyError(e);
      setError(`${c.kind}: ${c.detail}`);
    } finally {
      setBusy('');
    }
  };

  const onPassed = (password: string) => execute(password);

  // Ledger: the device can only be chosen right after a click, so connect first (before anything is awaited), then sign.
  const onLedger = async () => {
    const link = preferredLedgerLink();
    if (link === null) { setError(t('ledger.error_unsupported_browser')); return; }
    try {
      await ensureLedgerConnected(link);
    } catch (e) {
      if (e instanceof LedgerError) {
        if (e.kind !== 'no_device') setError(t(ledgerErrorKey(e), { chain: 'Symbol' }));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    await execute(null);
  };

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('apostille.create_intro', { chain: driver.name })}</Typography>

      {update && (
        <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={onCancelUpdate}>{t('apostille.cancel_update')}</Button>}>
          {t('apostille.update_banner', { name: update.filename })}
        </Alert>
      )}

      {/* Wide screens: the settings on the left, the files / text and the send button on the right (one column on a phone). */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, columnGap: 4, alignItems: 'start' }}>
      <Box>
      {isSymbol && multisigAccounts.length > 0 && !ledgerWallet && (
        <>
          <TextField select label={t('apostille.from_label')} value={from} onChange={(e) => setFrom(e.target.value)} fullWidth sx={{ mb: 2 }}>
            <MenuItem value="">{t('apostille.from_self')}</MenuItem>
            {multisigAccounts.map((a) => (
              <MenuItem key={a.info.address} value={a.info.address} sx={{ fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'normal' }}>{a.info.address}</MenuItem>
            ))}
          </TextField>
        </>
      )}
      {ledgerWallet && <Alert severity="info" sx={{ mb: 2 }}>{t('apostille.public_only_ledger')}</Alert>}
      {fromMultisig && (
        <>
          <Alert severity="info" sx={{ mb: 2 }}>{t('apostille.public_only_multisig')}</Alert>
          {plan !== null && !plan.eligible && <Alert severity="warning" sx={{ mb: 2 }}>{t('apostille.multisig_not_eligible')}</Alert>}
          {plan !== null && plan.eligible && multisigBonded && <Alert severity="info" sx={{ mb: 2 }}>{t('apostille.multisig_waiting_note', { count: plan.others + 1 })}</Alert>}
        </>
      )}
      {updateBlocked && <Alert severity="warning" sx={{ mb: 2 }}>{t('apostille.update_not_available')}</Alert>}
      {!update && !publicOnly && (
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
        <Typography variant="body2">{t('apostille.fee_each')}: {shownFee === null ? '…' : driver.formatFee(shownFee)}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t('apostille.total_fee')}: {totalFee === null ? '…' : driver.formatFee(totalFee)}</Typography>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('apostille.fee_hint', { context: driver.context })}</Typography>
        {fromMultisig && multisigCost !== null && multisigCost.lockAmount > 0n && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
            {t('apostille.multisig_lock_note', { amount: `${formatAtomic(multisigCost.lockAmount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}` })}
          </Typography>
        )}
      </Box>

      <Button
        variant="contained" color="primary" size="large" fullWidth sx={{ py: 1.5 }}
        disabled={!canSend}
        startIcon={busy ? <CircularProgress size={18} color="inherit" /> : ledgerWallet ? <UsbOutlinedIcon /> : <LockOutlinedIcon />}
        onClick={() => { if (ledgerWallet) void onLedger(); else setPasswordOpen(true); }}
      >
        {busy || (ledgerWallet ? t('ledger.sign_button') : t('apostille.submit', { count: candidates.length }))}
      </Button>
      </Box>
      </Box>

      {outcomes && (
        <Box sx={{ mt: 3 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('apostille.result_title')}</Typography>
          {outcomes.map((o, i) => (
            <Alert key={i} severity={o.ok ? 'success' : 'error'} sx={{ mb: 1, wordBreak: 'break-all' }}>
              {o.name}
              {o.ok && o.hash && <> — <a href={driver.txUrl(o.hash)} target="_blank" rel="noopener noreferrer">{t('nemns.view_explorer')}</a></>}
              {o.ok && o.waiting && <><br />{t('apostille.multisig_waiting_result')}</>}
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
