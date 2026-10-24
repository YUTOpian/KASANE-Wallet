import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  Radio, RadioGroup, TextField, Typography,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { getNetwork } from '../lib/symbol/network';
import { OFFICIAL_EXTRACT_SCRIPT, OfficialFormatError, parseOfficialData } from '../lib/officialProfile/format';
import { findNewOfficialProfiles } from '../lib/officialProfile/detect';
import type { OfficialFound } from '../lib/officialProfile/detect';
import type { OfficialData } from '../lib/officialProfile/format';
import {
  importOpenedProfile, isKasanePasswordUsable, KASANE_MAX_PASSWORD_BYTES, KASANE_MIN_PASSWORD, listOfficialProfiles, openOfficialProfile,
} from '../lib/officialProfile/convert';
import type { OfficialProfileSummary, OpenedProfile } from '../lib/officialProfile/convert';

type Step = 'data' | 'open' | 'confirm';

/** このブラウザで見つかった公式ウォレットのプロファイルを、最初から「パスワード入力」の段階で開くための指定。 */
export interface OfficialAutoFound {
  text: string;
  /** 一覧に出すプロファイル名。 */
  profiles: string[];
  /** 「今後は聞かない」が押されたとき。 */
  onNever: () => void;
}

function presetOf(auto: OfficialAutoFound | undefined) {
  if (!auto) return null;
  try {
    const data = parseOfficialData(auto.text);
    const profiles = listOfficialProfiles(data).filter((p) => auto.profiles.includes(p.profileName));
    return profiles.length > 0 ? { text: auto.text, data, profiles } : null;
  } catch {
    return null;
  }
}
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Symbol 公式ウォレットのプロファイル（localStorage の profiles / accounts）を読み込んで、KASANE のプロファイルにする。
// 1) データを貼り付ける／ファイルを選ぶ／（同じ場所にあれば）このブラウザから探す  2) プロファイルを選んで公式のパスワードで開く
// 3) 内容を確認して読み込む（公式のパスワードが KASANE の条件に合わないときは、新しいパスワードを決める）。
export default function OfficialProfileImportDialog({ open, onClose, auto }: { open: boolean; onClose: () => void; auto?: OfficialAutoFound }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAppChain = useAppStore((s) => s.setChain);
  const fileInput = useRef<HTMLInputElement>(null);

  // 自動で見つかったときは、データの入力を飛ばして、最初からパスワード入力の段階で開く。
  const [preset] = useState(() => presetOf(auto));
  const [step, setStep] = useState<Step>(preset ? 'open' : 'data');
  const [text, setText] = useState(preset?.text ?? '');
  const [data, setData] = useState<OfficialData | null>(preset?.data ?? null);
  const [profiles, setProfiles] = useState<OfficialProfileSummary[]>(preset?.profiles ?? []);
  const [selected, setSelected] = useState(preset?.profiles[0]?.profileName ?? '');
  const [officialPassword, setOfficialPassword] = useState('');
  const [opened, setOpened] = useState<OpenedProfile | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // このブラウザ（KASANE と同じアドレス）にある、まだ KASANE に無い公式ウォレットのプロファイル。
  // KASANE から削除したものも、ブラウザに残っていれば、ここにまた出る。
  const [here, setHere] = useState<OfficialFound | null>(null);

  useEffect(() => {
    if (!open || preset) return;
    let alive = true;
    void findNewOfficialProfiles({ ignoreDismissed: true }).then((result) => {
      if (alive) setHere(result);
    });
    return () => {
      alive = false;
    };
  }, [open, preset]);

  const reset = () => {
    setStep('data'); setText(''); setData(null); setProfiles([]); setSelected(''); setOfficialPassword('');
    setOpened(null); setNewPassword(''); setConfirm(''); setError(''); setNote(''); setCopied(false); setBusy(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const networkLabel = (network: 'mainnet' | 'testnet' | null) =>
    network === 'mainnet' ? t('wallet.official_network_mainnet') : network === 'testnet' ? t('wallet.official_network_testnet') : t('wallet.official_network_unknown');

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setNote('');
    if (file.size > MAX_FILE_BYTES) { setError(t('wallet.official_import_error_bad_shape')); return; }
    setText(await file.text());
  };

  // 公式ウォレットが同じ場所（同じアドレス）で動いているブラウザなら、localStorage から直接読める。
  const onFindHere = () => {
    setError(''); setNote('');
    try {
      const profilesRaw = localStorage.getItem('profiles');
      if (!profilesRaw) { setNote(t('wallet.official_import_not_found_here')); return; }
      setText(JSON.stringify({ profiles: profilesRaw, accounts: localStorage.getItem('accounts') }));
    } catch {
      setNote(t('wallet.official_import_not_found_here'));
    }
  };

  // ブラウザで見つかったプロファイルを選ぶ：データの貼り付けを飛ばして、パスワード入力の段階へ。
  const onPickHere = (profileName: string) => {
    if (!here) return;
    setError(''); setNote('');
    try {
      const parsed = parseOfficialData(here.text);
      const listed = listOfficialProfiles(parsed).filter((p) => here.profiles.some((h) => h.profileName === p.profileName));
      setText(here.text); setData(parsed); setProfiles(listed); setSelected(profileName);
      setStep('open');
    } catch {
      setError(t('wallet.official_import_error_bad_shape'));
    }
  };

  const onCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(OFFICIAL_EXTRACT_SCRIPT);
      setCopied(true);
    } catch { /* コピーできない環境では、画面のスクリプトを手でコピーしてもらう */ }
  };

  const onNext = () => {
    setError('');
    try {
      const parsed = parseOfficialData(text);
      const list = listOfficialProfiles(parsed);
      setData(parsed); setProfiles(list); setSelected(list[0]?.profileName ?? '');
      setStep('open');
    } catch (e) {
      const code = e instanceof OfficialFormatError ? e.code : 'bad-shape';
      setError(t(`wallet.official_import_error_${code.replace('-', '_')}`));
    }
  };

  const onOpen = async () => {
    if (!data || selected === '' || officialPassword === '' || busy) return;
    setBusy(true); setError('');
    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // 「開いています」を先に描画する
      const result = await openOfficialProfile(data, selected, officialPassword);
      if (!result.ok) {
        setError(result.reason === 'wrong-password' ? t('wallet.official_import_wrong_password') : t('wallet.official_import_no_accounts'));
      } else {
        setOpened(result.profile);
        setStep('confirm');
      }
    } catch (e) {
      console.error('OfficialProfileImportDialog: open failed', e instanceof Error ? e.message : 'unknown error');
      setError(t('wallet.official_import_failed'));
    }
    setBusy(false);
  };

  const sameUsable = isKasanePasswordUsable(officialPassword);
  const onImport = async () => {
    if (!opened || busy) return;
    setError('');
    let password = officialPassword;
    if (!sameUsable) {
      if (!isKasanePasswordUsable(newPassword)) { setError(t('wallet.official_import_new_password_hint', { min: KASANE_MIN_PASSWORD, max: KASANE_MAX_PASSWORD_BYTES })); return; }
      if (newPassword !== confirm) { setError(t('common.password_mismatch')); return; }
      password = newPassword;
    }
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await importOpenedProfile(opened, password);
      if (result.status === 'duplicate') {
        setError(t('wallet.official_import_duplicate', { names: result.names.join('、') }));
        setBusy(false);
        return;
      }
      setAppChain('symbol');
      setBusy(false);
      reset();
      onClose();
      navigate('/wallet/login/end');
    } catch (e) {
      console.error('OfficialProfileImportDialog: import failed', e instanceof Error ? e.message : 'unknown error');
      setError(t('wallet.official_import_failed'));
      setBusy(false);
    }
  };

  const counts = opened
    ? {
        derived: opened.accounts.filter((a) => a.kind === 'derived').length,
        imported: opened.accounts.filter((a) => a.kind === 'imported').length,
        ledger: opened.accounts.filter((a) => a.kind === 'ledger').length,
      }
    : { derived: 0, imported: 0, ledger: 0 };
  const keepsMnemonic = opened !== null && opened.mnemonic !== null && counts.derived > 0;
  const wrongNetwork = opened !== null && opened.network !== null && opened.network !== getNetwork();

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>{preset ? t('wallet.official_auto_title') : t('wallet.official_import_title')}</DialogTitle>
      <DialogContent>
        {step === 'data' && (
          <>
            <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.official_import_intro')}</Typography>
            {here && (
              <Alert severity="info" sx={{ mb: 2 }}>
                <div>{t('wallet.official_here_found')}</div>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                  {here.profiles.map((p) => (
                    <Button key={p.profileName} size="small" variant="outlined" onClick={() => onPickHere(p.profileName)}>
                      {t('wallet.official_here_pick', { name: p.profileName, count: p.accountCount })}
                    </Button>
                  ))}
                </Box>
              </Alert>
            )}
            <TextField
              fullWidth multiline minRows={4} maxRows={8}
              label={t('wallet.official_import_paste_label')}
              value={text}
              onChange={(e) => { setText(e.target.value); setError(''); }}
              slotProps={{ htmlInput: { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } } }}
            />
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
              <Button variant="outlined" onClick={() => fileInput.current?.click()}>{t('wallet.official_import_pick_file')}</Button>
              <Button variant="outlined" onClick={onFindHere}>{t('wallet.official_import_find_here')}</Button>
              <input
                ref={fileInput} type="file" accept=".json,.txt,application/json,text/plain" hidden
                onChange={(e) => { void onPickFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </Box>
            {note !== '' && <Alert severity="info" sx={{ mt: 2 }}>{note}</Alert>}
            <Typography sx={{ fontWeight: 700, fontSize: 13, mt: 3, mb: 0.5 }}>{t('wallet.official_import_howto_title')}</Typography>
            <Typography component="div" sx={{ color: 'text.secondary', fontSize: 13 }}>
              {(t('wallet.official_import_howto', { returnObjects: true }) as string[]).map((line, i) => <div key={i}>{line}</div>)}
            </Typography>
            <Box component="pre" sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>{OFFICIAL_EXTRACT_SCRIPT}</Box>
            <Button size="small" onClick={() => { void onCopyScript(); }}>{copied ? t('wallet.official_copied') : t('wallet.official_import_copy_script')}</Button>
          </>
        )}

        {step === 'open' && (
          <>
            {preset && <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>{t('wallet.official_auto_intro')}</Typography>}
            <Typography sx={{ fontWeight: 700, fontSize: 14, mb: 0.5 }}>{t('wallet.official_import_pick_profile')}</Typography>
            <RadioGroup value={selected} onChange={(e) => { setSelected(e.target.value); setError(''); }}>
              {profiles.map((p) => (
                <FormControlLabel
                  key={p.profileName} value={p.profileName} control={<Radio />}
                  label={t('wallet.official_profile_line', { name: p.profileName, network: networkLabel(p.network), count: p.accountCount })}
                />
              ))}
            </RadioGroup>
            <TextField
              fullWidth type="password" autoComplete="off" sx={{ mt: 2 }}
              label={t('wallet.official_import_password_label')}
              value={officialPassword}
              onChange={(e) => { setOfficialPassword(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onOpen(); } }}
            />
          </>
        )}

        {step === 'confirm' && opened && (
          <>
            <Typography sx={{ fontWeight: 700, mb: 1 }}>{opened.profileName}</Typography>
            <Typography sx={{ fontSize: 14 }}>{t('wallet.official_import_summary', { derived: counts.derived, imported: counts.imported, ledger: counts.ledger })}</Typography>
            {keepsMnemonic && <Typography sx={{ fontSize: 13, color: 'text.secondary', mt: 1 }}>{t('wallet.official_import_summary_mnemonic')}</Typography>}
            {opened.mnemonic !== null && !keepsMnemonic && <Alert severity="info" sx={{ mt: 2 }}>{t('wallet.official_import_mnemonic_dropped')}</Alert>}
            {opened.mnemonicUnreadable && <Alert severity="warning" sx={{ mt: 2 }}>{t('wallet.official_import_mnemonic_unreadable')}</Alert>}
            {wrongNetwork && <Alert severity="info" sx={{ mt: 2 }}>{t('wallet.official_import_network_note', { network: networkLabel(opened.network) })}</Alert>}
            {opened.skipped.length > 0 && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                <div>{t('wallet.official_import_skipped')}</div>
                {opened.skipped.map((s, i) => <div key={i}>{s.name || '-'}：{t(`wallet.official_skip_reason_${s.reason.replace(/-/g, '_')}`)}</div>)}
              </Alert>
            )}
            {sameUsable ? (
              <Typography sx={{ fontSize: 13, color: 'text.secondary', mt: 2 }}>{t('wallet.official_import_same_password')}</Typography>
            ) : (
              <Box sx={{ mt: 2 }}>
                <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1.5 }}>{t('wallet.official_import_new_password_hint', { min: KASANE_MIN_PASSWORD, max: KASANE_MAX_PASSWORD_BYTES })}</Typography>
                <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.official_import_new_password_label')} value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); }} sx={{ mb: 2 }} />
                <TextField fullWidth type="password" autoComplete="new-password" label={t('wallet.official_import_new_password_confirm')} value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
              </Box>
            )}
          </>
        )}

        {error !== '' && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        {preset && auto && step === 'open' && (
          <Button disabled={busy} onClick={() => { auto.onNever(); close(); }} sx={{ mr: 'auto' }}>{t('wallet.official_auto_never')}</Button>
        )}
        {step !== 'data' && !(preset && step === 'open') && (
          <Button disabled={busy} onClick={() => { setStep(step === 'confirm' ? 'open' : 'data'); setError(''); setOpened(null); }}>{t('wallet.official_back')}</Button>
        )}
        <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
        {step === 'data' && <Button variant="contained" disabled={text.trim() === ''} onClick={onNext}>{t('wallet.official_import_next')}</Button>}
        {step === 'open' && (
          <Button variant="contained" disabled={busy || selected === '' || officialPassword === ''} onClick={() => { void onOpen(); }} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            {t('wallet.official_import_open')}
          </Button>
        )}
        {step === 'confirm' && (
          <Button variant="contained" disabled={busy || (!sameUsable && (newPassword === '' || confirm === ''))} onClick={() => { void onImport(); }} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            {t('wallet.official_import_run')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
