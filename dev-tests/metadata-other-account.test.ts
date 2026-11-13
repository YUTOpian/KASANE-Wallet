// Metadata on ANOTHER account's address / mosaic / namespace: the aggregate is bonded, the wallet is the source of the
// entry, the owner is the target and has to cosign; the cosigner's view (offline payload summary) shows what the
// entry becomes. Metadata on the wallet's own account stays a complete aggregate, byte for byte as before.
// Run: npx tsx dev-tests/metadata-other-account.test.ts
import { models } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex, hexToBytes, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { applyValueChange, encodeValue, generateMetadataKey, keyToHex, metadataAggregateSize, xorValue } from '../src/lib/symbol/metadata';
import { metadataNeedsBonded, otherMetadataRef } from '../src/lib/symbol/metadataOther';
import { getNetworkConfig } from '../src/lib/symbol/network';
import { summarizePayload } from '../src/lib/symbol/payloadSummary';
import { COSIGNATURE_SIZE, signMetadata } from '../src/lib/symbol/tx';
import type { MetadataChange } from '../src/lib/symbol/tx';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// Any network access is a failure of this test: everything here is offline.
let networkCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => { networkCalls++; return Promise.reject(new Error('offline')); };

const cfg = getNetworkConfig();
const wallet = keyPairFromPrivateKey('1'.repeat(64));
const owner = keyPairFromPrivateKey('2'.repeat(64));
const walletAddress = addressFromPublicKey(wallet.publicKey, cfg.networkByte);
const ownerAddress = addressFromPublicKey(owner.publicKey, cfg.networkByte);
const deadline = BigInt(Date.now() - cfg.epochAdjustment * 1000) + 3600n * 1000n;
const key = generateMetadataKey('description');
const mosaicId = 'ABCDEF0123456789';
const namespaceId = 'A1B2C3D4E5F60718';

const base = { signerPublicKey: wallet.publicKey, ownerAddress: walletAddress, networkByte: cfg.networkByte, feeMultiplier: 100, deadline };
const change = (extra: Partial<MetadataChange>): MetadataChange => ({
  target: { type: 'account' }, key, oldValue: new Uint8Array(0), newValue: encodeValue('hello'), ...extra,
});

