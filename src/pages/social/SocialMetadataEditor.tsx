import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import TextField from '../../components/TextField';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SocialAvatar } from '../../components/SocialMetadataView';
import { fieldBoxSx } from '../../components/fieldBox';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { explorerTxUrl, fetchBalances, fetchMetadataValue, quoteMetadataFee, setMetadata } from '../../lib/symbol/api';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { encodeValue } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  SOCIAL_FIELD_MAX, SOCIAL_METADATA_KEY, SOCIAL_METADATA_KEY_TEXT, clearSocialMetadataCache, fetchSocialMetadata, sameSocialMetadata,
  serializeSocialMetadata, validateSocialMetadata,
} from '../../lib/symbol/socialMetadata';
import type { SocialMetadata } from '../../lib/symbol/socialMetadata';
import { useAppStore } from '../../store/appStore';
import { showTxNotice } from '../../store/txNoticeStore';
import { classifyError } from '../metadata/MetadataPage';

interface Props {
  /** ダイアログの中に出す（画面いっぱいのレイアウトにしない）。 */
  embedded?: boolean;
  /** メタデータを付けるアカウント。省略するとアクティブなアカウント。 */
  account?: Wallet;
  onClose?: () => void;
  /** 送信したあと（アカウント画面が読み直すため）。 */
  onSent?: () => void;
}

const EMPTY: SocialMetadata = { url: '', name: '', imageUrl: '', namespace: '' };

