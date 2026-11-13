import { useState } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { getNetwork } from '../../lib/symbol/network';
import { SectionCard, mono } from '../multisig/parts';
import { useDao } from './daoUi';

// 「自動連署ボット」の案内（管理者だけに出す）。ボットはこのウォレットの画面からは動かせない。
// サーバーで KASANE Wallet を動かしているとき、同じサーバーでコマンドを実行して動かす（詳しくは docs/DAO.md）。
// この画面でできるのは、ボット用アカウントを管理者（連署者）に加えるところまで。ボットが動いているかは、ここでは分からない。
export default function DaoBotGuide({ onAddAdmin }: { onAddAdmin: () => void }) {
  const { t } = useTranslation();
  const { dao, isAdmin } = useDao();
  const [copied, setCopied] = useState(false);
  const network = getNetwork();
  // ボットが対応しているのは Symbol のメインネット / テストネットだけ。
  if (!isAdmin || (network !== 'mainnet' && network !== 'testnet')) return null;

  const env = [
    'KASANE_DAO_BOT=1',
    `KASANE_DAO_BOT_DAO=${dao.id}`,
    `KASANE_DAO_BOT_NETWORK=${network}`,
    'KASANE_DAO_BOT_NODE=https://<node>',
    'KASANE_DAO_BOT_KEY_FILE=/etc/kasane/dao-bot.key',
    'KASANE_DAO_BOT_DRY_RUN=1',
    'npm run dao-bot',
  ].join('\n');
  const copy = () => {
    navigator.clipboard?.writeText(env).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* コピーできない環境では、手で選んでコピーしてもらう */ });
  };

  return (
    <SectionCard title={t('dao.bot_title')}>
      <Typography variant="body2" sx={{ mb: 1.5 }}>{t('dao.bot_lead')}</Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>{t('dao.bot_step_1')}</Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>{t('dao.bot_step_2')}</Typography>
      <Box sx={{ mb: 1.5 }}>
        <Button variant="outlined" onClick={onAddAdmin}>{t('dao.bot_add_admin')}</Button>
      </Box>
      <Typography variant="body2" sx={{ mb: 1 }}>{t('dao.bot_step_3')}</Typography>
      <Box component="pre" sx={{ ...mono, m: 0, p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider', fontSize: 13, whiteSpace: 'pre-wrap' }}>{env}</Box>
      <Box sx={{ mt: 1 }}>
        <Button size="small" onClick={copy}>{copied ? t('dao.bot_copied') : t('dao.bot_copy')}</Button>
      </Box>
      <Alert severity="warning" sx={{ mt: 1.5 }}>{t('dao.bot_warn')}</Alert>
      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>{t('dao.bot_note')}</Typography>
    </SectionCard>
  );
}
