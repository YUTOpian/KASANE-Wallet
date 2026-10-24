// Signing QR envelope (signed transaction / cosign request / cosignature / multisig template): build -> parse.
// Run: npx tsx dev-tests/kasane-qr.test.ts
import { buildKasaneQr, isKasaneQr, networkProblem, parseKasaneQr } from '../src/lib/symbol/kasaneQr';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const H = 'AB'.repeat(32);
const PK = '12'.repeat(32);
const SIG = 'CD'.repeat(64);
const ADDR_A = 'NBRVVAPBAF5G36NEFI3KMHVBB4Z2AGR2GSBYLTI';
const ADDR_B = 'NDNWNQ7X5FKZEBS4TFSEDDFNYKCZ75IIGBU3CKA';

// 1. signed transaction
{
  const text = buildKasaneQr({ kind: 'signed', payload: 'aabbccdd', hash: H.toLowerCase() });
  ok(isKasaneQr(text), 'isKasaneQr');
  const p = parseKasaneQr(text);
  ok(p?.qr.kind === 'signed', 'kind signed', p);
  ok(p?.qr.kind === 'signed' && p.qr.payload === 'AABBCCDD' && p.qr.hash === H, 'signed fields upper-cased');
  ok(p !== null && networkProblem(p) === null, 'same network accepted');
}

// 2. cosign request, with and without the payload
{
  const a = parseKasaneQr(buildKasaneQr({ kind: 'cosign_request', hash: H }));
  ok(a?.qr.kind === 'cosign_request' && a.qr.payload === undefined && a.qr.hash === H, 'cosign request, hash only');
  const b = parseKasaneQr(buildKasaneQr({ kind: 'cosign_request', hash: H, payload: '0011' }));
  ok(b?.qr.kind === 'cosign_request' && b.qr.payload === '0011', 'cosign request with payload');
}

// 3. cosignature
{
  const p = parseKasaneQr(buildKasaneQr({ kind: 'cosignature', parentHash: H, signerPublicKey: PK, signature: SIG, version: '0' }));
  ok(p?.qr.kind === 'cosignature' && p.qr.signature === SIG && p.qr.signerPublicKey === PK.toUpperCase() && p.qr.version === '0', 'cosignature fields', p);
}

// 4. multisig template, hyphenated address is normalised
{
  const p = parseKasaneQr(buildKasaneQr({
    kind: 'template', account: ADDR_A, recipient: `${ADDR_B.slice(0, 6)}-${ADDR_B.slice(6)}`,
    mosaics: [{ id: '6bed913fa20223f8', amount: '1500000' }], message: 'こんにちは',
  }));
  ok(p?.qr.kind === 'template', 'template parses', p);
  if (p?.qr.kind === 'template') {
    ok(p.qr.recipient === ADDR_B && p.qr.account === ADDR_A, 'addresses normalised');
    ok(p.qr.mosaics[0].id === '6BED913FA20223F8' && p.qr.mosaics[0].amount === '1500000', 'mosaic kept');
    ok(p.qr.message === 'こんにちは', 'message kept');
  }
}

// 5. malformed input is refused
{
  ok(parseKasaneQr('hello') === null, 'plain text refused');
  ok(parseKasaneQr('{"v":3,"type":0,"data":{}}') === null, 'official QR v3 is not ours');
  ok(!isKasaneQr('{"v":3,"type":0}'), 'isKasaneQr false for official QR');
  ok(!isKasaneQr('web+symbol://transaction?data=00'), 'isKasaneQr false for a URI');
  const base = { kasane: 1, network_id: 104, chain_id: getNetworkConfig().generationHash };
  const mk = (kind: string, data: unknown) => JSON.stringify({ ...base, kind, data });
  ok(parseKasaneQr(mk('signed', { payload: 'ZZ', hash: H })) === null, 'bad hex payload refused');
  ok(parseKasaneQr(mk('signed', { payload: 'AA', hash: 'AB' })) === null, 'short hash refused');
  ok(parseKasaneQr(mk('signed', { payload: 'AAB', hash: H })) === null, 'odd-length payload refused');
  ok(parseKasaneQr(mk('cosignature', { parentHash: H, signerPublicKey: PK, signature: 'AB' })) === null, 'short signature refused');
  ok(parseKasaneQr(mk('template', { account: ADDR_A, recipient: 'x', mosaics: [{ id: '6BED913FA20223F8', amount: '1' }] })) === null, 'bad recipient refused');
  ok(parseKasaneQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [] })) === null, 'no mosaic refused');
  ok(parseKasaneQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [{ id: '6BED913FA20223F8', amount: '0' }] })) === null, 'zero amount refused');
  ok(parseKasaneQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [{ id: '6BED913FA20223F8', amount: '-5' }] })) === null, 'negative amount refused');
  ok(parseKasaneQr(mk('unknown', {})) === null, 'unknown kind refused');
  ok(parseKasaneQr(JSON.stringify({ ...base, kasane: 2, kind: 'signed', data: { payload: 'AA', hash: H } })) === null, 'other version refused');
}

// 6. another network is refused
{
  const text = buildKasaneQr({ kind: 'cosign_request', hash: H });
  setNetwork('testnet');
  const p = parseKasaneQr(text);
  ok(p !== null && networkProblem(p) === 'wrong_network', 'mainnet QR refused on testnet');
  const testText = buildKasaneQr({ kind: 'cosign_request', hash: H });
  const q = parseKasaneQr(testText);
  ok(q !== null && networkProblem(q) === null, 'testnet QR accepted on testnet');
  setNetwork('mainnet');
  const q2 = parseKasaneQr(testText);
  ok(q2 !== null && networkProblem(q2) === 'wrong_network', 'testnet QR refused on mainnet');
  const noNet = parseKasaneQr(JSON.stringify({ kasane: 1, kind: 'cosign_request', data: { hash: H } }));
  ok(noNet !== null && networkProblem(noNet) === 'wrong_network', 'QR without a network refused');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
