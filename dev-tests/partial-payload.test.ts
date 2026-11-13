// 署名待ちのアグリゲートを、ノードの JSON から組み立て直す処理（SSS Extension で連署するための材料）の確認。
// SDK で作ったアグリゲートと、ノードが返す形式（に近い JSON）を用意し、組み立て直したものがバイト単位で一致するか、
// 食い違うものは必ず止まるかを見る。ネットワークには触れない。 実行: npx tsx dev-tests/partial-payload.test.ts
import { PrivateKey } from 'symbol-sdk';
import { Address, KeyPair, SymbolFacade, models } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex, facadeFor } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import { PartialRebuildError, rebuildPartialPayload } from '../src/lib/symbol/partialPayload';
import type { RestEmbedded, RestPartialAggregate } from '../src/lib/symbol/partialPayload';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

setNetwork('testnet');
const cfg = getNetworkConfig();
const facade = facadeFor(cfg.networkByte);
const kp = () => new KeyPair(PrivateKey.random());
const pk = (k: KeyPair) => k.publicKey.toString().toUpperCase();
const initiator = kp();
const account = pk(kp());
const other = pk(kp());
const removed = pk(kp());
const addrHex = (pub: string) => bytesToHex(new Address(addressFromPublicKey(pub, cfg.networkByte)).bytes).toUpperCase();
const idHex = (n: bigint) => n.toString(16).toUpperCase().padStart(16, '0');
const base = { signerPublicKey: account };
const hex = (s: string) => bytesToHex(new TextEncoder().encode(s)).toUpperCase();
const REST = { version: 1, network: cfg.networkByte };

interface Case { name: string; descriptor: Record<string, unknown>; rest: RestEmbedded }
const cases: Case[] = [
  {
    name: 'transfer (mosaics + message)',
    descriptor: { type: 'transfer_transaction_v1', ...base, recipientAddress: addressFromPublicKey(other, cfg.networkByte), mosaics: [{ mosaicId: 0x72C0212E67A08BCEn, amount: 1_500_000n }, { mosaicId: 0x7CDF3B117A3C40CCn, amount: 7n }], message: new Uint8Array([0, ...new TextEncoder().encode('hello DAO')]) },
    rest: { type: 0x4154, signerPublicKey: account, recipientAddress: addrHex(other), mosaics: [{ id: '72C0212E67A08BCE', amount: '1500000' }, { id: '7CDF3B117A3C40CC', amount: '7' }], message: '00' + hex('hello DAO') },
  },
  {
    name: 'transfer (no message, no mosaics)',
    descriptor: { type: 'transfer_transaction_v1', ...base, recipientAddress: addressFromPublicKey(other, cfg.networkByte), mosaics: [] },
    rest: { type: 0x4154, signerPublicKey: account, recipientAddress: addrHex(other), mosaics: [] },
  },
  {
    name: 'multisig modification',
    descriptor: { type: 'multisig_account_modification_transaction_v1', ...base, minApprovalDelta: 1, minRemovalDelta: -1, addressAdditions: [addressFromPublicKey(other, cfg.networkByte)], addressDeletions: [addressFromPublicKey(removed, cfg.networkByte)] },
    rest: { type: 0x4155, signerPublicKey: account, minApprovalDelta: 1, minRemovalDelta: -1, addressAdditions: [addrHex(other)], addressDeletions: [addrHex(removed)] },
  },
  {
    name: 'account metadata',
    descriptor: { type: 'account_metadata_transaction_v1', ...base, targetAddress: addressFromPublicKey(account, cfg.networkByte), scopedMetadataKey: 0xA1B2C3D4E5F60718n, valueSizeDelta: 5, value: new TextEncoder().encode('value') },
    rest: { type: 0x4144, signerPublicKey: account, targetAddress: addrHex(account), scopedMetadataKey: 'A1B2C3D4E5F60718', valueSizeDelta: 5, value: hex('value') },
  },
  {
    name: 'mosaic metadata',
    descriptor: { type: 'mosaic_metadata_transaction_v1', ...base, targetAddress: addressFromPublicKey(account, cfg.networkByte), scopedMetadataKey: 0x1n, targetMosaicId: 0x4B3C2D1E0F9A8B7Cn, valueSizeDelta: -3, value: new TextEncoder().encode('ab') },
    rest: { type: 0x4244, signerPublicKey: account, targetAddress: addrHex(account), scopedMetadataKey: '0000000000000001', targetMosaicId: '4B3C2D1E0F9A8B7C', valueSizeDelta: -3, value: hex('ab') },
  },
  {
    name: 'namespace metadata',
    descriptor: { type: 'namespace_metadata_transaction_v1', ...base, targetAddress: addressFromPublicKey(account, cfg.networkByte), scopedMetadataKey: 0x2n, targetNamespaceId: 0xA1B2C3D4E5F60718n, valueSizeDelta: 1, value: new TextEncoder().encode('x') },
    rest: { type: 0x4344, signerPublicKey: account, targetAddress: addrHex(account), scopedMetadataKey: '0000000000000002', targetNamespaceId: 'A1B2C3D4E5F60718', valueSizeDelta: 1, value: hex('x') },
  },
  {
    name: 'mosaic definition',
    descriptor: { type: 'mosaic_definition_transaction_v1', ...base, id: 0x5E4F3A2B1C0D9E8Fn, duration: 0n, nonce: 123456, flags: 'supply_mutable transferable', divisibility: 2 },
    rest: { type: 0x414d, signerPublicKey: account, id: '5E4F3A2B1C0D9E8F', duration: '0', nonce: 123456, flags: 3, divisibility: 2 },
  },
  {
    name: 'mosaic supply change',
    descriptor: { type: 'mosaic_supply_change_transaction_v1', ...base, mosaicId: 0x5E4F3A2B1C0D9E8Fn, delta: 1000n, action: 'increase' },
    rest: { type: 0x424d, signerPublicKey: account, mosaicId: '5E4F3A2B1C0D9E8F', delta: '1000', action: 1 },
  },
  {
    name: 'mosaic supply revocation',
    descriptor: { type: 'mosaic_supply_revocation_transaction_v1', ...base, sourceAddress: addressFromPublicKey(other, cfg.networkByte), mosaic: { mosaicId: 0x5E4F3A2B1C0D9E8Fn, amount: 42n } },
    rest: { type: 0x434d, signerPublicKey: account, sourceAddress: addrHex(other), mosaic: { id: '5E4F3A2B1C0D9E8F', amount: '42' } },
  },
];

