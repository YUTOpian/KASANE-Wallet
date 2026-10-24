// Account restrictions (アカウント制限): flags, REST parsing, validation, fee size and the signed transactions.
// Run: npx tsx dev-tests/account-restriction.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, SymbolFacade } from 'symbol-sdk/symbol';
import { addressFromPublicKey, hexToBytes } from '../src/lib/symbol/crypto';
import * as R from '../src/lib/symbol/restrictions';
import { signAccountRestriction } from '../src/lib/symbol/tx';
import { NETWORKS } from '../src/lib/symbol/constants';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = NETWORKS.testnet;
const me = new KeyPair(PrivateKey.random());
const other = new KeyPair(PrivateKey.random());
const myAddress = addressFromPublicKey(me.publicKey.toString(), cfg.networkByte);
const otherAddress = addressFromPublicKey(other.publicKey.toString(), cfg.networkByte);

// --- flags (the protocol's AccountRestrictionFlags)
ok(R.restrictionFlags({ kind: 'address', direction: 'incoming' }, 'allow') === 0x0001, 'address / incoming / allow');
ok(R.restrictionFlags({ kind: 'address', direction: 'outgoing' }, 'block') === 0xC001, 'address / outgoing / block');
ok(R.restrictionFlags({ kind: 'mosaic', direction: 'incoming' }, 'block') === 0x8002, 'mosaic / block');
ok(R.restrictionFlags({ kind: 'operation', direction: 'outgoing' }, 'allow') === 0x4004, 'operation / allow');

// --- the node's answer: addresses arrive as the 24 address bytes in hex, operations as numbers
const addrHex = Array.from(hexToBytes('98' + '00'.repeat(23))).map((b) => b.toString(16).padStart(2, '0')).join('');
const lists = R.parseAccountRestrictions({ accountRestrictions: { restrictions: [
  { restrictionFlags: 0xC001, values: [addrHex] },
  { restrictionFlags: 0x8002, values: ['6bed913fa20223f8'] },
  { restrictionFlags: 0xC004, values: [0x4154] },
] } });
ok(lists.length === 3, 'three lists');
ok(lists[0].rule.direction === 'outgoing' && lists[0].mode === 'block' && lists[0].values[0].length === 39, 'address list', lists[0]);
ok(lists[2].values[0] === '4154', 'operation value is a hex code');

// --- typed input
ok(R.parseRestrictionInput('address', otherAddress, { networkByte: cfg.networkByte, ownAddress: myAddress }).ok, 'another address is fine');
const self = R.parseRestrictionInput('address', myAddress, { networkByte: cfg.networkByte, ownAddress: myAddress });
ok(!self.ok && self.error === 'own_address', 'own address refused');
const bad = R.parseRestrictionInput('address', otherAddress.slice(0, 20));
ok(!bad.ok && bad.error === 'invalid_address', 'short address refused');

// --- the signed transactions: type, flags and size must match what the fee was quoted for
function check(kind: R.RestrictionKind, direction: R.RestrictionDirection, mode: R.RestrictionMode, adds: string[], dels: string[], typeCode: number) {
  const signed = signAccountRestriction(me.privateKey.toString(), cfg.generationHash, {
    signerPublicKey: me.publicKey.toString(), networkByte: cfg.networkByte, rule: { kind, direction }, mode,
    additions: adds, deletions: dels, feeMultiplier: 100, deadline: 1000n,
  });
  const bytes = hexToBytes(signed.payload);
  const label = `${kind}/${direction}/${mode}`;
  ok(bytes.length === R.restrictionTransactionSize(kind, adds.length, dels.length), `${label}: size`, bytes.length);
  ok((bytes[110] | (bytes[111] << 8)) === typeCode, `${label}: transaction type`, bytes[110].toString(16) + bytes[111].toString(16));
  ok((bytes[128] | (bytes[129] << 8)) === R.restrictionFlags({ kind, direction }, mode), `${label}: flags`);
  ok(bytes[130] === adds.length && bytes[131] === dels.length, `${label}: counts`);
  ok(/^[0-9A-F]{64}$/.test(signed.hash), `${label}: hash`);
  const facade = new SymbolFacade('testnet');
  ok(facade.network.generationHashSeed.toString().toUpperCase() === cfg.generationHash, 'facade / network agree');
}
check('address', 'outgoing', 'block', [otherAddress], [], 0x4150);
check('address', 'incoming', 'allow', [otherAddress], [otherAddress], 0x4150);
check('mosaic', 'incoming', 'block', ['6BED913FA20223F8', '72C0212E67A08BCE'], ['E74B99BA41F4AFEE'], 0x4250);
check('operation', 'outgoing', 'allow', ['4154', '4350'], [], 0x4350);

console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
