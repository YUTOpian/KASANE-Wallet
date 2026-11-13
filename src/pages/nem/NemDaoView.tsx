import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, FormControl, FormControlLabel, Radio, RadioGroup, Tab, Tabs, Typography } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { fetchNemMosaicHolding } from '../../lib/nem/api';
import { normalizeNemAddress, prettyNemAddress } from '../../lib/nem/crypto';
import { ACCESS_CHANGE_COST, accessChangeShortfall, changeDaoAccess, fetchDaoMembers, fetchDaoNamespaceStatus, fetchNemDao } from '../../lib/nem/dao';
import type { NemDao } from '../../lib/nem/dao';
import { canEnterNemDao, daoNamespaceOf, isDaoDissolved, isNemDaoId } from '../../lib/nem/daoCore';
import type { DaoMember, DaoNamespaceStatus, NemDaoAccess } from '../../lib/nem/daoCore';
import { useAppStore } from '../../store/appStore';
import NemNamespaceRenew from './NemNamespaceRenew';
import { NemMultisigConvertEmbedded } from './NemMultisigConvert';
import { GovernanceTab } from './NemDaoGovernance';
import { SectionCard, ValueBox, mono } from '../multisig/parts';
import { DistributeForm, ExchangeTab, ItemsTab, useConfirm } from './NemDaoItems';
import NemDaoBotGuide from './NemDaoBotGuide';
import NemDaoLimited from './NemDaoLimited';
import { LoadingBox, groupDigits, nemDaoPath, rememberNemDao, shortAddress, useNemActor } from './NemDaoUi';
import { nemXem } from './parts';

const TABS = ['home', 'members', 'governance', 'exchange', 'limited', 'items', 'settings', 'namespace'] as const;
type TabKey = (typeof TABS)[number];


