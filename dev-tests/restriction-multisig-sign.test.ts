// Account restrictions changed IN THE NAME OF a multisig account (a cosigner signs an aggregate):
// the signed aggregate must be the size the fee was quoted for, be the right aggregate type, and read back
// (offline, from the bytes only) as the same restriction change a cosigner is shown before signing.
// Run: npx tsx dev-tests/restriction-multisig-sign.test.ts
import { addressFromPublicKey, hexToBytes, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { summarizePayload } from '../src/lib/symbol/payloadSummary';
import * as R from '../src/lib/symbol/restrictions';
import { COSIGNATURE_SIZE, multisigRestrictionAggregateSize, signMultisigAggregate } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// Reading a payload must not touch the network.
let networkCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => { networkCalls++; return Promise.reject(new Error('offline')); };

const cfg = getNetworkConfig();
const cosigner = keyPairFromPrivateKey('1'.repeat(64));
const multisig = keyPairFromPrivateKey('4'.repeat(64));
const multisigAddress = addressFromPublicKey(multisig.publicKey, cfg.networkByte);
const friend = addressFromPublicKey('3'.repeat(64), cfg.networkByte);
const friend2 = addressFromPublicKey('5'.repeat(64), cfg.networkByte);
const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + 3600n * 1000n;

interface Case {
  label: string;
  rule: R.RestrictionRule;
  mode: R.RestrictionMode;
  additions: string[];
  deletions: string[];
}
const cases: Case[] = [
  { label: 'address / outgoing / block', rule: { kind: 'address', direction: 'outgoing' }, mode: 'block', additions: [friend], deletions: [] },
  { label: 'address / incoming / allow, add + remove', rule: { kind: 'address', direction: 'incoming' }, mode: 'allow', additions: [friend, friend2], deletions: [friend] },
  { label: 'mosaic / incoming / block', rule: { kind: 'mosaic', direction: 'incoming' }, mode: 'block', additions: ['6BED913FA20223F8', '72C0212E67A08BCE'], deletions: ['E74B99BA41F4AFEE'] },
  { label: 'operation / outgoing / allow (1 value: padded)', rule: { kind: 'operation', direction: 'outgoing' }, mode: 'allow', additions: ['4350'], deletions: [] },
  { label: 'operation / outgoing / allow (5 values: padded)', rule: { kind: 'operation', direction: 'outgoing' }, mode: 'allow', additions: ['4154', '4350', '4155', '4141', '4241'], deletions: [] },
];

(async () => {
  for (const c of cases) {
    for (const bonded of [false, true]) {
      const cosignatureCount = bonded ? 2 : 1;
      const label = `${c.label} / ${bonded ? 'bonded' : 'complete'}`;
      const signed = signMultisigAggregate(cosigner.privateKey, cfg.generationHash, {
        signerPublicKey: cosigner.publicKey, networkByte: cfg.networkByte, bonded, cosignatureCount, feeMultiplier: 100, deadline,
        inner: { kind: 'restriction', accountPublicKey: multisig.publicKey, rule: c.rule, mode: c.mode, additions: c.additions, deletions: c.deletions },
      });
      const bytes = hexToBytes(signed.payload);
      const expected = multisigRestrictionAggregateSize(c.rule.kind, c.additions.length, c.deletions.length);
      ok(bytes.length === expected, `${label}: aggregate size matches the estimate`, `${bytes.length} vs ${expected}`);
      ok(signed.fee === BigInt(bytes.length + COSIGNATURE_SIZE * cosignatureCount) * 100n, `${label}: fee covers the cosignatures`, signed.fee);
      const type = bytes[110] | (bytes[111] << 8);
      ok(type === (bonded ? 0x4241 : 0x4141), `${label}: aggregate type`, type.toString(16));

      const summary = await summarizePayload(signed.payload, { offline: true });
      ok(summary.contentsMatchHash, `${label}: inner transactions match the hash`);
      ok(summary.hash === signed.hash, `${label}: hash recomputed from the bytes`);
      const item = summary.items[0];
      ok(summary.items.length === 1 && item.kind === 'restriction', `${label}: read back as a restriction`, item);
      if (item.kind === 'restriction') {
        ok(item.account === multisigAddress, `${label}: it is in the name of the multisig account`, item.account);
        ok(item.rule.kind === c.rule.kind && item.rule.direction === c.rule.direction, `${label}: rule`, item.rule);
        ok(item.mode === c.mode, `${label}: mode`);
        ok(item.additions.join() === c.additions.join(), `${label}: additions`, item.additions);
        ok(item.deletions.join() === c.deletions.join(), `${label}: deletions`, item.deletions);
      }
    }
  }

  // An empty change is refused before anything is signed.
  let refused = '';
  try {
    signMultisigAggregate(cosigner.privateKey, cfg.generationHash, {
      signerPublicKey: cosigner.publicKey, networkByte: cfg.networkByte, bonded: false, cosignatureCount: 1, feeMultiplier: 100, deadline,
      inner: { kind: 'restriction', accountPublicKey: multisig.publicKey, rule: { kind: 'address', direction: 'incoming' }, mode: 'block', additions: [], deletions: [] },
    });
  } catch (e) { refused = (e as Error).message; }
  ok(refused === 'no_changes', 'an empty change is refused', refused);

  ok(networkCalls === 0, 'reading a payload never asks a node', networkCalls);
  console.log(`${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})();
