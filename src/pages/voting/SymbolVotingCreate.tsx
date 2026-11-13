import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Switch, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SssError, sssErrorKey } from '../../lib/sss';
import { WalletsHelper } from '../../lib/storage';
import { explorerTxUrl } from '../../lib/symbol/api';
import type { MosaicInfo } from '../../lib/symbol/api';
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  POLL_MAX_OPTION_LENGTH, POLL_MAX_OPTIONS, POLL_MAX_TITLE_LENGTH, POLL_MIN_OPTIONS, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_POI, POLL_TYPE_SIMPLE, POLL_TYPE_WHITELIST,
  buildPollMessages, pollUsesMosaic, validateNewPoll,
} from '../../lib/symbol/voting';
import type { NewPollInput } from '../../lib/symbol/voting';
import {
  createSymbolPoll, fetchPollFeeMultiplier, fetchXymBalance, pollAddressInUse, resolveMosaicInput, symbolAddressing, symbolPollFee,
} from '../../lib/symbol/votingApi';
import { useAppStore } from '../../store/appStore';
import { ConfirmRows, CostBox, classifyNemError } from '../nem/parts';
import { xymText } from '../multisig/parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import HolderRulePicker from './HolderRulePicker';
import { OptionsEditor, VotingFormFrame, VotingSection } from './VotingFormParts';
import { holderRuleBadgeKey, mosaicInputErrorKey, pollMosaicLabelKey, pollTypeHintKey, pollTypeLabelKey, votingErrorKey } from './votingText';

type Step = 'form' | 'confirm';

const pad = (n: number) => String(n).padStart(2, '0');
// <input type="datetime-local"> wants local time as YYYY-MM-DDTHH:mm.
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const defaultEnd = () => {
  const d = new Date(Date.now() + 7 * 86400_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d.getTime());
};

