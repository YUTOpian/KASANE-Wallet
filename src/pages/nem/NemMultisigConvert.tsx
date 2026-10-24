import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, Typography } from '@mui/material';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import MessageDialog from '../../components/MessageDialog';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemXemBalance } from '../../lib/nem/api';
import { fetchNemMultisigInfo, resolveNemCosigner, sendNemMultisigConversion, sendNemMultisigWrapped } from '../../lib/nem/multisigApi';
import type { NemCosigner, NemMultisigInfo } from '../../lib/nem/multisigApi';
import { normalizeNemAddress } from '../../lib/nem/crypto';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { NEM_MAX_MULTISIG_COSIGNERS, NEM_MULTISIG_MODIFICATION_FEE, NEM_MULTISIG_WRAPPER_FEE } from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { NemConfirmScreen, nemAddressPrefix } from './multisigParts';
import type { NemConfirmRow } from './multisigParts';
import { nemXem } from './parts';
import { Field, FormRow, SectionCard, ValueBox, mono } from '../multisig/parts';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { nemExplorerTxUrl } from '../../lib/nem/api';

type Step = 'form' | 'confirm';

// NEM 「マルチシグ化 / 設定変更」: make this wallet's account multisig (a plain transaction signed
// by the account), or change an existing multisig account (a multisig transaction started by one
// of its cosigners; the other cosigners then sign it).
function NemMultisigConvert({ onSent }: SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);
  const editAddress = params.get('account') ? normalizeNemAddress(params.get('account')!) : null;
  const editing = editAddress !== null;

  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState('');
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [info, setInfo] = useState<NemMultisigInfo | null>(null);
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);
  const [blocked, setBlocked] = useState('');

  const [rows, setRows] = useState<string[]>(['']);
  const [removed, setRemoved] = useState<string[]>([]); // addresses
  const [approvalInput, setApprovalInput] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<NemCosigner[]>([]);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet || cancelled) return;
        const account = editAddress ?? normalizeNemAddress(wallet.address);
        setTarget(account);
        const [i, balance] = await Promise.all([fetchNemMultisigInfo(account), fetchNemXemBalance(wallet.address).catch(() => null)]);
        if (cancelled) return;
        setInfo(i);
        setTargetKey(editing ? i.publicKey : wallet.publicKey.toUpperCase());
        setXemBalance(balance);
        if (editing) {
          if (!i.cosignatories.some((c) => c.address === normalizeNemAddress(wallet.address))) setBlocked('err_not_cosigner');
          else if (!i.publicKey) setBlocked('err_no_public_key');
          setApprovalInput(i.minCosignatories === 0 ? i.cosignatories.length : i.minCosignatories);
        } else if (i.isMultisig) {
          setBlocked('is_multisig_note');
        } else {
          setShowWarning(true);
        }
      } catch (e) {
        console.error('Failed to load multisig info', e);
        setBlocked('load_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editAddress, editing, network]);

  // --- validation -----------------------------------------------------------------------
  const existing = info?.cosignatories ?? [];
  const remaining = existing.filter((c) => !removed.includes(c.address));
  const filled = rows.filter((r) => r.trim() !== '');
  const total = remaining.length + filled.length;
  const tooMany = total > NEM_MAX_MULTISIG_COSIGNERS;
  const maxMin = Math.max(total, 1);
  const approval = Math.min(Math.max(approvalInput ?? maxMin, 1), maxMin);
  // NIS1 lets one cosigner be removed per transaction, and not together with additions.
  const removalProblem = removed.length > 1 || (removed.length > 0 && filled.length > 0);
  const currentMin = info ? (info.minCosignatories === 0 ? info.cosignatories.length : info.minCosignatories) : 0;
  const changed = filled.length > 0 || removed.length > 0 || (editing && approval !== currentMin);
  const canContinue = !blocked && !loading && !resolving && !tooMany && !removalProblem && total >= 1 && (editing ? changed : filled.length >= 1) && (!editing || targetKey !== null);

  // Looks up every typed cosigner (address -> public key) before the confirm step.
  const onGoConfirm = async () => {
    setResolving(true);
    try {
      const errors: string[] = rows.map(() => '');
      const out: NemCosigner[] = [];
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].trim() === '') continue;
        const r = await resolveNemCosigner(rows[i], netCfg.networkByte);
        if (r === 'invalid') errors[i] = 'err_address_invalid';
        else if (r === 'no_public_key') errors[i] = 'err_cosigner_no_key';
        else if (r.address === target) errors[i] = 'err_address_self';
        else if (out.some((o) => o.address === r.address) || remaining.some((c) => c.address === r.address)) errors[i] = 'err_address_duplicate';
        else out.push(r);
      }
      setRowErrors(errors);
      if (errors.some((e) => e !== '')) return;
      setResolved(out);
      setStep('confirm');
    } finally {
      setResolving(false);
    }
  };

  const onSend = async (password: string) => {
    const wallet = await WalletsHelper.getActive();
    if (!wallet || targetKey === null) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    let doneHash = '';
    const removedKeys = existing.filter((c) => removed.includes(c.address)).map((c) => c.publicKey);
    if (!editing) {
      // The account starts with "everyone must sign" (0); the delta is the number chosen.
      const sent = await sendNemMultisigConversion(privateKey, wallet.publicKey, {
        minCosignatoriesDelta: approval,
        additions: resolved.map((c) => c.publicKey),
        deletions: [],
      });
      doneHash = sent.hash;
    } else {
      const sent = await sendNemMultisigWrapped(privateKey, wallet.publicKey, targetKey, {
        kind: 'modification',
        change: { minCosignatoriesDelta: approval - (info?.minCosignatories ?? 0), additions: resolved.map((c) => c.publicKey), deletions: removedKeys },
      });
      doneHash = sent.hash;
    }
    showTxNotice({ lines: t(editing ? 'nemmultisig.done_edit' : 'nemmultisig.done_convert', { returnObjects: true }) as string[], explorerUrl: doneHash ? nemExplorerTxUrl(doneHash) : undefined, explorerLabel: t('multisig.view_explorer') });
    onSent();
  };

  const fee = editing ? NEM_MULTISIG_WRAPPER_FEE + NEM_MULTISIG_MODIFICATION_FEE : NEM_MULTISIG_MODIFICATION_FEE;
  const balanceShort = xemBalance !== null && xemBalance < fee;

  if (step === 'confirm') {
    const list = (title: string, items: string[]): NemConfirmRow[] => (items.length ? [{ label: title, value: items.join('\n') }] : []);
    const confirmRows: NemConfirmRow[] = [
      { label: t('multisig.account_label'), value: target, big: true },
      { label: t('multisig.network_label'), value: `NEM ${netCfg.label}` },
      ...list(t('multisig.item_add'), resolved.map((c) => c.address)),
      ...list(t('multisig.item_remove'), removed),
      { label: t('multisig.min_approval_label'), value: editing ? `${currentMin} → ${approval}` : `${approval}` },
      { label: t('multisig.total_after', { count: total }), value: [...remaining.map((c) => c.address), ...resolved.map((c) => c.address)].join('\n') },
      { label: t('nemmultisig.fee_row'), value: nemXem(fee) },
    ];
    return <NemConfirmScreen rows={confirmRows} onBack={() => setStep('form')} onPassword={onSend} />;
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={24} /></Box>}
        {blocked && <Alert severity="warning" sx={{ mb: 2 }}>{t(`multisig.${blocked}`)}</Alert>}
        <Alert severity={editing ? 'info' : 'warning'} sx={{ mb: 2 }}>
          {editing ? t('nemmultisig.edit_note') : (t('nemmultisig.convert_warning', { returnObjects: true }) as string[]).map((l, i) => <span key={i}>{l}<br /></span>)}
        </Alert>

        <SectionCard title={t('multisig.manage_title')}>
          <FormRow label={t('multisig.op_type_label')}>
            <Typography>{editing ? t('multisig.op_edit') : t('multisig.op_convert')}</Typography>
          </FormRow>
          <FormRow label={editing ? t('multisig.account_label') : t('multisig.convert_account_label')}>
            <ValueBox>{target}</ValueBox>
          </FormRow>

          <FormRow label={t('multisig.cosigners_label')} top>
            {editing && existing.length > 0 && (
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>{t('multisig.current_cosigners')}</Typography>
                {existing.map((c) => {
                  const gone = removed.includes(c.address);
                  return (
                    <Box key={c.address} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
                      <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0, textDecoration: gone ? 'line-through' : 'none', color: gone ? 'text.disabled' : 'text.primary', ...mono }}>
                        {c.address}
                      </Typography>
                      {gone && <Chip size="small" color="error" label={t('multisig.will_remove')} />}
                      <IconButton
                        size="small"
                        aria-label={gone ? t('multisig.undo_remove') : t('multisig.remove_row')}
                        onClick={() => setRemoved((r) => (gone ? r.filter((x) => x !== c.address) : [...r, c.address]))}
                      >
                        {gone ? <UndoIcon fontSize="small" /> : <DeleteOutlinedIcon fontSize="small" />}
                      </IconButton>
                    </Box>
                  );
                })}
                {removalProblem && <Alert severity="error" sx={{ mt: 1 }}>{t('nemmultisig.err_removal_rule')}</Alert>}
              </Box>
            )}

            {remaining.length === 0 && rows.length === 0 && !loading && (
              <Typography variant="body2" sx={{ textAlign: 'center', color: 'text.secondary', py: 1.5 }}>{t('multisig.no_cosigners')}</Typography>
            )}

            {rows.map((text, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'flex-start' }}>
                <Field
                  ariaLabel={t('multisig.cosigner_n', { n: i + 1 })}
                  placeholder={t('multisig.cosigner_n', { n: i + 1 })}
                  value={text}
                  onChange={(e) => { setRows((r) => r.map((x, j) => (j === i ? e.target.value : x))); setRowErrors([]); }}
                  error={!!rowErrors[i]}
                  helperText={rowErrors[i] ? t(`nemmultisig.${rowErrors[i]}`) : t('nemmultisig.cosigner_hint', { prefix: nemAddressPrefix() })}
                  htmlInput={{ autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false }}
                />
                <IconButton aria-label={t('multisig.remove_row')} onClick={() => { setRows((r) => r.filter((_, j) => j !== i)); setRowErrors([]); }}>
                  <DeleteOutlinedIcon />
                </IconButton>
              </Box>
            ))}

            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.5 }}>
              <Button startIcon={<AddCircleIcon />} onClick={() => setRows((r) => [...r, ''])} disabled={total >= NEM_MAX_MULTISIG_COSIGNERS}>
                {t('multisig.add_cosigner')}
              </Button>
            </Box>
            {tooMany && <Alert severity="error" sx={{ mt: 1.5 }}>{t('multisig.err_too_many', { max: NEM_MAX_MULTISIG_COSIGNERS })}</Alert>}
            <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.secondary', mt: 0.5 }}>{t('multisig.total_after', { count: total })}</Typography>
          </FormRow>

          <FormRow label={t('multisig.f_min_approval')} hint={t('multisig.hint_min_approval')}>
            <Field select ariaLabel={t('multisig.f_min_approval')} value={approval} onChange={(e) => setApprovalInput(Number(e.target.value))}>
              {Array.from({ length: maxMin }, (_, k) => k + 1).map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
            </Field>
          </FormRow>
          {editing && !changed && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('multisig.err_no_change')}</Typography>}

          <FormRow label={t('multisig.f_fee')}>
            <Typography>{nemXem(fee)}</Typography>
          </FormRow>
        </SectionCard>

        <Box sx={{ mt: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('multisig.cost_title')}</Typography>
          <Typography variant="body2">{t('nemmultisig.fee_row')}: {nemXem(fee)}</Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('nemmultisig.xem_short_warning')}</Alert>}
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={onGoConfirm} sx={{ py: 1.5 }}>
          {resolving ? t('nemmultisig.checking') : t('multisig.go_confirm')}
        </Button>
      </Box>
      <MessageDialog open={showWarning} title={t('multisig.convert_title')} texts={t('nemmultisig.convert_warning', { returnObjects: true }) as string[]} onClose={() => setShowWarning(false)} />
    </Box>
  );
}

export default withFormReset<object>(NemMultisigConvert);
