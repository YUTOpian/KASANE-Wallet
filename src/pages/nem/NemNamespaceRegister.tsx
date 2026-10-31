import { useEffect, useState } from 'react';
import { Alert, Box, Button, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { SxProps, Theme } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { withFormReset, type SentProps } from '../../lib/withFormReset';
import { showTxNotice } from '../../store/txNoticeStore';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemOwnedNamespaces, fetchNemXemBalance, nemExplorerTxUrl, registerNemNamespace } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  NEM_MAX_NAMESPACE_DEPTH, NEM_MAX_ROOT_NAMESPACE_LENGTH, NEM_MAX_SUB_NAMESPACE_LENGTH, NEM_PROVISION_TX_FEE,
  isValidNemName, nemNamespaceRentalFee,
} from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { ConfirmRows, CostBox, classifyNemError, nemXem } from './parts';

type Step = 'form' | 'confirm';
type Kind = 'root' | 'child';

interface NemNamespaceRegisterProps {
  /** Shown under the namespace screen's tabs (only this lower part changes) instead of as a screen of its own. */
  embedded?: boolean;
  /** Embedded: the kind is chosen by the tab, so the root / sub switch is not shown. */
  fixedKind?: Kind;
  /** Embedded: back to the owned-namespaces tab. */
  onShowList?: () => void;
}

// NEM ネームスペースの登録: 入力 → 確認（パスワード）→ 送信。ルート（100 XEM）またはサブ（10 XEM）。
function NemNamespaceRegister({ embedded = false, fixedKind, onShowList, onSent }: NemNamespaceRegisterProps & SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [kindState, setKind] = useState<Kind>('root');
  const kind: Kind = fixedKind ?? kindState;
  const [name, setName] = useState('');
  const [parents, setParents] = useState<NemOwnedNamespace[]>([]);
  const [parentName, setParentName] = useState('');
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);

  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // The XEM balance (to warn when it will not cover the cost) and the namespaces the wallet owns
  // (the candidates for a sub-namespace's parent).
  useEffect(() => {
    let cancelled = false;
    setXemBalance(null);
    setParents([]);
    setParentName('');
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const [balance, owned] = await Promise.all([
          fetchNemXemBalance(wallet.address),
          fetchNemOwnedNamespaces(wallet.address).catch(() => [] as NemOwnedNamespace[]),
        ]);
        if (cancelled) return;
        setXemBalance(balance);
        const usable = owned.filter((n) => n.depth < NEM_MAX_NAMESPACE_DEPTH && !n.expired);
        setParents(usable);
        setParentName(usable[0]?.name ?? '');
      } catch { /* the warning and the parent list are optional */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const maxLength = kind === 'root' ? NEM_MAX_ROOT_NAMESPACE_LENGTH : NEM_MAX_SUB_NAMESPACE_LENGTH;
  const nameValid = isValidNemName(name, maxLength);
  const nameError = name === '' || nameValid ? '' : t('nemns.invalid_name');
  const parentOk = kind === 'root' || parents.some((p) => p.name === parentName);
  const canContinue = nameValid && parentOk;
  const fullName = kind === 'child' && parentName ? `${parentName}.${name}` : name;

  const rental = nemNamespaceRentalFee(kind === 'root');
  const total = rental + NEM_PROVISION_TX_FEE;
  const balanceShort = xemBalance !== null && xemBalance < total;

  const onPassed = async (password: string) => {
    setRegistering(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await registerNemNamespace({
        privateKey,
        publicKey: wallet.publicKey,
        name,
        parentName: kind === 'child' ? parentName : undefined,
      });
      showTxNotice({ lines: t('nemns.done_message', { returnObjects: true }) as string[], explorerUrl: sent.hash ? nemExplorerTxUrl(sent.hash) : undefined, explorerLabel: t('nemns.view_explorer') });
      onSent();
    } catch (error) {
      setSendError(classifyNemError(error, 'NAMESPACE'));
    } finally {
      setRegistering(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else if (embedded) onShowList?.();
    else navigate('/namespace');
  };

  // A screen fills the window; the embedded form grows to fill what is left under the tabs.
  const rootSx: SxProps<Theme> = embedded
    ? { flexGrow: 1, display: 'flex', flexDirection: 'column' }
    : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };

  const errorTitle = sendError ? t(`nemns.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemns.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  if (step === 'confirm') {
    const rows = [
      { label: t('nemns.full_name'), value: fullName, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      { label: t('nemns.type_label'), value: kind === 'root' ? t('nemns.type_root') : t('nemns.type_child') },
      { label: t('nemns.rental_fee'), value: nemXem(rental) },
      { label: t('nemns.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
      { label: t('nemns.total'), value: nemXem(total) },
    ];
    return (
      <Box sx={rootSx}>
        <BackButton onBack={onBack} back="/namespace/register" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>
        <MessageDialog open={showCaution} title={t('nemns.confirm_title')} texts={t('nemns.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{registering ? t('nemns.registering') : t('nemns.confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={registering} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemns.confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  return (
    <Box sx={rootSx}>
      {!embedded && <BackButton onBack={onBack} back="/namespace" />}
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemns.caution_taken')}</Alert>

        {fixedKind === undefined && (
          <>
          <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemns.type_label')}</Typography>
          <ToggleButtonGroup exclusive fullWidth color="primary" value={kind} onChange={(_, v: Kind | null) => { if (v) { setKind(v); setName((n) => n.slice(0, v === 'root' ? NEM_MAX_ROOT_NAMESPACE_LENGTH : NEM_MAX_SUB_NAMESPACE_LENGTH)); } }} sx={{ mb: 2 }}>
            <ToggleButton value="root">{t('nemns.type_root')}</ToggleButton>
            <ToggleButton value="child">{t('nemns.type_child')}</ToggleButton>
          </ToggleButtonGroup>
          </>
        )}

        {kind === 'child' && (parents.length === 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>{t('nemns.no_parent')}</Alert>
        ) : (
          <TextField select label={t('nemns.parent_label')} value={parentName} onChange={(e) => setParentName(e.target.value)} fullWidth sx={{ mb: 2 }}>
            {parents.map((p) => <MenuItem key={p.name} value={p.name}>{p.name}</MenuItem>)}
          </TextField>
        ))}

        <TextField
          label={t('nemns.name_label')}
          placeholder={t('nemns.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, maxLength))}
          error={nameError !== ''}
          helperText={nameError || t('nemns.name_hint', { max: maxLength })}
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          sx={{ mb: 2 }}
        />
        {name !== '' && nameValid && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all' }}>{t('nemns.full_name')}: <b>{fullName}</b></Typography>
        )}

        <CostBox
          title={t('nemns.cost_title')}
          rows={[
            { label: t('nemns.rental_fee'), value: nemXem(rental) },
            { label: t('nemns.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
            { label: t('nemns.total'), value: nemXem(total), bold: true },
          ]}
          hint={t('nemns.cost_hint')}
          warning={balanceShort ? t('nemns.xem_short_warning') : undefined}
        />
      </Box>
      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue} onClick={() => { setStep('confirm'); setShowCaution(true); }} sx={{ py: 1.5 }}>
          {t('nemns.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}

export default withFormReset<NemNamespaceRegisterProps>(NemNamespaceRegister);
