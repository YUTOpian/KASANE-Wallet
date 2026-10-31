import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Link, Pagination, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SymbolSendError } from '../../lib/symbol/api';
import { SssError, sssErrorKey } from '../../lib/sss';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { catchSymbolNemonster, fetchSymbolNemonsterState, symbolNemonsterCatchFee } from '../../lib/symbol/nemonster';
import { getNetworkConfig as getSymbolNetworkConfig } from '../../lib/symbol/network';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { chainExplorerTxUrl } from '../../lib/chainApi';
import type { Monster } from '../../lib/nem/monster';
import { buildCollection, catchNemonster, fetchNemonsterState, nemonsterCatchFee } from '../../lib/nem/nemonster';
import type { NemonsterState } from '../../lib/nem/nemonster';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { useAppStore } from '../../store/appStore';
import { classifyNemError, nemXem } from './parts';
import './nemonster.css';

const PER_PAGE = 6;
const REFRESH_WHILE_PENDING_MS = 15_000;

const mono = { fontFamily: 'monospace', wordBreak: 'break-all' } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 2.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, px: 2, py: 1.5 }}>
      <Typography sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
      {children}
    </Box>
  );
}

// The monster's drawing: the markup of the official wallet's NEMonster page (styled by nemonster.css).
function MonsterView({ monster }: { monster: Monster }) {
  return (
    <div className="nemonster-scope">
      <div className="MonsterContainer">
        <div className={`${monster.body} ${monster.grad}`.trim()} style={{ backgroundColor: monster.color }} />
        <div className={monster.hair} style={{ background: monster.color }} />
        <div className="face">
          <div className={monster.eyes}>
            <div className={monster.iris} style={{ backgroundColor: monster.irisColor }}>
              <div />
              <div />
            </div>
          </div>
        </div>
        <div className={monster.mouth} />
        <div className={monster.teeth}>
          <div />
          <div />
        </div>
        <div className="Monstertext" />
      </div>
    </div>
  );
}

const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

