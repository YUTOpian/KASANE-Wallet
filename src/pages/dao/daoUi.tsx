import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { explorerTxUrl, fetchBalances } from '../../lib/symbol/api';
import type { AggregateSigner } from '../../lib/symbol/aggregate';
import type { KeylessSigner } from '../../lib/symbol/sssSign';
import { getNetworkConfig } from '../../lib/symbol/network';
import { quoteDao, submitDao } from '../../lib/dao/daoTx';
import type { DaoSubmitResult } from '../../lib/dao/daoTx';
import type { BatchProgress } from '../../lib/dao/daoBatch';
import type { Actor, DaoPlan } from '../../lib/dao/daoActions';
import type { DaoInfo, DaoMosaic, OwnedNamespace } from '../../lib/dao/daoApi';
import { showTxNotice } from '../../store/txNoticeStore';
import { ConfirmScreen, xymText } from '../multisig/parts';
import type { ConfirmRow } from '../multisig/parts';

/** いま開いているウォレットのアカウント（無ければ null、読み込み中は undefined）。 */
export function useActor(): Actor | null | undefined {
  const [actor, setActor] = useState<Actor | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    WalletsHelper.getActive('symbol')
      .then((w) => { if (!cancelled) setActor(w ? { address: w.address, publicKey: w.publicKey } : null); })
      .catch(() => { if (!cancelled) setActor(null); });
    return () => { cancelled = true; };
  }, []);
  return actor;
}

/** DAO の画面のタブ（DaoFrame）が子に渡す情報。 */
export interface DaoContext {
  dao: DaoInfo;
  actor: Actor;
  isAdmin: boolean;
  /** DAO の署名に加われるか: 管理者（直接の連署者）か、多段マルチシグの下の階層の連署者。DAO ウォレットの送金に使う。 */
  canSign: boolean;
  /** DAO アカウントとして署名するときの承認の状況（読めなければ null）。 */
  signer: AggregateSigner | null;
  mosaics: DaoMosaic[];
  /** DAO アカウントが持つネームスペース（期限つき）。読めなかったときは null（警告は出さず、一覧にエラーを出す）。 */
  namespaces: OwnedNamespace[] | null;
  reload: () => void;
}

export const DaoCtx = createContext<DaoContext | null>(null);

export function useDao(): DaoContext {
  const ctx = useContext(DaoCtx);
  if (!ctx) throw new Error('no_dao_context');
  return ctx;
}

export const LoadingBox = () => <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;

/** 送る前の用意の結果: 計画（見積もりに使う）と確認画面に出す行。 */
export interface Prepared {
  plans: DaoPlan[];
  rows: ConfirmRow[];
  /** 既定（plans[0] を送る）と違う送り方をするとき（分割して送る配布・回収、複数回の投票作成）。何回目まで送れたかは onProgress に伝える。 */
  execute?: (privateKey: string, keyless?: KeylessSigner, onProgress?: BatchProgress) => Promise<DaoSubmitResult>;
  /** 分割して送るとき、1 回に入れる件数（途中で止まったときに「先頭から何件は送信済み」と伝えるのに使う）。 */
  unit?: number;
}

const KNOWN_ERRORS = ['too_many_items', 'no_holders', 'invalid_signer', 'not_renewable', 'invalid_days', 'fee_unavailable', 'vote_token_short', 'invalid_deadline', 'too_many_options'];

/**
 * 「確認へ」ボタン → 見積もりと残高の確認 → 確認画面（パスワード）→ 送信、までを受け持つ。フォームは children に置き、
 * 送れたら onSent を呼ぶ（画面の作り直しや再読み込みは呼び出し側）。
 */