(async () => {
  // --- bonded needs / cosigners -------------------------------------------------------------------
  const plain: AggregateSigner = { address: ownerAddress, publicKey: owner.publicKey, multisig: false, selfSufficient: false, cosignatures: 1 };
  const selfSufficient: AggregateSigner = { ...plain, multisig: true, selfSufficient: true, cosignatures: 0 };
  ok(metadataNeedsBonded(plain), 'a normal account must cosign -> bonded');
  ok(!metadataNeedsBonded(selfSufficient), 'a multisig the wallet approves alone -> complete');

  // --- account metadata on another account: bonded, wallet = source, owner = target -------------------
  const signedAccount = signMetadata(wallet.privateKey, cfg.generationHash, {
    ...base, bonded: true, cosignatureCount: 1, changes: [change({ targetAddress: ownerAddress })],
  });
  const tx = models.TransactionFactory.deserialize(hexToBytes(signedAccount.payload)) as unknown as {
    type: { value: number }; fee: { value: bigint }; size: number; transactions: Array<{ type: { value: number }; signerPublicKey: { toString(): string }; targetAddress: { bytes: Uint8Array } }>;
  };
  ok(tx.type.value === 0x4241, 'aggregate bonded type', tx.type.value);
  ok(tx.transactions.length === 1 && tx.transactions[0].type.value === 0x4144, 'one account metadata inside');
  ok(tx.transactions[0].signerPublicKey.toString().toUpperCase() === wallet.publicKey.toUpperCase(), 'the wallet is the source');
  ok(addressFromPublicKey(owner.publicKey, cfg.networkByte) === ownerAddress, 'sanity: owner address');
  ok(bytesToHex(Uint8Array.from(tx.transactions[0].targetAddress.bytes)).length === 48, 'target address present');
  // fee = (size + one cosignature) * multiplier, and the returned fee is what was signed
  ok(signedAccount.fee === BigInt(Number(tx.size) + COSIGNATURE_SIZE) * 100n, 'fee leaves room for one cosignature', [signedAccount.fee, tx.size]);
  ok(BigInt(tx.fee.value) === signedAccount.fee, 'signed fee equals returned fee');
  ok(tx.size === metadataAggregateSize('account', [5]), 'size model matches the real aggregate', [tx.size, metadataAggregateSize('account', [5])]);

  // the target differs from the signer's own address
  const own = signMetadata(wallet.privateKey, cfg.generationHash, { ...base, changes: [change({})] });
  const ownTx = models.TransactionFactory.deserialize(hexToBytes(own.payload)) as unknown as { type: { value: number }; transactions: Array<{ targetAddress: { bytes: Uint8Array } }> };
  ok(ownTx.type.value === 0x4141, 'own metadata stays a complete aggregate');
  ok(bytesToHex(Uint8Array.from(ownTx.transactions[0].targetAddress.bytes)) !== bytesToHex(Uint8Array.from(tx.transactions[0].targetAddress.bytes)), 'own vs other target differ');
  ok(own.fee === BigInt(own.payload.length / 2) * 100n, 'own fee unchanged: no cosignature room', own.fee);

  // --- cosigner's view (offline): a brand-new key shows its value ------------------------------------
  const sum = await summarizePayload(signedAccount.payload, { offline: true });
  const item = sum.items[0];
  ok(sum.bonded && sum.contentsMatchHash, 'summary: bonded, contents match hash');
  ok(item.kind === 'metadata', 'summary item is metadata', item);
  if (item.kind === 'metadata') {
    ok(item.account === walletAddress, 'source account shown', item.account);
    ok(item.targetAddress === ownerAddress, 'target account shown', item.targetAddress);
    ok(item.targetType === 'account' && item.targetId === undefined, 'account target');
    ok(item.key === keyToHex(key), 'key shown');
    ok(item.value?.text === 'hello', 'a new key shows its value as text', item.value);
  }

  // --- mosaic / namespace of another account ----------------------------------------------------------
  for (const [type, target, txType, id] of [
    ['mosaic', { type: 'mosaic', mosaicId } as const, 0x4244, mosaicId],
    ['namespace', { type: 'namespace', namespaceId } as const, 0x4344, namespaceId],
  ] as const) {
    const signed = signMetadata(wallet.privateKey, cfg.generationHash, { ...base, bonded: true, cosignatureCount: 1, changes: [change({ targetAddress: ownerAddress, target })] });
    const s2 = await summarizePayload(signed.payload, { offline: true });
    const it = s2.items[0];
    ok(it.kind === 'metadata' && it.targetType === type && it.targetId === id && it.targetAddress === ownerAddress, `${type}: target kind / id / owner`, it);
    const t = models.TransactionFactory.deserialize(hexToBytes(signed.payload)) as unknown as { transactions: Array<{ type: { value: number } }> };
    ok(t.transactions[0].type.value === txType, `${type}: transaction type`);
    ok(signed.fee === BigInt(metadataAggregateSize(type, [5]) + COSIGNATURE_SIZE) * 100n, `${type}: size model + cosignature`, signed.fee);
  }

  // --- updating an existing key: the change is old XOR new; the cosigner sees it resolved when the stored value is known
  const oldValue = encodeValue('hello');
  const newValue = encodeValue('hello world');
  const update = signMetadata(wallet.privateKey, cfg.generationHash, {
    ...base, bonded: true, cosignatureCount: 1, changes: [change({ targetAddress: ownerAddress, oldValue, newValue })],
  });
  const us = await summarizePayload(update.payload, { offline: true });
  const ui = us.items[0];
  ok(ui.kind === 'metadata' && ui.valueSizeDelta === newValue.length - oldValue.length, 'update: size delta', ui);
  ok(ui.kind === 'metadata' && ui.value === undefined, 'update offline: the XOR is NOT shown as if it were the value', ui);
  if (ui.kind === 'metadata') {
    ok(ui.changeHex === bytesToHex(xorValue(oldValue, newValue)), 'update: change bytes are old XOR new');
    const resolved = applyValueChange(oldValue, hexToBytes(ui.changeHex), ui.valueSizeDelta);
    ok(resolved !== null && new TextDecoder().decode(resolved) === 'hello world', 'applying the change to the stored value gives the new value');
    const shrink = applyValueChange(newValue, xorValue(newValue, encodeValue('hi')), 'hi'.length - newValue.length);
    ok(shrink !== null && new TextDecoder().decode(shrink) === 'hi', 'a shorter value is cut to its new size');
    ok(applyValueChange(null, hexToBytes(ui.changeHex), 3) === null, 'unknown stored value -> unresolved');
  }

  // --- the entries the wallet reads back are ITS OWN entries on that target ------------------------------
  const ref = otherMetadataRef(walletAddress, ownerAddress, { type: 'mosaic', mosaicId });
  ok(ref.sourceAddress === walletAddress && ref.address === ownerAddress && ref.targetId === mosaicId && ref.type === 'mosaic', 'ref: source = wallet, target = owner');

  ok(networkCalls === 0, 'no network access', networkCalls);
  console.log(fails === 0 ? `OK: ${checks} checks` : `${fails} of ${checks} checks FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
