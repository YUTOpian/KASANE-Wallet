import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, MenuItem, Radio, RadioGroup, TextField, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { SxProps, Theme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { createNemMosaic, fetchNemMosaicEditState, fetchNemMosaicInfos, fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import type { NemMosaicEditState, NemMosaicInfo } from '../../lib/nem/api';
import { normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { nemMosaicEditBase, nemMosaicEditDiff, nemMosaicEditSend, validateNemLevy, validateNemMosaicEdit } from '../../lib/nem/mosaicEdit';
import type { NemMosaicEditValues } from '../../lib/nem/mosaicEdit';
import {
  NEM_MAX_MOSAIC_DESCRIPTION_BYTES, NEM_MAX_MOSAIC_DIVISIBILITY, NEM_MAX_MOSAIC_INITIAL_SUPPLY, NEM_MOSAIC_RENTAL, NEM_PROVISION_TX_FEE, splitNemMosaicId,
} from '../../lib/nem/tx';
import type { NemMosaicLevyParams } from '../../lib/nem/tx';
import { showTxNotice } from '../../store/txNoticeStore';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from '../mosaic/mosaicFlags';
import { ConfirmRows, classifyNemError, nemXem } from './parts';
import { NemLevyFieldsBox } from './NemLevyForm';
import { FormRow, MosaicColumns, ReadOnlyValue, SectionHead, supplyWithDecimals, xemFixed } from './mosaicLayout';

type Step = 'form' | 'confirm';
type LevyMode = 'keep' | 'set' | 'none';
type LevyCheck = { state: 'idle' } | { state: 'loading' } | { state: 'found'; info: NemMosaicInfo } | { state: 'missing' };

interface NemMosaicEditProps {
  /** The mosaic to edit ("namespace:name"), one the active wallet created. */
  mosaicId: string;
  /** Shown under the mosaic screen's tabs instead of as a screen of its own. */
  embedded?: boolean;
  /** Back to the list; `changed` is true after a definition was sent (so the list reloads). */
  onClose: (changed: boolean) => void;
}

// NEM モザイクの定義の編集: 同じ名前でモザイク定義を送り直す（NanoWallet と同じ仕組み）。
// 供給量のすべてを作成者が持っているときは全項目、そうでなければ説明だけ変えられる。入力 → 確認（パスワード）→ 送信。
export default function NemMosaicEdit({ mosaicId, embedded = false, onClose }: NemMosaicEditProps) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [loadState, setLoadState] = useState<'loading' | 'failed' | 'missing' | 'ready'>('loading');
  const [edit, setEdit] = useState<NemMosaicEditState | null>(null);
  const [walletKey, setWalletKey] = useState('');
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [step, setStep] = useState<Step>('form');
  const [description, setDescription] = useState('');
  const [divisibility, setDivisibility] = useState(0);
  const [supplyText, setSupplyText] = useState('');
  const [supplyMutable, setSupplyMutable] = useState(false);
  const [transferable, setTransferable] = useState(true);
  const [levyMode, setLevyMode] = useState<LevyMode>('none');
  const [levyFeeType, setLevyFeeType] = useState<'absolute' | 'percentile'>('absolute');
  const [levyRecipient, setLevyRecipient] = useState('');
  const [levyMosaic, setLevyMosaic] = useState('nem:xem');
  const [levyFeeText, setLevyFeeText] = useState('');
  const [levyCheck, setLevyCheck] = useState<LevyCheck>({ state: 'idle' });

  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // Read the definition, the supply and what the creator holds; fill the form with what is there now.
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setStep('form');
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const [state, balance] = await Promise.all([
          fetchNemMosaicEditState(wallet.address, mosaicId),
          fetchNemXemBalance(wallet.address).catch(() => null),
        ]);
        if (cancelled) return;
        setWalletKey(wallet.publicKey);
        setXemBalance(balance);
        if (!state) { setLoadState('missing'); return; }
        const base = nemMosaicEditBase(state.definition, state.supply);
        setEdit(state);
        setDescription(base.description);
        setDivisibility(base.divisibility);
        setSupplyText(base.initialSupply.toString());
        setSupplyMutable(base.supplyMutable);
        setTransferable(base.transferable);
        const levy = state.definition.levy;
        setLevyMode(levy ? 'keep' : 'none');
        setLevyFeeType(levy?.feeType ?? 'absolute');
        setLevyRecipient(levy?.recipient ?? wallet.address);
        setLevyMosaic(levy?.mosaicId ?? 'nem:xem');
        setLevyFeeText(levy ? levy.fee.toString() : '');
        setLoadState('ready');
      } catch (e) {
        console.error('Failed to load the mosaic definition', e);
        if (!cancelled) setLoadState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [mosaicId, network, reloadKey]);

  // The mosaic a levy is paid in has to exist: look it up while the levy is being set.
  const levyMosaicId = levyMosaic.trim().toLowerCase();
  const levyMosaicShapeOk = (() => { try { splitNemMosaicId(levyMosaicId); return true; } catch { return false; } })();
  useEffect(() => {
    if (levyMode !== 'set' || !levyMosaicShapeOk) { setLevyCheck({ state: 'idle' }); return; }
    let cancelled = false;
    setLevyCheck({ state: 'loading' });
    const timer = setTimeout(async () => {
      const infos = await fetchNemMosaicInfos([levyMosaicId]);
      if (cancelled) return;
      const info = infos[levyMosaicId];
      setLevyCheck(info ? { state: 'found', info } : { state: 'missing' });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [levyMode, levyMosaicId, levyMosaicShapeOk, network]);

  const def = edit?.definition ?? null;
  const access = edit?.access ?? 'unknown';
  const locked = access === 'description'; // only the description can change
  const base = useMemo(() => (def ? nemMosaicEditBase(def, edit?.supply ?? null) : null), [def, edit]);

  const supplyValid = /^\d+$/.test(supplyText) && BigInt(supplyText) > 0n;
  const supplyTooLarge = supplyValid && BigInt(supplyText) > NEM_MAX_MOSAIC_INITIAL_SUPPLY;
  const supplyError = locked || supplyText === '' ? '' : !supplyValid ? t('nemmosaic.invalid_supply') : supplyTooLarge ? t('nemmosaic.supply_too_large', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) }) : '';
  const descriptionBytes = new TextEncoder().encode(description).length;
  const descriptionValid = descriptionBytes <= NEM_MAX_MOSAIC_DESCRIPTION_BYTES;

  const levyFee = /^\d+$/.test(levyFeeText) ? BigInt(levyFeeText) : 0n;
  const levyValue: NemMosaicLevyParams | null = !def ? null
    : levyMode === 'none' ? null
    : levyMode === 'keep' ? def.levy
    : { feeType: levyFeeType, recipient: normalizeNemAddress(levyRecipient), mosaicId: levyMosaicId, fee: levyFee };
  const levyError = levyMode === 'set' && levyValue ? validateNemLevy(levyValue, netCfg.networkByte) : null;
  const levyMissing = levyMode === 'set' && levyMosaicShapeOk && levyCheck.state === 'missing';
  const levyPending = levyMode === 'set' && (levyCheck.state === 'loading' || (levyMosaicShapeOk && levyCheck.state === 'idle'));

  const values: NemMosaicEditValues | null = def ? {
    description,
    divisibility,
    initialSupply: supplyValid ? BigInt(supplyText) : 0n,
    supplyMutable,
    transferable,
    levy: levyValue,
  } : null;
  const problem = def && base && values ? validateNemMosaicEdit(def, base, values, access, netCfg.networkByte, walletKey) : null;
  const canContinue = def !== null && problem === null && !levyMissing && !levyPending;
  const sent = def && values ? nemMosaicEditSend(def, values, access) : null;
  // Without the whole supply only the description is sent: everything else goes out as the definition has it now, so compare against that.
  const shownBase = def && base ? nemMosaicEditSend(def, base, access) : base;
  const diff = shownBase && sent ? nemMosaicEditDiff(shownBase, sent) : null;

  const total = NEM_MOSAIC_RENTAL + NEM_PROVISION_TX_FEE;
  const balanceShort = xemBalance !== null && xemBalance < total;
  const yes = (v: boolean) => (v ? t('nemmosaic.on') : t('nemmosaic.off'));

  const levyText = (l: NemMosaicLevyParams | null): string => {
    if (!l) return t('nemmosaic.off');
    const pct = (Number(l.fee) / 100).toString();
    return l.feeType === 'percentile'
      ? t('nemmosaic.edit_levy_summary_percentile', { fee: l.fee.toString(), pct, mosaic: l.mosaicId, recipient: l.recipient })
      : t('nemmosaic.edit_levy_summary_absolute', { fee: l.fee.toString(), mosaic: l.mosaicId, recipient: l.recipient });
  };

  const onPassed = async (password: string) => {
    if (!def || !sent) return;
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const { namespace, name } = splitNemMosaicId(def.id);
      const out = await createNemMosaic({
        privateKey,
        publicKey: wallet.publicKey,
        namespace,
        name,
        description: sent.description,
        divisibility: sent.divisibility,
        initialSupply: sent.initialSupply,
        supplyMutable: sent.supplyMutable,
        transferable: sent.transferable,
        ...(sent.levy ? { levy: sent.levy } : {}),
      });
      // 送信後は完了画面に行かず、一覧へ戻ってトーストで知らせる（作成画面と同じ）。
      showTxNotice({ lines: t('nemmosaic.edit_done_message', { returnObjects: true }) as string[], explorerUrl: out.hash ? nemExplorerTxUrl(out.hash) : undefined, explorerLabel: t('nemmosaic.view_explorer') });
      onClose(true);
    } catch (error) {
      setSendError(classifyNemError(error, 'MOSAIC'));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else onClose(false);
  };

  const rootSx: SxProps<Theme> = embedded
    ? { flexGrow: 1, display: 'flex', flexDirection: 'column' }
    : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };

  const errorTitle = sendError ? t(`nemmosaic.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemmosaic.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  if (loadState !== 'ready' || !def || !base || !values) {
    return (
      <Box sx={rootSx}>
        <BackButton onBack={() => onClose(false)} back="/mosaic" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 3, boxSizing: 'border-box', textAlign: 'center' }}>
          {loadState === 'loading' ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 4 }}>
              <CircularProgress size={26} />
              <Typography sx={{ color: 'text.secondary' }}>{t('nemmosaic.edit_loading')}</Typography>
            </Box>
          ) : (
            <>
              <Typography sx={{ color: 'text.secondary', mb: 1.5 }}>{loadState === 'missing' ? t('nemmosaic.edit_missing') : t('nemmosaic.edit_load_failed')}</Typography>
              {loadState === 'failed' && <Button variant="outlined" onClick={() => setReloadKey((k) => k + 1)}>{t('nemmosaic.retry')}</Button>}
            </>
          )}
        </Box>
      </Box>
    );
  }

  if (step === 'confirm' && sent && diff && shownBase) {
    // 変えた項目は「今 → 新」で出す。
    const row = (label: string, before: string, after: string, changed: boolean) => ({ label, value: changed ? `${before} → ${after}` : after });
    const rows = [
      { label: t('nemmosaic.id_label'), value: def.id, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      row(t('nemmosaic.description_label'), shownBase.description || '–', sent.description || '–', diff.description),
      row(t('nemmosaic.edit_supply_label'), groupDigits(shownBase.initialSupply.toString()), groupDigits(sent.initialSupply.toString()), diff.initialSupply),
      row(t('nemmosaic.divisibility_label'), String(shownBase.divisibility), String(sent.divisibility), diff.divisibility),
      row(t('nemmosaic.supply_mutable_label'), yes(shownBase.supplyMutable), yes(sent.supplyMutable), diff.supplyMutable),
      row(t('nemmosaic.transferable_label'), yes(shownBase.transferable), yes(sent.transferable), diff.transferable),
      row(t('nemmosaic.edit_levy_label'), levyText(shownBase.levy), levyText(sent.levy), diff.levy),
      { label: t('nemmosaic.rental_fee'), value: nemXem(NEM_MOSAIC_RENTAL) },
      { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
      { label: t('nemmosaic.total'), value: nemXem(total) },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={onBack} back="/mosaic" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>
        <MessageDialog open={showCaution} title={t('nemmosaic.edit_confirm_title')} texts={t('nemmosaic.edit_confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('nemmosaic.editing') : t('nemmosaic.edit_confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemmosaic.edit_confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  const feeHintDiv = levyCheck.state === 'found' ? levyCheck.info.divisibility : null;
  const supplyNow = edit?.supply ?? null;
  const supplyChanged = supplyNow !== null && def.supplyMutable && supplyNow !== def.initialSupply;
  const shownSupply = locked ? def.initialSupply.toString() : supplyText;
  const checkLabel = (label: string, desc: string) => (
    <Box><Typography sx={{ fontSize: '0.95rem' }}>{label}</Typography><Typography variant="caption" sx={{ color: 'text.secondary' }}>{desc}</Typography></Box>
  );

  return (
    <Box sx={rootSx}>
      <BackButton onBack={onBack} back="/mosaic" />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontWeight: 'bold', fontSize: '1.2rem', wordBreak: 'break-all', mb: 1.5 }}>{def.id}</Typography>

        {def.creator.toLowerCase() !== walletKey.toLowerCase() && <Alert severity="error" sx={{ mb: 2 }}>{t('nemmosaic.edit_not_creator')}</Alert>}
        {access === 'full' && <Alert severity="info" sx={{ mb: 2 }}>{t('nemmosaic.edit_access_full')}</Alert>}
        {access === 'description' && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemmosaic.edit_access_description')}</Alert>}
        {access === 'unknown' && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemmosaic.edit_access_unknown')}</Alert>}
        <Alert severity="info" sx={{ mb: 3 }}>{t('nemmosaic.edit_intro')}</Alert>

        <MosaicColumns
          left={(
            <>
              <FormRow label={t('nemmosaic.full_name')}>
                <ReadOnlyValue value={def.id} mono />
              </FormRow>

              <FormRow label={t('nemmosaic.description_label')} top>
                <TextField
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  error={!descriptionValid}
                  helperText={descriptionValid ? t('nemmosaic.description_hint', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES }) : t('nemmosaic.description_too_long', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES })}
                  multiline
                  minRows={5}
                  fullWidth
                />
                <Typography variant="caption" sx={{ display: 'block', textAlign: 'right', bgcolor: 'action.hover', px: 1, py: 0.25, mt: 0.5, color: descriptionValid ? 'text.secondary' : 'error.main' }}>
                  {t('nemmosaic.description_remaining', { n: NEM_MAX_MOSAIC_DESCRIPTION_BYTES - descriptionBytes })}
                </Typography>
              </FormRow>

              <FormRow label={t('nemmosaic.tx_fee')}>
                <ReadOnlyValue value={xemFixed(NEM_PROVISION_TX_FEE)} unit="XEM" />
              </FormRow>
              <FormRow label={t('nemmosaic.rental_fee')}>
                <ReadOnlyValue value={xemFixed(NEM_MOSAIC_RENTAL)} unit="XEM" />
              </FormRow>
              <FormRow label={t('nemmosaic.total')}>
                <ReadOnlyValue value={xemFixed(total)} unit="XEM" bold />
              </FormRow>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>{t('nemmosaic.edit_cost_hint')}</Typography>
              {balanceShort && <Typography variant="body2" sx={{ color: 'warning.main', fontWeight: 'bold', mb: 1 }}>{t('nemmosaic.xem_short_warning')}</Typography>}
              {problem === 'no_changes' && <Typography variant="body2" sx={{ mt: 1.5, color: 'text.secondary' }}>{t('nemmosaic.edit_no_changes')}</Typography>}
            </>
          )}
          right={(
            <>
              <SectionHead first>{t('nemmosaic.section_props')}</SectionHead>

              <FormRow label={t('nemmosaic.edit_supply_label')}>
                <TextField
                  variant="standard"
                  value={shownSupply}
                  onChange={(e) => setSupplyText(e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''))}
                  error={supplyError !== ''}
                  helperText={supplyError || t('nemmosaic.edit_supply_hint', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) })}
                  disabled={locked}
                  fullWidth
                  slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                />
              </FormRow>
              {supplyChanged && supplyNow !== null && (
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>
                  {t('nemmosaic.edit_supply_changed_note', { now: groupDigits(supplyNow.toString()), initial: groupDigits(def.initialSupply.toString()) })}
                </Typography>
              )}
              <FormRow label={t('nemmosaic.divisibility_label')}>
                <TextField select variant="standard" value={divisibility} onChange={(e) => setDivisibility(Number(e.target.value))} disabled={locked} helperText={t('nemmosaic.divisibility_hint')} fullWidth>
                  {Array.from({ length: NEM_MAX_MOSAIC_DIVISIBILITY + 1 }, (_, i) => <MenuItem key={i} value={i}>{i}</MenuItem>)}
                </TextField>
              </FormRow>
              <FormRow label={t('nemmosaic.total_supply')}>
                <ReadOnlyValue value={supplyWithDecimals(supplyValid && !supplyTooLarge ? supplyText : (locked ? def.initialSupply.toString() : '0'), divisibility)} bold />
              </FormRow>

              <Box sx={{ display: 'flex', flexDirection: 'column', mb: 1 }}>
                <FormControlLabel
                  control={<Checkbox checked={transferable} disabled={locked} onChange={(e) => setTransferable(e.target.checked)} />}
                  label={checkLabel(t('nemmosaic.transferable_label'), t('nemmosaic.transferable_desc'))}
                  sx={{ alignItems: 'flex-start', mb: 1 }}
                />
                <FormControlLabel
                  control={<Checkbox checked={supplyMutable} disabled={locked} onChange={(e) => setSupplyMutable(e.target.checked)} />}
                  label={checkLabel(t('nemmosaic.supply_mutable_label'), t('nemmosaic.supply_mutable_desc'))}
                  sx={{ alignItems: 'flex-start', mb: 1 }}
                />
                {!def.levy && (
                  <FormControlLabel
                    control={<Checkbox checked={levyMode === 'set'} disabled={locked} onChange={(e) => setLevyMode(e.target.checked ? 'set' : 'none')} />}
                    label={checkLabel(t('nemmosaic.levy_required'), t('nemmosaic.edit_levy_desc'))}
                    sx={{ alignItems: 'flex-start' }}
                  />
                )}
              </Box>

              {(def.levy || levyMode === 'set') && <SectionHead>{t('nemmosaic.section_levy')}</SectionHead>}
              {def.levy && (
                <>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all', mb: 1 }}>{t('nemmosaic.edit_levy_current')}: {levyText(def.levy)}</Typography>
                  <RadioGroup value={levyMode} onChange={(e) => setLevyMode(e.target.value as LevyMode)} sx={{ mb: 2 }}>
                    <FormControlLabel value="keep" control={<Radio size="small" disabled={locked} />} label={t('nemmosaic.edit_levy_keep')} />
                    <FormControlLabel value="set" control={<Radio size="small" disabled={locked} />} label={t('nemmosaic.edit_levy_change')} />
                    <FormControlLabel value="none" control={<Radio size="small" disabled={locked} />} label={t('nemmosaic.edit_levy_remove')} />
                  </RadioGroup>
                </>
              )}
              {levyMode === 'set' && !locked && (
                <NemLevyFieldsBox
                  mosaic={levyMosaic}
                  setMosaic={setLevyMosaic}
                  mosaicShapeOk={levyMosaicShapeOk}
                  missing={levyMissing}
                  checking={levyCheck.state === 'loading'}
                  feeHintDiv={feeHintDiv}
                  recipient={levyRecipient}
                  setRecipient={setLevyRecipient}
                  feeType={levyFeeType}
                  setFeeType={setLevyFeeType}
                  feeText={levyFeeText}
                  setFeeText={setLevyFeeText}
                  fee={levyFee}
                  mosaicId={levyMosaicId}
                  error={levyError}
                  sentMosaic={def.id}
                />
              )}
            </>
          )}
        />
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('nemmosaic.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}
