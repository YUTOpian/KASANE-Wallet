// Payloads from other Symbol tools (symbol-cli, SDKs, REST): plain hex, labelled hex, JSON bodies, cosignature
// bodies, a bare hash. Run: npx tsx dev-tests/external-payload.test.ts
import { addressFromPublicKey, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { networkProblem } from '../src/lib/symbol/kasaneQr';
import { parseAnyInput, parseExternalPayload } from '../src/lib/symbol/externalPayload';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { cosignAggregateHash, signMultisigAggregate, signTransfer } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const a = keyPairFromPrivateKey('1'.repeat(64));
const b = keyPairFromPrivateKey('2'.repeat(64));
const msig = keyPairFromPrivateKey('4'.repeat(64));
const recipient = addressFromPublicKey('3'.repeat(64), cfg.networkByte);
const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + 3600n * 1000n;

const transfer = signTransfer(a.privateKey, cfg.generationHash, {
  signerPublicKey: a.publicKey, networkByte: cfg.networkByte, recipient, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }], maxFee: 17600n, deadline,
});
const bonded = signMultisigAggregate(a.privateKey, cfg.generationHash, {
  signerPublicKey: a.publicKey, networkByte: cfg.networkByte, bonded: true, cosignatureCount: 1, feeMultiplier: 100, deadline,
  inner: { kind: 'transfer', accountPublicKey: msig.publicKey, recipient, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }] },
});
const complete = signMultisigAggregate(a.privateKey, cfg.generationHash, {
  signerPublicKey: a.publicKey, networkByte: cfg.networkByte, bonded: false, cosignatureCount: 0, feeMultiplier: 100, deadline,
  inner: { kind: 'transfer', accountPublicKey: a.publicKey, recipient, mosaics: [{ id: cfg.currencyMosaicId, amount: 1n }] },
});

// plain hex (any case, 0x, line breaks)
for (const [name, text] of [
  ['hex', transfer.payload], ['lower-case hex', transfer.payload.toLowerCase()], ['0x hex', `0x${transfer.payload}`],
  ['hex with line breaks', transfer.payload.replace(/(.{64})/g, '$1\n')], ['labelled', `Payload: ${transfer.payload}\nHash: ${transfer.hash}`],
  ['REST body', JSON.stringify({ payload: transfer.payload })], ['nested', JSON.stringify({ signedTransaction: { payload: transfer.payload, hash: 'FF'.repeat(32) } })],
  ['transactionPayload', JSON.stringify({ transactionPayload: transfer.payload })], ['array', JSON.stringify([{ payload: transfer.payload }])],
] as const) {
  const p = parseAnyInput(text);
  ok(p?.qr.kind === 'signed' && p.qr.hash === transfer.hash.toUpperCase() && p.qr.payload === transfer.payload.toUpperCase() && networkProblem(p) === null, `signed transfer from ${name}`, p?.qr.kind);
}
// a "hash" in the JSON is never trusted: the hash comes from the bytes
{
  const p = parseExternalPayload(JSON.stringify({ payload: transfer.payload, hash: 'FF'.repeat(32) }));
  ok(p?.qr.kind === 'signed' && p.qr.hash === transfer.hash.toUpperCase(), 'a claimed hash is ignored');
}
// bonded -> cosign request that carries the payload; complete aggregate -> signed
{
  const p = parseAnyInput(bonded.payload);
  ok(p?.qr.kind === 'cosign_request' && p.qr.hash === bonded.hash.toUpperCase() && p.qr.payload === bonded.payload.toUpperCase() && networkProblem(p) === null, 'bonded payload is a cosign request');
  const c = parseAnyInput(JSON.stringify({ payload: complete.payload }));
  ok(c?.qr.kind === 'signed' && c.qr.hash === complete.hash.toUpperCase(), 'complete aggregate is a signed transaction');
}
// cosignature body (REST announce body)
{
  const body = cosignAggregateHash(b.privateKey, bonded.hash);
  const p = parseAnyInput(JSON.stringify(body));
  ok(p?.qr.kind === 'cosignature' && p.qr.signature === body.signature && networkProblem(p) === null, 'cosignature body');
}
// a bare hash
{
  const p = parseAnyInput(bonded.hash);
  ok(p?.qr.kind === 'cosign_request' && !p.qr.payload && p.qr.hash === bonded.hash.toUpperCase(), 'bare hash is a hash-only cosign request');
}
// refused
ok(parseAnyInput('hello') === null, 'plain text is not read');
ok(parseAnyInput('{"a":1}') === null, 'other JSON is not read');
ok(parseAnyInput('ABCD'.repeat(80)) === null, 'hex that is no transaction is not read');
ok(parseAnyInput(transfer.payload.slice(0, 300)) === null, 'a cut-off payload is not read');
ok(parseAnyInput('') === null, 'empty');
// another network's payload is read but refused by networkProblem
{
  const other = transfer.payload.toUpperCase();
  // network byte sits right after the version byte: header 108 bytes, version at 108, network at 109
  const at = 109 * 2;
  const flipped = other.slice(0, at) + (cfg.networkByte === 0x98 ? '68' : '98') + other.slice(at + 2);
  const p = parseAnyInput(flipped);
  ok(p === null || networkProblem(p) !== null, 'a payload of the other network is refused');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
