// コンソールの walletKeyPair.sign(bytes) の守り（lib/console/dataSignGuard.ts）。通信なし・SDK なし。
// 実行: npx tsx dev-tests/console-data-sign.test.ts
import { classifyDataSignature, rebuildSymbolTransaction, bytesToHexUpper } from '../src/lib/console/dataSignGuard';
import type { DataSignGuardOptions } from '../src/lib/console/dataSignGuard';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const GEN = Uint8Array.from({ length: 32 }, (_, i) => 0xA0 + i);   // 仮の生成ハッシュ
const OTHER_GEN = Uint8Array.from({ length: 32 }, (_, i) => 0x10 + i);
const SIGNER = Uint8Array.from({ length: 32 }, (_, i) => 0x70 + i);
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// 本体: version(1) network(1) type(2) fee(8) deadline(8) + 送金っぽい中身
const body = (extra = 20) => { const b = new Uint8Array(20 + extra); b[0] = 1; b[1] = 0x98; b[2] = 0x54; b[3] = 0x41; for (let i = 20; i < b.length; i++) b[i] = i; return b; };

// 偽の SDK: 「復元したトランザクション」から、署名対象（生成ハッシュ + version 以降）を作る。形が壊れていれば投げる。
const fakeDerive = (full: Uint8Array): Uint8Array => {
  const size = new DataView(full.buffer, full.byteOffset, full.byteLength).getUint32(0, true);
  if (size !== full.length) throw new Error('size mismatch');
  if (full[108] !== 1) throw new Error('bad version');
  return cat(GEN, full.subarray(108));
};

const symOpts = (over: Partial<DataSignGuardOptions> = {}): DataSignGuardOptions => ({
  isNem: false, generationHashes: [GEN], signerPublicKey: SIGNER,
  deriveSymbolSigningBytes: fakeDerive, reserializeNem: () => { throw new Error('not nem'); }, ...over,
});

// --- Symbol: トランザクションを「データ」として出した ---
{
  const data = cat(GEN, body());
  const r = classifyDataSignature(data, symOpts());
  ok(r.verdict === 'transaction', 'a readable transaction is shown as a transaction', r);
  if (r.verdict === 'transaction') {
    const full = rebuildSymbolTransaction(data, SIGNER);
    ok(r.payloadHex === bytesToHexUpper(full), 'payload is the rebuilt full transaction');
    ok(full.length === 108 + body().length, 'rebuilt length = header + body');
    ok(new DataView(full.buffer).getUint32(0, true) === full.length, 'size field matches');
    ok(bytesToHexUpper(full.subarray(72, 104)) === bytesToHexUpper(SIGNER), 'signer is the wallet key');
    ok(full.subarray(8, 72).every((b) => b === 0), 'signature field is zero');
  }
}
// 生成ハッシュで始まるのに、読めない（version が壊れている）→ 拒否
{
  const bad = body(); bad[0] = 9;
  const r = classifyDataSignature(cat(GEN, bad), symOpts());
  ok(r.verdict === 'refuse', 'transaction-shaped but unreadable data is refused', r);
}
// 生成ハッシュで始まるのに短すぎる → 拒否
ok(classifyDataSignature(cat(GEN, new Uint8Array(5)), symOpts()).verdict === 'refuse', 'generation hash + too short is refused');
ok(classifyDataSignature(GEN, symOpts()).verdict === 'refuse', 'a bare generation hash is refused');
// SDK が読めるが、署名対象が元と一致しない（末尾の余り・ずれ）→ 拒否
{
  const r = classifyDataSignature(cat(GEN, body()), symOpts({ deriveSymbolSigningBytes: (f) => cat(GEN, f.subarray(108), new Uint8Array(1)) }));
  ok(r.verdict === 'refuse', 'a transaction that does not read back exactly is refused', r);
}
// 別のネットワークの生成ハッシュ（知っているもの）も、トランザクションとして扱う
{
  const r = classifyDataSignature(cat(OTHER_GEN, body()), symOpts({ generationHashes: [GEN, OTHER_GEN], deriveSymbolSigningBytes: (f) => cat(OTHER_GEN, f.subarray(108)) }));
  ok(r.verdict === 'transaction', 'another known network generation hash is recognised');
}
// 知らない生成ハッシュで始まる → ただのデータ
ok(classifyDataSignature(cat(OTHER_GEN, body()), symOpts()).verdict === 'plain', 'unknown prefix is plain data');
// 普通のデータ
ok(classifyDataSignature(new TextEncoder().encode('hello'), symOpts()).verdict === 'plain', 'text is plain data');
ok(classifyDataSignature(new Uint8Array(0), symOpts()).verdict === 'plain', 'empty is plain data');
ok(classifyDataSignature(new Uint8Array(31), symOpts()).verdict === 'plain', '31 bytes is plain data');
ok(classifyDataSignature(new Uint8Array(33), symOpts()).verdict === 'plain', '33 bytes with no known prefix is plain data');
// ちょうど32バイト（連署のハッシュと同じ形）
ok(classifyDataSignature(Uint8Array.from({ length: 32 }, (_, i) => i), symOpts()).verdict === 'hash32', 'exactly 32 bytes is flagged as a hash');
// 生成ハッシュの一覧が空でも、32バイトの警告は出る
ok(classifyDataSignature(new Uint8Array(32), symOpts({ generationHashes: [] })).verdict === 'hash32', '32 bytes flagged even with no known hashes');

// --- NEM ---
const nemTx = (type: number, network: number, len = 80) => {
  const b = new Uint8Array(len);
  new DataView(b.buffer).setUint32(0, type, true);
  b[4] = 1; b[7] = network;
  new DataView(b.buffer).setUint32(12, 32, true);
  return b;
};
const nemOpts = (over: Partial<DataSignGuardOptions> = {}): DataSignGuardOptions => ({
  isNem: true, generationHashes: [], signerPublicKey: SIGNER,
  deriveSymbolSigningBytes: () => { throw new Error('not symbol'); }, reserializeNem: (b) => b, ...over,
});
{
  const data = nemTx(0x101, 0x98);
  const r = classifyDataSignature(data, nemOpts());
  ok(r.verdict === 'transaction' && r.payloadHex === bytesToHexUpper(data), 'NEM: a readable transaction is shown as a transaction', r);
}
ok(classifyDataSignature(nemTx(0x101, 0x68), nemOpts({ reserializeNem: () => { throw new Error('unreadable'); } })).verdict === 'refuse', 'NEM: transaction-shaped but unreadable is refused');
ok(classifyDataSignature(nemTx(0x101, 0x98), nemOpts({ reserializeNem: (b) => b.subarray(0, b.length - 1) })).verdict === 'refuse', 'NEM: not exactly reserialisable is refused');
ok(classifyDataSignature(nemTx(0x4001, 0x98), nemOpts()).verdict === 'transaction', 'NEM: other transaction types are recognised too');
ok(classifyDataSignature(new TextEncoder().encode('just some text that is long enough to pass a size check, honestly'), nemOpts()).verdict === 'plain', 'NEM: text is plain data');
ok(classifyDataSignature(nemTx(0x101, 0x01), nemOpts()).verdict === 'plain', 'NEM: an unknown network byte is plain data');
ok(classifyDataSignature(nemTx(0x20000, 0x98), nemOpts()).verdict === 'plain', 'NEM: an implausible type is plain data');
ok(classifyDataSignature(new Uint8Array(0), nemOpts()).verdict === 'plain', 'NEM: empty is plain data');

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
