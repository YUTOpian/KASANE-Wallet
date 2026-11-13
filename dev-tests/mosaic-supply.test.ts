// Standalone mosaic supply change (モザイク供給量の変更): the rules and the signed transaction.
// Run: npx tsx dev-tests/mosaic-supply.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/symbol';
import { hexToBytes } from '../src/lib/symbol/crypto';
import { NETWORKS } from '../src/lib/symbol/constants';
import {
  MAX_MOSAIC_SUPPLY, MOSAIC_FLAG_SUPPLY_MUTABLE, MOSAIC_FLAG_TRANSFERABLE, MOSAIC_SUPPLY_CHANGE_SIZE, signMosaicSupplyChange,
} from '../src/lib/symbol/tx';
import { isSupplyMutableMine, supplyAfter, supplyBlockedReason, validateSupplyChange } from '../src/lib/symbol/mosaicSupply';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = NETWORKS.testnet;
const me = new KeyPair(PrivateKey.random());
const base = { createdByMe: true, flags: MOSAIC_FLAG_SUPPLY_MUTABLE | MOSAIC_FLAG_TRANSFERABLE, expired: false, supply: 1000n, amount: 1000n };

// --- who may change the supply
ok(supplyBlockedReason(base) === null, 'owner holding everything can change it');
ok(supplyBlockedReason({ ...base, createdByMe: false }) === 'not_mine', 'not the owner');
ok(supplyBlockedReason({ ...base, flags: MOSAIC_FLAG_TRANSFERABLE }) === 'not_mutable', 'supply not mutable');
ok(supplyBlockedReason({ ...base, expired: true }) === 'expired', 'expired');
ok(supplyBlockedReason({ ...base, amount: 999n }) === 'not_all_held', 'owner does not hold the whole supply');
ok(isSupplyMutableMine({ ...base, amount: 0n }), 'still listed in the picker when the owner holds none (the form explains why)');
ok(!isSupplyMutableMine({ ...base, flags: 0 }), 'immutable mosaic is not listed');

// --- the entered amount
ok(validateSupplyChange(base, 'increase', null) === 'invalid', 'empty / unparsable');
ok(validateSupplyChange(base, 'increase', 0n) === 'invalid', 'zero');
ok(validateSupplyChange(base, 'increase', 5n) === null, 'increase');
ok(validateSupplyChange(base, 'increase', MAX_MOSAIC_SUPPLY) === 'over_max', 'increase past the network limit');
ok(validateSupplyChange({ ...base, supply: MAX_MOSAIC_SUPPLY, amount: MAX_MOSAIC_SUPPLY }, 'increase', 1n) === 'over_max', 'already at the limit');
ok(validateSupplyChange(base, 'decrease', 1000n) === null, 'decrease by everything held is allowed');
ok(validateSupplyChange(base, 'decrease', 1001n) === 'too_much', 'decrease by more than held');
ok(supplyAfter(1000n, 'increase', 5n) === 1005n && supplyAfter(1000n, 'decrease', 5n) === 995n, 'supply after');

// --- the signed transaction
function check(action: 'increase' | 'decrease', delta: bigint) {
  const signed = signMosaicSupplyChange(me.privateKey.toString(), cfg.generationHash, {
    signerPublicKey: me.publicKey.toString(), networkByte: cfg.networkByte, mosaicId: '6BED913FA20223F8',
    action, delta, feeMultiplier: 100, deadline: 1000n,
  });
  const bytes = hexToBytes(signed.payload);
  const tx = models.MosaicSupplyChangeTransactionV1.deserialize(bytes);
  ok(tx.type.value === 0x424d, `${action}: transaction type`, tx.type.value);
  ok(tx.mosaicId.value === 0x6BED913FA20223F8n, `${action}: mosaic id`);
  ok(tx.delta.value === delta, `${action}: delta`);
  ok(tx.action === (action === 'increase' ? models.MosaicSupplyChangeAction.INCREASE : models.MosaicSupplyChangeAction.DECREASE), `${action}: action`);
  ok(tx.fee.value === BigInt(bytes.length) * 100n, `${action}: fee = size x multiplier`);
  ok(bytes.length === MOSAIC_SUPPLY_CHANGE_SIZE, `${action}: size matches the quoted fee size`, bytes.length);
  ok(signed.hash.length === 64, `${action}: hash`);
}
check('increase', 123456n);
check('decrease', 1n);

let threw = false;
try { signMosaicSupplyChange(me.privateKey.toString(), cfg.generationHash, { signerPublicKey: me.publicKey.toString(), networkByte: cfg.networkByte, mosaicId: '6BED913FA20223F8', action: 'increase', delta: 0n, feeMultiplier: 100, deadline: 1000n }); } catch { threw = true; }
ok(threw, 'a zero delta is refused');

let wrongHash = false;
try { signMosaicSupplyChange(me.privateKey.toString(), '00'.repeat(32), { signerPublicKey: me.publicKey.toString(), networkByte: cfg.networkByte, mosaicId: '6BED913FA20223F8', action: 'increase', delta: 1n, feeMultiplier: 100, deadline: 1000n }); } catch { wrongHash = true; }
ok(wrongHash, 'a wrong generation hash is refused');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
