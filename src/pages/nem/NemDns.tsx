import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, Tab, Tabs, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SearchIcon from '@mui/icons-material/Search';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import PasswordDialog from '../../components/PasswordDialog';
import { LedgerError } from '../../lib/ledger/framing';
import { ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink } from '../../lib/ledger/session';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { formatAtomic } from '../../lib/symbol/amount';
import { SymbolSendError } from '../../lib/symbol/api';
import { fetchNemOwnedNamespaces, nemExplorerNamespaceUrl, nemExplorerTxUrl } from '../../lib/nem/api';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL, NEM_EPOCH_SECONDS } from '../../lib/nem/constants';
import {
  NEM_DNS_FIELDS, NEM_DNS_MAX_MESSAGE_BYTES, emptyNemDnsRecord, nemDnsDisplayName, nemDnsMessageBytes, nemDnsSiteUrl, normalizeNemDnsName,
} from '../../lib/nem/dns';
import type { NemDnsField, NemDnsRecord } from '../../lib/nem/dns';
import { NemDnsError, lookupNemDns, nemDnsFee, nemDnsPointer, publishNemDns } from '../../lib/nem/dnsApi';
import type { NemDnsLookup } from '../../lib/nem/dnsApi';
import { fetchNemMultisigInfo } from '../../lib/nem/multisigApi';
import { prettyNemAddress } from '../../lib/nem/crypto';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox } from '../multisig/parts';

// NEM の 「DNS」(Domain Name System): ネームスペース（"kasane.nem"）に、ポインタアカウント経由で連絡先などを紐づける。
// 検索タブ: 名前から登録内容を調べる（持ち主が署名した最新のものだけが表示される）。
// 設定タブ: 自分（または自分が連署するマルチシグ）のネームスペースの登録内容を、書き込む・更新する。
// しくみは lib/nem/dns.ts。ブロックチェーンに記録されるので、だれでも読める。

type TabKey = 'search' | 'configure';

const nemTime = (nemSeconds: number) => new Date((nemSeconds + NEM_EPOCH_SECONDS) * 1000).toLocaleString();
const xemText = (micro: bigint) => `${formatAtomic(micro, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`;

/** One line of a result: the label on the left, the value on the right (the NanoWallet look). */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '180px minmax(0, 1fr)' }, columnGap: 3, rowGap: 0.5, py: 1.1, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.9rem', color: 'text.secondary' }}>{label}</Typography>
      <Box sx={{ minWidth: 0, fontSize: '0.95rem', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{children}</Box>
    </Box>
  );
}

const fieldLabelKey = (field: NemDnsField) => `nemdns.field_${field}`;

