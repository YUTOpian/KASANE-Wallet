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
import { SssError, sssErrorKey } from '../../lib/sss';
import { LedgerError } from '../../lib/ledger/framing';
import { ensureLedgerConnected, ledgerErrorKey, preferredLedgerLink } from '../../lib/ledger/session';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { SymbolSendError, explorerNamespaceUrl, explorerTxUrl, fetchOwnedNamespaces } from '../../lib/symbol/api';
import { prettyAddress } from '../../lib/symbol/crypto';
import {
  SYMBOL_DNS_MAX_MESSAGE_BYTES, emptySymbolDnsRecord, normalizeSymbolDnsName,
} from '../../lib/symbol/dns';
import type { SymbolDnsRecord } from '../../lib/symbol/dns';
import {
  SymbolDnsError, lookupSymbolDns, publishSymbolDns, quoteSymbolDnsFee, quoteSymbolDnsFromMultisig, symbolDnsPointer,
} from '../../lib/symbol/dnsApi';
import type { SymbolDnsLookup } from '../../lib/symbol/dnsApi';
import { fetchAccountPublicKey, fetchCosignedAccounts, fetchCosignerGraph } from '../../lib/symbol/multisigApi';
import type { CosignedAccount, MultisigCost } from '../../lib/symbol/multisigApi';
import { planApproval } from '../../lib/symbol/multisigTree';
import type { ApprovalPlan } from '../../lib/symbol/multisigTree';
import { NEM_DNS_FIELDS, nemDnsMessageBytes, nemDnsSiteUrl } from '../../lib/nem/dns';
import type { NemDnsField } from '../../lib/nem/dns';
import { useAppStore } from '../../store/appStore';
import { Field, FormRow, SectionCard, ValueBox, xymText } from '../multisig/parts';

// Symbol の「DNS」: ネームスペース（"kasane"）に、ポインタアカウント経由で連絡先などを紐づける。NEM の DNS（pages/nem/NemDns.tsx）と同じ画面。
// 検索タブ: 名前から登録内容を調べる（持ち主が署名した最新のものだけが表示される）。
// 設定タブ: 自分（または自分が連署するマルチシグ）のネームスペースの登録内容を、書き込む・更新する。
// しくみは lib/symbol/dns.ts。ブロックチェーンに記録されるので、だれでも読める。文言は、Symbol 固有のものだけ symboldns.*、ほかは nemdns.* を使う。

type TabKey = 'search' | 'configure';

