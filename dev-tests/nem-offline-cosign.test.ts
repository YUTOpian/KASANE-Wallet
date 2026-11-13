// NEM のオフライン連署: 開始した人が署名したマルチシグのトランザクション（0x1004）を読み取り側（lib/nem/offline.ts）が正しく読めること、
// 連署が指すハッシュ（中身のトランザクションの Keccak-256）が、連署の署名データに入ること。
// Run: npx tsx dev-tests/nem-offline-cosign.test.ts   （symbol-sdk が必要）
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/nem';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { nemAddressFromPublicKey, verifyNemSignature } from '../src/lib/nem/crypto';
import { nemHexToBytes, parseNemSigned, buildNemSignedQr, readNemMultisigRequest, readNemTransfer } from '../src/lib/nem/offline';
import { signNemCosignature, signNemMultisigWrapped, signNemTransfer, nemTransferFee } from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const keyOf = (n: string) => new KeyPair(new PrivateKey(n.padStart(64, '0')));
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

const TESTNET = 0x98;
const initiatorPriv = '0000000000000000000000000000000000000000000000000000000000000001';
const cosignerPriv = '0000000000000000000000000000000000000000000000000000000000000002';
const initiatorPub = keyOf('1').publicKey.toString().toUpperCase();
const cosignerPub = keyOf('2').publicKey.toString().toUpperCase();
const multisigPub = keyOf('AB').publicKey.toString().toUpperCase();
const multisigAddress = nemAddressFromPublicKey(multisigPub, TESTNET);
const recipient = nemAddressFromPublicKey(keyOf('AA').publicKey.toString(), TESTNET);

// the initiator wraps a transfer made in the name of the multisig account
const bodyText = signNemMultisigWrapped(initiatorPriv, initiatorPub, TESTNET, multisigPub, { kind: 'transfer', recipient, amount: 5_000_000n, message: 'hi' });
const body = JSON.parse(bodyText) as { data: string; signature: string };
const s = readNemMultisigRequest(body.data);
ok(s.initiatorPublicKey === initiatorPub, 'initiator');
ok(s.multisigPublicKey === multisigPub, 'the multisig account is the wrapped transaction\'s signer', s.multisigPublicKey);
ok(s.networkByte === TESTNET, 'network');
ok(s.inner.typeValue === 0x101 && s.inner.transfer?.recipient === recipient, 'the wrapped transfer is read', s.inner);
ok(s.inner.transfer?.mosaics[0]?.quantity === 5_000_000n && s.inner.transfer.message?.text === 'hi', 'amount and message');
ok(s.deadlineMs > s.timestampMs, 'deadline');
ok(verifyNemSignature(s.initiatorPublicKey, nemHexToBytes(body.data), nemHexToBytes(body.signature)), 'the initiator\'s signature verifies');
const tampered = body.data.slice(0, -2) + (body.data.endsWith('00') ? '01' : '00');
ok(!verifyNemSignature(s.initiatorPublicKey, nemHexToBytes(tampered), nemHexToBytes(body.signature)), 'a changed byte breaks the signature');

// the hash: Keccak-256 of the wrapped transaction exactly as it sits in the wrapper (what NIS1 calls otherHash)
const bytes = nemHexToBytes(body.data);
// header: type, version, time stamp, signer length (4 x 4 bytes), signer (32), fee (8), deadline (4), then the wrapped transaction's length
const innerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16 + 32 + 8 + 4, true);
const innerBytes = bytes.subarray(16 + 32 + 8 + 4 + 4, 16 + 32 + 8 + 4 + 4 + innerSize);
ok(hexOf(keccak_256(innerBytes)) === s.innerHash, 'innerHash is the Keccak-256 of the wrapped bytes', s.innerHash);
ok(readNemTransfer(hexOf(innerBytes)).signerPublicKey === multisigPub, 'the wrapped bytes start with the multisig account as signer');

// QR round trip: the same body comes back from KASANE's NEM QR and from a bare announce body
const fromQr = parseNemSigned(buildNemSignedQr(bodyText, TESTNET));
ok(fromQr !== null && readNemMultisigRequest(fromQr.body.data).innerHash === s.innerHash, 'QR round trip');
const bare = parseNemSigned(bodyText);
ok(bare !== null && bare.networkId === null && readNemMultisigRequest(bare.body.data).innerHash === s.innerHash, 'bare announce body');

// the cosignature names that hash and the multisig account
const cosign = JSON.parse(signNemCosignature(cosignerPriv, cosignerPub, TESTNET, multisigAddress, s.innerHash)) as { data: string; signature: string };
const header = readNemTransfer(cosign.data);
ok(header.typeValue === 0x1002 && header.signerPublicKey === cosignerPub, 'the cosignature is a type 0x1002 transaction of the cosigner', header.typeValue);
ok(cosign.data.toUpperCase().includes(s.innerHash), 'it holds the inner hash');
ok(cosign.data.toUpperCase().includes(hexOf(new TextEncoder().encode(multisigAddress))), 'it holds the multisig account\'s address');
ok(verifyNemSignature(cosignerPub, nemHexToBytes(cosign.data), nemHexToBytes(cosign.signature)), 'the cosignature verifies');

// not a request: a plain transfer, and garbage
const plain = JSON.parse(signNemTransfer(initiatorPriv, { publicKey: initiatorPub, networkByte: TESTNET, recipient, amount: 1_000_000n, fee: nemTransferFee(1_000_000n, undefined), timeoutSeconds: 3600 })) as { data: string };
let threw = false;
try { readNemMultisigRequest(plain.data); } catch { threw = true; }
ok(threw, 'a plain transfer is not a multisig request');
threw = false;
try { readNemMultisigRequest(body.data.slice(0, body.data.length - 20)); } catch { threw = true; }
ok(threw, 'a cut-off transaction is refused');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
