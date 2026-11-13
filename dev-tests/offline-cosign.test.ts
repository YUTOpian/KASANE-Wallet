// Offline cosign: a cosign request that carries the aggregate is read WITHOUT any network access, the hash is
// recomputed from the bytes, and the cosignature verifies. A hash-only request and a tampered request are refused.
// Run: npx tsx dev-tests/offline-cosign.test.ts
import { addressFromPublicKey, hexToBytes, keyPairFromPrivateKey, verifySignature } from '../src/lib/symbol/crypto';
import { buildKasaneQr, networkProblem, parseKasaneQr } from '../src/lib/symbol/kasaneQr';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { summarizePayload } from '../src/lib/symbol/payloadSummary';
import { cosignAggregateHash, signMultisigAggregate } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// Any network access is a failure of this feature.
let networkCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => { networkCalls++; return Promise.reject(new Error('offline')); };

const cfg = getNetworkConfig();
const initiator = keyPairFromPrivateKey('1'.repeat(64));
const cosigner = keyPairFromPrivateKey('2'.repeat(64));
const multisig = keyPairFromPrivateKey('4'.repeat(64));
const recipient = addressFromPublicKey('3'.repeat(64), cfg.networkByte);
const unknownMosaic = 'ABCDEF0123456789';

const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + 3600n * 1000n;
const signed = signMultisigAggregate(initiator.privateKey, cfg.generationHash, {
  signerPublicKey: initiator.publicKey, networkByte: cfg.networkByte, bonded: true, cosignatureCount: 1, feeMultiplier: 100, deadline,
  inner: { kind: 'transfer', accountPublicKey: multisig.publicKey, recipient, mosaics: [{ id: cfg.currencyMosaicId, amount: 2_500_000n }, { id: unknownMosaic, amount: 7n }], message: 'hi' },
});

(async () => {
  const text = buildKasaneQr({ kind: 'cosign_request', hash: signed.hash, payload: signed.payload });
  const parsed = parseKasaneQr(text);
  ok(parsed?.qr.kind === 'cosign_request' && networkProblem(parsed) === null, 'request with the aggregate parses');
  if (parsed?.qr.kind !== 'cosign_request' || !parsed.qr.payload) return;

  const s = await summarizePayload(parsed.qr.payload, { offline: true });
  ok(networkCalls === 0, 'summarizing offline makes no network call', networkCalls);
  ok(s.bonded && s.signed, 'bonded and signed');
  ok(s.hash === signed.hash.toUpperCase(), 'hash recomputed from the bytes equals the QR hash');
  ok(s.signerPublicKey === initiator.publicKey.toUpperCase(), 'initiator read from the bytes');
  const item = s.items[0];
  ok(item.kind === 'transfer', 'inner transfer read');
  if (item.kind === 'transfer') {
    ok(item.recipient === recipient, 'recipient read');
    ok(item.mosaics[0].symbol === 'XYM' && item.mosaics[0].amount === '2.5', 'network currency shown as XYM with its decimals', item.mosaics[0]);
    ok(item.mosaics[1].symbol === unknownMosaic && item.mosaics[1].amount === '7', 'an unknown mosaic shows its id and the raw amount', item.mosaics[1]);
    ok(item.message === 'hi', 'message read');
  }
  const known = await summarizePayload(parsed.qr.payload, { offline: true, knownMosaics: { [unknownMosaic]: { symbol: 'my.coin', divisibility: 2 } } });
  const kitem = known.items[0];
  ok(kitem.kind === 'transfer' && kitem.mosaics[1].symbol === 'my.coin' && kitem.mosaics[1].amount === '0.07', 'a remembered mosaic is shown with its name and decimals');

  // the cosignature signs the recomputed hash
  const body = cosignAggregateHash(cosigner.privateKey, s.hash);
  ok(verifySignature(body.signerPublicKey, hexToBytes(s.hash), hexToBytes(body.signature)), 'cosignature verifies against the recomputed hash');
  const back = parseKasaneQr(buildKasaneQr({ kind: 'cosignature', ...body }));
  ok(back?.qr.kind === 'cosignature' && networkProblem(back) === null, 'cosignature QR parses for the online PC');

  // an aggregate's hash does not cover its inner transactions, so swapped content must be caught by the contents check

  ok(s.contentsMatchHash, 'an honest aggregate: inner transactions match the hash');
  // the inner transfer's amount is changed but the header (and so the hash) is left alone
  const marker = (2_500_000n).toString(16).toUpperCase().padStart(16, '0').match(/../g)!.reverse().join('');
  const idx = parsed.qr.payload.indexOf(marker);
  ok(idx > 0, 'found the amount in the payload');
  const swapped = parsed.qr.payload.slice(0, idx) + '0000000000000000'.replace(/0/g, '0').slice(0, 2) + 'FF' + parsed.qr.payload.slice(idx + 4);
  const sw = await summarizePayload(swapped, { offline: true });
  ok(sw.hash === s.hash && !sw.contentsMatchHash, 'swapped inner content keeps the hash but is flagged', { same: sw.hash === s.hash, match: sw.contentsMatchHash });

  // hash-only request still parses (the screen refuses it because there is nothing to check)
  const hashOnly = parseKasaneQr(buildKasaneQr({ kind: 'cosign_request', hash: signed.hash }));
  ok(hashOnly?.qr.kind === 'cosign_request' && !hashOnly.qr.payload, 'hash-only request has no payload');
  ok(networkCalls === 0, 'still no network call');

  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
