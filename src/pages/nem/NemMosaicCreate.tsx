import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
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
import { createNemMosaic, fetchNemMosaicDefinition, fetchNemOwnedNamespaces, fetchNemXemBalance, nemExplorerTxUrl } from '../../lib/nem/api';
import type { NemOwnedNamespace } from '../../lib/nem/api';
import { getNemNetworkConfig } from '../../lib/nem/network';
import {
  NEM_MAX_MOSAIC_DESCRIPTION_BYTES, NEM_MAX_MOSAIC_DIVISIBILITY, NEM_MAX_MOSAIC_INITIAL_SUPPLY, NEM_MAX_MOSAIC_NAME_LENGTH,
  NEM_MOSAIC_RENTAL, NEM_PROVISION_TX_FEE, isValidNemName, nemMosaicSentDescription, nemMosaicSinkAddress,
} from '../../lib/nem/tx';
import { useAppStore } from '../../store/appStore';
import { groupDigits } from '../mosaic/mosaicFlags';
import { ConfirmRows, classifyNemError, nemXem } from './parts';
import { hyphenateNemAddress, supplyWithDecimals } from './mosaicLayout';
import NemLevyFormFields, { useNemLevyForm } from './NemLevyForm';

type Step = 'form' | 'confirm';

interface NemMosaicCreateProps {
  /** Shown under the mosaic screen's tabs (only this lower part changes) instead of as a screen of its own. */
  embedded?: boolean;
  /** Embedded: back to the created-mosaics tab. */
  onShowList?: () => void;
  /** Open the edit form of a mosaic that already exists (the name typed here is taken by one of the wallet's own). */
  onEdit?: (id: string) => void;
}