// --- 検索 -------------------------------------------------------------------------------------------------------
function SearchPanel({ initialName }: { initialName: string }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [name, setName] = useState(initialName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<NemDnsLookup | null>(null);

  const search = useCallback(async (input: string) => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      setResult(await lookupNemDns(input));
    } catch (e) {
      if (e instanceof NemDnsError) setError(t(`nemdns.err_${e.code}`));
      else {
        console.error('DNS lookup failed', e);
        setError(t('nemdns.err_lookup_failed'));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  // A link with ?name= (e.g. from a namespace screen) searches right away. The network is part of the answer, so a change of it clears it.
  useEffect(() => { if (initialName !== '') void search(initialName); }, [initialName, search]);
  useEffect(() => { setResult(null); setError(''); }, [network]);

  const found = result?.found ?? null;
  const siteUrl = found ? nemDnsSiteUrl(found.record.ip1) : null;
  const shownFields = found ? NEM_DNS_FIELDS.filter((f) => found.record[f].trim() !== '') : [];

  return (
    <>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('nemdns.search_about')}</Typography>
      <SectionCard>
        <FormRow label={t('nemdns.search_label')} top hint={t('nemdns.search_hint')}>
          <Box onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() !== '' && !loading) void search(name); }}>
            <Field
              ariaLabel={t('nemdns.search_label')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="namespace.nem"
              htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
            />
          </Box>
        </FormRow>
        <Button variant="contained" size="large" fullWidth disabled={name.trim() === '' || loading} onClick={() => { void search(name); }} startIcon={loading ? <CircularProgress size={18} color="inherit" /> : <SearchIcon />} sx={{ mt: 1, py: 1.1 }}>
          {loading ? t('nemdns.searching') : t('nemdns.search_button')}
        </Button>
      </SectionCard>

      {error !== '' && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {result !== null && (
        <>
          <SectionCard title={nemDnsDisplayName(result.namespace)}>
            {result.expired && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('nemdns.expired_note')}</Alert>}
            <InfoRow label={t('nemdns.owner')}>
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{prettyNemAddress(result.owner)}</Box>
            </InfoRow>
            <InfoRow label={t('nemdns.pointer_address')}>
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{prettyNemAddress(result.pointerAddress)}</Box>
            </InfoRow>
          </SectionCard>

          {found === null ? (
            <Alert severity="info" sx={{ mb: 2 }}>{t('nemdns.no_record')}</Alert>
          ) : (
            <SectionCard title={t('nemdns.record_title')}>
              <Alert severity="success" sx={{ mb: 1.5 }}>{t('nemdns.record_found')}</Alert>
              {shownFields.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary', py: 1 }}>{t('nemdns.record_empty')}</Typography>}
              {shownFields.map((f) => (
                <InfoRow key={f} label={t(fieldLabelKey(f))}>{found.record[f]}</InfoRow>
              ))}
              {found.timeStamp !== null && <InfoRow label={t('nemdns.updated_at')}>{nemTime(found.timeStamp)}</InfoRow>}
              {found.hash !== '' && (
                <InfoRow label={t('nemdns.record_tx')}>
                  <Box component="a" href={nemExplorerTxUrl(found.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: 'primary.main', fontFamily: 'monospace' }}>{found.hash}</Box>
                </InfoRow>
              )}
              {found.record.ip1.trim() !== '' && (
                <Box sx={{ mt: 2 }}>
                  {siteUrl !== null ? (
                    <>
                      <Button variant="contained" startIcon={<OpenInNewIcon />} onClick={() => window.open(siteUrl, '_blank', 'noopener,noreferrer')}>{t('nemdns.open_site')}</Button>
                      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1, lineHeight: 1.6, wordBreak: 'break-all' }}>
                        {t('nemdns.open_site_note', { url: siteUrl })}
                      </Typography>
                    </>
                  ) : (
                    <Alert severity="warning">{t('nemdns.site_not_openable')}</Alert>
                  )}
                </Box>
              )}
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}

// --- 設定 -------------------------------------------------------------------------------------------------------
interface OwnerOption { key: string; address: string; multisigPublicKey?: string }

function ConfigurePanel() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [ownerKey, setOwnerKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [namespaces, setNamespaces] = useState<string[] | null>(null);
  const [namespace, setNamespace] = useState('');
  const [record, setRecord] = useState<NemDnsRecord>(emptyNemDnsRecord());
  const [recordLoading, setRecordLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sent, setSent] = useState<{ hash: string; multisig: boolean; namespace: string } | null>(null);

  // Who can write: this account, and the multisig accounts it cosigns for (not with a Ledger: the wrapper is signed with a key).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSent(null);
    (async () => {
      const w = await WalletsHelper.getActive();
      if (!w || cancelled) return;
      const list: OwnerOption[] = [{ key: 'self', address: w.address }];
      if (!w.ledger) {
        try {
          const info = await fetchNemMultisigInfo(w.address);
          // The wrapper needs the multisig account's public key, which the node lists with the account.
          for (const m of info.multisigOf) {
            if (m.publicKey) list.push({ key: m.address, address: m.address, multisigPublicKey: m.publicKey });
          }
        } catch (e) {
          console.error('Failed to read the multisig accounts', e);
        }
      }
      if (cancelled) return;
      setWallet(w);
      setOwners(list);
      setOwnerKey('self');
    })().catch((e) => console.error('Failed to load the account', e)).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [network]);

  const owner = owners.find((o) => o.key === ownerKey) ?? null;

  // The namespaces of the chosen owner that can still be written to.
  useEffect(() => {
    if (owner === null) return undefined;
    let cancelled = false;
    setNamespaces(null);
    setNamespace('');
    setRecord(emptyNemDnsRecord());
    fetchNemOwnedNamespaces(owner.address)
      .then((list) => { if (!cancelled) setNamespaces(list.filter((n) => !n.expired).map((n) => n.name)); })
      .catch((e) => { console.error('Failed to read the namespaces', e); if (!cancelled) setNamespaces([]); });
    return () => { cancelled = true; };
  }, [owner]);

  // Choosing a namespace shows what is registered now (that is what an update starts from).
  const onSelectNamespace = async (ns: string) => {
    setNamespace(ns);
    setSent(null);
    setRecord(emptyNemDnsRecord());
    if (ns === '') return;
    setRecordLoading(true);
    try {
      const lookup = await lookupNemDns(ns);
      setRecord(lookup.found?.record ?? emptyNemDnsRecord());
    } catch (e) {
      console.error('Failed to read the current DNS record', e);
    } finally {
      setRecordLoading(false);
    }
  };

  const pointer = useMemo(() => {
    const ns = namespace === '' ? null : normalizeNemDnsName(namespace);
    return ns === null ? null : nemDnsPointer(ns);
  }, [namespace]);

  const bytes = nemDnsMessageBytes(record);
  const tooLong = bytes > NEM_DNS_MAX_MESSAGE_BYTES;
  const fee = useMemo(() => nemDnsFee(record, owner?.multisigPublicKey !== undefined), [record, owner]);
  const ledgerWallet = wallet?.ledger === true;
  const canSend = wallet !== null && owner !== null && pointer !== null && !tooLong && !recordLoading && !sending;

  const publish = async (privateKey: string, ledgerIndex?: number) => {
    if (wallet === null || owner === null || pointer === null) return;
    const result = await publishNemDns({
      namespace: pointer.namespace,
      record,
      privateKey,
      publicKey: wallet.publicKey,
      ledgerIndex,
      multisigPublicKey: owner.multisigPublicKey,
    });
    setSent({ hash: result.hash, multisig: owner.multisigPublicKey !== undefined, namespace: pointer.namespace });
  };

  const fail = (e: unknown) => {
    if (e instanceof LedgerError) {
      if (e.kind !== 'no_device') setErrorMessage(t(ledgerErrorKey(e), { chain: 'NEM' }));
      return;
    }
    console.error('Failed to register the DNS record', e);
    const code = e instanceof SymbolSendError ? e.code.toUpperCase() : '';
    if (code.includes('INSUFFICIENT_BALANCE')) setErrorMessage(t('nemdns.err_insufficient'));
    else setErrorMessage(e instanceof Error ? e.message : String(e));
  };

  const onPassed = async (password: string) => {
    if (wallet === null) return;
    setSending(true);
    try {
      const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      await publish(privateKey);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  // Ledger: the device can only be chosen right after a click, so connect here, then sign.
  const onLedger = async () => {
    if (wallet === null) return;
    if (wallet.accountIndex === null) { setErrorMessage(t('ledger.error_unknown')); return; }
    const link = preferredLedgerLink();
    if (link === null) { setErrorMessage(t('ledger.error_unsupported_browser')); return; }
    setSending(true);
    try {
      await ensureLedgerConnected(link);
      await publish('', wallet.accountIndex);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const setField = (field: NemDnsField, value: string) => { setRecord((r) => ({ ...r, [field]: value })); setSent(null); };

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>;
  if (wallet === null) return <Alert severity="warning">{t('nemdns.no_wallet')}</Alert>;

  return (
    <>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('nemdns.configure_about')}</Typography>
      <Alert severity="warning" sx={{ mb: 2 }}>{t('nemdns.public_warning')}</Alert>

      <SectionCard>
        {owners.length > 1 && (
          <FormRow label={t('nemdns.owner_account')} top hint={t('nemdns.owner_account_hint')}>
            <Field select ariaLabel={t('nemdns.owner_account')} value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)}>
              {owners.map((o) => (
                <MenuItem key={o.key} value={o.key} sx={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {o.multisigPublicKey === undefined ? `${t('nemdns.owner_self')}  ${prettyNemAddress(o.address)}` : `${t('nemdns.owner_multisig')}  ${prettyNemAddress(o.address)}`}
                </MenuItem>
              ))}
            </Field>
          </FormRow>
        )}
        <FormRow label={t('nemdns.namespace')} top>
          {namespaces === null ? (
            <Box sx={{ py: 1 }}><CircularProgress size={20} /></Box>
          ) : namespaces.length === 0 ? (
            <Alert severity="info">{t('nemdns.no_namespace')}</Alert>
          ) : (
            <Field select ariaLabel={t('nemdns.namespace')} value={namespace} onChange={(e) => { void onSelectNamespace(e.target.value); }}>
              <MenuItem value=""><em>{t('nemdns.select_namespace')}</em></MenuItem>
              {namespaces.map((n) => <MenuItem key={n} value={n}>{nemDnsDisplayName(n)}</MenuItem>)}
            </Field>
          )}
        </FormRow>
        {pointer !== null && (
          <FormRow label={t('nemdns.pointer_address')} top hint={t('nemdns.pointer_hint')}>
            <ValueBox>{prettyNemAddress(pointer.address)}</ValueBox>
          </FormRow>
        )}
      </SectionCard>

      {pointer !== null && (
        <>
          <SectionCard title={t('nemdns.record_title')}>
            {recordLoading && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}><CircularProgress size={16} /><Typography variant="body2">{t('nemdns.loading_current')}</Typography></Box>}
            {NEM_DNS_FIELDS.map((f) => (
              <FormRow key={f} label={t(fieldLabelKey(f))} top hint={t(`nemdns.hint_${f}`)}>
                <Field
                  ariaLabel={t(fieldLabelKey(f))}
                  value={record[f]}
                  onChange={(e) => setField(f, e.target.value)}
                  multiline={f === 'other'}
                  minRows={f === 'other' ? 2 : undefined}
                  htmlInput={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
                />
              </FormRow>
            ))}
            <Typography variant="body2" sx={{ color: tooLong ? 'error.main' : 'text.secondary', mt: 1 }}>
              {tooLong ? t('nemdns.too_long', { max: NEM_DNS_MAX_MESSAGE_BYTES }) : t('nemdns.bytes_left', { left: NEM_DNS_MAX_MESSAGE_BYTES - bytes })}
            </Typography>
          </SectionCard>

          <SectionCard title={t('nemdns.send_title')}>
            <FormRow label={t('nemdns.fee')}>
              <Typography>{xemText(fee.transfer + fee.wrapper)}</Typography>
            </FormRow>
            {fee.wrapper > 0n && <Typography variant="body2" sx={{ color: 'text.secondary', pb: 1 }}>{t('nemdns.fee_multisig_note', { transfer: xemText(fee.transfer), wrapper: xemText(fee.wrapper) })}</Typography>}
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>{t('nemdns.send_note')}</Typography>
          </SectionCard>

          {sent !== null && (
            <Alert severity="success" sx={{ mb: 2 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('nemdns.sent_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>{sent.multisig ? t('nemdns.sent_multisig') : t('nemdns.sent_note')}</Typography>
              {sent.hash !== '' && (
                <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>
                  <Box component="a" href={nemExplorerTxUrl(sent.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: 'inherit' }}>{t('multisig.view_explorer')}</Box>
                  {' · '}
                  <Box component="a" href={nemExplorerNamespaceUrl(sent.namespace)} target="_blank" rel="noopener noreferrer" sx={{ color: 'inherit' }}>{t('nemdns.view_namespace')}</Box>
                </Typography>
              )}
            </Alert>
          )}

          {ledgerWallet ? (
            <Button variant="contained" size="large" fullWidth disabled={!canSend} onClick={() => { void onLedger(); }} startIcon={<UsbOutlinedIcon />} sx={{ py: 1.25 }}>
              {sending ? t('ledger.confirm_on_device') : t('ledger.sign_button')}
            </Button>
          ) : (
            <Button variant="contained" size="large" fullWidth disabled={!canSend} onClick={() => setShowPassword(true)} startIcon={<LockOutlinedIcon />} sx={{ py: 1.25 }}>
              {sending ? t('nemdns.sending') : t('nemdns.send_button')}
            </Button>
          )}
        </>
      )}

      <PasswordDialog open={showPassword} mode="check" popup onClose={() => setShowPassword(false)} onPass={(password) => { setShowPassword(false); void onPassed(password); }} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </>
  );
}

export default function NemDns() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const initialName = params.get('name') ?? '';
  const [tab, setTab] = useState<TabKey>('search');
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', maxWidth: 840, px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemdns.title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('nemdns.about')}</Typography>
        <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="search" label={t('nemdns.tab_search')} />
          <Tab value="configure" label={t('nemdns.tab_configure')} />
        </Tabs>
        {tab === 'search' ? <SearchPanel initialName={initialName} /> : <ConfigurePanel />}
      </Box>
    </Box>
  );
}
