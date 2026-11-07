import { useMemo, useState } from 'react';
import { Alert, Box, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { planCreateDao } from '../../lib/dao/daoActions';
import type { CreateDaoPlan } from '../../lib/dao/daoActions';
import { DAO_NAME_MAX_BYTES, GOVERNANCE_SUPPLY, byteLength } from '../../lib/dao/daoCore';
import { getNetworkConfig } from '../../lib/symbol/network';
import { withFormReset } from '../../lib/withFormReset';
import type { SentProps } from '../../lib/withFormReset';
import { Field, FormRow, SectionCard, xymText } from '../multisig/parts';
import { DaoAction, useActor } from './daoUi';
import { daoPath } from './DaoTop';

// 「DAO を作成」: 新しいアカウント（DAO）に、ガバナンストークンの発行・マルチシグ化（作った人が管理者）・メタデータの登録までを 1 回で行う。
function DaoCreate({ onSent }: SentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const actor = useActor();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreateDaoPlan | null>(null);
  const nameBytes = useMemo(() => byteLength(name.trim()), [name]);
  const valid = name.trim() !== '' && nameBytes <= DAO_NAME_MAX_BYTES;
  const net = getNetworkConfig();

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton back="/dao" />
      <Box sx={{ px: { xs: 2, md: 4 }, py: 2, textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 400, mb: 2 }}>{t('dao.create_title')}</Typography>
        {created && (
          <Alert severity="success" sx={{ mb: 2 }} action={<Typography component="a" sx={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => navigate(daoPath(created.daoId))}>{t('dao.open_button')}</Typography>}>
            {t('dao.created_note', { id: created.daoId })}
          </Alert>
        )}
        <SectionCard>
          <DaoAction
            label={t('multisig.go_confirm')}
            disabled={!valid || !actor}
            prepare={async () => {
              const plan = await planCreateDao(actor!, name.trim());
              setCreated(plan);
              return {
                plans: [plan],
                rows: [
                  { label: t('dao.f_name'), value: name.trim(), big: true },
                  { label: t('dao.row_network'), value: `${net.key === 'mijin' ? '' : 'Symbol '}${net.label}` },
                  { label: t('dao.row_dao_address'), value: plan.daoAddress },
                  { label: t('dao.row_governance'), value: t('dao.row_governance_value', { amount: GOVERNANCE_SUPPLY.toString() }) },
                  { label: t('dao.row_admin'), value: actor!.address },
                  { label: t('dao.row_deposit'), value: xymText(plan.deposit) },
                ],
              };
            }}
            onSent={onSent}
          >
            <FormRow label={t('dao.f_name')} hint={t('dao.hint_name')}>
              <Field ariaLabel={t('dao.f_name')} value={name} onChange={(e) => setName(e.target.value)} error={name !== '' && !valid} helperText={`${nameBytes} / ${DAO_NAME_MAX_BYTES} bytes`} />
            </FormRow>
            <Alert severity="info" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{t('dao.create_explain', { supply: GOVERNANCE_SUPPLY.toString() })}</Alert>
          </DaoAction>
        </SectionCard>
      </Box>
    </Box>
  );
}

export default withFormReset<object>(DaoCreate);
