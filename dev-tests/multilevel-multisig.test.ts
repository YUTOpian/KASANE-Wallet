// マルチレベルマルチシグ (a cosigner that is itself a multisig account): which signatures an aggregate needs, loops and depth,
// the fee's signature count, walking the tree / the chain of accounts over a mocked REST gateway, and the signers
// of a waiting transaction. No real network.
// Run: npx tsx dev-tests/multilevel-multisig.test.ts
import { Address } from 'symbol-sdk/symbol';
import { addressFromPublicKey, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { resolveSigner } from '../src/lib/symbol/aggregateApi';
import { fetchCosignedAccounts, fetchCosignerGraph, fetchMaxMultisigDepth, fetchPartialTransactions } from '../src/lib/symbol/multisigApi';
import {
  depthAfterChange, isCosignerAtAnyDepth, levelsBelow, mergeGraphs, missingSignatures, modificationCosignatures, planApproval, treeRows,
} from '../src/lib/symbol/multisigTree';
import type { MultisigGraph, MultisigNodeInfo } from '../src/lib/symbol/multisigTree';
import { getNetwork, getNetworkConfig, setCustomNodeUrl } from '../src/lib/symbol/network';
import { COSIGNATURE_SIZE, signMultisigAggregate } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const key = (n: number) => keyPairFromPrivateKey(n.toString(16).padStart(2, '0').repeat(32));
const addr = (kp: { publicKey: string }) => addressFromPublicKey(kp.publicKey, cfg.networkByte);

// Accounts: A (top) <- B (multisig) <- W (the wallet), X, Y ; A <- C ; plus D (a loner leaf).
const kW = key(1), kX = key(2), kY = key(3), kC = key(4), kB = key(5), kA = key(6), kD = key(7);
const [W, X, Y, C, B, A, D] = [kW, kX, kY, kC, kB, kA, kD].map(addr);

const node = (address: string, minApproval: number, cosignatories: string[]): MultisigNodeInfo => ({
  address, minApproval, minRemoval: minApproval, cosignatories, isMultisig: cosignatories.length > 0,
});
const leaf = (address: string) => node(address, 0, []);
const graphOf = (...nodes: MultisigNodeInfo[]): MultisigGraph => new Map(nodes.map((n) => [n.address, n]));

// A needs 2 of {B, C}; B needs 2 of {W, X, Y}.
const g = graphOf(node(A, 2, [B, C]), node(B, 2, [W, X, Y]), leaf(C), leaf(W), leaf(X), leaf(Y));

// --- what it takes to approve --------------------------------------------------------------------
ok(missingSignatures(g, A) === 3, 'nothing signed: B needs 2 of its cosigners, C needs 1', missingSignatures(g, A));
ok(missingSignatures(g, A, new Set([W])) === 2, 'wallet signed: one more for B, one for C', missingSignatures(g, A, new Set([W])));
ok(missingSignatures(g, A, new Set([W, X, C])) === 0, 'W+X approve B, C signed: A is approved');
ok(missingSignatures(g, A, new Set([W, X])) === 1, 'B approved, C missing');
ok(missingSignatures(g, B, new Set([W])) === 1, 'B alone: one more');
ok(missingSignatures(g, C, new Set()) === 1 && missingSignatures(g, C, new Set([C])) === 0, 'a leaf costs 1 or 0');

let plan = planApproval(g, A, W);
ok(plan.eligible && !plan.selfSufficient && plan.others === 2, 'wallet is an eligible deep cosigner, two more signatures needed', plan);
plan = planApproval(g, B, W);
ok(plan.eligible && !plan.selfSufficient && plan.others === 1, 'direct cosigner of B', plan);
plan = planApproval(g, A, D);
ok(!plan.eligible && !plan.selfSufficient, 'an unrelated account cannot sign for A', plan);
plan = planApproval(g, A, B);
ok(!plan.eligible, 'a multisig account cannot sign itself (only leaves sign)', plan);
plan = planApproval(g, A, A);
ok(!plan.eligible, 'the account is not its own cosigner', plan);

// minApproval 1 all the way: the wallet alone approves, through two levels.
const g1 = graphOf(node(A, 1, [B, C]), node(B, 1, [W, X]), leaf(C), leaf(W), leaf(X));
plan = planApproval(g1, A, W);
ok(plan.eligible && plan.selfSufficient && plan.others === 0, 'wallet alone approves through 1-of-n at every level (complete aggregate)', plan);
// ... but not when the wallet is on the other branch and B needs two
const g1b = graphOf(node(A, 1, [B, C]), node(B, 2, [X, Y]), leaf(C), leaf(W), leaf(X), leaf(Y));
ok(planApproval(g1b, A, C).selfSufficient, 'C alone approves A (1 of {B, C})');
ok(planApproval(g1b, A, X).others === 1 && !planApproval(g1b, A, X).selfSufficient, 'X: B needs one more (Y) or C signs -> 1', planApproval(g1b, A, X));

// flat accounts behave as before
const flat = graphOf(node(A, 2, [W, X, Y]), leaf(W), leaf(X), leaf(Y));
plan = planApproval(flat, A, W);
ok(plan.eligible && plan.others === 1 && !plan.selfSufficient, 'flat 2-of-3: wallet + 1 other', plan);
ok(planApproval(graphOf(node(A, 1, [W, X]), leaf(W), leaf(X)), A, W).selfSufficient, 'flat 1-of-2: wallet alone');
ok(planApproval(flat, A, D).others === 2, 'a non-cosigner counts nothing: 2 signatures from others');

// loops and impossible thresholds never read as approved
const loop = graphOf(node(A, 1, [B]), node(B, 1, [A]));
ok(missingSignatures(loop, A) === Infinity, 'a loop cannot be approved');
ok(missingSignatures(graphOf(node(A, 3, [W, X]), leaf(W), leaf(X)), A) === Infinity, 'threshold above the cosigner count cannot be approved');
ok(!isCosignerAtAnyDepth(loop, A, D), 'loop terminates when searching');

// --- who is a cosigner --------------------------------------------------------------------------
ok(isCosignerAtAnyDepth(g, A, W) && isCosignerAtAnyDepth(g, A, B) && isCosignerAtAnyDepth(g, A, C), 'cosigners at any depth');
ok(!isCosignerAtAnyDepth(g, B, C) && !isCosignerAtAnyDepth(g, A, D), 'not cosigners');

// --- fee: signatures to leave room for in a modification ----------------------------------------
// editing flat F (2-of-{W,P}) adding a leaf N: P (to reach 2) and N (opt-in)
const P = addr(key(8)), N = addr(key(9)), F = addr(key(10));
const gf = graphOf(node(F, 2, [W, P]), leaf(W), leaf(P), leaf(N));
ok(modificationCosignatures(gf, F, [N], W) === 2, 'edit flat: the other current cosigner AND the new one', modificationCosignatures(gf, F, [N], W));
ok(modificationCosignatures(gf, F, [], W) === 1, 'threshold-only change: the other current cosigner');
ok(modificationCosignatures(gf, null, [N], W) === 1, 'convert: just the new cosigner');
// converting the wallet's own account with a multisig cosigner added: that cosigner's own cosigners sign for it
ok(modificationCosignatures(g, null, [B], D) === 2, 'adding multisig B (2-of-3): two of its cosigners', modificationCosignatures(g, null, [B], D));
ok(modificationCosignatures(g, null, [B, C], X) === 1 + 1, 'adding B and C when the wallet is X: one more for B, one for C', modificationCosignatures(g, null, [B, C], X));

// --- depth ----------------------------------------------------------------------------------------
ok(levelsBelow(g, A) === 2 && levelsBelow(g, B) === 1 && levelsBelow(g, W) === 0, 'levels below', [levelsBelow(g, A), levelsBelow(g, B)]);
ok(depthAfterChange(g, [B, C], 0) === 2 && depthAfterChange(g, [A], 0) === 3, 'a new account over B and C: 2 levels; over A: 3', [depthAfterChange(g, [B, C], 0), depthAfterChange(g, [A], 0)]);
ok(depthAfterChange(g, [W], 0) === 1 && depthAfterChange(g, [W], 2) === 3, 'plain cosigners; accounts above add their levels');
ok(depthAfterChange(g, [A], 1) === 4, 'A (2 levels) under a new account that itself cosigns one more: 4 > 3', depthAfterChange(g, [A], 1));
ok(mergeGraphs(graphOf(leaf(W)), graphOf(node(W, 1, [X]))).get(W)?.isMultisig === false, 'merge: first wins');

// --- display rows --------------------------------------------------------------------------------
const rows = treeRows(g, A);
ok(rows.map((r) => `${r.depth}:${r.address === B ? 'B' : r.address === W ? 'W' : r.address === C ? 'C' : r.address === X ? 'X' : 'Y'}`).join(' ') === '0:B 1:W 1:X 1:Y 0:C', 'tree rows are indented by depth', rows.map((r) => `${r.depth}`));
ok(rows[0].multisig && rows[0].minApproval === 2 && rows[0].cosignerCount === 3, 'a multisig cosigner row carries its threshold');
ok(treeRows(loop, A).some((r) => r.repeated), 'a loop is shown once, then marked repeated');

// --- a transaction signed through the tree has room for the cosignatures --------------------------
{
  const others = planApproval(g, A, W).others;
  const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + 3600n * 1000n;
  const base = signMultisigAggregate(kW.privateKey, cfg.generationHash, {
    signerPublicKey: kW.publicKey, networkByte: cfg.networkByte, bonded: true, cosignatureCount: 0, feeMultiplier: 100, deadline,
    inner: { kind: 'transfer', accountPublicKey: kA.publicKey, recipient: D, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }] },
  });
  const withCos = signMultisigAggregate(kW.privateKey, cfg.generationHash, {
    signerPublicKey: kW.publicKey, networkByte: cfg.networkByte, bonded: true, cosignatureCount: others, feeMultiplier: 100, deadline,
    inner: { kind: 'transfer', accountPublicKey: kA.publicKey, recipient: D, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }] },
  });
  ok(withCos.fee - base.fee === BigInt(COSIGNATURE_SIZE * others) * 100n, 'fee leaves room for the leaf cosignatures', [withCos.fee, base.fee]);
}

