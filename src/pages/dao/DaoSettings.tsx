import { useState } from 'react';
import { Alert, Box, Button, FormControl, FormControlLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { planSetAccess } from '../../lib/dao/daoActions';
import type { DaoAccess } from '../../lib/dao/daoCore';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { SectionCard, mono } from '../multisig/parts';
import { MultisigConvertEmbedded } from '../multisig/MultisigConvert';
import DaoBotGuide from './DaoBotGuide';
import { DaoAction, useDao } from './daoUi';

// 「DAO 設定」（管理者）: 管理者（DAO アカウントの連署者）の一覧。追加・削除は「マルチシグの設定変更」の画面で行う
// （新しい管理者の同意の連署、承認数の設定、多段マルチシグまで、そちらがそのまま使える）。
export default function DaoSettings() {
  const { t } = useTranslation();
  const { dao, actor, isAdmin, signer, reload } = useDao();
  const [access, setAccess] = useState<DaoAccess>(dao.access);
  // 管理者の追加・削除（マルチシグの設定変更）は、画面を移らずにこの中で行う。
  const [editingAdmins, setEditingAdmins] = useState(false);
  if (editingAdmins) {
    return (
      <>
        <Button onClick={() => setEditingAdmins(false)} sx={{ mb: 1 }}>{t('dao.settings_back')}</Button>
        <MultisigConvertEmbedded account={dao.address} embedded onDone={() => { setEditingAdmins(false); reload(); }} />
      </>
    );
  }
  return (
    <>
      <SectionCard title={t('dao.access_title')}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('dao.access_lead')}</Typography>
        <FormControl>
          <RadioGroup value={access} onChange={(e) => setAccess(e.target.value as DaoAccess)}>
            <FormControlLabel value="id" control={<Radio />} disabled={!isAdmin} label={t('dao.access_id')} />
            <FormControlLabel value="token" control={<Radio />} disabled={!isAdmin} label={t('dao.access_token')} />
          </RadioGroup>
        </FormControl>
        <Typography variant="caption" sx={{ display: 'block', mt: 1, mb: 1, color: 'text.secondary' }}>{t('dao.access_note')}</Typography>
        <DaoAction
          label={t('dao.access_save')}
          disabled={!isAdmin || !signer || access === dao.access}
          prepare={async () => {
            if (!signer) throw new Error('invalid_signer');
            return {
              plans: [await planSetAccess(actor, dao, signer, access)],
              rows: [
                { label: t('dao.access_row_action'), value: t('dao.access_row_value') },
                { label: t('dao.access_row_mode'), value: t(access === 'token' ? 'dao.access_token' : 'dao.access_id'), big: true },
              ],
            };
          }}
          onSent={reload}
        />
      </SectionCard>
      <SectionCard title={t('dao.settings_admins')}>
        {dao.admins.map((a) => (
          <Typography key={a} variant="body2" sx={{ py: 0.5, ...mono }}>
            {a}{normalizeAddress(a) === normalizeAddress(actor.address) ? `  (${t('dao.you')})` : ''}
          </Typography>
        ))}
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
          {t('dao.settings_approval', { approval: dao.minApproval, count: dao.admins.length })}
        </Typography>
        <Alert severity="info" sx={{ mt: 2 }}>{t('dao.settings_note')}</Alert>
        <Box sx={{ mt: 2 }}>
          <Button variant="contained" disabled={!isAdmin} onClick={() => setEditingAdmins(true)}>{t('dao.settings_edit')}</Button>
        </Box>
      </SectionCard>
      <DaoBotGuide onAddAdmin={() => setEditingAdmins(true)} />
    </>
  );
}
