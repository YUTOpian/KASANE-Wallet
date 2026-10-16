import { useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, IconButton, InputAdornment, ListItemButton, Paper, Snackbar, Switch, Tab, Tabs, TextField, Typography, alpha, useMediaQuery, useTheme } from '@mui/material';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlineOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import SearchIcon from '@mui/icons-material/Search';
import { QRCodeCanvas } from 'qrcode.react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ContactDialog from '../../components/ContactDialog';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { useAddressBook } from '../../hooks/useAddressBook';
import { useWatchOnly } from '../../hooks/useWatchOnly';
import { useAddressBookStore } from '../../store/addressBookStore';
import { useAppStore } from '../../store/appStore';
import { BackupFormatError, displayName } from '../../lib/addressBook';
import type { AddressBookEntry, ContactError, ContactList, ParsedBackup } from '../../lib/addressBook';
import { chainAddressQr, prettyChainAddress } from '../../lib/chainApi';
import { downloadCanvasPng } from '../../lib/qrImage';

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

type ContactField = 'name' | 'address' | 'phone' | 'email' | 'memo';
const FIELDS: ContactField[] = ['name', 'address', 'phone', 'email', 'memo'];

// 詳細の1行（グリッドの3列：ラベル / 内容 / 右端の操作）。ラベルの列は一番長いラベルの幅に合わせるので、内容がラベルのすぐ隣に来る。
function FieldRow({ label, children, editLabel, onEdit, extraAction }: { label: string; children: React.ReactNode; editLabel: string; onEdit: () => void; extraAction?: React.ReactNode }) {
  return (
    <>
      <Typography sx={{ color: 'text.secondary', whiteSpace: 'nowrap', lineHeight: '32px' }}>{label}:</Typography>
      <Box sx={{ minWidth: 0, minHeight: 32, display: 'flex', alignItems: 'flex-start' }}>{children}</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: 32 }}>
        {extraAction}
        <IconButton size="small" aria-label={editLabel} onClick={onEdit}><EditIcon fontSize="small" /></IconButton>
      </Box>
    </>
  );
}

/**
 * アドレス帳：連絡先（名前・アドレス・メール・電話・メモ）をホワイトリスト / ブラックリストに分けて持つ。JSONのバックアップとインポート。
 * `?pick=1` で開くと送金先を選ぶ画面になり、選んだ連絡先のアドレスを送金フォームに入れて Home に戻る。
 *
 * 広い画面では、公式のSymbolウォレットの「マイ連絡先」と同じく、左に一覧（ホワイトリスト / ブラックリストのタブ、下に追加とインポート）、
 * 右に選んだ連絡先の詳細を並べる。狭い画面では一覧だけで、連絡先を押すと詳細がダイアログで開く。
 * 送金先を選ぶときは一覧だけで、押した連絡先がそのまま送金先になる。
 */
