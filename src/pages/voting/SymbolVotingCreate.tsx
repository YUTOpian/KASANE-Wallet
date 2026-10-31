import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, IconButton, Switch, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
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
import { isValidAddress, normalizeAddress } from '../../lib/symbol/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  POLL_MAX_OPTION_LENGTH, POLL_MAX_OPTIONS, POLL_MAX_TITLE_LENGTH, POLL_MIN_OPTIONS, POLL_TYPE_POI, POLL_TYPE_WHITELIST,
  buildPollMessages, validateNewPoll,
} from '../../lib/symbol/voting';
import type { NewPollInput } from '../../lib/symbol/voting';
import {
  createSymbolPoll, fetchPollFeeMultiplier, fetchXymBalance, pollAddressInUse, symbolAddressing, symbolPollFee,
} from '../../lib/symbol/votingApi';
import { useAppStore } from '../../store/appStore';
import { ConfirmRows, CostBox, classifyNemError } from '../nem/parts';
import { xymText } from '../multisig/parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { votingErrorKey } from './votingText';

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

  const whitelist = useMemo(
    () => (type === POLL_TYPE_WHITELIST ? [...new Set(whitelistText.split(/[\s,;]+/).filter((s) => s !== '').map(normalizeAddress))] : []),
    [type, whitelistText],
  );
  const doe = new Date(endLocal).getTime();
  const input: NewPollInput = { title, description, options, doe: Number.isNaN(doe) ? 0 : doe, type, multiple, whitelist };
  const issues = validateNewPoll(input, ad);
  const cleanOptions = options.map((o) => o.trim());
  const filledOptions = cleanOptions.filter((o) => o !== '');
  const invalidWhitelist = whitelist.filter((a) => !isValidAddress(a, ad.networkByte)).length;
  const canContinue = issues.length === 0;

  const { messages } = useMemo(
    () => buildPollMessages(input, publicKey || '0'.repeat(64), ad),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, description, options, doe, type, multiple, whitelist, publicKey, ad],
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
      { label: t('nemvoting.type_label'), value: type === POLL_TYPE_WHITELIST ? t('nemvoting.type_whitelist_short') : t('nemvoting.type_poi_short') },
      { label: t('nemvoting.choice_label'), value: multiple ? t('nemvoting.multiple_badge') : t('nemvoting.single_badge') },
      ...(type === POLL_TYPE_WHITELIST ? [{ label: t('nemvoting.whitelist_count_label'), value: String(whitelist.length) }] : []),
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
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} back="/voting" />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left', maxWidth: 800 }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('symbolvoting.create_intro')}</Alert>

        <TextField
          label={t('nemvoting.title_label')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={issues.includes('title_long')}
          helperText={issues.includes('title_long') ? t('nemvoting.issue_title_long', { max: POLL_MAX_TITLE_LENGTH }) : t('nemvoting.title_hint', { max: POLL_MAX_TITLE_LENGTH })}
          fullWidth
          sx={{ mb: 2 }}
        />
        <TextField label={t('nemvoting.description_label')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} fullWidth sx={{ mb: 2 }} />

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemvoting.options_label')}</Typography>
        {options.map((option, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mb: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder={t('nemvoting.option_placeholder', { n: i + 1 })}
              value={option}
              onChange={(e) => setOption(i, e.target.value)}
              error={option.length > POLL_MAX_OPTION_LENGTH || (optionDuplicate && option.trim() !== '' && cleanOptions.filter((o) => o === option.trim()).length > 1)}
              helperText={option.length > POLL_MAX_OPTION_LENGTH ? t('nemvoting.issue_option_long', { max: POLL_MAX_OPTION_LENGTH }) : undefined}
            />
            <IconButton aria-label={t('nemvoting.remove_option')} disabled={options.length <= POLL_MIN_OPTIONS} onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}>
              <DeleteOutlinedIcon />
            </IconButton>
          </Box>
        ))}
        <Button startIcon={<AddIcon />} disabled={options.length >= POLL_MAX_OPTIONS} onClick={() => setOptions((cur) => [...cur, ''])} sx={{ mb: 0.5 }}>{t('nemvoting.add_option')}</Button>
        {optionDuplicate && <Typography variant="caption" sx={{ display: 'block', color: 'error.main' }}>{t('nemvoting.issue_option_duplicate')}</Typography>}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>{t('nemvoting.options_hint', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS })}</Typography>

        <TextField
          label={t('nemvoting.end_label')}
          type="datetime-local"
          value={endLocal}
          onChange={(e) => setEndLocal(e.target.value)}
          error={issues.includes('end_past')}
          helperText={issues.includes('end_past') ? t('nemvoting.issue_end_past') : t('nemvoting.end_hint')}
          fullWidth
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ mb: 2 }}
        />

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemvoting.type_label')}</Typography>
        <ToggleButtonGroup exclusive fullWidth color="primary" value={type} onChange={(_, v: number | null) => { if (v !== null) setType(v); }} sx={{ mb: 0.5 }}>
          <ToggleButton value={POLL_TYPE_POI}>{t('nemvoting.type_poi_short')}</ToggleButton>
          <ToggleButton value={POLL_TYPE_WHITELIST}>{t('nemvoting.type_whitelist_short')}</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1.5 }}>
          {type === POLL_TYPE_WHITELIST ? t('nemvoting.type_whitelist_hint') : t('nemvoting.type_poi_hint')}
        </Typography>

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

        <FormControlLabel control={<Switch checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />} label={t('nemvoting.multiple_label')} sx={{ display: 'block' }} />
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('nemvoting.multiple_hint')}</Typography>

        {issues.includes('message_too_large') && <Alert severity="warning" sx={{ mt: 2 }}>{t('nemvoting.issue_too_large')}</Alert>}

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
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('nemvoting.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}

export default withFormReset<object>(SymbolVotingCreate);
