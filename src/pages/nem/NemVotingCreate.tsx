import { nemNetworkOf } from '../../lib/nem/network';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Switch, Typography } from '@mui/material';
import TextField from '../../components/TextField';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import type { NemMosaicInfo } from '../../lib/nem/api';
import { isValidNemAddress, normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  POLL_INDEX_ADDRESS, POLL_MAX_OPTION_LENGTH, POLL_MAX_OPTIONS, POLL_MAX_TITLE_LENGTH, POLL_MIN_OPTIONS, POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_POI, POLL_TYPE_SIMPLE, POLL_TYPE_WHITELIST,
  PollBroadcastError, buildPollMessages, pollAddressInUse, pollUsesMosaic, resolveNemMosaicInput, sendNemPoll, totalPollFee, validateNewPoll,
} from '../../lib/nem/voting';
import type { NewPollInput } from '../../lib/nem/voting';
import { useAppStore } from '../../store/appStore';
import HolderRulePicker from '../voting/HolderRulePicker';
import { OptionsEditor, VotingFormFrame, VotingSection } from '../voting/VotingFormParts';
import { holderRuleBadgeKey, nemMosaicInputErrorKey, pollMosaicLabelKey, pollTypeHintKey, pollTypeLabelKey } from '../voting/votingText';
import { ConfirmRows, CostBox, classifyNemError, nemXem } from './parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';

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