export default function AddressBookPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [params] = useSearchParams();
  const picking = params.get('pick') === '1';
  // 閲覧用プロファイルは送金できないので、送金ボタンは出さない。
  const watchOnly = useWatchOnly();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const setReceiverAddress = useAppStore((s) => s.setReceiverAddress);
  const setHomePanel = useAppStore((s) => s.setHomePanel);

  const { entries, loaded } = useAddressBook();
  const hideBlocked = useAddressBookStore((s) => s.hideBlocked);
  const setHideBlocked = useAddressBookStore((s) => s.setHideBlocked);
  const removeContact = useAddressBookStore((s) => s.removeContact);
  const updateContact = useAddressBookStore((s) => s.updateContact);
  const exportJson = useAddressBookStore((s) => s.exportJson);
  const readBackup = useAddressBookStore((s) => s.readBackup);
  const applyBackup = useAddressBookStore((s) => s.applyBackup);

  const [filter, setFilter] = useState<ContactList>('white');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<AddressBookEntry | null>(null);
  const [blockedPick, setBlockedPick] = useState<AddressBookEntry | null>(null);
  const [pendingImport, setPendingImport] = useState<ParsedBackup | null>(null);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldEdit, setFieldEdit] = useState<{ entry: AddressBookEntry; field: ContactField } | null>(null);
  const [fieldValue, setFieldValue] = useState('');
  const [fieldError, setFieldError] = useState<ContactError | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);

  // いま選んでいるチェーン・ネットワークの連絡先だけを並べる（別のチェーンのアドレスには送れないので）。
  const mine = useMemo(() => entries.filter((e) => e.chain === chain && e.network === network), [entries, chain, network]);
  const otherCount = entries.length - mine.length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mine
      .filter((e) => e.list === filter)
      .filter((e) => q === '' || [e.name, e.address, e.email, e.phone, e.memo].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [mine, filter, query]);

  // 右の詳細：選んだ連絡先。選んでいない（または一覧から消えた）ときは、先頭の連絡先を出す。
  const selected = visible.find((e) => e.id === selectedId) ?? visible[0] ?? null;

  const pick = (entry: AddressBookEntry) => {
    setReceiverAddress(entry.address);
    setHomePanel('send');
    navigate('/top', { replace: true });
  };

  // 送金画面へ：このアドレスを送金先に入れて開く。ブラックリストの相手には、確認のダイアログを挟む。
  const sendTo = (entry: AddressBookEntry) => {
    if (entry.list === 'black') setBlockedPick(entry);
    else pick(entry);
  };

  const onClickEntry = (entry: AddressBookEntry) => {
    if (picking) { sendTo(entry); return; }
    setSelectedId(entry.id);
    if (compact) setDetailOpen(true);
  };

  const copyAddress = async (entry: AddressBookEntry) => {
    try {
      await navigator.clipboard.writeText(entry.address);
      setNotice(t('addressbook.address_copied'));
    } catch (e) {
      console.warn('Failed to copy the address', e);
    }
  };

  // 1項目だけ書き換えて保存する（ほかの項目は今のまま）。
  const saveField = async (entry: AddressBookEntry, patch: Partial<Record<ContactField, string>> & { list?: ContactList }) => {
    const input = { name: entry.name, address: entry.address, email: entry.email, phone: entry.phone, memo: entry.memo, list: entry.list, ...patch };
    return updateContact(entry.id, input);
  };

  const openFieldEdit = (entry: AddressBookEntry, field: ContactField) => {
    setFieldValue(entry[field]);
    setFieldError(null);
    setFieldEdit({ entry, field });
  };

  const onSaveField = async () => {
    if (!fieldEdit) return;
    const patch: Partial<Record<ContactField, string>> = { [fieldEdit.field]: fieldValue };
    const result = await saveField(fieldEdit.entry, patch);
    if (!result.ok) { setFieldError(result.error); return; }
    setFieldEdit(null);
  };

  // ホワイトリスト <-> ブラックリストを入れ替える。
  const onMoveList = async (entry: AddressBookEntry) => {
    const result = await saveField(entry, { list: entry.list === 'white' ? 'black' : 'white' });
    if (!result.ok) setErrorMessage(t(`addressbook.error_${result.error}`));
  };

  const onDownloadQr = () => {
    if (selected && qrRef.current) void downloadCanvasPng(qrRef.current, `${selected.address}.png`);
  };

  const onExport = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `kasane-address-book-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(t('addressbook.exported', { count: entries.length }));
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new BackupFormatError();
      const parsed = readBackup(await file.text());
      if (parsed.entries.length === 0) { setErrorMessage(t('addressbook.import_empty')); return; }
      setPendingImport(parsed);
    } catch (e) {
      console.warn('Failed to read the address book backup', e);
      setErrorMessage(t('addressbook.import_invalid'));
    }
  };

  const onApplyImport = async (mode: 'merge' | 'replace') => {
    if (!pendingImport) return;
    const result = await applyBackup(pendingImport.entries, mode);
    setPendingImport(null);
    setNotice(mode === 'replace'
      ? t('addressbook.import_replaced', { count: result.added })
      : t('addressbook.import_merged', { added: result.added, updated: result.updated }));
  };

  // 左のパネル（狭い画面・送金先を選ぶ画面では、これだけを出す）。
  const listPanel = (
    <Paper
      elevation={0}
      sx={{ display: 'flex', flexDirection: 'column', p: { xs: 2, md: 3 }, borderRadius: 3, minHeight: { md: 560 }, boxSizing: 'border-box', maxWidth: picking && !compact ? 720 : undefined }}
    >
      <Typography sx={{ fontSize: '1.4rem', fontWeight: 300, mb: 1.5 }}>{picking ? t('addressbook.pick_title') : t('addressbook.title')}</Typography>

      <Tabs value={filter} onChange={(_, v: ContactList) => setFilter(v)} sx={{ mb: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="white" label={t('addressbook.list_white')} sx={{ textTransform: 'none' }} />
        <Tab value="black" label={t('addressbook.list_black')} sx={{ textTransform: 'none' }} />
      </Tabs>

      <TextField
        size="small"
        fullWidth
        placeholder={t('addressbook.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
      />

      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>
        {t(filter === 'black' ? 'addressbook.blacklist_info' : 'addressbook.whitelist_info')}
      </Typography>
      {filter === 'black' && (
        <FormControlLabel
          sx={{ mt: 0.5 }}
          control={<Switch size="small" checked={hideBlocked} onChange={(e) => { void setHideBlocked(e.target.checked); }} />}
          label={<Typography variant="body2">{t('addressbook.hide_blocked')}</Typography>}
        />
      )}

      <Box sx={{ flexGrow: 1, mt: 1.5, minHeight: 120 }}>
        {!loaded ? null : visible.length === 0 ? (
          <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary', whiteSpace: 'pre-line' }}>
            {mine.length === 0 ? t('addressbook.empty') : t('addressbook.no_match')}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {visible.map((entry) => {
              const active = !picking && !compact && selected?.id === entry.id;
              return (
                <Box component="li" key={entry.id}>
                  <ListItemButton
                    selected={active}
                    onClick={() => onClickEntry(entry)}
                    sx={{ borderRadius: 2, py: 1.25, '&.Mui-selected': { bgcolor: alpha(theme.palette.primary.main, 0.1) } }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', minWidth: 0 }}>
                      <PersonOutlineOutlinedIcon sx={{ flexShrink: 0 }} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography sx={{ fontWeight: 700 }}>{entry.name || t('addressbook.no_name')}</Typography>
                        <Typography variant="body2" sx={{ color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.address}
                        </Typography>
                      </Box>
                    </Box>
                  </ListItemButton>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {otherCount > 0 && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1.5, color: 'text.secondary' }}>
          {t('addressbook.other_chain_note', { count: otherCount })}
        </Typography>
      )}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mt: 2 }}>
        <Button size="small" startIcon={<AddCircleOutlineIcon />} onClick={() => { setAdding(true); }} sx={{ textTransform: 'none' }}>{t('addressbook.add_link')}</Button>
        <Button size="small" startIcon={<FileUploadOutlinedIcon />} onClick={() => fileInput.current?.click()} sx={{ textTransform: 'none' }}>{t('addressbook.import_link')}</Button>
        <Button size="small" startIcon={<FileDownloadOutlinedIcon />} onClick={onExport} disabled={entries.length === 0} sx={{ textTransform: 'none' }}>{t('addressbook.export')}</Button>
      </Box>
      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>{t('addressbook.storage_note')}</Typography>
    </Paper>
  );

  // 連絡先の詳細（右のパネル、または狭い画面のダイアログの中身）。公式のSymbolウォレットと同じく、QRコードと項目ごとの鉛筆。
  const detail = (entry: AddressBookEntry) => (
    <Box>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', lg: 'row' }, gap: { xs: 2, lg: 5 }, alignItems: { xs: 'center', lg: 'flex-start' } }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.95rem' }}>{t('addressbook.detail_qr_label')}</Typography>
          <Box sx={{ p: 1, bgcolor: '#fff', borderRadius: 1, lineHeight: 0 }}>
            <QRCodeCanvas ref={qrRef} value={chainAddressQr(entry.address, displayName(entry))} size={200} marginSize={1} />
          </Box>
          <Button size="small" startIcon={<DownloadIcon />} onClick={onDownloadQr} sx={{ textTransform: 'none' }}>{t('addressbook.detail_download')}</Button>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr) auto', columnGap: 2, rowGap: 1.5, alignItems: 'start' }}>
            {FIELDS.map((field) => (
              <FieldRow
                key={field}
                label={t(`addressbook.detail_${field}`)}
                editLabel={t('common.edit')}
                onEdit={() => openFieldEdit(entry, field)}
                extraAction={field === 'address'
                  ? <IconButton size="small" aria-label={t('addressbook.copy_address')} onClick={() => { void copyAddress(entry); }}><ContentCopyIcon fontSize="small" /></IconButton>
                  : undefined}
              >
                {field === 'address' ? (
                  // ハイフンの位置で折り返す（6文字ずつのまとまりのまま読める）。コピーされるのはハイフンなしのアドレス。
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 15, lineHeight: '22px', py: '5px', overflowWrap: 'anywhere' }}>{prettyChainAddress(entry.address)}</Typography>
                ) : (
                  <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '32px' }}>
                    {field === 'name' ? (entry.name || t('addressbook.no_name')) : entry[field]}
                  </Typography>
                )}
              </FieldRow>
            ))}
          </Box>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1.5, mt: 3 }}>
            {!watchOnly && <Button variant="outlined" onClick={() => sendTo(entry)}>{t('addressbook.send_to')}</Button>}
            <Button variant="outlined" onClick={() => { void onMoveList(entry); }}>{t(entry.list === 'white' ? 'addressbook.list_black' : 'addressbook.list_white')}</Button>
            <Button variant="outlined" onClick={() => setDeleting(entry)}>{t('addressbook.delete_contact')}</Button>
          </Box>
        </Box>
      </Box>
    </Box>
  );

  const showDetailPanel = !compact && !picking;

  return (
    <Box sx={{ pb: 4 }}>
      {picking && <BackButton back="/top" />}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => { void onFileChosen(e.target.files?.[0]); e.target.value = ''; }}
      />

      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, pt: 2, boxSizing: 'border-box' }}>
        {showDetailPanel ? (
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: 'minmax(380px, 5fr) 7fr', alignItems: 'stretch' }}>
            {listPanel}
            <Paper elevation={0} sx={{ p: 3, borderRadius: 3, minHeight: 560, boxSizing: 'border-box' }}>
              <Typography sx={{ fontSize: '1.1rem', fontWeight: 500, mb: 3, px: 1 }}>{t('addressbook.detail_title')}</Typography>
              <Box sx={{ px: 1 }}>
                {selected ? detail(selected) : (
                  loaded && mine.length > 0 && <Typography sx={{ color: 'text.secondary' }}>{t('addressbook.detail_empty')}</Typography>
                )}
              </Box>
            </Paper>
          </Box>
        ) : listPanel}
      </Box>

      {/* 狭い画面：連絡先の詳細 */}
      <Dialog open={compact && !picking && detailOpen && selected !== null} onClose={() => setDetailOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('addressbook.detail_title')}</DialogTitle>
        <DialogContent>{selected && detail(selected)}</DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailOpen(false)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      {/* 1項目の編集 */}
      <Dialog open={fieldEdit !== null} onClose={() => setFieldEdit(null)} fullWidth maxWidth="sm">
        <DialogTitle>{fieldEdit ? t(`addressbook.detail_${fieldEdit.field}`) : ''}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline={fieldEdit?.field === 'memo' || fieldEdit?.field === 'address'}
            minRows={fieldEdit?.field === 'memo' ? 3 : 1}
            margin="dense"
            value={fieldValue}
            onChange={(e) => { setFieldValue(e.target.value); setFieldError(null); }}
            error={fieldError !== null}
            helperText={fieldError !== null ? t(`addressbook.error_${fieldError}`) : ''}
            slotProps={{ htmlInput: { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFieldEdit(null)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={() => { void onSaveField(); }}>{t('addressbook.save')}</Button>
        </DialogActions>
      </Dialog>

      <ContactDialog open={adding} onClose={() => setAdding(false)} initial={{ list: filter }} />

      {/* 削除の確認 */}
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('addressbook.delete_title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('addressbook.delete_message', { name: deleting ? displayName(deleting) : '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
          <Button color="error" onClick={async () => { if (deleting) { await removeContact(deleting.id); setDetailOpen(false); } setDeleting(null); }}>{t('common.delete')}</Button>
        </DialogActions>
      </Dialog>

      {/* ブラックリストの相手を送金先に選んだとき */}
      <Dialog open={blockedPick !== null} onClose={() => setBlockedPick(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('addressbook.pick_blocked_title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('addressbook.pick_blocked_message', { name: blockedPick ? displayName(blockedPick) : '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setBlockedPick(null)}>{t('common.cancel')}</Button>
          <Button color="error" onClick={() => { const e = blockedPick; setBlockedPick(null); if (e) pick(e); }}>{t('addressbook.pick_blocked_continue')}</Button>
        </DialogActions>
      </Dialog>

      {/* インポート：統合 / 置き換え */}
      <Dialog open={pendingImport !== null} onClose={() => setPendingImport(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('addressbook.import_title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1 }}>
            {t('addressbook.import_found', { count: pendingImport?.entries.length ?? 0 })}
            {pendingImport && pendingImport.skipped > 0 ? ` ${t('addressbook.import_skipped', { count: pendingImport.skipped })}` : ''}
          </DialogContentText>
          <DialogContentText variant="body2">{t('addressbook.import_modes')}</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button onClick={() => setPendingImport(null)}>{t('common.cancel')}</Button>
          <Button color="error" onClick={() => { void onApplyImport('replace'); }}>{t('addressbook.import_replace')}</Button>
          <Button variant="contained" onClick={() => { void onApplyImport('merge'); }}>{t('addressbook.import_merge')}</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={notice !== ''} autoHideDuration={4000} onClose={() => setNotice('')} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setNotice('')} sx={{ width: '100%' }}>{notice}</Alert>
      </Snackbar>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
