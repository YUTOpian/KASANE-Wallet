import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Alert, Box, Button, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, InputBase, MenuItem, Stack, Switch, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { toAppLanguage } from '../../i18n/languages';
import { createConsoleEnv } from '../../lib/console/env';
import type { ConsoleEnv, LogKind, SignRequest } from '../../lib/console/env';
import { formatValue } from '../../lib/console/format';
import { StopSignal, isInterpreterError } from '../../lib/console/interpreter';
import { isIncomplete, pushHistory, stepHistory } from '../../lib/console/repl';
import { consoleSamplesFor } from '../../lib/console/samples';
import { sampleCodeFor } from '../../lib/console/samplesTs';
import { isConsoleLang } from '../../lib/console/tsStrip';
import type { ChainKey } from '../../lib/chain';
import { resolveNemNode } from '../../lib/nem/api';
import { getNemNetworkConfig } from '../../lib/nem/network';
import { getConnectedNode, resolveNode } from '../../lib/symbol/api';
import { getNetworkConfig } from '../../lib/symbol/network';
import { useAppStore } from '../../store/appStore';
import { useLedgerProfile } from '../../hooks/useWatchOnly';
import { PROTECTION_KEYS, getNetworkProtections, isNetworkLimited, useConsoleSettingsStore } from '../../store/consoleSettingsStore';
import type { ProtectionKey } from '../../store/consoleSettingsStore';
import { accountLabel, useSigningAccounts } from '../offline/signingAccounts';
import ConsoleSignDialog from './ConsoleSignDialog';
import DiagnosticsPanel from './DiagnosticsPanel';

// 「コンソール」(Symbol / NEM): コードを1つずつ打ち込んで、このウォレットのアカウントで動かす対話画面。
// 今のチェーン（Symbol か NEM）に合わせて、facade・SDK・ノード・サンプルが切り替わる。切り替えると画面ごと作り直す（別のチェーンの変数は持ち越さない）。
// ブラウザの開発者ツールのコンソールと同じ見た目で、入力は「<」、出力は「>」で出る。console.log の出力はそのまま並ぶ。
// コードは lib/console/interpreter.ts のインタープリタで動く（CSP が eval を許さないため。window / document / 保存された鍵には届かない）。
// 署名・暗号化・復号が要るとき（wallet.signTransaction(tx)、wallet.messageEncoder() など）は、内容を見せる確認ダイアログとパスワード入力を挟む。

type OutKind = LogKind | 'input' | 'result' | 'undef';
interface OutLine { id: number; kind: OutKind; text: string }
interface Pending { request: SignRequest; resolve: (s: Uint8Array | null) => void; reject: (e: Error) => void }

const MAX_LINES = 500;
// 画面は、テーマに関係なく濃い紫の地に、入力は水色、出力は白（開発者ツールのコンソール風）。
const CON_BG = '#150629';
const CON_INPUT = '#7be4e4';
const outColor: Record<OutKind, string> = { log: '#f3effa', info: '#9db8ff', warn: '#ffd37a', error: '#ff8fa3', input: CON_INPUT, result: '#f3effa', undef: '#a597c2' };
// 入力は「<」（水色）、出力（console.log・警告・エラー・最後の式の値）はすべて「>」
const gutterOf = (k: OutKind): string => (k === 'input' ? '<' : '>');
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// 画面は2つのタブ: 「コード実行」（対話コンソール）と「診断ログ」（アプリの動きの記録。以前は 設定 > 診断コンソール にあった）。
// タブを切り替えても、コード実行の入力・出力・変数が消えないよう、隠すだけで作り直さない。
// 診断ログだけは Ledger のプロファイルでも開ける（コード実行は署名できないので出さず、診断ログだけ出す）。?tab=diagnostics で診断ログを開く。
type ConsoleTab = 'run' | 'diagnostics';

// ヘルプの見せ方: 「名前 … 説明」の形の項目は、名前を等幅の太字にして、説明と分ける。説明は、文（。）ごとに改行する。
function HelpSection({ title, children, last }: { title: string; children: ReactNode; last?: boolean }) {
  return (
    <Box sx={{ mb: last ? 0 : 2.5 }}>
      <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', pb: 0.5, mb: 1, borderBottom: 1, borderColor: 'divider' }}>{title}</Typography>
      <Stack spacing={1.25}>{children}</Stack>
    </Box>
  );
}