function makeAggregate(selected: Case[]) {
  const embedded = selected.map((c) => facade.transactionFactory.createEmbedded(c.descriptor as never));
  const tx = facade.transactionFactory.create({
    type: 'aggregate_bonded_transaction_v3',
    signerPublicKey: initiator.publicKey,
    fee: 0n,
    deadline: 987654321000n,
    transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded),
    transactions: embedded,
  });
  tx.fee = new models.Amount(BigInt(tx.size + 104) * 100n);
  tx.signature = new models.Signature(facade.signTransaction(initiator, tx).bytes);
  const hash = facade.hashTransaction(tx).toString().toUpperCase();
  const json: RestPartialAggregate = {
    meta: { hash },
    transaction: {
      signature: bytesToHex(tx.signature.bytes).toUpperCase(),
      signerPublicKey: initiator.publicKey.toString().toUpperCase(),
      version: 3,
      network: cfg.networkByte,
      type: 0x4241,
      maxFee: tx.fee.value.toString(),
      deadline: '987654321000',
      transactionsHash: SymbolFacade.hashEmbeddedTransactions(embedded).toString().toUpperCase(),
      transactions: selected.map((c) => ({ transaction: { ...REST, ...c.rest } as RestEmbedded })),
    },
  };
  return { tx, hash, json };
}

// 1つずつ、そして全部まとめて、ノードの JSON から作り直したものが元と同じになる。
for (const c of [...cases.map((x) => [x]), cases]) {
  const label = c.length === 1 ? c[0].name : 'all types in one aggregate';
  const { tx, hash, json } = makeAggregate(c);
  try {
    const rebuilt = rebuildPartialPayload(json, cfg.networkByte, hash);
    ok(rebuilt.hash === hash, `${label}: hash`);
    ok(rebuilt.payload === bytesToHex(tx.serialize()).toUpperCase(), `${label}: payload identical to the original`);
  } catch (e) {
    ok(false, `${label}: rebuilt`, e instanceof Error ? e.message : e);
  }
}

// 食い違い・対応外は必ず止まる。
function expectKind(label: string, kind: string, fn: () => unknown) {
  try { fn(); ok(false, `${label}: should have been refused`); } catch (e) { ok(e instanceof PartialRebuildError && e.kind === kind, `${label}: refused as ${kind}`, e instanceof Error ? e.message : e); }
}
{
  const { hash, json } = makeAggregate([cases[0]]);
  const tweak = (mut: (j: RestPartialAggregate) => void) => { const j = JSON.parse(JSON.stringify(json)) as RestPartialAggregate; mut(j); return j; };
  expectKind('wrong amount', 'hash_mismatch', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions![0].transaction.mosaics![0].amount = '1500001'; }), cfg.networkByte, hash));
  expectKind('wrong recipient', 'hash_mismatch', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions![0].transaction.recipientAddress = addrHex(pk(kp())); }), cfg.networkByte, hash));
  expectKind('message changed', 'hash_mismatch', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions![0].transaction.message = '00' + hex('hello DAx'); }), cfg.networkByte, hash));
  expectKind('deadline changed', 'hash_mismatch', () => rebuildPartialPayload(tweak((j) => { j.transaction.deadline = '987654321001'; }), cfg.networkByte, hash));
  expectKind('fee changed', 'hash_mismatch', () => rebuildPartialPayload(tweak((j) => { j.transaction.maxFee = '1'; }), cfg.networkByte, hash));
  expectKind('different hash expected', 'hash_mismatch', () => rebuildPartialPayload(json, cfg.networkByte, 'AB'.repeat(32)));
  expectKind('unsupported inner type', 'unsupported_type', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions![0].transaction.type = 0x4143; }), cfg.networkByte, hash));
  expectKind('broken address', 'bad_json', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions![0].transaction.recipientAddress = 'XYZ'; }), cfg.networkByte, hash));
  expectKind('no inner transactions', 'bad_json', () => rebuildPartialPayload(tweak((j) => { j.transaction.transactions = []; }), cfg.networkByte, hash));
  expectKind('wrong network', 'bad_json', () => rebuildPartialPayload(tweak((j) => { j.transaction.network = 104; }), cfg.networkByte, hash));
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