// --- the REST walk (mocked gateway) ---------------------------------------------------------------
const hexOf = (a: string) => Array.from(new Address(a).bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
interface Rec { minApproval: number; minRemoval: number; cosigners: string[]; parents: string[] }
const chain: Record<string, Rec> = {
  [A]: { minApproval: 2, minRemoval: 2, cosigners: [B, C], parents: [] },
  [B]: { minApproval: 2, minRemoval: 2, cosigners: [W, X, Y], parents: [A] },
  [W]: { minApproval: 0, minRemoval: 0, cosigners: [], parents: [B] },
  [X]: { minApproval: 0, minRemoval: 0, cosigners: [], parents: [B] },
  [Y]: { minApproval: 0, minRemoval: 0, cosigners: [], parents: [B] },
  [C]: { minApproval: 0, minRemoval: 0, cosigners: [], parents: [A] },
};
const requested: string[] = [];
const partials: Record<string, unknown> = {};
globalThis.fetch = (async (url: string) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let m = path.match(/^\/account\/([A-Z0-9]+)\/multisig$/);
  if (m) {
    requested.push(m[1]);
    const rec = chain[m[1]];
    if (!rec) return json({ code: 'ResourceNotFound' }, 404);
    return json({ multisig: { minApproval: rec.minApproval, minRemoval: rec.minRemoval, cosignatoryAddresses: rec.cosigners.map(hexOf), multisigAddresses: rec.parents.map(hexOf) } });
  }
  m = path.match(/^\/accounts\/([A-Z0-9]+)$/);
  if (m) return json({ account: { publicKey: m[1] === A ? kA.publicKey : '0'.repeat(64) } });
  if (path === '/network/properties') return json({ plugins: { multisig: { maxMultisigDepth: '3' }, lockhash: { lockedFundsPerAggregate: '10\'000\'000' } } });
  m = path.match(/^\/transactions\/partial\?address=([A-Z0-9]+)/);
  if (m) return json({ data: m[1] === A ? [{ meta: { hash: 'AB'.repeat(32) } }] : [] });
  m = path.match(/^\/transactions\/partial\/([A-F0-9]+)$/);
  if (m && partials[m[1]]) return json(partials[m[1]]);
  return json({ code: 'ResourceNotFound' }, 404);
}) as typeof fetch;
setCustomNodeUrl(getNetwork(), 'http://mock.local');

