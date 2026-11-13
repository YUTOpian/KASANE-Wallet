import { useMemo, useState } from 'react';
import { Alert, Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { SocialAvatar } from '../../components/SocialMetadataView';
import { planSetSocialMetadata } from '../../lib/dao/daoActions';
import {
  SOCIAL_FIELD_MAX, SOCIAL_METADATA_KEY_TEXT, clearSocialMetadataCache, sameSocialMetadata, serializeSocialMetadata, validateSocialMetadata,
} from '../../lib/symbol/socialMetadata';
import type { SocialMetadata } from '../../lib/symbol/socialMetadata';
import { SectionCard, mono } from '../multisig/parts';
import { DaoAction, useDao } from './daoUi';

const EMPTY: SocialMetadata = { url: '', name: '', imageUrl: '', namespace: '' };

const normalize = (m: SocialMetadata): SocialMetadata => ({ url: m.url.trim(), name: m.name.trim(), imageUrl: m.imageUrl.trim(), namespace: m.namespace.trim().replace(/^@/, '') });

// 「DAO のソーシャルメタデータ」（管理者）: DAO アカウント自身に、SNS などの URL・名前・アイコン画像・ネームスペースを登録する。
// ウォレットの「ソーシャルメタデータ」と同じ仕様（キー social_meta_data、値は JSON）。署名者は DAO（管理者の連署）で、DAO アカウントが
// 「発起人 = 対象」の自己登録として書くので、取引の履歴などでこの DAO のアドレスを見たときに、同じ形で表示される。
export default function DaoSocialMetadata() {
  const { t } = useTranslation();
  const { dao, actor, isAdmin, signer, reload } = useDao();
  const [form, setForm] = useState<SocialMetadata>(dao.social ? { ...dao.social } : EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof SocialMetadata, boolean>>>({});

  const errors = useMemo(() => validateSocialMetadata(form), [form]);
  const valid = Object.values(errors).every((e) => e === null);
  const unchanged = dao.social !== null && sameSocialMetadata(dao.social, normalize(form));
  const preview = normalize(form);

  const set = (field: keyof SocialMetadata) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const blur = (field: keyof SocialMetadata) => () => setTouched((x) => ({ ...x, [field]: true }));
  const errorText = (field: keyof SocialMetadata): string => {
    const e = errors[field];
    if (e === null || (!touched[field] && form[field] === '')) return '';
    return t(`social.error_${e}`, { max: SOCIAL_FIELD_MAX[field] });
  };
  const inputProps = (label: string) => ({ htmlInput: { inputMode: 'url' as const, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': label } });

  return (
    <SectionCard title={t('dao.social_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('dao.social_lead')}</Typography>
      {!isAdmin && <Alert severity="info" sx={{ mb: 2 }}>{t('dao.social_admin_only')}</Alert>}
      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
        <SocialAvatar key={preview.imageUrl} meta={preview} size={72} loadImage={errors.imageUrl === null && form.imageUrl.trim() !== ''} />
      </Box>
      <TextField
        label={t('social.field_image_url')}
        value={form.imageUrl}
        onChange={set('imageUrl')}
        onBlur={blur('imageUrl')}
        disabled={!isAdmin}
        error={errorText('imageUrl') !== ''}
        helperText={errorText('imageUrl') || t('social.hint_image_url')}
        placeholder="https://"
        fullWidth
        slotProps={inputProps(t('social.field_image_url'))}
        sx={{ mb: 2 }}
      />
      <TextField
        label={t('social.field_url')}
        value={form.url}
        onChange={set('url')}
        onBlur={blur('url')}
        disabled={!isAdmin}
        error={errorText('url') !== ''}
        helperText={errorText('url') || t('social.hint_url')}
        placeholder="https://"
        fullWidth
        slotProps={inputProps(t('social.field_url'))}
        sx={{ mb: 2 }}
      />
      <TextField
        label={t('social.field_namespace_optional')}
        value={form.namespace}
        onChange={set('namespace')}
        onBlur={blur('namespace')}
        disabled={!isAdmin}
        error={errorText('namespace') !== ''}
        helperText={errorText('namespace') || t('social.hint_namespace')}
        fullWidth
        slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_namespace_optional') } }}
        sx={{ mb: 2 }}
      />
      <TextField
        label={t('social.field_name')}
        value={form.name}
        onChange={set('name')}
        onBlur={blur('name')}
        disabled={!isAdmin}
        error={errorText('name') !== ''}
        helperText={errorText('name') || t('social.hint_name')}
        fullWidth
        slotProps={{ htmlInput: { 'aria-label': t('social.field_name') } }}
        sx={{ mb: 2 }}
      />
      {unchanged && <Alert severity="success" sx={{ mb: 2 }}>{t('social.unchanged')}</Alert>}
      {dao.social !== null && !unchanged && valid && <Alert severity="warning" sx={{ mb: 2 }}>{t('social.will_overwrite')}</Alert>}
      <DaoAction
        label={t('dao.social_save')}
        disabled={!isAdmin || !signer || !valid || unchanged}
        prepare={async () => {
          if (!signer) throw new Error('invalid_signer');
          const meta = normalize(form);
          return {
            plans: [await planSetSocialMetadata(actor, dao, signer, meta)],
            rows: [
              { label: t('dao.social_row_action'), value: t('dao.social_row_value') },
              { label: t('dao.social_row_key'), value: SOCIAL_METADATA_KEY_TEXT },
              { label: t('dao.social_row_content'), value: serializeSocialMetadata(meta) },
            ],
          };
        }}
        onSent={() => { clearSocialMetadataCache(dao.address); reload(); }}
      />
      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary', ...mono }}>{SOCIAL_METADATA_KEY_TEXT}</Typography>
      <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>{t('dao.social_note')}</Typography>
    </SectionCard>
  );
}