function HelpItem({ text }: { text: string }) {
  const at = text.indexOf(' … ');
  const term = at > 0 ? text.slice(0, at) : '';
  const body = at > 0 ? text.slice(at + 3) : text;
  const sentences = body.split(/(?<=。)/).map((x) => x.trim()).filter((x) => x !== '');
  return (
    <Box>
      {term !== '' && (
        <Typography component="code" sx={{ display: 'inline-block', mb: 0.25, px: 0.75, py: 0.1, borderRadius: 0.75, bgcolor: 'action.hover', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.85rem' }}>{term}</Typography>
      )}
      {sentences.map((x, i) => <Box key={i} sx={{ pl: term !== '' ? 1 : 0, wordBreak: 'break-word' }}>{x}</Box>)}
    </Box>
  );
}

export default function ConsolePage() {
  const { t } = useTranslation();
  const chain = useAppStore((s) => s.chain);
  const ledger = useLedgerProfile();
  const [params, setParams] = useSearchParams();
  const tab: ConsoleTab = ledger || params.get('tab') === 'diagnostics' ? 'diagnostics' : 'run';
  const changeTab = (next: ConsoleTab) => setParams(next === 'run' ? {} : { tab: 'diagnostics' }, { replace: true });
  return (
    <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
      <Typography sx={{ fontSize: '1.4rem', fontWeight: 300, mb: 1 }}>{t('console.title')}</Typography>
      {!ledger && (
        <Tabs value={tab} onChange={(_, v: ConsoleTab) => changeTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="run" label={t('console.tab_run')} />
          <Tab value="diagnostics" label={t('console.tab_diag')} />
        </Tabs>
      )}
      {ledger && <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('console.ledger_diag_only')}</Typography>}
      {!ledger && <Box sx={{ display: tab === 'run' ? 'block' : 'none' }}><ConsoleScreen key={chain} chain={chain} visible={tab === 'run'} /></Box>}
      <Box sx={{ display: tab === 'diagnostics' ? 'block' : 'none' }}><DiagnosticsPanel visible={tab === 'diagnostics'} /></Box>
    </Box>
  );
}

// NEM のときだけ文言を差し替えるヘルプの項目（console.help_<k>_nem）
const NEM_HELP = new Set(['facade', 'node', 'wallet', 'clog', 'keep']);

function ConsoleScreen({ chain, visible }: { chain: ChainKey; visible: boolean }) {
  const { t, i18n } = useTranslation();
  const isNem = chain === 'nem';
  const samples = consoleSamplesFor(chain);
  const { signer, activeWallet } = useSigningAccounts(chain, { noLedger: true, keyless: true });
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<OutLine[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [sampleId, setSampleId] = useState('');
  const limitNetwork = useConsoleSettingsStore((s) => s.limitNetwork);
  const setLimitNetwork = useConsoleSettingsStore((s) => s.setLimitNetwork);
  // 実行する言語（JavaScript / TypeScript）。TypeScript は、動かす前に型を取り除くだけ（型のチェックはしない）。
  const lang = useConsoleSettingsStore((s) => s.lang);
  const setLang = useConsoleSettingsStore((s) => s.setLang);
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  // 通信の保護（URL内のユーザー名・パスワード／Cookie／参照元）。初期値はすべて「保護する」。開発者向けの詳細設定から、項目ごとにオフにできる。
  const protections = useConsoleSettingsStore(useShallow((s) => ({ blockUrlCredentials: s.blockUrlCredentials, omitCookies: s.omitCookies, hideReferrer: s.hideReferrer })));
  const setProtection = useConsoleSettingsStore((s) => s.setProtection);
  const [confirmProtection, setConfirmProtection] = useState<ProtectionKey | null>(null);
  const [showAdvancedNet, setShowAdvancedNet] = useState(false);
  const anyProtectionOff = PROTECTION_KEYS.some((k) => !protections[k]);
  const envRef = useRef<{ key: string; env: ConsoleEnv } | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const idRef = useRef(0);
  const outRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // ↑ ↓ で呼び出す、これまでの入力（この画面を開いている間だけ。保存しない）
  const historyRef = useRef<string[]>([]);
  const histIndexRef = useRef(0);
  const draftRef = useRef('');

  const push = useCallback((kind: OutKind, text: string) => {
    setLines((cur) => [...cur, { id: ++idRef.current, kind, text }].slice(-MAX_LINES));
  }, []);

  const cancelPending = useCallback(() => {
    const p = pendingRef.current;
    if (p === null) return;
    pendingRef.current = null;
    setPending(null);
    p.reject(new Error('キャンセルされました (cancelled)'));
  }, []);

  const disposeEnv = useCallback(() => {
    envRef.current?.env.dispose();
    envRef.current = null;
    cancelPending();
  }, [cancelPending]);

  // ページを離れたら、タイマー・WebSocket・署名待ちを片づける
  useEffect(() => disposeEnv, [disposeEnv]);

  // 画面の外から呼ばれたコールバック（イベント・タイマー）の中で起きたエラーも、画面に出す
  useEffect(() => {
    const onError = (ev: ErrorEvent) => { if (isInterpreterError(ev.error)) { push('error', describeError(ev.error)); ev.preventDefault(); } };
    const onRejection = (ev: PromiseRejectionEvent) => { if (isInterpreterError(ev.reason)) { push('error', describeError(ev.reason)); ev.preventDefault(); } };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, [push]);

  // 出力が増えたら、入力欄まで見えるように一番下へ
  useEffect(() => {
    const el = outRef.current;
    if (el && visible) el.scrollTop = el.scrollHeight;
  }, [lines, code, running, visible]);

  // 実行が終わったら入力欄に戻る（開いた直後は、スマホのキーボードが勝手に出ないよう、何もしない）
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (!running) inputRef.current?.focus({ preventScroll: true });
  }, [running]);

  const askSignature = useCallback((request: SignRequest) => new Promise<Uint8Array | null>((resolve, reject) => {
    cancelPending();
    const p: Pending = { request, resolve, reject };
    pendingRef.current = p;
    setPending(p);
  }), [cancelPending]);

  /** 実行環境は、アカウントかネットワークが変わるまで使い回す（変数を持ち越せる）。 */
  const ensureEnv = async (): Promise<ConsoleEnv> => {
    if (signer === null) throw new Error('no signing account');
    const networkByte = isNem ? getNemNetworkConfig().networkByte : getNetworkConfig().networkByte;
    const key = `${chain}|${signer.id}|${networkByte}`;
    if (envRef.current?.key === key) return envRef.current.env;
    disposeEnv();
    let nodeUrl: string;
    if (isNem) {
      try { nodeUrl = await resolveNemNode(); } catch { throw new Error(t('console.nem_no_node')); }
    } else {
      nodeUrl = getConnectedNode() || await resolveNode();
    }
    const env = createConsoleEnv({
      chain,
      networkByte,
      nodeUrl,
      signer: { publicKey: signer.publicKey },
      onLog: (kind, text) => push(kind, text),
      onClear: () => setLines([]),
      onSign: askSignature,
      limitNetwork: isNetworkLimited,
      protections: getNetworkProtections,
    });
    envRef.current = { key, env };
    return env;
  };

  const run = async () => {
    const source = code;
    if (running || signer === null || source.trim() === '') return;
    setRunning(true);
    push('input', source.replace(/\s+$/, ''));
    historyRef.current = pushHistory(historyRef.current, source);
    histIndexRef.current = historyRef.current.length;
    draftRef.current = '';
    setCode('');
    try {
      const env = await ensureEnv();
      const r = await env.interpreter.run(source, lang);
      if (r.hasValue) push(r.value === undefined ? 'undef' : 'result', formatValue(r.value));
    } catch (e) {
      push('error', describeError(e, envRef.current?.env.interpreter.line));
    } finally {
      cancelPending();
      setRunning(false);
    }
  };

  const stop = () => {
    const env = envRef.current?.env;
    if (env) { env.interpreter.stopRequested = true; env.dispose(); }
    cancelPending();
  };

  const reset = () => {
    stop();
    envRef.current = null;
    setLines([]);
  };

  const recall = (dir: -1 | 1) => {
    const hist = historyRef.current;
    const cur = histIndexRef.current;
    if (cur === hist.length) draftRef.current = code; // 履歴を辿り始めるとき、書きかけを取っておく
    const next = stepHistory(hist, cur, dir);
    if (next === cur) return;
    histIndexRef.current = next;
    setCode(next === hist.length ? draftRef.current : hist[next]);
    requestAnimationFrame(() => { const ta = inputRef.current; if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length; });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // 日本語入力の変換中の Enter は、変換の確定。実行しない。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ta = e.currentTarget as HTMLTextAreaElement;
    if (e.key === 'Enter' && !e.shiftKey) {
      // Ctrl / ⌘ + Enter は、途中でも実行。Enter だけのときは、括弧などが閉じていなければ改行（開発者ツールと同じ）。
      if (e.ctrlKey || e.metaKey || !isIncomplete(code, lang)) { e.preventDefault(); void run(); }
      return;
    }
    if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); setLines([]); return; }
    if (e.key === 'ArrowUp' && !e.shiftKey && ta.selectionStart === ta.selectionEnd && !code.slice(0, ta.selectionStart).includes('\n')) { e.preventDefault(); recall(-1); return; }
    if (e.key === 'ArrowDown' && !e.shiftKey && ta.selectionStart === ta.selectionEnd && !code.slice(ta.selectionEnd).includes('\n')) { e.preventDefault(); recall(1); return; }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = ta;
      setCode(`${code.slice(0, a)}  ${code.slice(b)}`);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = a + 2; });
    }
  };

  const insertSample = (id: string) => {
    setSampleId('');
    const s = samples.find((x) => x.id === id);
    if (!s) return;
    histIndexRef.current = historyRef.current.length;
    // TypeScript のときは、変数に型を付けた書き方で入れる（動かすときは型を取り除くので、JavaScript のサンプルと同じ動きになる）。
    // コメントは、設定言語に合わせる（コードの部分は変わらない）
    const sampleCode = sampleCodeFor(chain, s, lang, toAppLanguage(i18n.language));
    setCode((cur) => (cur.trim() === '' ? sampleCode : `${cur.replace(/\s+$/, '')}\n\n${sampleCode}`));
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  // 文字を選ぼうとしているとき以外は、どこを押しても入力欄に戻る
  const focusInput = () => {
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus({ preventScroll: true });
  };

  const net = isNem ? getNemNetworkConfig() : getNetworkConfig();
  const help = (k: string) => t(isNem && NEM_HELP.has(k) ? `console.help_${k}_nem` : `console.help_${k}`);
  return (
    <Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t(isNem ? 'console.intro_nem' : 'console.intro', { network: net.label })}</Typography>
      <Alert severity="warning" sx={{ mb: 2 }}>{t('console.safety')}</Alert>

      {/* 通信の制限・保護（設定）。すべて開発者向けの詳細設定にまとめた（初期値はすべてオン）。オフにするときは確認を挟む。切り替えは、実行中のコードにもすぐ効く。
          スキーム（http / https / ws / wss 以外の拒否）は、CSP も同じなので、ここでは切り替えない。 */}
      <Box sx={{ mb: 1.5 }}>
        <Button size="small" onClick={() => setShowAdvancedNet((v) => !v)} sx={{ ml: -1, textTransform: 'none', fontSize: 12 }}>
          {t(showAdvancedNet ? 'console.prot_hide' : 'console.prot_show')}
        </Button>
        <Collapse in={showAdvancedNet} unmountOnExit>
          <Box sx={{ ml: 1, mt: 0.5 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>{t('console.prot_intro')}</Typography>
            <Box>
              <FormControlLabel
                control={<Switch size="small" checked={limitNetwork} onChange={(e) => { if (e.target.checked) setLimitNetwork(true); else setConfirmUnlimited(true); }} />}
                label={<Typography sx={{ fontSize: 13 }}>{t('console.net_limit_label')}</Typography>}
              />
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ml: 6 }}>{t('console.net_limit_hint')}</Typography>
            </Box>
            {PROTECTION_KEYS.map((k) => (
              <Box key={k}>
                <FormControlLabel
                  control={<Switch size="small" checked={protections[k]} onChange={(e) => { if (e.target.checked) setProtection(k, true); else setConfirmProtection(k); }} />}
                  label={<Typography sx={{ fontSize: 13 }}>{t(`console.prot_${k}_label`)}</Typography>}
                />
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', ml: 6 }}>{t(`console.prot_${k}_hint`)}</Typography>
              </Box>
            ))}
          </Box>
        </Collapse>
        {/* 閉じていても、オフになっているものがあれば警告を出す */}
        {!limitNetwork && <Alert severity="warning" sx={{ mt: 1 }}>{t('console.net_unlimited_notice')}</Alert>}
        {anyProtectionOff && <Alert severity="warning" sx={{ mt: 1 }}>{t('console.prot_off_notice')}</Alert>}
      </Box>
      <Dialog open={confirmProtection !== null} onClose={() => setConfirmProtection(null)} fullWidth maxWidth="xs">
        <DialogTitle>{confirmProtection !== null && t(`console.prot_${confirmProtection}_title`)}</DialogTitle>
        <DialogContent><Typography sx={{ fontSize: 14 }}>{confirmProtection !== null && t(`console.prot_${confirmProtection}_body`)}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmProtection(null)} autoFocus>{t('common.cancel')}</Button>
          <Button color="warning" onClick={() => { if (confirmProtection !== null) setProtection(confirmProtection, false); setConfirmProtection(null); }}>{t('console.prot_off_confirm')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={confirmUnlimited} onClose={() => setConfirmUnlimited(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('console.net_unlimited_title')}</DialogTitle>
        <DialogContent><Typography sx={{ fontSize: 14 }}>{t('console.net_unlimited_body')}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmUnlimited(false)} autoFocus>{t('common.cancel')}</Button>
          <Button color="warning" onClick={() => { setLimitNetwork(false); setConfirmUnlimited(false); }}>{t('console.net_unlimited_confirm')}</Button>
        </DialogActions>
      </Dialog>

      {/* 使うアカウントは、ウォレットで選んでいるアカウント（選び直しはウォレット側）。鍵を持つアカウントがないときだけ知らせる。 */}
      {signer === null && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('console.no_account')}</Alert>}
      {/* wallet が誰か（コードで使える名前と、そのアカウント）。選んでいるアカウントが使えないときは、代わりのアカウントを使っていると知らせる。 */}
      {signer !== null && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('console.using_account', { label: accountLabel(signer, t('wallet.account_imported')) })}</Typography>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontFamily: MONO, wordBreak: 'break-all' }}>{signer.address}</Typography>
          {activeWallet !== null && activeWallet.id !== signer.id && (
            <Alert severity="info" sx={{ mt: 1 }}>{t('console.account_unusable', { active: accountLabel(activeWallet, t('wallet.account_imported')), signer: accountLabel(signer, t('wallet.account_imported')) })}</Alert>
          )}
        </Box>
      )}
      <Stack direction="row" spacing={2} sx={{ mb: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <TextField select size="small" label={t('console.samples')} value={sampleId} onChange={(e) => insertSample(e.target.value)} sx={{ minWidth: 240 }}>
          {samples.map((s) => <MenuItem key={s.id} value={s.id}>{t(`console.sample_${s.id}`)}</MenuItem>)}
        </TextField>
        {/* 実行する言語。次に実行するコードから効く（実行中のコードや、すでにある変数には影響しない）。 */}
        <ToggleButtonGroup
          exclusive size="small" value={lang} aria-label={t('console.lang_label')} disabled={running}
          onChange={(_, v: unknown) => { if (isConsoleLang(v)) setLang(v); }}
        >
          <ToggleButton value="js" sx={{ textTransform: 'none', px: 1.5 }}>{t('console.lang_js')}</ToggleButton>
          <ToggleButton value="ts" sx={{ textTransform: 'none', px: 1.5 }}>{t('console.lang_ts')}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: -0.75, mb: 1.5 }}>{t(lang === 'ts' ? 'console.lang_hint_ts' : 'console.lang_hint_js')}</Typography>

      {/* 対話の本体: 出力と入力欄（最後の行の「>」）が1つの枠に並ぶ。どこを押しても入力欄に戻る。 */}
      <Box
        ref={outRef} role="log" aria-live="polite" aria-label={t('console.section_output')} onClick={focusInput}
        sx={{
          fontFamily: MONO, fontSize: '0.9rem', lineHeight: 1.6, height: { xs: '60vh', md: '58vh' }, minHeight: 280, overflow: 'auto',
          resize: 'vertical', // 右下の角をドラッグして、高さを変えられる（height は初期値）
          bgcolor: CON_BG, color: outColor.log, borderRadius: 3, p: 2, cursor: 'text', colorScheme: 'dark',
          '& ::selection': { bgcolor: 'rgba(123,228,228,0.3)' },
        }}
      >
        {lines.length === 0 && !running && <Typography variant="caption" sx={{ display: 'block', color: outColor.undef, mb: 1, fontFamily: 'inherit' }}>{t('console.output_empty')}</Typography>}
        {lines.map((l) => (
          <Box key={l.id} sx={{ display: 'grid', gridTemplateColumns: '1.6em minmax(0, 1fr)', mt: l.kind === 'input' ? 1 : 0 }}>
            <Box aria-hidden sx={{ color: l.kind === 'input' ? CON_INPUT : outColor.undef, userSelect: 'none' }}>{gutterOf(l.kind)}</Box>
            <Box sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: outColor[l.kind] }}>{l.text}</Box>
          </Box>
        ))}
        <Box sx={{ display: 'grid', gridTemplateColumns: '1.6em minmax(0, 1fr)', alignItems: 'start', mt: lines.length > 0 ? 1 : 0 }}>
          <Box aria-hidden sx={{ color: CON_INPUT, userSelect: 'none' }}>{'<'}</Box>
          {running ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: outColor.undef }}>
              <span>{t('console.running')}</span>
              <Button size="small" variant="outlined" startIcon={<StopOutlinedIcon />} onClick={stop} sx={{ py: 0, minHeight: 24, color: CON_INPUT, borderColor: CON_INPUT }}>{t('console.stop')}</Button>
            </Stack>
          ) : (
            <InputBase
              multiline fullWidth value={code} onChange={(e) => { setCode(e.target.value); histIndexRef.current = historyRef.current.length; }} onKeyDown={onKeyDown}
              disabled={signer === null} placeholder={t('console.placeholder')} inputRef={inputRef}
              slotProps={{ input: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', 'aria-label': t('console.section_code') } }}
              sx={{
                fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', p: 0, alignItems: 'flex-start', color: CON_INPUT, caretColor: CON_INPUT,
                '& textarea::placeholder': { color: outColor.undef, opacity: 0.7 },
              }}
            />
          )}
        </Box>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
        <Button variant="outlined" startIcon={<StopOutlinedIcon />} onClick={stop} disabled={!running && envRef.current === null}>{t('console.stop')}</Button>
        <Button onClick={() => setLines([])} disabled={lines.length === 0}>{t('console.clear_output')}</Button>
        <Button onClick={reset}>{t('console.reset')}</Button>
        <Button onClick={() => setShowHelp((v) => !v)}>{showHelp ? t('console.help_hide') : t('console.help_show')}</Button>
      </Stack>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.75 }}>{t('console.shortcut')}</Typography>
      <Collapse in={showHelp}>
        <Box sx={{ mt: 1.5, p: 2, borderRadius: 1, border: 1, borderColor: 'divider', fontSize: '0.875rem', lineHeight: 1.7 }}>
          <HelpSection title={t('console.help_vars_title')}>
            {(['facade', 'node', 'wallet', 'clog', 'sdk', 'web', 'keep'] as const).map((k) => <HelpItem key={k} text={help(k)} />)}
          </HelpSection>
          <HelpSection title={t('console.help_limits_title')} last>
            {(['limit_syntax', 'limit_ts', 'limit_sign', 'limit_access', 'limit_size'] as const).map((k) => <HelpItem key={k} text={t(`console.help_${k}`)} />)}
          </HelpSection>
        </Box>
      </Collapse>

      {signer !== null && (
        <ConsoleSignDialog
          chain={chain}
          request={pending ? pending.request : null}
          signerId={signer.id}
          signerProfileKey={signer.profileKey}
          signerPublicKey={signer.publicKey}
          signerKeyless={signer.sss || signer.ledger}
          signerSss={signer.sss}
          signerAddress={signer.address}
          onCancel={cancelPending}
          onSigned={(sig) => { const p = pendingRef.current; pendingRef.current = null; setPending(null); p?.resolve(sig); }}
        />
      )}
    </Box>
  );
}

function describeError(e: unknown, line?: number): string {
  if (e instanceof StopSignal) return '停止しました (stopped)';
  const where = line && line > 0 && !(e instanceof SyntaxError) ? ` (${line})` : '';
  if (e instanceof Error) return `${e.name}: ${e.message}${where}`;
  return `Uncaught ${formatValue(e)}${where}`;
}
