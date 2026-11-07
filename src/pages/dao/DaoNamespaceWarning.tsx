import { useState } from 'react';
import { Alert, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { linkedNamespaceStatus } from '../../lib/dao/daoNamespaceExpiry';
import { daoPath } from './DaoTop';
import { useDao } from './daoUi';

// モザイク（ガバナンストークン・ポイント・特典）に紐付いているネームスペースの期限の警告。
// 紐付けの表示のすぐ下に置く。期限が1か月以内なら黄色、切れていれば赤で、「ネームスペース」タブへのボタンを付ける。
// DAO が持つルートが見つからない（他のアカウントのもの・一覧を読めなかった）ときは何も出さない。
export default function LinkedNamespaceWarning({ linked }: { linked: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dao, namespaces } = useDao();
  const [nowMs] = useState(() => Date.now());
  const st = linkedNamespaceStatus(linked, namespaces, nowMs);
  if (st.state !== 'soon' && st.state !== 'expired') return null;
  return (
    <Alert
      severity={st.state === 'expired' ? 'error' : 'warning'}
      sx={{ mt: 1, textAlign: 'left' }}
      action={<Button color="inherit" size="small" onClick={() => navigate(daoPath(dao.id, 'namespace'))}>{t('dao.nsx_go')}</Button>}
    >
      {st.state === 'expired' ? t('dao.nsx_warn_expired', { name: st.rootName }) : t('dao.nsx_warn_soon', { name: st.rootName, days: st.days ?? 0 })}
    </Alert>
  );
}