// 開いた NEM の DAO: 上に名前とタブ、下に選んだ画面。ホーム / 会員（トークンの配布は管理者だけ）/ ガバナンス投票。
export default function NemDaoView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const [params] = useSearchParams();
  const id = (params.get('id') ?? '').trim().toUpperCase();
  const actor = useNemActor();
  const [dao, setDao] = useState<NemDao | null>(null);
  const [members, setMembers] = useState<DaoMember[] | null>(null);
  const [myHolding, setMyHolding] = useState<bigint | null>(null);
  const [nsStatus, setNsStatus] = useState<DaoNamespaceStatus | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!actor) return undefined;
    if (!isNemDaoId(id)) { setError('not_dao'); return undefined; }
    let cancelled = false;
    setMembers(null);
    setNsStatus(null);
    (async () => {
      try {
        const info = await fetchNemDao(id);
        if (cancelled) return;
        setDao(info);
        setError('');
        fetchDaoNamespaceStatus(info).then((st) => { if (!cancelled) setNsStatus(st); });
        const [list, mine] = await Promise.all([fetchDaoMembers(info).catch(() => [] as DaoMember[]), fetchNemMosaicHolding(actor.address, info.mosaicId)]);
        if (cancelled) return;
        setMembers(list);
        setMyHolding(mine);
        // 入れない DAO は「最近開いた DAO」に残さない。
        const admin = info.admins.some((a) => a.address === normalizeNemAddress(actor.address));
        if (canEnterNemDao(info.access, admin, mine ?? 0n)) rememberNemDao(network, { id: info.id, name: info.name });
      } catch (e) {
        if (!cancelled) setError((e as Error).message === 'not_dao' ? 'not_dao' : 'load_failed');
      }
    })();
    return () => { cancelled = true; };
  }, [actor, id, network, version]);

  const isAdmin = !!dao && !!actor && dao.admins.some((a) => a.address === normalizeNemAddress(actor.address));
  // ネームスペースの期限が切れた（または他の人に移った）DAO は、解散した扱い。ホームだけ見られる。
  // 管理者は、猶予期間のうちなら「ネームスペース」タブから更新して元に戻せる（他の人に移っていたら更新できない）。
  const dissolved = isDaoDissolved(nsStatus);
  const lost = nsStatus?.state === 'lost';
  // 「ポイント・特典」の管理とネームスペースの更新は管理者だけ。
  const visibleTabs = TABS.filter((k) => {
    if (k === 'home') return true;
    if (k === 'namespace') return isAdmin && !lost;
    if (dissolved) return false;
    return (k !== 'items' && k !== 'settings') || isAdmin;
  });
  // 入る条件が「トークンあり」の DAO は、管理者かガバナンストークンの保有者だけが中に入れる（保有量が読めないときは入れず、読み直しを案内する）。
  const gateLoading = !!dao && dao.access === 'token' && !isAdmin && members === null;
  const entered = !!dao && !gateLoading && canEnterNemDao(dao.access, isAdmin, myHolding ?? 0n) && (dao.access === 'id' || isAdmin || myHolding !== null);
  const requested = (params.get('tab') ?? 'home') as TabKey;
  const tab: TabKey = visibleTabs.includes(requested) ? requested : 'home';

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton onBack={() => navigate('/dao')} back="/dao" />
      <Box sx={{ px: { xs: 2, md: 4 }, py: 1, textAlign: 'left' }}>
        {error && <Alert severity="error" sx={{ mt: 2 }}>{t(`nemdao.err_${error}`)}</Alert>}
        {!error && !dao && <LoadingBox />}
        {dao && actor && gateLoading && <LoadingBox />}
        {dao && actor && !gateLoading && !entered && (
          <>
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>{dao.name || t('nemdao.unnamed')}</Typography>
            <SectionCard title={t('nemdao.gate_title')}>
              <Alert severity={myHolding === null ? 'warning' : 'info'} sx={{ mb: 2 }}>{t(myHolding === null ? 'nemdao.gate_unreadable' : 'nemdao.gate_lead')}</Alert>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemdao.gate_token')}</Typography>
              <Typography variant="body2" sx={{ ...mono, mb: 1 }}>{dao.mosaicId}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemdao.gate_held')}</Typography>
              <Typography variant="body2">{myHolding === null ? '—' : groupDigits(myHolding)}</Typography>
              {myHolding === null && <Box sx={{ mt: 2 }}><Button variant="outlined" onClick={reload}>{t('nemdao.gate_reload')}</Button></Box>}
            </SectionCard>
          </>
        )}
        {dao && actor && entered && (
          <>
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>
              {dao.name || t('nemdao.unnamed')}
              {dissolved && <Chip size="small" color="error" label={t('nemdao.badge_dissolved')} sx={{ ml: 1, verticalAlign: 'middle' }} />}
            </Typography>
            <Tabs value={tab} onChange={(_, v: TabKey) => navigate(nemDaoPath(dao.id, v), { replace: true })} variant="scrollable" scrollButtons="auto" sx={{ mb: 2 }}>
              {visibleTabs.map((k) => <Tab key={k} value={k} label={t(`nemdao.tab_${k}`)} />)}
            </Tabs>
            {tab === 'home' && <HomeTab dao={dao} isAdmin={isAdmin} myHolding={myHolding} nsStatus={nsStatus} />}
            {tab === 'members' && <MembersTab dao={dao} actorAddress={actor.address} isAdmin={isAdmin} members={members} reload={reload} />}
            {tab === 'governance' && <GovernanceTab dao={dao} actor={actor} isAdmin={isAdmin} myHolding={myHolding} />}
            {tab === 'exchange' && <ExchangeTab dao={dao} actorAddress={actor.address} isAdmin={isAdmin} reload={reload} version={version} />}
            {tab === 'limited' && <NemDaoLimited dao={dao} actorAddress={actor.address} isAdmin={isAdmin} reload={reload} version={version} />}
            {tab === 'settings' && isAdmin && <AccessTab dao={dao} reload={reload} />}
            {tab === 'namespace' && isAdmin && <NamespaceTab dao={dao} status={nsStatus} reload={reload} />}
            {tab === 'items' && isAdmin && <ItemsTab dao={dao} actorAddress={actor.address} reload={reload} version={version} />}
          </>
        )}
      </Box>
    </Box>
  );
}

