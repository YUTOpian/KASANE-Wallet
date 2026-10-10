import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { WalletsHelper } from '../../lib/storage';
import { createNemMosaic, fetchNemOwnedNamespaces, fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  NEM_MAX_MOSAIC_DESCRIPTION_BYTES, NEM_MAX_MOSAIC_DIVISIBILITY, NEM_MAX_MOSAIC_INITIAL_SUPPLY, NEM_MAX_MOSAIC_NAME_LENGTH,
  NEM_MOSAIC_RENTAL, NEM_PROVISION_TX_FEE, isValidNemName,
} from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from '../mosaic/mosaicFlags';
import { ConfirmRows, CostBox, classifyNemError, nemXem } from './parts';

type Step = 'form' | 'confirm' | 'done';

// NEM モザイクの作成: 入力 → 確認（パスワード）→ 送信。自分が持つネームスペースの下に作る（10 XEM）。
export default function NemMosaicCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);

  const [step, setStep] = useState<Step>('form');
  const [namespaces, setNamespaces] = useState<NemOwnedNamespace[]>([]);
  const [namespace, setNamespace] = useState('');
  const [loadingNs, setLoadingNs] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [divisibility, setDivisibility] = useState(0);
  const [supplyText, setSupplyText] = useState('');
  const [supplyMutable, setSupplyMutable] = useState(false);
  const [transferable, setTransferable] = useState(true);
  const [xemBalance, setXemBalance] = useState<bigint | null>(null);

  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);
  const [result, setResult] = useState<{ hash: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setXemBalance(null);
    setNamespaces([]);
    setNamespace('');
    setLoadingNs(true);
    (async () => {
      try {
        const wallet = await WalletsHelper.getActive();
        if (!wallet) return;
        const [balance, owned] = await Promise.all([
          fetchNemXemBalance(wallet.address).catch(() => null),
          fetchNemOwnedNamespaces(wallet.address).catch(() => [] as NemOwnedNamespace[]),
        ]);
        if (cancelled) return;
        setXemBalance(balance);
        const usable = owned.filter((n) => !n.expired);
        setNamespaces(usable);
        setNamespace(usable[0]?.name ?? '');
      } finally {
        if (!cancelled) setLoadingNs(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

  const nameValid = isValidNemName(name, NEM_MAX_MOSAIC_NAME_LENGTH);
  const nameError = name === '' || nameValid ? '' : t('nemmosaic.invalid_name');
  const descriptionBytes = new TextEncoder().encode(description).length;
  const descriptionValid = descriptionBytes <= NEM_MAX_MOSAIC_DESCRIPTION_BYTES;
  const supplyValid = /^\d+$/.test(supplyText) && BigInt(supplyText) > 0n;
  const supplyTooLarge = supplyValid && BigInt(supplyText) > NEM_MAX_MOSAIC_INITIAL_SUPPLY;
  const supplyError = supplyText === '' ? '' : !supplyValid ? t('nemmosaic.invalid_supply') : supplyTooLarge ? t('nemmosaic.supply_too_large', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) }) : '';
  const canContinue = namespace !== '' && nameValid && descriptionValid && supplyValid && !supplyTooLarge;

  const total = NEM_MOSAIC_RENTAL + NEM_PROVISION_TX_FEE;
  const balanceShort = xemBalance !== null && xemBalance < total;
  const id = `${namespace}:${name}`;
  const yes = (v: boolean) => (v ? t('nemmosaic.on') : t('nemmosaic.off'));

  const onPassed = async (password: string) => {
    setCreating(true);
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await createNemMosaic({
        privateKey,
        publicKey: wallet.publicKey,
        namespace,
        name,
        description,
        divisibility,
        initialSupply: BigInt(supplyText),
        supplyMutable,
        transferable,
      });
      setResult({ hash: sent.hash });
      setStep('done');
    } catch (error) {
      setSendError(classifyNemError(error, 'MOSAIC'));
    } finally {
      setCreating(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else navigate('/mosaic');
  };

  const errorTitle = sendError ? t(`nemmosaic.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemmosaic.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  if (step === 'done') {
    return (
      <Box sx={{ minHeight: '100vh' }}>
        <Box sx={{ width: '100%', px: { xs: 3, md: 5 }, py: 4, boxSizing: 'border-box', textAlign: 'center' }}>
          <Typography sx={{ fontSize: 'x-large', color: 'primary.main', mb: 2 }}>
            {(t('nemmosaic.done_message', { returnObjects: true }) as string[]).map((line, i) => (<span key={i}>{line}<br /></span>))}
          </Typography>
          <Typography sx={{ fontWeight: 'bold', wordBreak: 'break-all', mb: 3 }}>{id}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Button variant="contained" color="primary" fullWidth onClick={() => navigate('/mosaic', { replace: true })}>{t('nemmosaic.to_list')}</Button>
            {result && result.hash && (
              <Button href={nemExplorerTxUrl(result.hash)} target="_blank" rel="noopener" variant="contained" fullWidth>
                {t('nemmosaic.view_explorer')}
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'confirm') {
    const rows = [
      { label: t('nemmosaic.id_label'), value: id, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      ...(description ? [{ label: t('nemmosaic.description_label'), value: description }] : []),
      { label: t('nemmosaic.initial_supply'), value: groupDigits(supplyText) },
      { label: t('nemmosaic.divisibility_label'), value: String(divisibility) },
      { label: t('nemmosaic.supply_mutable_label'), value: yes(supplyMutable) },
      { label: t('nemmosaic.transferable_label'), value: yes(transferable) },
      { label: t('nemmosaic.rental_fee'), value: nemXem(NEM_MOSAIC_RENTAL) },
      { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
      { label: t('nemmosaic.total'), value: nemXem(total) },
    ];
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <BackButton onBack={onBack} back="/mosaic/create" />
        <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 3, md: 5 }, py: 3, boxSizing: 'border-box', textAlign: 'left' }}>
          <ConfirmRows rows={rows} />
        </Box>
        <MessageDialog open={showCaution} title={t('nemmosaic.confirm_title')} texts={t('nemmosaic.confirm_dialog_message', { returnObjects: true }) as string[]} onClose={() => setShowCaution(false)} />
        <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <Typography>{creating ? t('nemmosaic.creating') : t('nemmosaic.confirm_ready')}</Typography>
            <Button variant="contained" color="primary" size="large" fullWidth disabled={creating} onClick={() => setShowPasswordDialog(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.5 }}>
              {t('nemmosaic.confirm_password')}
            </Button>
          </Box>
        </Box>
        <PasswordDialog open={showPasswordDialog} mode="check" onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BackButton onBack={onBack} back="/mosaic" />
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemmosaic.caution_immutable')}</Alert>

        {!loadingNs && namespaces.length === 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate('/namespace/register')}>{t('nemmosaic.go_namespace')}</Button>}>
            {t('nemmosaic.no_namespace')}
          </Alert>
        ) : (
          <TextField select label={t('nemmosaic.namespace_label')} value={namespace} onChange={(e) => setNamespace(e.target.value)} helperText={t('nemmosaic.namespace_hint')} fullWidth sx={{ mb: 2 }}>
            {namespaces.map((n) => <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>)}
          </TextField>
        )}

        <TextField
          label={t('nemmosaic.name_label')}
          placeholder={t('nemmosaic.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, NEM_MAX_MOSAIC_NAME_LENGTH))}
          error={nameError !== ''}
          helperText={nameError || t('nemmosaic.name_hint', { max: NEM_MAX_MOSAIC_NAME_LENGTH })}
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
          sx={{ mb: 2 }}
        />
        {namespace !== '' && name !== '' && nameValid && (
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all' }}>{t('nemmosaic.id_label')}: <b>{id}</b></Typography>
        )}

        <TextField
          label={t('nemmosaic.description_label')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={!descriptionValid}
          helperText={descriptionValid ? t('nemmosaic.description_hint', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES }) : t('nemmosaic.description_too_long', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES })}
          multiline
          minRows={2}
          fullWidth
          sx={{ mb: 2 }}
        />

        <TextField
          label={t('nemmosaic.initial_supply')}
          placeholder={t('nemmosaic.initial_supply_placeholder')}
          value={supplyText}
          onChange={(e) => setSupplyText(e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''))}
          error={supplyError !== ''}
          helperText={supplyError || t('nemmosaic.supply_hint', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) })}
          fullWidth
          slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          sx={{ mb: 2 }}
        />

        <TextField select label={t('nemmosaic.divisibility')} value={divisibility} onChange={(e) => setDivisibility(Number(e.target.value))} helperText={t('nemmosaic.divisibility_hint')} fullWidth sx={{ mb: 2 }}>
          {Array.from({ length: NEM_MAX_MOSAIC_DIVISIBILITY + 1 }, (_, i) => <MenuItem key={i} value={i}>{i}</MenuItem>)}
        </TextField>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemmosaic.options_title')}</Typography>
        <FormControlLabel
          control={<Switch checked={supplyMutable} onChange={(e) => setSupplyMutable(e.target.checked)} />}
          label={<Box><Typography>{t('nemmosaic.supply_mutable_label')}</Typography><Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemmosaic.supply_mutable_desc')}</Typography></Box>}
          sx={{ display: 'flex', alignItems: 'flex-start', mb: 1 }}
        />
        <FormControlLabel
          control={<Switch checked={transferable} onChange={(e) => setTransferable(e.target.checked)} />}
          label={<Box><Typography>{t('nemmosaic.transferable_label')}</Typography><Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemmosaic.transferable_desc')}</Typography></Box>}
          sx={{ display: 'flex', alignItems: 'flex-start' }}
        />

        <CostBox
          title={t('nemmosaic.cost_title')}
          rows={[
            { label: t('nemmosaic.rental_fee'), value: nemXem(NEM_MOSAIC_RENTAL) },
            { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
            { label: t('nemmosaic.total'), value: nemXem(total), bold: true },
          ]}
          hint={t('nemmosaic.cost_hint')}
          warning={balanceShort ? t('nemmosaic.xem_short_warning') : undefined}
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