export function DaoAction({ children, label, disabled, prepare, onSent }: {
  children?: ReactNode;
  label: string;
  disabled?: boolean;
  prepare: () => Promise<Prepared>;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ prepared: Prepared; rows: ConfirmRow[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: boolean } | null>(null);

  const next = async () => {
    setBusy(true);
    setError('');
    try {
      const prepared = await prepare();
      const wallet = await WalletsHelper.getActive('symbol');
      if (!wallet) throw new Error('no_wallet');
      const quotes = await Promise.all(prepared.plans.map((p) => quoteDao(p.input)));
      const fee = quotes.reduce((s, q) => s + q.fee + q.lockFee, 0n);
      const lock = quotes.reduce((s, q) => s + q.lockAmount, 0n);
      const spend = prepared.plans.reduce((s, p) => s + p.spend, 0n);
      const balances = await fetchBalances(wallet.address).catch(() => null);
      const have = balances?.find((b) => b.id === getNetworkConfig().currencyMosaicId)?.amount ?? null;
      const need = fee + lock + spend;
      if (have !== null && have < need) {
        setError(t('dao.err_balance', { need: xymText(need), have: xymText(have) }));
        return;
      }
      const bonded = quotes.some((q) => q.bonded);
      const batches = prepared.plans.length;
      const bondedCount = quotes.filter((q) => q.bonded).length;
      const rows: ConfirmRow[] = [
        ...prepared.rows,
        ...(batches > 1 ? [{ label: t('dao.row_batches_label'), value: `${t('dao.row_batches', { count: batches })}${wallet.sss ? `\n${t('dao.row_batches_sss', { count: batches })}` : ''}` }] : []),
        ...(spend > 0n ? [{ label: t('dao.cost_deposit'), value: xymText(spend) }] : []),
        { label: t('dao.cost_fee'), value: xymText(fee) },
        ...(lock > 0n ? [{ label: t('dao.cost_lock'), value: `${xymText(lock)}\n${t('dao.cost_lock_note')}` }] : []),
        ...(bonded ? [{ label: t('dao.cost_cosign'), value: `${t('dao.cost_cosign_value', { count: Math.max(...quotes.map((q) => q.cosignatures)) })}${bondedCount > 1 ? `\n${t('dao.cost_cosign_batches', { count: bondedCount })}` : ''}` }] : []),
        { label: t('dao.cost_total'), value: xymText(need), big: true },
      ];
      setConfirm({ prepared, rows });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(KNOWN_ERRORS.includes(code) ? t(`dao.err_${code}`) : t('dao.err_prepare', { detail: code }));
    } finally {
      setBusy(false);
    }
  };

  const send = async (password: string) => {
    const wallet = await WalletsHelper.getActive('symbol');
    if (!wallet || !confirm) throw new Error('no_wallet');
    const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
    if (privateKey == null) throw new Error('invalid_password');
    const { prepared } = confirm;
    // SSS Extension のアカウントは秘密鍵が空文字で返る。署名は拡張に頼む（署名のたびに拡張の画面で承認する）。
    const keyless: KeylessSigner | undefined = wallet.sss ? { kind: 'sss' } : undefined;
    const total = Math.max(prepared.plans.length, 1);
    let done = 0;
    const onProgress: BatchProgress = (d, tot) => { done = d; setProgress({ done: d, total: tot, failed: false }); };
    let result: DaoSubmitResult;
    try {
      result = prepared.execute ? await prepared.execute(privateKey, keyless, onProgress) : await submitDao(privateKey, prepared.plans[0].input, keyless);
    } catch (e) {
      // 分割して送っていて、途中で止まった。ここまで送れた分を画面に残す（同じ操作をやり直すと、送れた分にも重ねて送ってしまうため）。
      if (total > 1) setProgress({ done, total, failed: true });
      throw e;
    }
    setProgress(null);
    showTxNotice({
      lines: t(result.bonded ? 'dao.done_bonded' : 'dao.done_complete', { returnObjects: true }) as string[],
      explorerUrl: explorerTxUrl(result.hash),
      explorerLabel: t('multisig.view_explorer'),
    });
    setConfirm(null);
    onSent();
  };

  if (confirm) {
    const unit = confirm.prepared.unit;
    return (
      <>
        <ConfirmScreen rows={confirm.rows} onBack={() => { setConfirm(null); setProgress(null); }} onPassword={send} />
        {progress && (
          <Alert severity={progress.failed ? 'error' : 'info'} sx={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 2000, maxWidth: 'calc(100vw - 32px)', whiteSpace: 'pre-wrap' }}>
            {progress.failed
              ? t(unit ? 'dao.batch_stopped_items' : 'dao.batch_stopped', { done: progress.done, total: progress.total, items: progress.done * (unit ?? 0) })
              : t('dao.batch_progress', { done: progress.done, total: progress.total })}
          </Alert>
        )}
      </>
    );
  }
  return (
    <Box>
      {children}
      {error && <Alert severity="error" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{error}</Alert>}
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" color="primary" size="large" fullWidth disabled={disabled || busy} onClick={next} sx={{ py: 1.25 }}>
          {busy ? <CircularProgress size={24} /> : label}
        </Button>
      </Box>
    </Box>
  );
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** 正の整数の入力（モザイクの量）。空・不正は null。 */
export function parseAmount(text: string): bigint | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const v = BigInt(s);
  return v > 0n && v <= 9_000_000_000_000_000n ? v : null;
}