// NEM 「投票を作る」: writes a poll to the chain in the format of the official NEM Wallet, so it
// appears in its poll list too. The poll is made of several 0-XEM messages, sent one after another.
function NemVotingCreate({ onSent }: SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);
  // DAO のガバナンス投票から開いたときは、種類（3 = 保有量で重み付け / 4 = 保有者だけ）とモザイクを先に入れておく。
  const [params] = useSearchParams();
  const presetType = Number(params.get('type'));
  const presetMosaic = (params.get('mosaic') ?? '').trim().toLowerCase();
  const initialType = presetType === POLL_TYPE_MOSAIC || presetType === POLL_TYPE_MOSAIC_HOLDER ? presetType : POLL_TYPE_POI;
  const initialMosaic = initialType !== POLL_TYPE_POI && /^[a-z0-9_.-]+:[a-z0-9_-]+$/.test(presetMosaic) ? presetMosaic : '';

  const [step, setStep] = useState<Step>('form');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [endLocal, setEndLocal] = useState(defaultEnd);
  const [type, setType] = useState<number>(initialType);
  const [multiple, setMultiple] = useState(false);
  const [whitelistText, setWhitelistText] = useState('');
  const [mosaicText, setMosaicText] = useState(initialMosaic);
  const [nonTransferableOnly, setNonTransferableOnly] = useState(true); // holder poll: the default is the safe side, non-transferable mosaics only
  const [mosaicInfo, setMosaicInfo] = useState<NemMosaicInfo | null>(null); // the input, once it has been confirmed on the chain
  const [mosaicChecking, setMosaicChecking] = useState(false);
  const [mosaicError, setMosaicError] = useState<string | null>(null);

  const [publicKey, setPublicKey] = useState('');
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);
  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string; partial?: { sent: number; total: number } } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setXemBalance(null);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        setPublicKey(wallet.publicKey);
        const balance = await fetchNemXemBalance(wallet.address);
        if (!cancelled) setXemBalance(balance);
      } catch { /* the balance warning is optional */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  // The mosaic is checked once typing has stopped ("namespace:name", or "xem").
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
      resolveNemMosaicInput(mosaicText)
        .then((info) => { if (!cancelled) setMosaicInfo(info); })
        .catch((e: unknown) => { if (!cancelled) setMosaicError(e instanceof Error ? e.message : 'failed'); })
        .finally(() => { if (!cancelled) setMosaicChecking(false); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [type, mosaicText, network]);

  const whitelist = useMemo(
    () => (type === POLL_TYPE_WHITELIST ? [...new Set(whitelistText.split(/[\s,;]+/).filter((s) => s !== '').map(normalizeNemAddress))] : []),
    [type, whitelistText],
  );
  const doe = new Date(endLocal).getTime();
  const input: NewPollInput = { title, description, options, doe: Number.isNaN(doe) ? 0 : doe, type, multiple, whitelist, mosaicId: pollUsesMosaic(type) ? mosaicInfo?.id ?? '' : undefined, ...(type === POLL_TYPE_MOSAIC_HOLDER ? { nonTransferableOnly, mosaicTransferable: mosaicInfo?.transferable } : {}) };
  const issues = validateNewPoll(input, netCfg.networkByte);
  const cleanOptions = options.map((o) => o.trim());
  const filledOptions = cleanOptions.filter((o) => o !== '');
  const invalidWhitelist = whitelist.filter((a) => !isValidNemAddress(a, netCfg.networkByte)).length;

  const { messages } = useMemo(
    () => buildPollMessages(input, publicKey || '0'.repeat(64), netCfg.networkByte, POLL_INDEX_ADDRESS[nemNetworkOf(network)]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, description, options, doe, type, multiple, whitelist, mosaicInfo, nonTransferableOnly, publicKey, network],
  );
  const totalFee = totalPollFee(messages);
  const balanceShort = xemBalance !== null && xemBalance < totalFee;
  const canContinue = issues.length === 0;

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
      const built = buildPollMessages(input, wallet.publicKey, netCfg.networkByte, POLL_INDEX_ADDRESS[nemNetworkOf(network)]);
      if (await pollAddressInUse(built.pollAddress)) {
        setSendError({ kind: 'duplicate', detail: '' });
        return;
      }
      setProgress({ sent: 0, total: built.messages.length });
      const hashes = await sendNemPoll(privateKey, wallet.publicKey, built.messages, (sent, total) => setProgress({ sent, total }));
      const lastHash = hashes[hashes.length - 1] ?? '';
      showTxNotice({ lines: t('nemvoting.create_done_message', { returnObjects: true }) as string[], explorerUrl: lastHash ? nemExplorerTxUrl(lastHash) : undefined, explorerLabel: t('nemvoting.view_explorer') });
      onSent();
    } catch (error) {
      if (error instanceof PollBroadcastError) {
        setSendError({ ...classifyNemError(error.reason, 'NONE'), partial: error.sent > 0 ? { sent: error.sent, total: progress.total } : undefined });
      } else {
        setSendError(classifyNemError(error, 'NONE'));
      }
    } finally {
      setSending(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate('/voting');
  };

  const errorTitle = sendError ? t(`nemvoting.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError
    ? [
      ...(t(`nemvoting.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]),
      ...(sendError.partial ? [t('nemvoting.error_partial', { sent: sendError.partial.sent, total: sendError.partial.total })] : []),
    ]
    : [];

  if (step === 'confirm') {
    const rows = [
      { label: t('nemvoting.title_label'), value: title.trim(), big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      { label: t('nemvoting.options_label'), value: filledOptions.join('\n') },
      { label: t('nemvoting.end_label'), value: new Date(doe).toLocaleString() },
      { label: t('nemvoting.type_label'), value: t(pollTypeLabelKey(type)) },
      { label: t('nemvoting.choice_label'), value: multiple ? t('nemvoting.multiple_badge') : t('nemvoting.single_badge') },
      ...(type === POLL_TYPE_WHITELIST ? [{ label: t('nemvoting.whitelist_count_label'), value: String(whitelist.length) }] : []),
      ...(pollUsesMosaic(type) && mosaicInfo ? [{ label: t(pollMosaicLabelKey(type, 'summary')), value: mosaicInfo.id }] : []),
      ...(type === POLL_TYPE_MOSAIC_HOLDER ? [{ label: t('symbolvoting.holder_rule_summary_label'), value: t(holderRuleBadgeKey(nonTransferableOnly)) }] : []),
      { label: t('nemvoting.tx_count_label'), value: String(messages.length) },
      { label: t('nemvoting.total_fee'), value: nemXem(totalFee) },
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
            <Typography>{sending ? t('nemvoting.creating', { sent: progress.sent, total: progress.total }) : t('nemvoting.create_confirm_ready')}</Typography>
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
      intro={t('nemvoting.create_intro')}
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

            {type === POLL_TYPE_SIMPLE && <Alert severity="warning" sx={{ mb: 2 }}>{t('nemvoting.simple_note')}</Alert>}

            {type === POLL_TYPE_MOSAIC_HOLDER && (
              <HolderRulePicker
                nonTransferableOnly={nonTransferableOnly}
                onChange={setNonTransferableOnly}
                conflict={issues.includes('mosaic_transferable')}
              />
            )}

            {pollUsesMosaic(type) && (
              <Box sx={{ mb: 2 }}>
                <Alert severity="warning" sx={{ mb: 2 }}>{t(type === POLL_TYPE_MOSAIC_HOLDER ? 'nemvoting.holder_note' : 'nemvoting.mosaic_note')}</Alert>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                  <TextField
                    label={t(pollMosaicLabelKey(type, 'field'))}
                    placeholder={t('nemvoting.mosaic_placeholder')}
                    value={mosaicText}
                    onChange={(e) => setMosaicText(e.target.value.toLowerCase().replace(/[^a-z0-9_.:-]/g, ''))}
                    error={mosaicError !== null || (issues.includes('mosaic_invalid') && mosaicText.trim() !== '' && !mosaicChecking)}
                    helperText={mosaicChecking
                      ? t('symbolvoting.mosaic_checking')
                      : mosaicError !== null
                        ? t(nemMosaicInputErrorKey(mosaicError))
                        : mosaicInfo
                          ? t('nemvoting.mosaic_ok', { id: mosaicInfo.id, divisibility: mosaicInfo.divisibility }) + (type === POLL_TYPE_MOSAIC_HOLDER ? ` / ${t(mosaicInfo.transferable ? 'symbolvoting.holder_mosaic_transferable' : 'symbolvoting.holder_mosaic_nontransferable')}` : '')
                          : t('nemvoting.mosaic_hint')}
                    slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
                    fullWidth
                  />
                  {!(type === POLL_TYPE_MOSAIC_HOLDER && nonTransferableOnly) && (
                    <Button variant="outlined" sx={{ mt: 1, whiteSpace: 'nowrap' }} onClick={() => setMosaicText('nem:xem')}>{t('nemvoting.mosaic_use_xem')}</Button>
                  )}
                </Box>
              </Box>
            )}

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
                { label: t('nemvoting.tx_count_label'), value: String(messages.length) },
                { label: t('nemvoting.total_fee'), value: nemXem(totalFee), bold: true },
              ]}
              hint={t('nemvoting.cost_hint')}
              warning={balanceShort ? t('nemvoting.xem_short_warning') : undefined}
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

export default withFormReset<object>(NemVotingCreate);
