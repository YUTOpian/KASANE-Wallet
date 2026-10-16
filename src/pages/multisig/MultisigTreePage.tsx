import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RemoveIcon from '@mui/icons-material/Remove';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { WalletsHelper } from '../../lib/storage';
import { normalizeAddress } from '../../lib/symbol/crypto';
import { fetchCosignedAccounts, fetchCosignerGraph, fetchMultisigInfo } from '../../lib/symbol/multisigApi';
import { MAX_MULTISIG_DEPTH, levelsBelow, mergeGraphs, missingSignatures, planApproval } from '../../lib/symbol/multisigTree';
import type { MultisigGraph } from '../../lib/symbol/multisigTree';
import { useAppStore } from '../../store/appStore';
import { Field, SectionCard, addressPrefix, addressProblem, mono } from './parts';

// 「マルチシグツリー」 (Multisig Tree): the whole multi-level multisig hierarchy around an account, drawn like a tournament bracket.
// The accounts that actually sign (ordinary accounts) are on the LEFT; every multisig account collects the signatures of its
// cosigners and moves on to the right, until the account nobody else controls (the "final") on the far right.
// Read-only, so it also works for a watch-only profile and for any address typed in.

interface Marks { target: string; wallet: string }
interface BracketCtx {
  graph: MultisigGraph;
  marks: Marks;
  /** Set to {wallet} when this wallet can sign for the bracket's top account (so each box can show how many are still missing). */
  signed: ReadonlySet<string> | null;
  /** For every multisig account: the one place (path) where it is drawn in full. Any other occurrence is a compact reference. */
  firstAt: ReadonlyMap<string, string>;
}

// Bracket geometry: the width of the gap between two columns (the connector lives in it), the line, and the box.
const GAP = 28;
const LINE = 2;
const CARD_W = 184;
const LINE_COLOR = 'text.disabled';

const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** One account as a box of the bracket. */
function AccountBox({ ctx, address, repeated, expandable, open, hidden, onToggle }: {
  ctx: BracketCtx; address: string; repeated: boolean; expandable: boolean; open: boolean; hidden: number; onToggle: () => void;
}) {
  const { t } = useTranslation();
  const node = ctx.graph.get(address);
  const multisig = node?.isMultisig === true;
  const isTarget = address === ctx.marks.target;
  const isMe = address === ctx.marks.wallet;
  const need = ctx.signed && multisig && !repeated ? missingSignatures(ctx.graph, address, ctx.signed) : null;
  const copy = () => { void navigator.clipboard?.writeText(address).catch(() => undefined); };
  return (
    <Box
      sx={{
        width: CARD_W, flexShrink: 0, boxSizing: 'border-box', position: 'relative', textAlign: 'left',
        px: 1, py: 0.75, borderRadius: 2, border: 2,
        borderColor: isMe ? 'success.main' : multisig ? 'primary.main' : 'divider',
        bgcolor: isTarget ? 'action.selected' : 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 28 }}>
        {multisig ? (
          <>
            <Typography sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1, color: 'primary.main' }}>{node!.minApproval} / {node!.cosignatories.length}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.2, flex: 1, minWidth: 0 }}>
              {t('multisig.tree_card_rule', { approval: node!.minApproval, count: node!.cosignatories.length })}
            </Typography>
          </>
        ) : (
          <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1 }}>{t('multisig.tree_card_signer')}</Typography>
        )}
        {expandable && (
          <IconButton size="small" onClick={onToggle} aria-label={open ? t('multisig.tree_collapse') : t('multisig.tree_expand')}
            sx={{ border: 1, borderColor: 'divider', p: 0.25 }}>
            {open ? <RemoveIcon sx={{ fontSize: 14 }} /> : <AddIcon sx={{ fontSize: 14 }} />}
          </IconButton>
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
        <Typography variant="body2" title={address} sx={{ ...mono, wordBreak: 'normal', fontSize: 12.5, flex: 1, minWidth: 0 }}>{shortAddress(address)}</Typography>
        <IconButton size="small" aria-label={t('multisig.tree_copy')} onClick={copy} sx={{ p: 0.25 }}><ContentCopyIcon sx={{ fontSize: 14 }} /></IconButton>
      </Box>
      {multisig && !repeated && (
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
          {t('multisig.tree_card_removal', { removal: node!.minRemoval })}
        </Typography>
      )}
      {(isTarget || isMe || repeated || need !== null || (multisig && !open && hidden > 0)) && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          {isTarget && <Chip size="small" color="primary" label={t('multisig.tree_target')} />}
          {isMe && <Chip size="small" color="success" label={t('multisig.tree_me')} />}
          {repeated && <Chip size="small" variant="outlined" color="warning" label={t('multisig.tree_repeated')} />}
          {need !== null && Number.isFinite(need) && (need === 0
            ? <Chip size="small" color="success" variant="outlined" label={`✓ ${t('multisig.tree_step_ok')}`} />
            : <Chip size="small" variant="outlined" label={t('multisig.tree_step_need', { count: need })} />)}
          {multisig && !open && hidden > 0 && <Chip size="small" variant="outlined" label={t('multisig.tree_folded', { count: hidden })} />}
        </Box>
      )}
    </Box>
  );
}

