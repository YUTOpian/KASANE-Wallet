// DAO のソーシャルメタデータ（DAO アカウント自身に social_meta_data を付ける）。ネットワークに触れずに確かめる。Run: npx tsx dev-tests/dao-social.test.ts
import { PrivateKey, utils } from 'symbol-sdk';
import { Address, KeyPair, models } from 'symbol-sdk/symbol';
import { VOTE_INDEX_FIRST_KEY } from '../src/lib/dao/daoCore';
import { socialMetadataInner } from '../src/lib/dao/daoActions';
import { splitDaoMetadata } from '../src/lib/dao/daoApi';
import type { MetaRow } from '../src/lib/dao/daoApi';
import { signDao } from '../src/lib/dao/daoTx';
import { addressFromPublicKey, bytesToHex } from '../src/lib/symbol/crypto';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';
import type { AggregateSigner } from '../src/lib/symbol/aggregate';
import { SOCIAL_METADATA_KEY, serializeSocialMetadata, validateSocialMetadata } from '../src/lib/symbol/socialMetadata';
import type { SocialMetadata } from '../src/lib/symbol/socialMetadata';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const sameAddr = (u: { bytes: Uint8Array }, base32: string) => bytesToHex(u.bytes) === bytesToHex(new Address(base32).bytes);

setNetwork('testnet');
const cfg = getNetworkConfig();
const ownerKp = new KeyPair(PrivateKey.random());
const daoKp = new KeyPair(PrivateKey.random());
const ownerPub = ownerKp.publicKey.toString();
const daoId = daoKp.publicKey.toString();
const daoAddress = addressFromPublicKey(daoId, cfg.networkByte);
const dao = { id: daoId, address: daoAddress };
const selfSigner: AggregateSigner = { address: daoAddress, publicKey: daoId, multisig: true, selfSufficient: true, cosignatures: 0 };

const meta: SocialMetadata = { url: 'https://x.com/example_dao', name: 'みんなのDAO', imageUrl: 'https://example.com/dao.png', namespace: 'example.dao' };

// --- 内側のトランザクション ---
const innerOf = (previous: Uint8Array | null, m: SocialMetadata = meta) => {
  const signed = signDao(ownerKp.privateKey.toString(), { publicKey: ownerPub, build: socialMetadataInner(dao, m, previous), dao: selfSigner }, 100, 100_000n);
  const tx = models.AggregateCompleteTransactionV3.deserialize(utils.hexToUint8(signed.payload));
  return { signed, tx, inner: tx.transactions as models.EmbeddedAccountMetadataTransactionV1[] };
};

const first = innerOf(null);
ok(!first.signed.bonded, 'a DAO that one wallet can sign for: complete aggregate');
ok(first.inner.length === 1, 'one inner transaction', first.inner.length);
const m0 = first.inner[0];
ok(m0.scopedMetadataKey === SOCIAL_METADATA_KEY, 'key is social_meta_data');
ok(m0.signerPublicKey.toString() === daoId && sameAddr(m0.targetAddress, daoAddress), 'source = target = the DAO account (self-registered)');
const text = new TextDecoder().decode(m0.value);
ok(text === serializeSocialMetadata(meta), 'value is the standard JSON', text);
ok(Object.keys(JSON.parse(text)).join() === 'url,name,imageUrl,namespace', 'key order follows the spec');
ok(m0.valueSizeDelta === m0.value.length, 'new value: size delta = length');

// 上書き: 前の値との差分（XOR）で書く。サイズの差も入る。
const prev = new TextEncoder().encode(serializeSocialMetadata({ ...meta, name: 'old' }));
const upd = innerOf(prev)[ 'inner' ][0];
const next = new TextEncoder().encode(serializeSocialMetadata(meta));
ok(upd.valueSizeDelta === next.length - prev.length, 'update: size delta is new - old', [upd.valueSizeDelta, next.length - prev.length]);
const xored = new Uint8Array(Math.max(prev.length, next.length));
for (let i = 0; i < xored.length; i += 1) xored[i] = (prev[i] ?? 0) ^ (next[i] ?? 0);
ok(bytesToHex(upd.value) === bytesToHex(xored), 'update: value is old XOR new');

// --- 読み取り: 投票の索引と取り違えない ---
ok(SOCIAL_METADATA_KEY >= VOTE_INDEX_FIRST_KEY, 'the social key is in the "vote index" range, so it must be split off first');
const hex = (s: string) => bytesToHex(new TextEncoder().encode(s)).toUpperCase();
const keyHex = (k: bigint) => k.toString(16).toUpperCase().padStart(16, '0');
const addrHex = (a: string) => bytesToHex(new Address(a).bytes).toUpperCase();
const other = addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), cfg.networkByte);
const row = (key: bigint, value: string, source = daoAddress): MetaRow => ({
  metadataEntry: { scopedMetadataKey: keyHex(key), value: hex(value), sourceAddress: addrHex(source), targetAddress: addrHex(daoAddress), targetId: '0'.repeat(16) },
});
const txHash = 'A'.repeat(64);
const social = serializeSocialMetadata(meta);

const parts = splitDaoMetadata([row(6n, 'DAO名', other), row(VOTE_INDEX_FIRST_KEY, txHash, other), row(SOCIAL_METADATA_KEY, social)]);
ok(parts.index.length === 1 && parts.index[0].key === VOTE_INDEX_FIRST_KEY && parts.index[0].txHash === txHash, 'the vote index is only the real index', parts.index);
ok(parts.values.get(6n) === 'DAO名', 'settings keep working');
ok(parts.social !== null && parts.social.name === meta.name && parts.social.url === meta.url && parts.social.namespace === 'example.dao', 'social metadata is read', parts.social);

const foreign = splitDaoMetadata([row(SOCIAL_METADATA_KEY, social, other)]);
ok(foreign.social === null && foreign.index.length === 0, 'social metadata written by another account is ignored (and is not an index)');
const broken = splitDaoMetadata([row(SOCIAL_METADATA_KEY, 'not json')]);
ok(broken.social === null && broken.index.length === 0, 'a value in another shape is ignored (and is not an index)');
const none = splitDaoMetadata([row(VOTE_INDEX_FIRST_KEY, txHash, other), row(VOTE_INDEX_FIRST_KEY + 1n, 'B'.repeat(64), other)]);
ok(none.social === null && none.index.length === 2, 'a DAO without social metadata is read as before');

// --- 入力の検証（ウォレットの登録画面と同じ規則） ---
ok(Object.values(validateSocialMetadata(meta)).every((e) => e === null), 'the sample is valid');
ok(validateSocialMetadata({ ...meta, url: 'javascript:alert(1)' }).url === 'bad_url', 'only http(s) URLs');
ok(validateSocialMetadata({ ...meta, name: '' }).name === 'required', 'name is required');
ok(validateSocialMetadata({ ...meta, namespace: '' }).namespace === null, 'namespace is optional');

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
