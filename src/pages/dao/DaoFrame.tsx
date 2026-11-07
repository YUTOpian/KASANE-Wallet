import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Tab, Tabs, Typography } from '@mui/material';
import { SectionCard, mono } from '../multisig/parts';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { resolveDaoSigner } from '../../lib/dao/daoActions';
import { fetchDao, fetchDaoMosaics, fetchHeld, fetchOwnedNamespaces, isDaoId } from '../../lib/dao/daoApi';
import { canEnterDao } from '../../lib/dao/daoCore';
import type { DaoInfo, DaoMosaic, OwnedNamespace } from '../../lib/dao/daoApi';
import type { AggregateSigner } from '../../lib/symbol/aggregate';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { useAppStore } from '../../store/appStore';
import DaoExchange from './DaoExchange';
import DaoGovernance from './DaoGovernance';
import DaoHome from './DaoHome';
import DaoLimited from './DaoLimited';
import DaoMosaics from './DaoMosaics';
import DaoNamespaces from './DaoNamespaces';
import DaoSettings from './DaoSettings';
import { daoPath, rememberDao } from './DaoTop';
import { DaoCtx, LoadingBox, useActor } from './daoUi';
import type { DaoContext } from './daoUi';

const MEMBER_TABS = ['home', 'governance', 'exchange', 'limited'] as const;
const ADMIN_TABS = ['settings', 'reward', 'point', 'namespace'] as const;
type Tab = (typeof MEMBER_TABS)[number] | (typeof ADMIN_TABS)[number];

// 開いた DAO の枠: 上に名前とタブ、下に選んだ画面。管理者だけが見られるタブ（DAO 設定・特典管理・ポイント管理・ネームスペース）もある。
export default function DaoFrame() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const [params] = useSearchParams();
  const id = (params.get('id') ?? '').toUpperCase();
  const actor = useActor();
  const [dao, setDao] = useState<DaoInfo | null>(null);
  const [mosaics, setMosaics] = useState<DaoMosaic[]>([]);
  const [signer, setSigner] = useState<AggregateSigner | null>(null);
  const [namespaces, setNamespaces] = useState<OwnedNamespace[] | null>(null);
  /** 自分が持っているガバナンストークンの量（入る条件が「トークンあり」のときの判定に使う）。 */
  const [myHeld, setMyHeld] = useState<bigint>(0n);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!actor) return undefined;
    if (!isDaoId(id)) { setError('not_dao'); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchDao(id);
        const [m, s, held, ns] = await Promise.all([fetchDaoMosaics(info), resolveDaoSigner(actor, info).catch(() => null), fetchHeld(actor.address), fetchOwnedNamespaces(info.address).catch(() => null)]);
        if (cancelled) return;
        const mine = held.get(info.governanceTokenId) ?? 0n;
        setDao(info);
        setMosaics(m);
        setSigner(s);
        setNamespaces(ns);
        setMyHeld(mine);
        setError('');
        // 入れない DAO は「最近開いた DAO」に残さない。
        const admin = info.admins.map(normalizeAddress).includes(normalizeAddress(actor.address));
        if (canEnterDao(info.access, admin, mine)) rememberDao(network, { id: info.id, name: info.name });
      } catch (e) {
        if (!cancelled) { const m = (e as Error).message; setError(m === 'not_dao' || m === 'not_found' ? m : 'load_failed'); }
      }
    })();
    return () => { cancelled = true; };
  }, [actor, id, network, version]);

  const isAdmin = !!dao && !!actor && dao.admins.map(normalizeAddress).includes(normalizeAddress(actor.address));
  const entered = !!dao && canEnterDao(dao.access, isAdmin, myHeld);
  const tabs: Tab[] = isAdmin ? [...MEMBER_TABS, ...ADMIN_TABS] : [...MEMBER_TABS];
  const requested = (params.get('tab') ?? 'home') as Tab;
  const tab: Tab = tabs.includes(requested) ? requested : 'home';
  const ctx: DaoContext | null = useMemo(() => (dao && actor ? { dao, actor, isAdmin, signer, mosaics, namespaces, reload } : null), [dao, actor, isAdmin, signer, mosaics, namespaces, reload]);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton onBack={() => navigate('/dao')} back="/dao" />
      <Box sx={{ px: { xs: 2, md: 4 }, py: 1, textAlign: 'left' }}>
        {error && <Alert severity="error" sx={{ mt: 2 }}>{t(`dao.err_${error}`, { network })}</Alert>}
        {!error && !ctx && <LoadingBox />}
        {ctx && !entered && (
          <>
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>{ctx.dao.name || t('dao.unnamed')}</Typography>
            <SectionCard title={t('dao.gate_title')}>
              <Alert severity="info" sx={{ mb: 2 }}>{t('dao.gate_lead')}</Alert>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.gate_token')}</Typography>
              <Typography variant="body2" sx={{ ...mono, mb: 1 }}>{ctx.dao.governanceTokenId}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('dao.gate_held')}</Typography>
              <Typography variant="body2">{myHeld.toString()}</Typography>
            </SectionCard>
          </>
        )}
        {ctx && entered && (
          <>
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>{ctx.dao.name || t('dao.unnamed')}</Typography>
            <Tabs value={tab} onChange={(_, v: Tab) => navigate(daoPath(ctx.dao.id, v), { replace: true })} variant="scrollable" scrollButtons="auto" sx={{ mb: 2 }}>
              {tabs.map((k) => <Tab key={k} value={k} label={t(`dao.tab_${k}`)} />)}
            </Tabs>
            <DaoCtx.Provider value={ctx}>
              {tab === 'home' && <DaoHome />}
              {tab === 'governance' && <DaoGovernance />}
              {tab === 'exchange' && <DaoExchange />}
              {tab === 'limited' && <DaoLimited />}
              {tab === 'settings' && <DaoSettings />}
              {tab === 'reward' && <DaoMosaics kind="reward" />}
              {tab === 'point' && <DaoMosaics kind="point" />}
              {tab === 'namespace' && <DaoNamespaces />}
            </DaoCtx.Provider>
          </>
        )}
      </Box>
    </Box>
  );
}