/**
 * An account and, to its left, the cosigners whose signatures it collects (each one a bracket of its own).
 * The connectors are plain borders: a short line out of every cosigner, a vertical bar joining them, and one line into this account.
 */
function Bracket({ ctx, address, path, depth, parentKey = '' }: { ctx: BracketCtx; address: string; path: ReadonlySet<string>; depth: number; parentKey?: string }) {
  const node = ctx.graph.get(address);
  const multisig = node?.isMultisig === true;
  const key = parentKey ? `${parentKey}>${address}` : address;
  const loop = path.has(address);
  // A multisig account that several branches share is drawn in full once; elsewhere it is only a small box (no duplicated subtree).
  const isFirst = ctx.firstAt.get(address) === key;
  const repeated = loop || (multisig && !isFirst);
  const expandable = multisig && !repeated;
  const [open, setOpen] = useState(depth < MAX_MULTISIG_DEPTH + 1);
  const next = useMemo(() => new Set([...path, address]), [path, address]);
  const cosigners = expandable ? node!.cosignatories : [];
  const half = `${GAP / 2}px`;
  const line = { content: '""', position: 'absolute', borderColor: LINE_COLOR } as const;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      {expandable && open && cosigners.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', position: 'relative', '&::after': { ...line, right: 0, top: '50%', width: half, borderTop: LINE, transform: `translateY(-${LINE / 2}px)` } }}>
          {cosigners.map((c, i) => (
            <Box
              key={c}
              sx={{
                position: 'relative', display: 'flex', alignItems: 'center', py: 0.75, pr: `${GAP}px`,
                // the short line out of this cosigner...
                '&::after': { ...line, right: half, top: '50%', width: half, borderTop: LINE, transform: `translateY(-${LINE / 2}px)` },
                // ...and its piece of the vertical bar (the first one starts at its middle, the last one ends there)
                ...(cosigners.length > 1 && {
                  '&::before': { ...line, right: `${GAP / 2 - LINE / 2}px`, width: 0, borderLeft: LINE, top: i === 0 ? '50%' : 0, bottom: i === cosigners.length - 1 ? '50%' : 0 },
                }),
              }}
            >
              <Bracket ctx={ctx} address={c} path={next} depth={depth + 1} parentKey={key} />
            </Box>
          ))}
        </Box>
      )}
      <AccountBox ctx={ctx} address={address} repeated={repeated} expandable={expandable} open={open} hidden={cosigners.length} onToggle={() => setOpen((o) => !o)} />
    </Box>
  );
}

/**
 * One account (with everything below it) that several final accounts depend on: drawn once on the left,
 * with a line fanning out to each of the final accounts on the right (instead of repeating its whole subtree for each).
 */
