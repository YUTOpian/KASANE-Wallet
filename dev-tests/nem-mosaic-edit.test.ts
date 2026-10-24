// NEM: 既存モザイクの定義の編集（定義の送り直し）の判定・入力チェックと、徴収つき定義の署名。
// Run: npx tsx dev-tests/nem-mosaic-edit.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair, models } from 'symbol-sdk/nem';
import { nemAddressFromPublicKey } from '../src/lib/nem/crypto';
import {
  nemLevyEquals, nemLevyFromRaw, nemMosaicEditAccess, nemMosaicEditBase, nemMosaicEditDiff, nemMosaicEditSend, validateNemLevy, validateNemMosaicEdit,
} from '../src/lib/nem/mosaicEdit';
import type { NemMosaicDefinition, NemMosaicEditValues } from '../src/lib/nem/mosaicEdit';
import { NEM_MOSAIC_RENTAL, NEM_PROVISION_TX_FEE, signNemMosaicCreation } from '../src/lib/nem/tx';
import type { NemMosaicLevyParams } from '../src/lib/nem/tx';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const TESTNET = 0x98;
const priv = '0000000000000000000000000000000000000000000000000000000000000001';
const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString();
const other = new KeyPair(new PrivateKey('00000000000000000000000000000000000000000000000000000000000000AA')).publicKey.toString();
const recipient = nemAddressFromPublicKey(other, TESTNET);

const def: NemMosaicDefinition = {
  id: 'ns.sub:token', creator: pub, description: 'old', divisibility: 2, initialSupply: 1000n, supplyMutable: false, transferable: true, levy: null,
};
const levy: NemMosaicLevyParams = { feeType: 'absolute', recipient, mosaicId: 'nem:xem', fee: 50_000n };

// --- who may change what
ok(nemMosaicEditAccess(def, 100_000n, null) === 'full', 'holding the whole supply (1000 × 10^2) = full');
ok(nemMosaicEditAccess(def, 99_999n, null) === 'description', 'holding less than the supply = description only');
ok(nemMosaicEditAccess(def, null, null) === 'unknown', 'holding unknown = unknown');
const mutable = { ...def, supplyMutable: true };
ok(nemMosaicEditAccess(mutable, 100_000n, null) === 'unknown', 'a mutable mosaic with an unreadable supply = unknown (initial supply may be stale)');
ok(nemMosaicEditAccess(mutable, 150_000n, 1500n) === 'full', 'a mutable mosaic uses the current supply');
ok(nemMosaicEditAccess(mutable, 100_000n, 1500n) === 'description', '… so the stale initial supply is not mistaken for the supply');

// --- the form starts from what is on the chain (the current supply for a mutable mosaic)
ok(nemMosaicEditBase(mutable, 1500n).initialSupply === 1500n, 'base uses the current supply of a mutable mosaic');
ok(nemMosaicEditBase(def, 999n).initialSupply === 1000n, 'a fixed-supply mosaic keeps its definition');
const base = nemMosaicEditBase(def, 1000n);
ok(!nemMosaicEditDiff(base, { ...base }).any, 'no change = no diff');
ok(nemMosaicEditDiff(base, { ...base, description: 'new' }).any && !nemMosaicEditDiff(base, { ...base, description: 'new' }).propertiesOrLevy, 'description only');
ok(nemMosaicEditDiff(base, { ...base, levy }).levy, 'adding a levy is a change');
ok(!nemMosaicEditDiff({ ...base, levy }, { ...base, levy: { ...levy, recipient: recipient.replace(/-/g, '').toLowerCase() } }).levy, 'the same levy typed differently is not a change');

// --- a re-definition without full ownership carries everything but the description over unchanged (and keeps the levy)
const withLevy: NemMosaicDefinition = { ...def, levy };
const tampered: NemMosaicEditValues = { description: 'new', divisibility: 6, initialSupply: 5n, supplyMutable: true, transferable: false, levy: null };
const sent = nemMosaicEditSend(withLevy, tampered, 'description');
ok(sent.description === 'new' && sent.divisibility === 2 && sent.initialSupply === 1000n && !sent.supplyMutable && sent.transferable && nemLevyEquals(sent.levy, levy), 'description-only keeps properties and levy');
ok(nemMosaicEditSend(withLevy, tampered, 'full') === tampered, 'full ownership sends the edited values');

