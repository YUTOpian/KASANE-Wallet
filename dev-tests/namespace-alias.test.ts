// Alias link / unlink (エイリアスのリンク / 解除): the rules and the signed transactions.
// Run: npx tsx dev-tests/namespace-alias.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex, decodeAddress, hexToBytes } from '../src/lib/symbol/crypto';
import { NETWORKS } from '../src/lib/symbol/constants';
import { ADDRESS_ALIAS_SIZE, MOSAIC_ALIAS_SIZE, aliasTransactionSize, signAlias } from '../src/lib/symbol/tx';
import { aliasActionFor, currentAliasTarget, isAliasableMosaic } from '../src/lib/symbol/namespaceAlias';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = NETWORKS.testnet;
const me = new KeyPair(PrivateKey.random());
const myAddress = addressFromPublicKey(me.publicKey.toString(), cfg.networkByte);
const NS = '85BBEA6CC462B244';
const MOSAIC = '6BED913FA20223F8';

// --- what can be done with a namespace
ok(aliasActionFor({ expired: false, aliasType: 'none', alias: '' }) === 'link', 'no alias -> link');
ok(aliasActionFor({ expired: false, aliasType: 'mosaic', alias: MOSAIC }) === 'unlink', 'mosaic alias -> unlink');
ok(aliasActionFor({ expired: false, aliasType: 'address', alias: myAddress }) === 'unlink', 'address alias -> unlink');
ok(aliasActionFor({ expired: true, aliasType: 'none', alias: '' }) === null, 'expired -> nothing');
ok(aliasActionFor({ expired: true, aliasType: 'mosaic', alias: MOSAIC }) === null, 'expired with an alias -> nothing');

// --- unlink must name what is linked now
const m = currentAliasTarget({ expired: false, aliasType: 'mosaic', alias: MOSAIC });
ok(m?.type === 'mosaic' && m.mosaicId === MOSAIC, 'current mosaic target', m);
const a = currentAliasTarget({ expired: false, aliasType: 'address', alias: myAddress });
ok(a?.type === 'address' && a.address === myAddress, 'current address target', a);
ok(currentAliasTarget({ expired: false, aliasType: 'none', alias: '' }) === null, 'nothing linked -> no target');

// --- mosaics a mosaic alias may point at
ok(isAliasableMosaic({ createdByMe: true, expired: false }), 'my live mosaic');
ok(!isAliasableMosaic({ createdByMe: false, expired: false }), 'not mine');
ok(!isAliasableMosaic({ createdByMe: true, expired: true }), 'expired');

// --- the signed transactions: type, fields, size and fee must match what was quoted
const base = { signerPublicKey: me.publicKey.toString(), networkByte: cfg.networkByte, namespaceId: NS, feeMultiplier: 100, deadline: 1000n };
for (const action of ['link', 'unlink'] as const) {
  const expectAction = action === 'link' ? models.AliasAction.LINK : models.AliasAction.UNLINK;

  const addr = signAlias(me.privateKey.toString(), cfg.generationHash, { ...base, action, target: { type: 'address', address: myAddress } });
  const ab = hexToBytes(addr.payload);
  const at = models.AddressAliasTransactionV1.deserialize(ab);
  ok(at.type.value === 0x424e, `address/${action}: type`, at.type.value);
  ok(at.namespaceId.value === BigInt(`0x${NS}`), `address/${action}: namespace id`);
  ok(at.address.toString().toUpperCase() === bytesToHex(decodeAddress(myAddress)).toUpperCase(), `address/${action}: address`, at.address.toString());
  ok(at.aliasAction === expectAction, `address/${action}: action`);
  ok(ab.length === ADDRESS_ALIAS_SIZE && aliasTransactionSize('address') === ab.length, `address/${action}: size`, ab.length);
  ok(at.fee.value === BigInt(ab.length) * 100n, `address/${action}: fee = size x multiplier`);

  const mos = signAlias(me.privateKey.toString(), cfg.generationHash, { ...base, action, target: { type: 'mosaic', mosaicId: MOSAIC } });
  const mb = hexToBytes(mos.payload);
  const mt = models.MosaicAliasTransactionV1.deserialize(mb);
  ok(mt.type.value === 0x434e, `mosaic/${action}: type`, mt.type.value);
  ok(mt.namespaceId.value === BigInt(`0x${NS}`), `mosaic/${action}: namespace id`);
  ok(mt.mosaicId.value === BigInt(`0x${MOSAIC}`), `mosaic/${action}: mosaic id`);
  ok(mt.aliasAction === expectAction, `mosaic/${action}: action`);
  ok(mb.length === MOSAIC_ALIAS_SIZE && aliasTransactionSize('mosaic') === mb.length, `mosaic/${action}: size`, mb.length);
  ok(mt.fee.value === BigInt(mb.length) * 100n, `mosaic/${action}: fee = size x multiplier`);
  ok(addr.hash.length === 64 && mos.hash.length === 64 && addr.hash !== mos.hash, `${action}: hashes`);
}

let wrongHash = false;
try { signAlias(me.privateKey.toString(), '00'.repeat(32), { ...base, action: 'link', target: { type: 'mosaic', mosaicId: MOSAIC } }); } catch { wrongHash = true; }
ok(wrongHash, 'a wrong generation hash is refused');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