// NEM モザイクの作成: 入力 → 確認（パスワード）→ 送信。自分が持つネームスペースの下に作る（10 XEM）。
function NemMosaicCreate({ embedded = false, onShowList, onEdit, onSent }: NemMosaicCreateProps & SentProps) {
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
  // A mosaic with this id already exists: sending the definition again would re-define it (and cost the rental fee), so stop here.
  const [existing, setExisting] = useState<{ id: string; mine: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  // 徴収（レビー）: 作成と同時に設定できる（あとから編集で足すと、定義の送り直しでレンタル料がもう一度かかる）。
  const levy = useNemLevyForm(netCfg.networkByte, network);
  const { setRecipient: setLevyRecipient } = levy;

  const [showCaution, setShowCaution] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

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
        setLevyRecipient(wallet.address);
        const usable = owned.filter((n) => !n.expired);
        setNamespaces(usable);
        setNamespace(usable[0]?.name ?? '');
      } finally {
        if (!cancelled) setLoadingNs(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network, setLevyRecipient]);

  const nameValid = isValidNemName(name, NEM_MAX_MOSAIC_NAME_LENGTH);
  const nameError = name === '' || nameValid ? '' : t('nemmosaic.invalid_name');
  const descriptionBytes = new TextEncoder().encode(description).length;
  const descriptionValid = descriptionBytes <= NEM_MAX_MOSAIC_DESCRIPTION_BYTES;
  const supplyValid = /^\d+$/.test(supplyText) && BigInt(supplyText) > 0n;
  const supplyTooLarge = supplyValid && BigInt(supplyText) > NEM_MAX_MOSAIC_INITIAL_SUPPLY;
  const supplyError = supplyText === '' ? '' : !supplyValid ? t('nemmosaic.invalid_supply') : supplyTooLarge ? t('nemmosaic.supply_too_large', { max: groupDigits(NEM_MAX_MOSAIC_INITIAL_SUPPLY.toString()) }) : '';
  const canContinue = namespace !== '' && nameValid && descriptionValid && supplyValid && !supplyTooLarge && levy.ok;

  const total = NEM_MOSAIC_RENTAL + NEM_PROVISION_TX_FEE;
  const balanceShort = xemBalance !== null && xemBalance < total;
  const id = `${namespace}:${name}`;
  const yes = (v: boolean) => (v ? t('nemmosaic.on') : t('nemmosaic.off'));

  useEffect(() => { setExisting(null); }, [namespace, name]);

  const onContinue = async () => {
    setChecking(true);
    try {
      const wallet = await WalletsHelper.getActive();
      // If the lookup fails the node decides when the definition is announced.
      const found = await fetchNemMosaicDefinition(id).catch(() => null);
      if (found) {
        setExisting({ id, mine: !!wallet && found.creator.toLowerCase() === wallet.publicKey.toLowerCase() });
        return;
      }
    } finally {
      setChecking(false);
    }
    setStep('confirm');
    setShowCaution(true);
  };

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
        ...(levy.value ? { levy: levy.value } : {}),
      });
      showTxNotice({ lines: t('nemmosaic.done_message', { returnObjects: true }) as string[], explorerUrl: sent.hash ? nemExplorerTxUrl(sent.hash) : undefined, explorerLabel: t('nemmosaic.view_explorer') });
      onSent();
    } catch (error) {
      setSendError(classifyNemError(error, 'MOSAIC'));
    } finally {
      setCreating(false);
    }
  };

  const onBack = () => {
    if (step === 'confirm') setStep('form');
    else if (embedded) onShowList?.();
    else navigate('/mosaic');
  };

  // A screen fills the window; the embedded form grows to fill what is left under the tabs.
  const rootSx: SxProps<Theme> = embedded
    ? { flexGrow: 1, display: 'flex', flexDirection: 'column' }
    : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };

  const errorTitle = sendError ? t(`nemmosaic.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`nemmosaic.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  if (step === 'confirm') {
    const lv = levy.value;
    const levyText = !lv ? t('nemmosaic.off')
      : lv.feeType === 'percentile'
        ? t('nemmosaic.edit_levy_summary_percentile', { fee: lv.fee.toString(), pct: (Number(lv.fee) / 100).toString(), mosaic: lv.mosaicId, recipient: lv.recipient })
        : t('nemmosaic.edit_levy_summary_absolute', { fee: lv.fee.toString(), mosaic: lv.mosaicId, recipient: lv.recipient });
    const rows = [
      { label: t('nemmosaic.id_label'), value: id, big: true },
      { label: t('send.network'), value: `NEM ${netCfg.label}` },
      { label: t('nemmosaic.description_label'), value: nemMosaicSentDescription(namespace, name, description) },
      { label: t('nemmosaic.initial_supply'), value: groupDigits(supplyText) },
      { label: t('nemmosaic.divisibility_label'), value: String(divisibility) },
      { label: t('nemmosaic.supply_mutable_label'), value: yes(supplyMutable) },
      { label: t('nemmosaic.transferable_label'), value: yes(transferable) },
      { label: t('nemmosaic.edit_levy_label'), value: levyText },
      { label: t('nemmosaic.rental_fee'), value: nemXem(NEM_MOSAIC_RENTAL) },
      { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
      { label: t('nemmosaic.total'), value: nemXem(total) },
    ];
    return (
      <Box sx={rootSx}>
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
        <PasswordDialog open={showPasswordDialog} mode="check" popup onClose={() => setShowPasswordDialog(false)} onPass={onPassed} />
        <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
        <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
      </Box>
    );
  }

  // ============================ form ============================
  // Symbol のモザイク作成と同じ並び: 1列、枠線つきの入力欄、設定はスイッチ、費用は枠で囲む。
  const optionRows = [
    { checked: supplyMutable, set: setSupplyMutable, label: 'nemmosaic.supply_mutable_label', desc: 'nemmosaic.supply_mutable_desc' },
    { checked: transferable, set: setTransferable, label: 'nemmosaic.transferable_label', desc: 'nemmosaic.transferable_desc' },
    { checked: levy.enabled, set: levy.setEnabled, label: 'nemmosaic.levy_required', desc: 'nemmosaic.edit_levy_desc' },
  ];
  const costRows = [
    { label: t('nemmosaic.rental_fee'), value: nemXem(NEM_MOSAIC_RENTAL) },
    { label: t('nemmosaic.tx_fee'), value: nemXem(NEM_PROVISION_TX_FEE) },
    { label: t('nemmosaic.total'), value: nemXem(total), bold: true },
  ];

  return (
    <Box sx={rootSx}>
      {!embedded && <BackButton onBack={onBack} back="/mosaic" />}
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('nemmosaic.caution_immutable')}</Alert>

        {!loadingNs && namespaces.length === 0 && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate('/namespace/register')}>{t('nemmosaic.go_namespace')}</Button>}>
            {t('nemmosaic.no_namespace')}
          </Alert>
        )}

        <TextField
          select
          label={t('nemmosaic.namespace_label')}
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          helperText={t('nemmosaic.namespace_hint')}
          fullWidth
          disabled={namespaces.length === 0}
          sx={{ mb: 2 }}
        >
          {namespaces.map((n) => <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>)}
        </TextField>

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
          <Typography variant="body2" sx={{ mb: 2, wordBreak: 'break-all' }}>{t('nemmosaic.full_name')}: <b>{id}</b></Typography>
        )}

        <TextField
          label={t('nemmosaic.description_label')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={!descriptionValid}
          helperText={descriptionValid
            ? `${t('nemmosaic.description_hint', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES })} ${t('nemmosaic.description_remaining', { n: NEM_MAX_MOSAIC_DESCRIPTION_BYTES - descriptionBytes })}`
            : t('nemmosaic.description_too_long', { max: NEM_MAX_MOSAIC_DESCRIPTION_BYTES })}
          multiline
          minRows={3}
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

        <TextField
          select
          label={t('nemmosaic.divisibility_label')}
          value={divisibility}
          onChange={(e) => setDivisibility(Number(e.target.value))}
          helperText={t('nemmosaic.divisibility_hint')}
          fullWidth
          sx={{ mb: 1 }}
        >
          {Array.from({ length: NEM_MAX_MOSAIC_DIVISIBILITY + 1 }, (_, i) => <MenuItem key={i} value={i}>{i}</MenuItem>)}
        </TextField>
        <Typography variant="body2" sx={{ mb: 3, wordBreak: 'break-all' }}>
          {t('nemmosaic.total_supply')}: <b>{supplyWithDecimals(supplyValid && !supplyTooLarge ? supplyText : '0', divisibility)}</b>
        </Typography>

        <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemmosaic.options_title')}</Typography>
        {optionRows.map((o) => (
          <Box key={o.label} sx={{ mb: 1 }}>
            <FormControlLabel
              control={<Switch checked={o.checked} onChange={(e) => o.set(e.target.checked)} />}
              label={t(o.label)}
            />
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ml: 6, mt: -0.5 }}>{t(o.desc)}</Typography>
          </Box>
        ))}

        <NemLevyFormFields form={levy} sentMosaic={namespace && name ? id : ''} stacked />

        {existing && (
          <Alert
            severity="warning"
            sx={{ mt: 2 }}
            action={existing.mine ? <Button color="inherit" size="small" onClick={() => (onEdit ? onEdit(existing.id) : navigate(`/mosaic/edit?id=${encodeURIComponent(existing.id)}`))}>{t('nemmosaic.edit_button')}</Button> : undefined}
          >
            {existing.mine ? t('nemmosaic.exists_mine') : t('nemmosaic.exists_other')}
          </Alert>
        )}

        <Box sx={{ mt: 3, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
          <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{t('nemmosaic.cost_title')}</Typography>
          {costRows.map((r) => (
            <Typography key={r.label} variant="body2" sx={{ py: 0.25, fontWeight: r.bold ? 'bold' : 'normal', wordBreak: 'break-all' }}>{r.label}: {r.value}</Typography>
          ))}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemmosaic.cost_hint')}</Typography>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5, wordBreak: 'break-all' }}>
            {t('nemmosaic.sink_address')}: <Box component="span" sx={{ fontFamily: 'monospace' }}>{hyphenateNemAddress(nemMosaicSinkAddress(netCfg.networkByte))}</Box>
          </Typography>
          {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('nemmosaic.xem_short_warning')}</Alert>}
        </Box>
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={!canContinue || checking} onClick={onContinue} sx={{ py: 1.5 }}>
          {t('nemmosaic.go_confirm')}
        </Button>
      </Box>
    </Box>
  );
}

export default withFormReset<NemMosaicCreateProps>(NemMosaicCreate);
