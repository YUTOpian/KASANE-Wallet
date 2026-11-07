import { useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { WalletsHelper } from '../../lib/storage';
import { fetchNemXemBalance } from '../../lib/nem/api';
import { checkDaoNamespace, createNemDao } from '../../lib/nem/dao';
import type { CreateNemDaoResult } from '../../lib/nem/dao';
import {
  DAO_CREATE_STEPS, DAO_NAMESPACE_RENTAL, NEM_DAO_NAMESPACE_MAX_LENGTH, NEM_DAO_NAME_MAX_BYTES, NEM_DAO_SUPPLY, byteLength, checkDaoName, daoDepositMicro,
  governanceMosaicId, isValidDaoNamespace,
} from '../../lib/nem/daoCore';
import type { DaoCreateStep } from '../../lib/nem/daoCore';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { useAppStore } from '../../store/appStore';
import { ConfirmScreen, Field, FormRow, SectionCard } from '../multisig/parts';
import type { ConfirmRow } from '../multisig/parts';
import { nemXem } from './parts';
import { nemDaoPath, useNemActor } from './NemDaoUi';

type Phase = 'form' | 'confirm' | 'running' | 'done' | 'failed';
type StepState = 'pending' | 'sending' | 'waiting' | 'done';

// NEM 「DAO を作成」: DAO 用のアカウントを作り、ネームスペース（100 XEM）・ガバナンストークンを用意して、
// トークンの全量を管理者へ渡し、DAO をマルチシグ（管理者が連署者）にする。確定を待ちながら進めるので数分かかる。
export default function NemDaoCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNemNetworkConfig(network);
  const actor = useNemActor();
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<ConfirmRow[]>([]);
  const [steps, setSteps] = useState<Record<DaoCreateStep, StepState>>({ deposit: 'pending', namespace: 'pending', mosaic: 'pending', handover: 'pending', multisig: 'pending' });
  const [result, setResult] = useState<CreateNemDaoResult | null>(null);

  const nameBytes = useMemo(() => byteLength(name.trim()), [name]);
  const nameIssue = name === '' ? null : checkDaoName(name);
  const namespaceOk = isValidDaoNamespace(namespace);
  const valid = checkDaoName(name) === null && namespaceOk;

  const toConfirm = async () => {
    if (!actor) return;
    setError('');
    try {
      const have = await fetchNemXemBalance(actor.address).catch(() => null);
      const need = daoDepositMicro() + 1_000_000n; // 入金の手数料の余裕
      if (have !== null && have < need) {
        setError(t('nemdao.err_balance', { need: nemXem(need), have: nemXem(have) }));
        return;
      }
    } catch { /* 残高が読めなくても進める（送信時にノードが判定する） */ }
    const id = governanceMosaicId(namespace);
    setRows([
      { label: t('nemdao.f_name'), value: name.trim(), big: true },
      { label: t('nemdao.row_network'), value: `NEM ${netCfg.label}` },
      { label: t('nemdao.row_namespace'), value: namespace },
      { label: t('nemdao.row_governance'), value: t('nemdao.row_governance_value', { id, amount: NEM_DAO_SUPPLY.toString() }) },
      { label: t('nemdao.row_admin'), value: actor.address },
      { label: t('nemdao.row_namespace_rental'), value: nemXem(DAO_NAMESPACE_RENTAL) },
      { label: t('nemdao.row_deposit'), value: `${nemXem(daoDepositMicro())}\n${t('nemdao.row_deposit_note')}`, big: true },
      { label: t('nemdao.row_time'), value: t('nemdao.row_time_value') },
    ]);
    setPhase('confirm');
  };

  const run = async (privateKey: string, publicKey: string) => {
    setSteps({ deposit: 'pending', namespace: 'pending', mosaic: 'pending', handover: 'pending', multisig: 'pending' });
    setPhase('running');
    try {
      const problem = await checkDaoNamespace(privateKey, namespace);
      if (problem) {
        setError(t(`nemdao.err_${problem}`));
        setPhase('form');
        return;
      }
      const done = await createNemDao({ adminPrivateKey: privateKey, adminPublicKey: publicKey, name: name.trim(), namespace }, (step, p) => {
        setSteps((s) => ({ ...s, [step]: p === 'sending' ? 'sending' : p === 'waiting' ? 'waiting' : 'done' }));
      });
      setResult(done);
      setPhase('done');
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setError(code === 'confirm_timeout' || code === 'stuck' ? t(`nemdao.err_${code}`) : t('nemdao.err_create', { detail: code }));
      setPhase('failed');
    }
  };

  const onPassword = async (password: string) => {
    const wallet = await WalletsHelper.getActive('nem');
    if (!wallet) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    // 数分かかるので待たずに、進み具合の画面へ移る。
    void run(privateKey, wallet.publicKey);
  };

  if (phase === 'confirm') return <ConfirmScreen rows={rows} onBack={() => setPhase('form')} onPassword={onPassword} />;

  const stepLabel = (step: DaoCreateStep) => t(`nemdao.step_${step}`);
  const icon = (state: StepState) => (state === 'done' ? <CheckCircleOutlineIcon color="success" /> : state === 'pending' ? <RadioButtonUncheckedIcon sx={{ color: 'text.disabled' }} /> : <CircularProgress size={22} />);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton back="/dao" />
      <Box sx={{ px: { xs: 2, md: 4 }, py: 2, textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 400, mb: 2 }}>{t('nemdao.create_title')}</Typography>

        {(phase === 'running' || phase === 'done' || phase === 'failed') && (
          <SectionCard title={t('nemdao.progress_title')}>
            {DAO_CREATE_STEPS.map((step) => (
              <Box key={step} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
                {icon(steps[step])}
                <Typography>{stepLabel(step)}{steps[step] === 'waiting' ? ` — ${t('nemdao.waiting')}` : ''}</Typography>
              </Box>
            ))}
            {phase === 'running' && <Alert severity="info" sx={{ mt: 1.5 }}>{t('nemdao.running_note')}</Alert>}
          </SectionCard>
        )}

        {phase === 'done' && result && (
          <Alert severity="success" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate(nemDaoPath(result.daoId))}>{t('nemdao.open_button')}</Button>}>
            {t('nemdao.created_note', { id: result.daoId, address: result.daoAddress })}
          </Alert>
        )}

        {phase === 'failed' && (
          <Alert severity="error" sx={{ mb: 2, whiteSpace: 'pre-wrap' }} action={<Button color="inherit" size="small" onClick={() => { setError(''); setPhase('form'); }}>{t('nemdao.retry')}</Button>}>
            {error}
            {'\n'}{t('nemdao.resume_note')}
          </Alert>
        )}

        {(phase === 'form' || phase === 'failed') && (
          <SectionCard>
            <FormRow label={t('nemdao.f_name')} hint={t('nemdao.hint_name')}>
              <Field ariaLabel={t('nemdao.f_name')} value={name} onChange={(e) => setName(e.target.value)} error={nameIssue !== null} helperText={`${nameBytes} / ${NEM_DAO_NAME_MAX_BYTES} bytes`} />
            </FormRow>
            <FormRow label={t('nemdao.f_namespace')} hint={t('nemdao.hint_namespace', { max: NEM_DAO_NAMESPACE_MAX_LENGTH })}>
              <Field
                ariaLabel={t('nemdao.f_namespace')}
                value={namespace}
                onChange={(e) => setNamespace(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, NEM_DAO_NAMESPACE_MAX_LENGTH))}
                error={namespace !== '' && !namespaceOk}
                helperText={namespaceOk ? t('nemdao.hint_governance_id', { id: governanceMosaicId(namespace) }) : ''}
                htmlInput={{ style: { fontFamily: 'monospace' } }}
              />
            </FormRow>
            <Alert severity="info" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{t('nemdao.create_explain', { supply: NEM_DAO_SUPPLY.toString(), rental: nemXem(DAO_NAMESPACE_RENTAL) })}</Alert>
            {error && phase === 'form' && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
            <Box sx={{ mt: 2 }}>
              <Button variant="contained" color="primary" size="large" fullWidth disabled={!valid || !actor} onClick={toConfirm} sx={{ py: 1.25 }}>
                {t('nemdao.go_confirm')}
              </Button>
            </Box>
          </SectionCard>
        )}
      </Box>
    </Box>
  );
}