/** One line of a result: the label on the left, the value on the right. */
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
  const [result, setResult] = useState<SymbolDnsLookup | null>(null);

  const search = useCallback(async (input: string) => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      setResult(await lookupSymbolDns(input));
    } catch (e) {
      if (e instanceof SymbolDnsError) setError(e.code === 'invalid_name' ? t('symboldns.err_invalid_name') : t(`nemdns.err_${e.code}`));
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
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('symboldns.search_about')}</Typography>
      <SectionCard>
        <FormRow label={t('nemdns.search_label')} top hint={t('symboldns.search_hint')}>
          <Box onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() !== '' && !loading) void search(name); }}>
            <Field
              ariaLabel={t('nemdns.search_label')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="namespace"
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
          <SectionCard title={result.namespace}>
            {result.expired && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('nemdns.expired_note')}</Alert>}
            <InfoRow label={t('nemdns.owner')}>
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{prettyAddress(result.owner)}</Box>
            </InfoRow>
            <InfoRow label={t('nemdns.pointer_address')}>
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{prettyAddress(result.pointerAddress)}</Box>
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
              {found.updatedAtMs !== null && <InfoRow label={t('nemdns.updated_at')}>{new Date(found.updatedAtMs).toLocaleString()}</InfoRow>}
              {found.hash !== '' && (
                <InfoRow label={t('nemdns.record_tx')}>
                  <Box component="a" href={explorerTxUrl(found.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: 'primary.main', fontFamily: 'monospace' }}>{found.hash}</Box>
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
function ConfigurePanel() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  // The multisig accounts this wallet can sign for (not with a Ledger: the aggregate is signed with a key held here).
  const [cosigned, setCosigned] = useState<CosignedAccount[]>([]);
  const [ownerAddress, setOwnerAddress] = useState(''); // '' = this account, otherwise a multisig account (address)
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [plan, setPlan] = useState<ApprovalPlan | null>(null);
  const [namespaces, setNamespaces] = useState<string[] | null>(null);
  const [namespace, setNamespace] = useState('');
  const [record, setRecord] = useState<SymbolDnsRecord>(emptySymbolDnsRecord());
  const [recordLoading, setRecordLoading] = useState(false);
  const [fee, setFee] = useState<bigint | null>(null);
  const [multisigCost, setMultisigCost] = useState<MultisigCost | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sent, setSent] = useState<{ hash: string; waiting: boolean; namespace: string } | null>(null);

  const fromMultisig = ownerAddress !== '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSent(null);
    setCosigned([]);
    setOwnerAddress('');
    (async () => {
      const w = await WalletsHelper.getActive();
      if (!w || cancelled) return;
      if (!w.ledger && !w.sss && !w.watchOnly) {
        try {
          const list = await fetchCosignedAccounts(w.address);
          if (!cancelled) setCosigned(list);
        } catch (e) {
          console.error('Failed to read the multisig accounts', e);
        }
      }
      if (!cancelled) setWallet(w);
    })().catch((e) => console.error('Failed to load the account', e)).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [network]);

  // In the name of a multisig account: the public key to send from, and what it takes to approve it.
  useEffect(() => {
    setOwnerKey(null);
    setPlan(null);
    if (!fromMultisig || wallet === null) return undefined;
    let live = true;
    Promise.all([fetchAccountPublicKey(ownerAddress), fetchCosignerGraph(ownerAddress)]).then(([key, graph]) => {
      if (!live) return;
      setOwnerKey(key);
      setPlan(planApproval(graph, ownerAddress, wallet.address));
    }, (e) => console.error('Failed to load the multisig account', e));
    return () => { live = false; };
  }, [fromMultisig, ownerAddress, wallet, network]);
  const multisigBonded = plan ? !plan.selfSufficient : true;
  const multisigSignatures = Math.max(plan?.others ?? 1, 1);
  const multisigBlocked = fromMultisig && (plan === null || !plan.eligible || ownerKey === null);

  // The namespaces of the chosen owner that can still be written to.
  useEffect(() => {
    if (wallet === null) return undefined;
    let cancelled = false;
    setNamespaces(null);
    setNamespace('');
    setRecord(emptySymbolDnsRecord());
    fetchOwnedNamespaces(fromMultisig ? ownerAddress : wallet.address)
      .then((list) => { if (!cancelled) setNamespaces(list.filter((n) => !n.expired).map((n) => n.name)); })
      .catch((e) => { console.error('Failed to read the namespaces', e); if (!cancelled) setNamespaces([]); });
    return () => { cancelled = true; };
  }, [wallet, fromMultisig, ownerAddress]);

  // Choosing a namespace shows what is registered now (that is what an update starts from).
  const onSelectNamespace = async (ns: string) => {
    setNamespace(ns);
    setSent(null);
    setRecord(emptySymbolDnsRecord());
    if (ns === '') return;
    setRecordLoading(true);
    try {
      const lookup = await lookupSymbolDns(ns);
      setRecord(lookup.found?.record ?? emptySymbolDnsRecord());
    } catch (e) {
      console.error('Failed to read the current DNS record', e);
    } finally {
      setRecordLoading(false);
    }
  };

  const pointer = useMemo(() => {
    const ns = namespace === '' ? null : normalizeSymbolDnsName(namespace);
    return ns === null ? null : symbolDnsPointer(ns);
  }, [namespace]);

  const bytes = nemDnsMessageBytes(record);
  const tooLong = bytes > SYMBOL_DNS_MAX_MESSAGE_BYTES;

  // The fee follows the text (its length) and the fee level of the settings; asked of the node a moment after the typing stops.
  useEffect(() => {
    setFee(null);
    setMultisigCost(null);
    if (pointer === null || tooLong) return undefined;
    if (fromMultisig && plan === null) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      if (fromMultisig) {
        quoteSymbolDnsFromMultisig(record, multisigSignatures, multisigBonded)
          .then((c) => { if (live) setMultisigCost(c); }, () => { if (live) setMultisigCost(null); });
      } else {
        quoteSymbolDnsFee(record).then((f) => { if (live) setFee(f); }, () => { if (live) setFee(null); });
      }
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [pointer, tooLong, record, fromMultisig, plan, multisigBonded, multisigSignatures]);

  const shownFee = fromMultisig ? (multisigCost ? multisigCost.aggregateFee.fee + multisigCost.lockFee : null) : fee;
  const ledgerWallet = wallet?.ledger === true;
  const canSend = wallet !== null && !wallet.watchOnly && pointer !== null && !tooLong && !recordLoading && !sending && shownFee !== null && !multisigBlocked;

  const publish = async (privateKey: string, ledgerIndex?: number) => {
    if (wallet === null || pointer === null) return;
    const result = await publishSymbolDns({
      namespace: pointer.namespace,
      record,
      privateKey,
      publicKey: wallet.publicKey,
      ledgerIndex,
      sss: wallet.sss,
      multisigPublicKey: fromMultisig ? ownerKey ?? undefined : undefined,
      bonded: multisigBonded,
      cosignatureCount: multisigSignatures,
    });
    setSent({ hash: result.hash, waiting: result.bonded, namespace: pointer.namespace });
  };

  const fail = (e: unknown) => {
    if (e instanceof SssError) {
      setErrorMessage(t(sssErrorKey(e)));
      return;
    }
    if (e instanceof LedgerError) {
      if (e.kind !== 'no_device') setErrorMessage(t(ledgerErrorKey(e), { chain: 'Symbol' }));
      return;
    }
    console.error('Failed to register the DNS record', e);
    const code = e instanceof SymbolSendError ? e.code.toUpperCase() : '';
    if (code.includes('INSUFFICIENT_BALANCE')) setErrorMessage(t('symboldns.err_insufficient'));
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
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('symboldns.configure_about')}</Typography>
      <Alert severity="warning" sx={{ mb: 2 }}>{t('nemdns.public_warning')}</Alert>

      <SectionCard>
        {cosigned.length > 0 && (
          <FormRow label={t('nemdns.owner_account')} top hint={t('nemdns.owner_account_hint')}>
            <Field select ariaLabel={t('nemdns.owner_account')} value={ownerAddress} onChange={(e) => { setOwnerAddress(e.target.value); setSent(null); }}>
              <MenuItem value="" sx={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{`${t('nemdns.owner_self')}  ${prettyAddress(wallet.address)}`}</MenuItem>
              {cosigned.map((a) => (
                <MenuItem key={a.info.address} value={a.info.address} sx={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {`${t('nemdns.owner_multisig')}  ${prettyAddress(a.info.address)}`}
                </MenuItem>
              ))}
            </Field>
          </FormRow>
        )}
        {fromMultisig && plan !== null && !plan.eligible && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('apostille.multisig_not_eligible')}</Alert>}
        {fromMultisig && plan !== null && plan.eligible && multisigBonded && <Alert severity="info" sx={{ mb: 1.5 }}>{t('apostille.multisig_waiting_note', { count: plan.others + 1 })}</Alert>}
        <FormRow label={t('nemdns.namespace')} top>
          {namespaces === null ? (
            <Box sx={{ py: 1 }}><CircularProgress size={20} /></Box>
          ) : namespaces.length === 0 ? (
            <Alert severity="info">{t('nemdns.no_namespace')}</Alert>
          ) : (
            <Field select ariaLabel={t('nemdns.namespace')} value={namespace} onChange={(e) => { void onSelectNamespace(e.target.value); }}>
              <MenuItem value=""><em>{t('nemdns.select_namespace')}</em></MenuItem>
              {namespaces.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
            </Field>
          )}
        </FormRow>
        {pointer !== null && (
          <FormRow label={t('nemdns.pointer_address')} top hint={t('symboldns.pointer_hint')}>
            <ValueBox>{prettyAddress(pointer.address)}</ValueBox>
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
              {tooLong ? t('nemdns.too_long', { max: SYMBOL_DNS_MAX_MESSAGE_BYTES }) : t('nemdns.bytes_left', { left: SYMBOL_DNS_MAX_MESSAGE_BYTES - bytes })}
            </Typography>
          </SectionCard>

          <SectionCard title={t('nemdns.send_title')}>
            <FormRow label={t('nemdns.fee')}>
              <Typography>{shownFee === null ? '…' : xymText(shownFee)}</Typography>
            </FormRow>
            {fromMultisig && multisigCost !== null && multisigCost.lockAmount > 0n && (
              <Typography variant="body2" sx={{ color: 'text.secondary', pb: 1 }}>{t('apostille.multisig_lock_note', { amount: xymText(multisigCost.lockAmount) })}</Typography>
            )}
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>{t('symboldns.send_note')}</Typography>
          </SectionCard>

          {sent !== null && (
            <Alert severity="success" sx={{ mb: 2 }}>
              <Typography sx={{ fontWeight: 'bold' }}>{t('nemdns.sent_title')}</Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>{sent.waiting ? t('apostille.multisig_waiting_result') : t('nemdns.sent_note')}</Typography>
              {sent.hash !== '' && (
                <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-all' }}>
                  {/* A transaction waiting for signatures is not in the explorer yet. */}
                  {!sent.waiting && (
                    <>
                      <Box component="a" href={explorerTxUrl(sent.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: 'inherit' }}>{t('multisig.view_explorer')}</Box>
                      {' · '}
                    </>
                  )}
                  <Box component="a" href={explorerNamespaceUrl(sent.namespace)} target="_blank" rel="noopener noreferrer" sx={{ color: 'inherit' }}>{t('nemdns.view_namespace')}</Box>
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

export default function SymbolDns() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const initialName = params.get('name') ?? '';
  const [tab, setTab] = useState<TabKey>('search');
  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', maxWidth: 840, px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemdns.title')}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, lineHeight: 1.8 }}>{t('symboldns.about')}</Typography>
        <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="search" label={t('nemdns.tab_search')} />
          <Tab value="configure" label={t('nemdns.tab_configure')} />
        </Tabs>
        {tab === 'search' ? <SearchPanel initialName={initialName} /> : <ConfigurePanel />}
      </Box>
    </Box>
  );
}