// 管理者用「DAO 設定」タブ: ページに入る条件（ID だけ / ID とガバナンストークン）。ガバナンストークンの説明に書く（定義の送り直し）。
function AccessTab({ dao, reload }: { dao: NemDao; reload: () => void }) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<NemDaoAccess>(dao.access);
  // 管理者の追加・削除（マルチシグの設定変更）は、画面を移らずにこの中で行う。
  const [editingAdmins, setEditingAdmins] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setConfirm, screen } = useConfirm('nemdao.done_access', reload);

  const toConfirm = async () => {
    setError('');
    setBusy(true);
    try {
      const short = await accessChangeShortfall(dao).catch(() => null);
      setConfirm({
        rows: [
          { label: t('nemdao.access_row_action'), value: t('nemdao.access_row_value') },
          { label: t('nemdao.access_row_mode'), value: t(access === 'token' ? 'nemdao.access_token' : 'nemdao.access_id'), big: true },
          { label: t('nemdao.row_fee'), value: t('nemdao.access_row_fee', { cost: nemXem(ACCESS_CHANGE_COST) }) },
          ...(short !== null && short > 0n ? [{ label: t('nemdao.access_row_deposit'), value: t('nemdao.access_row_deposit_value', { amount: nemXem(short) }) }] : []),
          ...(dao.admins.length > 1 ? [{ label: t('nemdao.row_cosign'), value: t('nemdao.row_cosign_value') }] : []),
        ],
        run: (key) => changeDaoAccess(key.privateKey, key.publicKey, dao, access),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (screen) return screen;
  if (editingAdmins) {
    return (
      <>
        <Button onClick={() => setEditingAdmins(false)} sx={{ mb: 1 }}>{t('nemdao.settings_back')}</Button>
        <NemMultisigConvertEmbedded account={dao.address} embedded onDone={() => { setEditingAdmins(false); reload(); }} />
      </>
    );
  }
  return (
    <>
      <SectionCard title={t('nemdao.admins')}>
        {dao.admins.length === 0 ? <Alert severity="warning">{t('nemdao.no_admins')}</Alert> : dao.admins.map((a) => (
          <Typography key={a.address} variant="body2" sx={{ ...mono, py: 0.5 }}>{prettyNemAddress(a.address)}</Typography>
        ))}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>
          {dao.minCosignatories === 0 ? t('nemdao.approval_all') : t('nemdao.approval_n', { count: dao.minCosignatories })}
        </Typography>
        <Box sx={{ mt: 1.5 }}>
          <Button variant="outlined" onClick={() => setEditingAdmins(true)}>{t('nemdao.go_multisig_edit')}</Button>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>{t('nemdao.go_multisig_hint')}</Typography>
        </Box>
      </SectionCard>
    <SectionCard title={t('nemdao.access_title')}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('nemdao.access_lead')}</Typography>
      <FormControl>
        <RadioGroup value={access} onChange={(e) => setAccess(e.target.value as NemDaoAccess)}>
          <FormControlLabel value="id" control={<Radio />} label={t('nemdao.access_id')} />
          <FormControlLabel value="token" control={<Radio />} label={t('nemdao.access_token')} />
        </RadioGroup>
      </FormControl>
      <Typography variant="caption" sx={{ display: 'block', mt: 1, mb: 1, color: 'text.secondary' }}>{t('nemdao.access_note')}</Typography>
      {error && <Alert severity="error" sx={{ mb: 1 }}>{t('nemdao.err_access', { detail: error })}</Alert>}
      <Button variant="contained" size="large" fullWidth disabled={busy || access === dao.access} onClick={toConfirm} sx={{ py: 1.25 }}>
        {busy ? <CircularProgress size={24} /> : t('nemdao.access_save')}
      </Button>
    </SectionCard>
    <NemDaoBotGuide dao={dao} onAddAdmin={() => setEditingAdmins(true)} />
    </>
  );
}

// DAO のネームスペースの期限の警告。切れる 30 日前から出す（更新画面に出てくるのもこの範囲から）。
// 期限が切れた・他の人に移ったときは「解散」の表示。管理者には、DAO 画面の「ネームスペース」タブ（更新）への道を出す。
function NamespaceExpiryAlert({ dao, isAdmin, status }: { dao: NemDao; isAdmin: boolean; status: DaoNamespaceStatus | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!status || status.state === 'ok') return null;
  const ns = daoNamespaceOf(dao.mosaicId);
  const severity = status.state === 'soon' || status.state === 'unknown' ? 'warning' : 'error';
  const canRenew = isAdmin && status.state !== 'lost';
  return (
    <Alert
      severity={severity}
      sx={{ mb: 2 }}
      action={canRenew ? <Button color="inherit" size="small" onClick={() => navigate(nemDaoPath(dao.id, 'namespace'))}>{t('nemdao.ns_renew_button')}</Button> : undefined}
    >
      {isDaoDissolved(status) && <Typography component="div" sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemdao.dissolved_title')}</Typography>}
      {t(`nemdao.ns_${status.state}`, { namespace: ns, days: status.remainingDays ?? 0 })}
    </Alert>
  );
}

// 管理者用「ネームスペース」タブ: 期限の状態と、DAO アカウントのネームスペースの更新（マルチシグで DAO アカウントの名前で送る）。
function NamespaceTab({ dao, status, reload }: { dao: NemDao; status: DaoNamespaceStatus | null; reload: () => void }) {
  const { t } = useTranslation();
  const ns = daoNamespaceOf(dao.mosaicId);
  return (
    <>
      <NamespaceExpiryAlert dao={dao} isAdmin={false} status={status} />
      <SectionCard title={t('nemdao.ns_tab_title', { namespace: ns })}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{t('nemdao.ns_renew_howto')}</Typography>
        {status?.state === 'ok' && status.remainingDays !== undefined && (
          <Alert severity="info" sx={{ mb: 1 }}>{t('nemdao.ns_ok', { days: status.remainingDays })}</Alert>
        )}
      </SectionCard>
      <NemNamespaceRenew lockedAccount={dao.address} initialName={ns} onDone={reload} />
    </>
  );
}

function HomeTab({ dao, isAdmin, myHolding, nsStatus }: { dao: NemDao; isAdmin: boolean; myHolding: bigint | null; nsStatus: DaoNamespaceStatus | null }) {
  const { t } = useTranslation();
  return (
    <>
      <NamespaceExpiryAlert dao={dao} isAdmin={isAdmin} status={nsStatus} />
      <SectionCard title={t('nemdao.home_about')}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('nemdao.row_dao_address')}</Typography>
        <ValueBox>{prettyNemAddress(dao.address)}</ValueBox>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>{t('nemdao.f_dao_id')}</Typography>
        <ValueBox>{dao.id}</ValueBox>
        <Box sx={{ mt: 1.5 }}>
          <Chip size="small" color={isAdmin ? 'primary' : 'default'} label={isAdmin ? t('nemdao.role_admin') : t('nemdao.role_member')} />
        </Box>
      </SectionCard>
      <SectionCard title={t('nemdao.home_holdings')}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1, gap: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography>{t('nemdao.row_governance_token')}</Typography>
            <Typography variant="caption" sx={{ ...mono, color: 'text.secondary' }}>{dao.mosaicId}</Typography>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{t('nemdao.supply_value', { amount: groupDigits(dao.supply) })}</Typography>
          </Box>
          <Typography sx={{ fontWeight: 'bold' }}>{myHolding === null ? '—' : groupDigits(myHolding)}</Typography>
        </Box>
      </SectionCard>
    </>
  );
}

function MembersTab({ dao, actorAddress, isAdmin, members, reload }: { dao: NemDao; actorAddress: string; isAdmin: boolean; members: DaoMember[] | null; reload: () => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const total = members?.reduce((s, m) => s + m.amount, 0n) ?? 0n;

  return (
    <>
      {!confirming && (
        <SectionCard title={t('nemdao.members_title')}>
          {members === null ? <LoadingBox /> : members.length === 0 ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nemdao.members_none')}</Typography> : (
            <Box>
              {members.map((m) => (
                <Box key={m.address} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.75, flexWrap: 'wrap' }}>
                  <Typography variant="body2" sx={mono}>{shortAddress(m.address)}</Typography>
                  <Typography variant="body2">{groupDigits(m.amount)}{total > 0n ? ` (${(Number((m.amount * 10000n) / total) / 100).toFixed(2)}%)` : ''}</Typography>
                </Box>
              ))}
            </Box>
          )}
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('nemdao.members_note')}</Typography>
        </SectionCard>
      )}
      {isAdmin ? (
        <DistributeForm mosaicId={dao.mosaicId} title={t('nemdao.distribute_title')} actorAddress={actorAddress} reload={reload} onConfirming={setConfirming} />
      ) : (
        <Alert severity="info">{t('nemdao.admin_only_distribute')}</Alert>
      )}
    </>
  );
}
