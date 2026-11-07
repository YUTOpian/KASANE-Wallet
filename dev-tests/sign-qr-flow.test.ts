// Signed-transaction QR and cosignature QR, with the real SDK: sign a transfer -> QR -> read it back and
// recompute the hash from the bytes; cosign an aggregate hash -> QR -> verify the signature.
// (summarizePayload itself looks mosaics up on a node, so this checks the parts that need no network.)
// Run: npx tsx dev-tests/sign-qr-flow.test.ts
import { models } from 'symbol-sdk/symbol';
import { addressFromPublicKey, facadeFor, hexToBytes, keyPairFromPrivateKey, verifySignature } from '../src/lib/symbol/crypto';
import { buildKasaneQr, networkProblem, parseKasaneQr } from '../src/lib/symbol/kasaneQr';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { cosignAggregateHash, signTransfer } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const sender = keyPairFromPrivateKey('1'.repeat(64));
const cosigner = keyPairFromPrivateKey('2'.repeat(64));
const recipient = addressFromPublicKey('3'.repeat(64), cfg.networkByte);

// 1. signed transaction -> QR -> back
{
  const signed = signTransfer(sender.privateKey, cfg.generationHash, {
    signerPublicKey: sender.publicKey, networkByte: cfg.networkByte, recipient,
    mosaics: [{ id: cfg.currencyMosaicId, amount: 1_000_000n }], message: 'hello', maxFee: 17600n, deadline: 123456789n,
  });
  const text = buildKasaneQr({ kind: 'signed', payload: signed.payload, hash: signed.hash });
  const p = parseKasaneQr(text);
  ok(p?.qr.kind === 'signed' && networkProblem(p) === null, 'signed QR parses on its own network');
  if (p?.qr.kind === 'signed') {
    const tx = models.TransactionFactory.deserialize(hexToBytes(p.qr.payload));
    const hash = facadeFor(cfg.networkByte).hashTransaction(tx).toString().toUpperCase();
    ok(hash === p.qr.hash, 'hash recomputed from the bytes equals the QR hash', { hash, claimed: p.qr.hash });
    const signature = (tx as unknown as { signature: { bytes: Uint8Array } }).signature.bytes;
    ok(signature.some((b) => b !== 0), 'the payload carries a signature');
    // a payload that was altered no longer matches the hash the QR claims
    const altered = p.qr.payload.slice(0, -2) + (p.qr.payload.endsWith('00') ? '01' : '00');
    const tx2 = models.TransactionFactory.deserialize(hexToBytes(altered));
    ok(facadeFor(cfg.networkByte).hashTransaction(tx2).toString().toUpperCase() !== p.qr.hash, 'an altered payload gives another hash');
  }
}

// 2. cosignature -> QR -> back, signature verifies against the aggregate hash
{
  const aggregateHash = 'AB'.repeat(32);
  const body = cosignAggregateHash(cosigner.privateKey, aggregateHash);
  const p = parseKasaneQr(buildKasaneQr({ kind: 'cosignature', parentHash: body.parentHash, signerPublicKey: body.signerPublicKey, signature: body.signature, version: body.version }));
  ok(p?.qr.kind === 'cosignature', 'cosignature QR parses');
  if (p?.qr.kind === 'cosignature') {
    ok(verifySignature(p.qr.signerPublicKey, hexToBytes(p.qr.parentHash), hexToBytes(p.qr.signature)), 'cosignature verifies');
    ok(!verifySignature(p.qr.signerPublicKey, hexToBytes('CD'.repeat(32)), hexToBytes(p.qr.signature)), 'cosignature does not verify for another hash');
    ok(p.qr.signerPublicKey === cosigner.publicKey.toUpperCase(), 'signer public key kept');
  }
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