// 「ソーシャルメタデータ」の設定: アドレスに、その人の SNS などの URL・名前・アイコン画像・ネームスペースを登録する。
// 登録先は自分のアドレスのメタデータ（キー social_meta_data、値は JSON）。取引の相手が URL から「誰のアドレスか」を確かめられる。
export default function SocialMetadataEditor({ embedded = false, account, onClose, onSent }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  const [address, setAddress] = useState('');
  const [current, setCurrent] = useState<SocialMetadata | null | 'loading' | 'failed'>('loading');
  const [form, setForm] = useState<SocialMetadata>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof SocialMetadata, boolean>>>({});
  const [foreign, setForeign] = useState(false); // social_meta_data に、この形式でない値が入っている

  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // アカウントのアドレスと、いま登録されている内容（フォームの初期値）。
  useEffect(() => {
    let cancelled = false;
    setCurrent('loading');
    (async () => {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet || cancelled) return;
      setAddress(wallet.address);
      const balances = await fetchBalances(wallet.address).catch(() => null);
      if (!cancelled && balances) setXymBalance(balances.find((b) => b.id === netCfg.currencyMosaicId)?.amount ?? 0n);
      try {
        const existing = await fetchSocialMetadata(wallet.address);
        if (cancelled) return;
        setCurrent(existing);
        if (existing) setForm({ ...existing });
        else setForeign(await hasForeignValue(wallet.address));
      } catch {
        if (!cancelled) setCurrent('failed');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, network]);

  const errors = useMemo(() => validateSocialMetadata(form), [form]);
  const valid = Object.values(errors).every((e) => e === null);
  const unchanged = typeof current === 'object' && current !== null && sameSocialMetadata(current, normalize(form));
  const canUpdate = valid && !unchanged && current !== 'loading' && current !== 'failed' && address !== '';
  const valueText = valid ? serializeSocialMetadata(form) : '';

  // 手数料: 値の大きさ（いま付いている値と新しい値の大きいほう）で決まる。
  const newLength = valid ? encodeValue(valueText).length : 0;
  const oldLength = current !== null && typeof current === 'object' ? encodeValue(serializeSocialMetadata(current)).length : 0;
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    if (!valid) return undefined;
    quoteMetadataFee('account', [Math.max(newLength, oldLength)])
      .then((q) => { if (!cancelled) setTxFee(q.fee); })
      .catch(() => { /* shown as unavailable */ });
    return () => { cancelled = true; };
  }, [valid, newLength, oldLength, network]);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const balanceShort = txFee !== null && xymBalance !== null && xymBalance < txFee;

  const set = (field: keyof SocialMetadata) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const blur = (field: keyof SocialMetadata) => () => setTouched((x) => ({ ...x, [field]: true }));
  const errorText = (field: keyof SocialMetadata): string => {
    const e = errors[field];
    if (e === null || (!touched[field] && form[field] === '')) return '';
    return t(`social.error_${e}`, { max: SOCIAL_FIELD_MAX[field] });
  };

  const onBack = () => { if (embedded) onClose?.(); else navigate(-1); };

  const onPassed = async (password: string) => {
    if (!valid) return;
    setSending(true);
    try {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      const sent = await setMetadata({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        target: { type: 'account' },
        items: [{ key: SOCIAL_METADATA_KEY, value: encodeValue(valueText) }],
      });
      clearSocialMetadataCache(wallet.address);
      showTxNotice({
        lines: t('social.done_message', { returnObjects: true }) as string[],
        explorerUrl: explorerTxUrl(sent.hash),
        explorerLabel: t('metadata.view_explorer'),
      });
      setCurrent(normalize(form));
      onSent?.();
      if (embedded) onClose?.();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const rootSx: SxProps<Theme> = embedded ? { display: 'flex', flexDirection: 'column' } : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };
  const previewMeta: SocialMetadata = normalize(form);
  const errorTitle = sendError ? t(`metadata.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`metadata.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  return (
    <Box sx={rootSx}>
      {!embedded && <BackButton onBack={onBack} back="/account" />}
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left', maxWidth: 640, mx: 'auto' }}>
        {!embedded && <Typography sx={{ fontWeight: 'bold', fontSize: '1.3rem', mb: 1 }}>{t('social.title')}</Typography>}
        <Alert severity="info" sx={{ mb: 2 }}>{t('social.lead')}</Alert>

        {address !== '' && (
          <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', mb: 2 }}>{address}</Typography>
        )}

        {current === 'loading' && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={26} /></Box>}
        {current === 'failed' && <Alert severity="error" sx={{ mb: 2 }}>{t('social.load_failed')}</Alert>}
        {foreign && <Alert severity="warning" sx={{ mb: 2 }}>{t('social.foreign_value')}</Alert>}

        {current !== 'loading' && current !== 'failed' && (
          <>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <SocialAvatar key={previewMeta.imageUrl} meta={previewMeta} size={88} loadImage={errors.imageUrl === null && form.imageUrl.trim() !== ''} />
            </Box>

            <TextField
              label={t('social.field_image_url')}
              value={form.imageUrl}
              onChange={set('imageUrl')}
              onBlur={blur('imageUrl')}
              error={errorText('imageUrl') !== ''}
              helperText={errorText('imageUrl') || t('social.hint_image_url')}
              placeholder="https://"
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_image_url') } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('social.field_url')}
              value={form.url}
              onChange={set('url')}
              onBlur={blur('url')}
              error={errorText('url') !== ''}
              helperText={errorText('url') || t('social.hint_url')}
              placeholder="https://"
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_url') } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('social.field_namespace_optional')}
              value={form.namespace}
              onChange={set('namespace')}
              onBlur={blur('namespace')}
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
              error={errorText('name') !== ''}
              helperText={errorText('name') || t('social.hint_name')}
              fullWidth
              slotProps={{ htmlInput: { 'aria-label': t('social.field_name') } }}
              sx={{ mb: 2 }}
            />

            {unchanged && <Alert severity="success" sx={{ mb: 2 }}>{t('social.unchanged')}</Alert>}
            {current !== null && !unchanged && valid && <Alert severity="warning" sx={{ mb: 2 }}>{t('social.will_overwrite')}</Alert>}

            <Box sx={{ ...fieldBoxSx }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>
                {t('metadata.tx_fee')}: {txFee === null ? t('metadata.cost_unavailable') : xym(txFee)}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('metadata.cost_hint')}</Typography>
              {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('metadata.xym_short_warning')}</Alert>}
            </Box>
          </>
        )}
      </Box>

      <Box sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '4px solid', borderColor: 'primary.main', px: 3, py: 2, display: 'flex', gap: 1.5 }}>
        <Button variant="outlined" color="inherit" size="large" onClick={onBack} sx={{ flex: 1, py: 1.5 }}>{t('common.cancel')}</Button>
        <Button variant="contained" color="primary" size="large" disabled={!canUpdate || sending} onClick={() => setConfirmOpen(true)} sx={{ flex: 1, py: 1.5 }}>
          {sending ? t('metadata.sending') : t('social.update')}
        </Button>
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 'bold' }}>{t('social.confirm_title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1.5 }}>{t('social.confirm_message')}</Typography>
          <Box sx={{ ...fieldBoxSx, fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
            {SOCIAL_METADATA_KEY_TEXT}{'\n'}{valueText}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={() => { setConfirmOpen(false); setShowPassword(true); }}>{t('metadata.confirm_password')}</Button>
        </DialogActions>
      </Dialog>

      <PasswordDialog open={showPassword} mode="check" popup profileKey={account?.profileKey} onClose={() => setShowPassword(false)} onPass={onPassed} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Box>
  );
}

function normalize(m: SocialMetadata): SocialMetadata {
  return { url: m.url.trim(), name: m.name.trim(), imageUrl: m.imageUrl.trim(), namespace: m.namespace.trim().replace(/^@/, '') };
}

// social_meta_data が既にあるが、仕様の形（JSON）でないときに、上書きになることを知らせる。
async function hasForeignValue(address: string): Promise<boolean> {
  const bytes = await fetchMetadataValue({ type: 'account', address }, SOCIAL_METADATA_KEY).catch(() => new Uint8Array(0));
  return bytes.length > 0;
}