// --- validation
const edit = (v: Partial<NemMosaicEditValues>, access: 'full' | 'description' | 'unknown' = 'full', d = def, signer = pub) => {
  const b = nemMosaicEditBase(d, null);
  return validateNemMosaicEdit(d, b, { ...b, ...v }, access, TESTNET, signer);
};
ok(edit({}) === 'no_changes', 'unchanged is refused (NIS1: Failure_Mosaic_Modification_No_Changes)');
ok(edit({ description: 'x' }) === null, 'a new description is fine');
ok(edit({ description: 'x'.repeat(513) }) === 'description', 'description over 512 bytes');
ok(edit({ description: 'あ'.repeat(171) }) === 'description', '… counted in bytes (171 × 3 = 513)');
ok(edit({ divisibility: 7 }) === 'divisibility', 'divisibility above 6');
ok(edit({ initialSupply: 0n }) === 'supply', 'supply of zero');
ok(edit({ initialSupply: 9_000_000_001n }) === 'supply_too_large', 'supply above 9,000,000,000');
ok(edit({ initialSupply: 9_000_000_000n }) === null, 'supply at the limit');
ok(edit({ transferable: false }) === null, 'changing a flag is fine');
ok(edit({ description: 'x' }, 'full', def, other) === 'not_creator', 'only the creator may edit');
ok(edit({ description: 'x', divisibility: 5 }, 'description') === null, 'description-only ignores the locked fields');
ok(edit({ divisibility: 5 }, 'description') === 'no_changes', '… and a locked field alone changes nothing');
ok(edit({ levy: { ...levy, fee: 0n } }) === 'levy', 'a levy of zero');
ok(edit({ levy: { ...levy, recipient: 'NOT-AN-ADDRESS' } }) === 'levy', 'a levy to a bad address');
ok(edit({ levy: { ...levy, mosaicId: 'nocolon' } }) === 'levy', 'a levy in a bad mosaic id');
ok(edit({ levy }) === null, 'a good levy');
ok(edit({ levy: { feeType: 'percentile', recipient, mosaicId: 'nem:xem', fee: 10_001n } }) === 'levy', 'a percentile levy above 100%');
ok(edit({ levy: { feeType: 'percentile', recipient, mosaicId: 'nem:xem', fee: 10_000n } }) === null, 'a percentile levy of 100%');
// an existing levy that is kept is never re-validated (it may predate these limits)
const oddLevy: NemMosaicLevyParams = { feeType: 'percentile', recipient, mosaicId: 'nem:xem', fee: 20_000n };
{
  const b = nemMosaicEditBase({ ...def, levy: oddLevy }, null);
  ok(validateNemMosaicEdit({ ...def, levy: oddLevy }, b, { ...b, description: 'x' }, 'full', TESTNET, pub) === null, 'a kept levy is not re-validated');
}
ok(validateNemLevy({ ...levy, recipient: nemAddressFromPublicKey(other, 0x68) }, TESTNET) === 'recipient', 'a mainnet address on the test network');

// --- reading a levy from NIS1
const rawLevy = nemLevyFromRaw({ type: 2, recipient: recipient.toLowerCase(), mosaicId: { namespaceId: 'NS', name: 'Fee' }, fee: 25 });
ok(rawLevy !== null && rawLevy.feeType === 'percentile' && rawLevy.mosaicId === 'ns:fee' && rawLevy.fee === 25n && rawLevy.recipient === recipient, 'REST levy is read (type 2 = percentile)');
ok(nemLevyFromRaw({ type: 1, recipient, mosaicId: { namespaceId: 'nem', name: 'xem' }, fee: 5 })?.feeType === 'absolute', 'type 1 = absolute');
ok(nemLevyFromRaw(null) === null && nemLevyFromRaw({}) === null && nemLevyFromRaw(undefined) === null, 'no levy / empty object');

// --- the signed definition
const decode = (payload: string) => {
  const body = JSON.parse(payload);
  return models.NonVerifiableMosaicDefinitionTransactionV1.deserialize(Uint8Array.from((body.data as string).match(/.{2}/g)!.map((h) => parseInt(h, 16))));
};
const dec = new TextDecoder();
const common = { publicKey: pub, networkByte: TESTNET, namespace: 'ns.sub', name: 'token', description: 'new description', divisibility: 2, initialSupply: 1000n, supplyMutable: false, transferable: true };

const noLevy = decode(signNemMosaicCreation(priv, common));
ok(dec.decode(noLevy.mosaicDefinition.description) === 'new description', 'description is in the definition');
ok(`${dec.decode(noLevy.mosaicDefinition.id.namespaceId.name)}:${dec.decode(noLevy.mosaicDefinition.id.name)}` === 'ns.sub:token', 'same id');
ok(noLevy.rentalFee.value === NEM_MOSAIC_RENTAL && noLevy.fee.value === NEM_PROVISION_TX_FEE, 'rental fee 10 XEM, fee 0.15 XEM');
ok(!noLevy.mosaicDefinition.levy, 'no levy unless asked for (as before)');

const withLevyTx = decode(signNemMosaicCreation(priv, { ...common, levy: { feeType: 'percentile', recipient, mosaicId: 'ns.sub:fee', fee: 250n } }));
const lv = withLevyTx.mosaicDefinition.levy!;
ok(!!lv, 'the levy is in the definition');
ok(lv.transferFeeType === models.MosaicTransferFeeType.PERCENTILE, 'percentile type');
ok(lv.fee.value === 250n, 'levy fee');
ok(`${dec.decode(lv.mosaicId.namespaceId.name)}:${dec.decode(lv.mosaicId.name)}` === 'ns.sub:fee', 'levy mosaic id');
ok(dec.decode(Uint8Array.from(lv.recipientAddress.toString().match(/.{2}/g)!.map((h) => parseInt(h, 16)))) === recipient, 'levy recipient');
const abs = decode(signNemMosaicCreation(priv, { ...common, levy }));
ok(abs.mosaicDefinition.levy!.transferFeeType === models.MosaicTransferFeeType.ABSOLUTE && abs.mosaicDefinition.levy!.fee.value === 50_000n, 'absolute levy of 50,000 micro-XEM');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