(async () => {
  const graph = await fetchCosignerGraph(A);
  ok([A, B, C, W, X, Y].every((a) => graph.has(a)), 'the walk reaches every account in the tree', [...graph.keys()].length);
  ok(graph.get(B)?.isMultisig === true && graph.get(W)?.isMultisig === false, 'a cosigner that is multisig is a node, an ordinary one a leaf');
  ok(new Set(requested).size === requested.length, 'no account is read twice', requested.length);
  ok(planApproval(graph, A, W).others === 2, 'the fetched graph gives the same plan', planApproval(graph, A, W));

  const cosigned = await fetchCosignedAccounts(W);
  ok(cosigned.length === 2 && cosigned[0].info.address === B && cosigned[0].level === 1 && cosigned[0].via === '', 'wallet cosigns for B directly', cosigned.map((c) => c.level));
  ok(cosigned[1]?.info.address === A && cosigned[1].level === 2 && cosigned[1].via === B, 'and for A through B (level 2, via B)', cosigned[1]);
  ok((await fetchCosignedAccounts(D)).length === 0, 'an unknown account cosigns for nothing');
  ok((await fetchCosignedAccounts(W, 1)).length === 1, 'the level limit is honoured');
  ok(await fetchMaxMultisigDepth() === 3, 'max depth is read from the network properties');

  const signer = await resolveSigner(W, A, kA.publicKey);
  ok(signer.multisig && !signer.selfSufficient && signer.cosignatures === 2, 'resolveSigner: nested account needs two other signatures', signer);
  const direct = await resolveSigner(W, B, kB.publicKey);
  ok(direct.multisig && !direct.selfSufficient && direct.cosignatures === 1, 'resolveSigner: direct 2-of-3 needs one more (as before)', direct);
  const unrelated = await resolveSigner(D, B, kB.publicKey);
  ok(unrelated.multisig && !unrelated.selfSufficient && unrelated.cosignatures === 2, 'resolveSigner: a non-cosigner needs two (as before)', unrelated);
  const plain = await resolveSigner(W, C, kC.publicKey);
  ok(!plain.multisig && plain.cosignatures === 1, 'resolveSigner: an ordinary account is unchanged', plain);

  // a waiting transaction: who has signed so far
  const hash = 'AB'.repeat(32);
  partials[hash] = {
    transaction: { signerPublicKey: kW.publicKey, network: cfg.networkByte, deadline: '1000', cosignatures: [{ signerPublicKey: kX.publicKey }], transactions: [] },
  };
  const list = await fetchPartialTransactions(W, kW.publicKey, cosigned.map((c) => c.info.address));
  ok(list.length === 1 && list[0].signers.length === 2 && list[0].signers[0] === W && list[0].signers[1] === X, 'a waiting transaction lists the initiator and cosigners by address', list[0]?.signers);
  ok(missingSignatures(graph, A, new Set(list[0].signers)) === 1, 'W and X approve B; C is the one still missing', missingSignatures(graph, A, new Set(list[0].signers)));
  ok(list[0].signedByMe, 'signed by the wallet');

  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