function SharedBlock({ source, tops, contexts }: { source: string; tops: string[]; contexts: ReadonlyMap<string, BracketCtx> }) {
  const half = `${GAP / 2}px`;
  const line = { content: '""', position: 'absolute', borderColor: LINE_COLOR } as const;
  const base = contexts.get(tops[0])!;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Bracket ctx={base} address={source} path={new Set()} depth={0} />
      {/* the line out of the shared account, up to the bar that joins the final accounts */}
      <Box sx={{ width: half, height: LINE, flexShrink: 0, position: 'relative', '&::after': { ...line, left: 0, right: 0, top: 0, borderTop: LINE } }} />
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        {tops.map((a, i) => {
          const ctx = contexts.get(a)!;
          return (
            <Box
              key={a}
              sx={{
                position: 'relative', display: 'flex', alignItems: 'center', py: 0.75, pl: half,
                '&::after': { ...line, left: 0, top: '50%', width: half, borderTop: LINE, transform: `translateY(-${LINE / 2}px)` },
                ...(tops.length > 1 && {
                  '&::before': { ...line, left: `-${LINE / 2}px`, width: 0, borderLeft: LINE, top: i === 0 ? '50%' : 0, bottom: i === tops.length - 1 ? '50%' : 0 },
                }),
              }}
            >
              <AccountBox ctx={ctx} address={a} repeated={false} expandable={false} open={false} hidden={0} onToggle={() => undefined} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Tops that are controlled only by one and the same account are drawn as one block: that account once, its outputs fanning out to the right. */
type Block = { kind: 'single'; top: string } | { kind: 'shared'; source: string; tops: string[] };

function planBlocks(graph: MultisigGraph, tops: string[]): Block[] {
  const soleCosigner = (a: string) => {
    const n = graph.get(a);
    return n?.isMultisig === true && n.cosignatories.length === 1 ? n.cosignatories[0] : null;
  };
  const bySource = new Map<string, string[]>();
  for (const a of tops) {
    const src = soleCosigner(a);
    if (src && graph.get(src)?.isMultisig === true) bySource.set(src, [...(bySource.get(src) ?? []), a]);
  }
  const blocks: Block[] = [];
  const done = new Set<string>();
  for (const a of tops) {
    if (done.has(a)) continue;
    const src = soleCosigner(a);
    const group = src ? bySource.get(src) : undefined;
    if (src && group && group.length >= 2) {
      group.forEach((g) => done.add(g));
      blocks.push({ kind: 'shared', source: src, tops: group });
    } else {
      done.add(a);
      blocks.push({ kind: 'single', top: a });
    }
  }
  return blocks;
}

/** Which place draws each multisig account in full: the first one met, going through the blocks in drawing order. */
function planFirstAt(graph: MultisigGraph, blocks: Block[]): Map<string, string> {
  const firstAt = new Map<string, string>();
  const walk = (address: string, key: string, path: Set<string>) => {
    const node = graph.get(address);
    if (!node?.isMultisig || path.has(address) || firstAt.has(address)) return;
    firstAt.set(address, key);
    path.add(address);
    for (const c of node.cosignatories) walk(c, `${key}>${c}`, path);
    path.delete(address);
  };
  for (const b of blocks) {
    if (b.kind === 'shared') {
      walk(b.source, b.source, new Set());
      for (const t of b.tops) if (!firstAt.has(t)) firstAt.set(t, t);
    } else walk(b.top, b.top, new Set());
  }
  return firstAt;
}

export default function MultisigTreePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const network = useAppStore((s) => s.network);
  const queried = params.get('account') ? normalizeAddress(params.get('account')!) : '';

  const [wallet, setWallet] = useState('');
  const [input, setInput] = useState(queried);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState('');
  const [tops, setTops] = useState<string[]>([]);
  const [graph, setGraph] = useState<MultisigGraph>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const me = (await WalletsHelper.getActive())?.address ?? '';
      setWallet(me ? normalizeAddress(me) : '');
      const root = queried || (me ? normalizeAddress(me) : '');
      setTarget(root);
      if (!root) { setTops([]); setGraph(new Map()); return; }
      // Up to the accounts nobody else controls, then down from each of them.
      const above = await fetchCosignedAccounts(root);
      const top = above.filter((a) => a.info.multisigOf.length === 0 || a.level === Math.max(...above.map((x) => x.level))).map((a) => a.info.address);
      let roots = top.length > 0 ? [...new Set(top)] : [root];
      let merged = mergeGraphs(...await Promise.all(roots.map((r) => fetchCosignerGraph(r, MAX_MULTISIG_DEPTH + 1))));
      // The same whole structure whichever account it is opened from: a multisig account in the tree can also be a cosigner of
      // other accounts (siblings of the one asked for), so look upward from every multisig account found and add what is above it.
      const parentsOf = new Map<string, string[]>();
      for (let round = 0; round < 3; round++) {
        const unchecked = [...merged.values()].filter((n) => n.isMultisig && !parentsOf.has(n.address)).map((n) => n.address).slice(0, 40);
        if (unchecked.length === 0) break;
        const infos = await Promise.all(unchecked.map((a) => fetchMultisigInfo(a).catch(() => null)));
        const fresh: string[] = [];
        infos.forEach((info, i) => {
          parentsOf.set(unchecked[i], info ? info.multisigOf : []);
          for (const p of info?.multisigOf ?? []) if (!merged.has(p) && !fresh.includes(p)) fresh.push(p);
        });
        if (fresh.length === 0) continue;
        const extra = await Promise.all(fresh.map((r) => fetchCosignerGraph(r, MAX_MULTISIG_DEPTH + 1).catch(() => new Map() as MultisigGraph)));
        merged = mergeGraphs(merged, ...extra);
        roots = [...roots, ...fresh];
      }
      // The final accounts: the ones no other account in the tree sits above.
      roots = [...new Set(roots)].filter((r) => !(parentsOf.get(r) ?? []).some((p) => merged.has(p)));
      setTops(roots);
      setGraph(merged);
    } catch (e) {
      console.error('Failed to load the multisig tree', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [queried]);

  useEffect(() => { void load(); }, [load, network]);

  const problem = input.trim() === '' ? null : addressProblem(input);
  const show = () => setParams(input.trim() === '' ? {} : { account: normalizeAddress(input) });

  const targetNode = graph.get(target);
  const isTree = tops.length > 0 && (graph.size > 1 || tops.some((a) => graph.get(a)?.isMultisig));
  const depth = Math.max(0, ...tops.map((a) => levelsBelow(graph, a)));
  const plan = target && wallet && targetNode?.isMultisig ? planApproval(graph, target, wallet) : null;
  const marks = useMemo<Marks>(() => ({ target, wallet }), [target, wallet]);
  const blocks = useMemo(() => planBlocks(graph, tops), [graph, tops]);
  const firstAt = useMemo(() => planFirstAt(graph, blocks), [graph, blocks]);
  // For each top account: can this wallet sign for it (so the boxes can show "N more needed" counting the wallet's signature)?
  const contexts = useMemo(() => {
    const m = new Map<string, BracketCtx>();
    for (const a of tops) {
      const eligible = wallet !== '' && graph.get(a)?.isMultisig === true && planApproval(graph, a, wallet).eligible;
      m.set(a, { graph, marks, signed: eligible ? new Set([wallet]) : null, firstAt });
    }
    return m;
  }, [tops, graph, marks, wallet, firstAt]);

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <BackButton onBack={() => navigate('/multisig')} />
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <SectionCard title={t('multisig.tree_title')}>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('multisig.tree_intro')}</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <Field
              ariaLabel={t('multisig.tree_account')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              error={problem !== null}
              helperText={problem ? t(`multisig.${problem}`) : t('multisig.tree_input_hint', { prefix: addressPrefix() })}
              htmlInput={{ autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false }}
            />
            <Button variant="contained" disabled={problem !== null} onClick={show} sx={{ py: 1, flexShrink: 0 }}>{t('multisig.tree_show')}</Button>
          </Box>
        </SectionCard>

        {failed && (
          <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => void load()}>{t('multisig.reload')}</Button>}>
            {t('multisig.load_failed')}
          </Alert>
        )}
        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}

        {!loading && !failed && (
          <SectionCard>
            {!target && <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 1.5 }}>{t('multisig.tree_no_account')}</Typography>}
            {target && !isTree && <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', py: 1.5 }}>{t('multisig.tree_none')}</Typography>}
            {isTree && (
              <>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                  <Chip size="small" label={t('multisig.tree_levels', { count: depth })} />
                  <Chip size="small" label={t('multisig.tree_accounts', { count: graph.size })} />
                  {plan?.eligible && <Chip size="small" color="success" label={plan.selfSufficient ? t('multisig.tree_alone') : t('multisig.tree_others', { count: plan.others })} />}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, color: 'text.secondary' }}>
                  <ArrowForwardIcon sx={{ fontSize: 16 }} />
                  <Typography variant="caption">{t('multisig.tree_flow')}</Typography>
                </Box>
                {/* The bracket is wider than a phone: it scrolls sideways inside its own box. */}
                <Box sx={{ overflowX: 'auto', pb: 1.5 }}>
                  <Box sx={{ width: 'max-content', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {blocks.map((b) => b.kind === 'single' ? (
                      <Bracket key={b.top} ctx={contexts.get(b.top)!} address={b.top} path={new Set()} depth={0} />
                    ) : (
                      <SharedBlock key={`${b.source}:${b.tops.join(',')}`} source={b.source} tops={b.tops} contexts={contexts} />
                    ))}
                  </Box>
                </Box>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('multisig.tree_legend')}</Typography>
              </>
            )}
          </SectionCard>
        )}
      </Box>
    </Box>
  );
}
