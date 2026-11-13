// 委任リクエストの再送（FormPersistentDelegationRequest）: 再送してよいかの判定と、送るメッセージの中身。通信なし。
// Run: npx tsx dev-tests/harvest-delegation-resend.test.ts
import { MessageEncoder, KeyPair } from 'symbol-sdk/symbol';
import { PrivateKey, PublicKey } from 'symbol-sdk';
import { planDelegationResend } from '../src/lib/symbol/harvestKeys';
import { harvestPublicKeyOf, newHarvestKeyPair, signHarvestDelegation } from '../src/lib/symbol/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const err = (x: { ok: boolean }) => (x as { error?: string }).error;

// --- key derivation
const remote = newHarvestKeyPair();
const vrf = newHarvestKeyPair();
const node = newHarvestKeyPair();
ok(harvestPublicKeyOf(remote.privateKey) === remote.publicKey.toUpperCase(), 'public key of a private key');
ok(harvestPublicKeyOf(remote.privateKey.toLowerCase()) === remote.publicKey.toUpperCase(), 'lower case private key works');
ok(harvestPublicKeyOf('abc') === null && harvestPublicKeyOf('g'.repeat(64)) === null && harvestPublicKeyOf('') === null, 'not 64 hex chars -> null');

// --- plan
const linked = { remotePublicKey: remote.publicKey.toLowerCase(), vrfPublicKey: vrf.publicKey, nodePublicKey: node.publicKey };
const good = planDelegationResend(linked, remote.privateKey, vrf.privateKey);
ok(good.ok && good.nodePublicKey === node.publicKey.toUpperCase() && good.remotePrivateKey === remote.privateKey.toUpperCase() && good.vrfPrivateKey === vrf.privateKey.toUpperCase(),
  'matching keys: sent to the linked node, keys in upper case', good);
const spaced = planDelegationResend(linked, ` ${remote.privateKey.toLowerCase()} `, ` ${vrf.privateKey.toLowerCase()}\n`);
ok(spaced.ok, 'typed keys (lower case, spaces) are accepted');

const none = { remotePublicKey: null, vrfPublicKey: null, nodePublicKey: null };
ok(err(planDelegationResend(none, remote.privateKey, vrf.privateKey)) === 'not_linked', 'nothing linked: refused');
ok(err(planDelegationResend({ ...linked, nodePublicKey: null }, remote.privateKey, vrf.privateKey)) === 'not_linked', 'node missing: refused');
ok(err(planDelegationResend({ ...linked, vrfPublicKey: null }, remote.privateKey, vrf.privateKey)) === 'not_linked', 'VRF missing: refused');
ok(err(planDelegationResend({ ...linked, remotePublicKey: null }, remote.privateKey, vrf.privateKey)) === 'not_linked', 'remote missing: refused');

ok(err(planDelegationResend(linked, '', vrf.privateKey)) === 'invalid_remote', 'empty remote key');
ok(err(planDelegationResend(linked, 'xyz', vrf.privateKey)) === 'invalid_remote', 'bad remote key');
ok(err(planDelegationResend(linked, remote.privateKey, '')) === 'invalid_vrf', 'empty VRF key');
ok(err(planDelegationResend(linked, remote.privateKey, remote.privateKey.slice(1))) === 'invalid_vrf', 'short VRF key');
ok(err(planDelegationResend(linked, remote.privateKey, remote.privateKey)) === 'same_key', 'the same key twice');

const other = newHarvestKeyPair();
ok(err(planDelegationResend(linked, other.privateKey, vrf.privateKey)) === 'remote_mismatch', 'remote key of another account: refused');
ok(err(planDelegationResend(linked, remote.privateKey, other.privateKey)) === 'vrf_mismatch', 'VRF key of another account: refused');
ok(err(planDelegationResend(linked, vrf.privateKey, remote.privateKey)) === 'remote_mismatch', 'swapped keys: refused');

// the key derivation can be replaced (no dependency on the SDK in the decision itself)
const fake = (k: string) => (k === 'A'.repeat(64) ? '1'.repeat(64) : k === 'B'.repeat(64) ? '2'.repeat(64) : null);
ok(planDelegationResend({ remotePublicKey: '1'.repeat(64), vrfPublicKey: '2'.repeat(64), nodePublicKey: '3'.repeat(64) }, 'A'.repeat(64), 'B'.repeat(64), fake).ok, 'decision uses the given derivation');

// --- the request itself: it is signed for the network and its message can be read by the node (and only by it)
import { facadeFor } from '../src/lib/symbol/crypto';
import { HARVEST_DELEGATION_MESSAGE_BYTES, harvestDelegationSize } from '../src/lib/symbol/tx';
const facade = facadeFor(0x98);
const genHash = facade.network.generationHashSeed.toString();
const account = new KeyPair(PrivateKey.random());
const signed = signHarvestDelegation(account.privateKey.toString(), genHash, {
  signerPublicKey: account.publicKey.toString(), networkByte: 0x98, nodePublicKey: node.publicKey, remotePrivateKey: remote.privateKey, vrfPrivateKey: vrf.privateKey,
  feeMultiplier: 100, deadline: 1_000_000n,
});
ok(/^[0-9A-F]{64}$/.test(signed.hash), 'signed: hash is 64 hex chars', signed.hash);
ok(signed.payload.length / 2 === harvestDelegationSize(), 'size matches the fee estimate', signed.payload.length / 2);
ok(HARVEST_DELEGATION_MESSAGE_BYTES === 132, 'message is 8 + 32 + 16 + 12 + 64 bytes');

let wrongNetwork = false;
try {
  signHarvestDelegation(account.privateKey.toString(), 'F'.repeat(64), {
    signerPublicKey: account.publicKey.toString(), networkByte: 0x98, nodePublicKey: node.publicKey, remotePrivateKey: remote.privateKey, vrfPrivateKey: vrf.privateKey,
    feeMultiplier: 100, deadline: 1_000_000n,
  });
} catch (e) { wrongNetwork = (e as Error).message === 'generation_hash_mismatch'; }
ok(wrongNetwork, 'a generation hash of another network is refused');

// The node decrypts the message with its own key and finds exactly the two private keys (remote first, then VRF).
const message = new MessageEncoder(new KeyPair(PrivateKey.random())).encodePersistentHarvestingDelegation(
  new PublicKey(node.publicKey), new KeyPair(new PrivateKey(remote.privateKey)), new KeyPair(new PrivateKey(vrf.privateKey)));
ok(message.length === HARVEST_DELEGATION_MESSAGE_BYTES && message[0] === 0xFE, 'the message is the persistent delegation request (starts with 0xFE, 132 bytes)', message.length);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const nodeSide = new MessageEncoder(new KeyPair(new PrivateKey(node.privateKey))).tryDecode(account.publicKey, message);
ok(nodeSide.isDecoded === true, 'the node can decrypt the request');
if (nodeSide.isDecoded) {
  ok(toHex(nodeSide.message) === (remote.privateKey + vrf.privateKey).toUpperCase(), 'the node finds the remote and VRF private keys');
}
const stranger = new MessageEncoder(new KeyPair(PrivateKey.random())).tryDecode(account.publicKey, message);
ok(stranger.isDecoded === false, 'another account cannot decrypt it');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