// 「NEMonster」: 自分専用の宛先へ 0 XEM（Symbol は 0 XYM）を送るたびに、そのトランザクションのハッシュから
// モンスターが1匹生まれる収集ゲーム。NEM は公式 NEM Nano Wallet の NEMonster と同じ仕組み。
// Symbol には公式版が無いので、同じ作り（自分専用の宛先・ハッシュから姿を決める）の KASANE 版。
export default function NemMonster() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const isSymbol = chain === 'symbol';
  // Symbol の文言は `nemonster.xxx_symbol`（無ければ共通の `nemonster.xxx`）
  const context = isSymbol ? 'symbol' : undefined;
  // NEM の手数料は固定、Symbol はノードの手数料倍率で決まるので、画面を開いたときに見積もる。
  const [symbolFee, setSymbolFee] = useState<bigint | null>(null);
  useEffect(() => {
    if (!isSymbol) return undefined;
    let alive = true;
    setSymbolFee(null);
    symbolNemonsterCatchFee().then((f) => { if (alive) setSymbolFee(f); }).catch(() => { /* the fee row shows … */ });
    return () => { alive = false; };
  }, [isSymbol, network]);
  const feeText = isSymbol
    ? symbolFee === null ? '…' : `${formatAtomic(symbolFee, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`
    : nemXem(nemonsterCatchFee());

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [state, setState] = useState<NemonsterState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);

  const [asking, setAsking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // Ignore the answer of a load that a newer load (or a network switch) has overtaken.
  const loadSeq = useRef(0);

  const load = useCallback(async (silent = false) => {
    const seq = (loadSeq.current += 1);
    if (!silent) {
      setLoading(true);
      setFailed(false);
    }
    try {
      const w = await WalletsHelper.getActive();
      if (seq !== loadSeq.current) return;
      setWallet(w);
      if (!w) return;
      const next = isSymbol
        ? await fetchSymbolNemonsterState(w.address, w.publicKey, getSymbolNetworkConfig().networkByte)
        : await fetchNemonsterState(w.address, getNemNetworkConfig().networkByte);
      if (seq !== loadSeq.current) return;
      setState(next);
      setFailed(false);
    } catch {
      if (seq === loadSeq.current && !silent) setFailed(true);
    } finally {
      if (seq === loadSeq.current && !silent) setLoading(false);
    }
  }, [isSymbol]);

  useEffect(() => {
    setState(null);
    setPage(1);
    void load();
  }, [load, network]);

  // While catches wait for a block, look again now and then so the new monsters show up by themselves.
  const pending = state?.pending ?? 0;
  useEffect(() => {
    if (pending === 0) return undefined;
    const timer = setInterval(() => { void load(true); }, REFRESH_WHILE_PENDING_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  const collection = useMemo(() => (state ? buildCollection(state.hashes) : []), [state]);
  const pageCount = Math.max(1, Math.ceil(collection.length / PER_PAGE));
  const shown = collection.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  const ask = () => { setConfirmed(false); setAsking(true); };

  const onPassed = async (password: string) => {
    setConfirmed(false);
    setBusy(true);
    try {
      const w = await WalletsHelper.getActive();
      if (!w) return;
      const privateKey = await WalletsHelper.decryptKey(w.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      if (isSymbol) {
        await catchSymbolNemonster({ privateKey, sss: w.sss, publicKey: w.publicKey, address: w.address, networkByte: getSymbolNetworkConfig().networkByte });
      } else {
        await catchNemonster({ privateKey, publicKey: w.publicKey, address: w.address, networkByte: getNemNetworkConfig().networkByte });
      }
      setDone(true);
      await load(true);
    } catch (error) {
      // SSS Extension: declined in the extension, wrong account/network selected there, ...
      if (error instanceof SssError) {
        setErrorMessage(t(sssErrorKey(error)));
        return;
      }
      const c = classifyNemError(error, 'MOSAIC');
      const code = error instanceof SymbolSendError ? error.code.toLowerCase() : '';
      let kind = c.kind;
      if (kind === 'expired') kind = 'deadline';
      if (!['insufficient_balance', 'deadline', 'wrong_network'].includes(kind)) {
        kind = ['node_unreachable', 'timeout', 'node_not_https'].includes(code) || /failed to fetch|network|timeout|unreachable/i.test(c.detail)
          ? 'node'
          : 'unknown';
      }
      setSendError({ kind, detail: c.detail });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const confirmTexts = t('nemonster.confirm_message', { returnObjects: true, fee: feeText, context }) as string[];
  const errorTitle = sendError ? t(`nemonster.error_${sendError.kind}_title`, { context }) : '';
  const errorTexts = sendError ? (t(`nemonster.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail, context }) as string[]) : [];

  if (loading && !state) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress color="primary" /></Box>;
  }

  if (!wallet) {
    return <Box sx={{ px: 3, py: 4 }}><Typography>{t('nemonster.no_wallet')}</Typography></Box>;
  }

  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
      <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 1 }}>{isSymbol ? `${t('nemonster.title')} for Symbol` : t('nemonster.title')}</Typography>
      <Alert severity="info" sx={{ mb: 1 }}>{t('nemonster.about', { context })}</Alert>

      {failed && (
        <Alert severity="warning" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={() => void load()}>{t('nemonster.retry')}</Button>}>
          {t('nemonster.load_failed')}
        </Alert>
      )}

      <Section title={t('nemonster.catch_title')}>
        <Typography variant="body2" sx={{ mb: 1 }}>{t('nemonster.catch_about', { context })}</Typography>
        {state && (
          <Typography variant="body2" component="div" sx={{ py: 0.4, wordBreak: 'break-all' }}>
            <Box component="span" sx={{ color: 'text.secondary' }}>{t('nemonster.sink')}: </Box>
            <Box component="span" sx={mono}>{state.sink}</Box>
          </Typography>
        )}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5, mb: 1.5 }}>
          {t('nemonster.fee')}: {feeText}
        </Typography>
        <Button variant="contained" color="primary" fullWidth disabled={busy || !state || (isSymbol && symbolFee === null)} onClick={ask}>
          {t('nemonster.catch_button')}
        </Button>
        {busy && <Typography variant="body2" sx={{ mt: 1.5, textAlign: 'center' }}>{t('nemonster.working')}</Typography>}
        {pending > 0 && <Alert severity="info" sx={{ mt: 1.5 }}>{t('nemonster.pending', { count: pending })}</Alert>}
      </Section>

      <Section title={`${t('nemonster.collection_title')}${state ? ` (${t('nemonster.count', { count: collection.length })})` : ''}`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 2 }}>
          {shown.map((c) => (
            <Box key={c.hash ?? 'starter'} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2, textAlign: 'center', overflow: 'hidden' }}>
              <Typography sx={{ fontWeight: 'bold', minHeight: 48 }}>{`${c.monster.name1} ${c.monster.name2}`.trim()}</Typography>
              <MonsterView monster={c.monster} />
              <Typography variant="caption" component="div" sx={{ color: 'text.secondary', mt: 1 }}>
                {c.hash ? (
                  <Link href={chainExplorerTxUrl(c.hash)} target="_blank" rel="noopener" sx={mono} underline="hover">{shortHash(c.hash)}</Link>
                ) : (
                  t('nemonster.starter')
                )}
              </Typography>
            </Box>
          ))}
        </Box>
        {pageCount > 1 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Pagination count={pageCount} page={page} color="primary" onChange={(_, p) => setPage(p)} />
          </Box>
        )}
        <Box sx={{ mt: 1 }}>
          <Button size="small" onClick={() => void load()}>{t('nemonster.reload')}</Button>
        </Box>
      </Section>

      <MessageDialog
        open={asking && !confirmed && !busy}
        title={t('nemonster.confirm_title')}
        texts={confirmTexts}
        selectable
        onClose={() => setConfirmed(true)}
        onCancel={() => setAsking(false)}
      />
      <PasswordDialog open={asking && confirmed && !busy} mode="check" popup onClose={() => { setConfirmed(false); setAsking(false); }} onPass={onPassed} />
      <MessageDialog open={done} title={t('nemonster.done_title')} texts={t('nemonster.done_message', { returnObjects: true, context }) as string[]} onClose={() => setDone(false)} />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} variant="error" onClose={() => setSendError(null)} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </Box>
  );
}