// Symbol 「投票を作る」: 投票をチェーンに書く。NEM の投票（pages/nem/NemVotingCreate.tsx）と同じ画面と同じメッセージの形。
// NEM は複数の 0 XEM 送金を 1 つずつ送るが、Symbol は 1 つのアグリゲートにまとめて送る（全部入るか、全部入らないか）。
// 文言は、Symbol 固有のものだけ symbolvoting.*、ほかは nemvoting.* を使う。
function SymbolVotingCreate({ onSent }: SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig();
  const ad = useMemo(() => symbolAddressing(), [network]);

  const [step, setStep] = useState<Step>('form');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [endLocal, setEndLocal] = useState(defaultEnd);
  const [type, setType] = useState<number>(POLL_TYPE_POI);
  const [multiple, setMultiple] = useState(false);
  const [whitelistText, setWhitelistText] = useState('');
  const [mosaicText, setMosaicText] = useState('');
  const [nonTransferableOnly, setNonTransferableOnly] = useState(true); // モザイク保有者の投票: 既定は、移転できないモザイクのみ（安全な側）
  const [mosaicInfo, setMosaicInfo] = useState<MosaicInfo | null>(null); // 入力が、確認できたモザイクになったとき
  const [mosaicChecking, setMosaicChecking] = useState(false);
  const [mosaicError, setMosaicError] = useState<string | null>(null);

  const [publicKey, setPublicKey] = useState('');
  const [address, setAddress] = useState('');
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setXymBalance(null);
    setMultiplier(null);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        setPublicKey(wallet.publicKey);
        setAddress(wallet.address);
        fetchXymBalance(wallet.address).then((b) => { if (!cancelled) setXymBalance(b); }).catch(() => { /* the balance warning is optional */ });
        fetchPollFeeMultiplier().then((m) => { if (!cancelled) setMultiplier(m); }).catch(() => { /* the fee shows as unknown */ });
      } catch { /* the wallet could not be read */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // モザイクの入力は、止まってから確認する（モザイク ID、または、モザイクに紐付いたネームスペース名）。
  useEffect(() => {
    setMosaicInfo(null);
    setMosaicError(null);
    if (!pollUsesMosaic(type) || mosaicText.trim() === '') {
      setMosaicChecking(false);
      return undefined;
    }
    let cancelled = false;
    setMosaicChecking(true);
    const timer = setTimeout(() => {
      resolveMosaicInput(mosaicText)
        .then((info) => { if (!cancelled) setMosaicInfo(info); })
        .catch((e: unknown) => { if (!cancelled) setMosaicError(e instanceof Error ? e.message : 'failed'); })
        .finally(() => { if (!cancelled) setMosaicChecking(false); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [type, mosaicText, network]);

  const whitelist = useMemo(
    () => (type === POLL_TYPE_WHITELIST ? [...new Set(whitelistText.split(/[\s,;]+/).filter((s) => s !== '').map(normalizeAddress))] : []),
    [type, whitelistText],
  );
  const doe = new Date(endLocal).getTime();
  const input: NewPollInput = { title, description, options, doe: Number.isNaN(doe) ? 0 : doe, type, multiple, whitelist, mosaicId: pollUsesMosaic(type) ? mosaicInfo?.id ?? '' : undefined, ...(type === POLL_TYPE_MOSAIC_HOLDER ? { nonTransferableOnly, mosaicTransferable: mosaicInfo?.transferable } : {}) };
  const issues = validateNewPoll(input, ad);
  const cleanOptions = options.map((o) => o.trim());
  const filledOptions = cleanOptions.filter((o) => o !== '');
  const invalidWhitelist = whitelist.filter((a) => !isValidAddress(a, ad.networkByte)).length;
  const canContinue = issues.length === 0;

  const { messages } = useMemo(
    () => buildPollMessages(input, publicKey || '0'.repeat(64), ad),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, description, options, doe, type, multiple, whitelist, mosaicInfo, nonTransferableOnly, publicKey, ad],
  );
  // 手数料は、実際に送るアグリゲートの大きさから決まる（内容が正しいときだけ計算できる）。
  const totalFee = useMemo(() => {
    if (!canContinue || publicKey === '' || address === '' || multiplier === null) return null;
    try {
      return symbolPollFee(messages, publicKey, address, multiplier);
    } catch {
      return null;
    }
  }, [canContinue, messages, publicKey, address, multiplier]);
  const balanceShort = xymBalance !== null && totalFee !== null && xymBalance < totalFee;
  const feeText = totalFee === null ? '-' : xymText(totalFee);

  const setOption = (i: number, value: string) => setOptions((cur) => cur.map((o, j) => (j === i ? value.slice(0, POLL_MAX_OPTION_LENGTH + 1) : o)));

  const onPassed = async (password: string) => {
    setSending(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const built = buildPollMessages(input, wallet.publicKey, ad);
      if (await pollAddressInUse(built.pollAddress)) {
        setSendError({ kind: 'duplicate', detail: '' });
        return;
      }
      const { hash } = await createSymbolPoll({ privateKey, keyless: wallet.sss ? { kind: 'sss' } : undefined, publicKey: wallet.publicKey, address: wallet.address, input });
      showTxNotice({ lines: t('nemvoting.create_done_message', { returnObjects: true }) as string[], explorerUrl: explorerTxUrl(hash), explorerLabel: t('nemvoting.view_explorer') });
      onSent();
    } catch (error) {
      if (error instanceof SssError) {
        setErrorMessage(t(sssErrorKey(error)));
        return;
      }
      setSendError(classifyNemError(error, 'NONE'));
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate('/voting');
  };

  const errorTitle = sendError ? t(votingErrorKey(sendError.kind, 'title')) : '';
  const errorTexts = sendError ? (t(votingErrorKey(sendError.kind, 'message'), { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  if (step === 'confirm') {
    const rows = [
      { label: t('nemvoting.title_label'), value: title.trim(), big: true },
      { label: t('send.network'), value: `Symbol ${netCfg.label}` },
      { label: t('nemvoting.options_label'), value: filledOptions.join('\n') },
      { label: t('nemvoting.end_label'), value: new Date(doe).toLocaleString() },
      { label: t('nemvoting.type_label'), value: t(pollTypeLabelKey(type)) },
      { label: t('nemvoting.choice_label'), value: multiple ? t('nemvoting.multiple_badge') : t('nemvoting.single_badge') },
      ...(type === POLL_TYPE_WHITELIST ? [{ label: t('nemvoting.whitelist_count_label'), value: String(whitelist.length) }] : []),
      ...(pollUsesMosaic(type) && mosaicInfo ? [{ label: t(pollMosaicLabelKey(type, 'summary')), value: `${mosaicInfo.symbol}\n${mosaicInfo.id}` }] : []),
      ...(type === POLL_TYPE_MOSAIC_HOLDER ? [{ label: t('symbolvoting.holder_rule_summary_label'), value: t(holderRuleBadgeKey(nonTransferableOnly)) }] : []),
      { label: t('symbolvoting.messages_label'), value: String(messages.length) },
      { label: t('nemvoting.total_fee'), value: feeText },
    ];
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back="/voting/create" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>
        <MessageDialog open={showCaution} title={t('nemvoting.create_confirm_title')} texts={t('nemvoting.create_confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{sending ? t('symbolvoting.creating') : t('nemvoting.create_confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={sending} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemvoting.create_confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  const optionDuplicate = issues.includes('option_duplicate');
  return (
    <VotingFormFrame
      title={t('nemvoting.create_button')}
      intro={t('symbolvoting.create_intro')}
      onBack={onBack}
      back="/voting"
      left={(
        <>
          <VotingSection title={t('nemvoting.section_content')}>
            <TextField
              label={t('nemvoting.title_label')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={issues.includes('title_long')}
              helperText={issues.includes('title_long') ? t('nemvoting.issue_title_long', { max: POLL_MAX_TITLE_LENGTH }) : t('nemvoting.title_hint', { max: POLL_MAX_TITLE_LENGTH })}
              fullWidth
              sx={{ mb: 2.5 }}
            />
            <TextField label={t('nemvoting.description_label')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={4} fullWidth />
          </VotingSection>

          <VotingSection title={t('nemvoting.options_label')}>
            <OptionsEditor
              options={options}
              min={POLL_MIN_OPTIONS}
              max={POLL_MAX_OPTIONS}
              maxLength={POLL_MAX_OPTION_LENGTH}
              duplicate={optionDuplicate}
              onChange={setOption}
              onRemove={(i) => setOptions((cur) => cur.filter((_, j) => j !== i))}
              onAdd={() => setOptions((cur) => [...cur, ''])}
            />
          </VotingSection>
        </>
      )}
      right={(
        <>
          <VotingSection title={t('nemvoting.section_rules')}>
            <TextField
              label={t('nemvoting.end_label')}
              type="datetime-local"
              value={endLocal}
              onChange={(e) => setEndLocal(e.target.value)}
              error={issues.includes('end_past')}
              helperText={issues.includes('end_past') ? t('nemvoting.issue_end_past') : t('nemvoting.end_hint')}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ mb: 3 }}
            />

            <Typography sx={{ fontWeight: 'bold', mb: 0.75 }}>{t('nemvoting.type_label')}</Typography>
            <TextField select fullWidth size="small" value={type} onChange={(e) => setType(Number(e.target.value))} sx={{ mb: 0.5 }}>
              <MenuItem value={POLL_TYPE_POI}>{t('nemvoting.type_poi_short')}</MenuItem>
              <MenuItem value={POLL_TYPE_WHITELIST}>{t('nemvoting.type_whitelist_short')}</MenuItem>
              <MenuItem value={POLL_TYPE_SIMPLE}>{t('nemvoting.type_simple_short')}</MenuItem>
              <MenuItem value={POLL_TYPE_MOSAIC}>{t('symbolvoting.type_mosaic_short')}</MenuItem>
              <MenuItem value={POLL_TYPE_MOSAIC_HOLDER}>{t('symbolvoting.type_holder_short')}</MenuItem>
            </TextField>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>
              {t(pollTypeHintKey(type))}
            </Typography>

            {type === POLL_TYPE_MOSAIC_HOLDER && (
              <HolderRulePicker
                nonTransferableOnly={nonTransferableOnly}
                onChange={setNonTransferableOnly}
                conflict={issues.includes('mosaic_transferable')}
              />
            )}

            {pollUsesMosaic(type) && (
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                  <TextField
                    label={t(pollMosaicLabelKey(type, 'field'))}
                    placeholder={t('symbolvoting.mosaic_placeholder')}
                    value={mosaicText}
                    onChange={(e) => setMosaicText(e.target.value)}
                    error={mosaicError !== null || (issues.includes('mosaic_invalid') && mosaicText.trim() !== '' && !mosaicChecking)}
                    helperText={mosaicChecking
                      ? t('symbolvoting.mosaic_checking')
                      : mosaicError !== null
                        ? t(mosaicInputErrorKey(mosaicError))
                        : mosaicInfo
                          ? t('symbolvoting.mosaic_ok', { name: mosaicInfo.symbol, id: mosaicInfo.id, divisibility: mosaicInfo.divisibility }) + (type === POLL_TYPE_MOSAIC_HOLDER ? ` / ${t(mosaicInfo.transferable ? 'symbolvoting.holder_mosaic_transferable' : 'symbolvoting.holder_mosaic_nontransferable')}` : '')
                          : t('symbolvoting.mosaic_hint')}
                    fullWidth
                  />
                  {!(type === POLL_TYPE_MOSAIC_HOLDER && nonTransferableOnly) && (
                    <Button variant="outlined" sx={{ mt: 1, whiteSpace: 'nowrap' }} onClick={() => setMosaicText('symbol.xym')}>{t('symbolvoting.mosaic_use_xym')}</Button>
                  )}
                </Box>
              </Box>
            )}

            {type === POLL_TYPE_SIMPLE && <Alert severity="info" sx={{ mb: 2 }}>{t('symbolvoting.simple_note')}</Alert>}

            {type === POLL_TYPE_WHITELIST && (
              <TextField
                label={t('nemvoting.whitelist_label')}
                placeholder={t('nemvoting.whitelist_placeholder')}
                value={whitelistText}
                onChange={(e) => setWhitelistText(e.target.value)}
                multiline
                minRows={4}
                fullWidth
                error={invalidWhitelist > 0}
                helperText={invalidWhitelist > 0 ? t('nemvoting.issue_whitelist_invalid', { count: invalidWhitelist }) : t('nemvoting.whitelist_hint', { count: whitelist.length })}
                slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
                sx={{ mb: 2 }}
              />
            )}

            <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, mt: 1 }}>
              <FormControlLabel control={<Switch checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />} label={t('nemvoting.multiple_label')} sx={{ display: 'block' }} />
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('nemvoting.multiple_hint')}</Typography>
            </Box>
          </VotingSection>

          {issues.includes('message_too_large') && <Alert severity="warning" sx={{ mt: 2.5 }}>{t('nemvoting.issue_too_large')}</Alert>}

          <Box sx={{ mt: -0.5 }}>
            <CostBox
              title={t('nemvoting.cost_title')}
              rows={[
                { label: t('symbolvoting.messages_label'), value: String(messages.length) },
                { label: t('nemvoting.total_fee'), value: feeText, bold: true },
              ]}
              hint={t('symbolvoting.cost_hint')}
              warning={balanceShort ? t('symbolvoting.xym_short_warning') : undefined}
            />
          </Box>
        </>
      )}
      action={(
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('nemvoting.go_confirm')}
        </Button>
      )}
    />
  );
}

export default withFormReset<object>(SymbolVotingCreate);
