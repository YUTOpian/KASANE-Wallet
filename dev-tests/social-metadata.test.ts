// ソーシャルメタデータ（NFTDriveEX 仕様）: キー、JSON の作り方・読み方、URL の安全確認、他人が付けた値を使わないこと、
// 履歴向けの取得（同時実行・キャッシュ）。ネットワークには出ない（fetch を差し替える）。
// Run: npx tsx dev-tests/social-metadata.test.ts
import { generateMetadataKey, keyToHex } from '../src/lib/symbol/metadata';
import {
  SOCIAL_METADATA_KEY, SOCIAL_METADATA_KEY_TEXT, cachedSocialMetadata, clearSocialMetadataCache, fetchSocialMetadata, isValidNamespaceName,
  fetchSocialDirectoryPage, loadSocialMetadata, matchesSocialQuery, parseSocialMetadata, safeHttpUrl, serializeSocialMetadata, sniffRasterMime, validateSocialMetadata,
} from '../src/lib/symbol/socialMetadata';
import { addressFromPublicKey, bytesToHex, decodeAddress, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { getNetwork, getNetworkConfig, setCustomNodeUrl } from '../src/lib/symbol/network';

setCustomNodeUrl(getNetwork(), 'https://node.test:3001'); // 固定ノード（探索の通信を出さない）

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const GOOD = {
  url: 'https://x.com/Bootarou_0x00', name: 'ボー太郎 jr', imageUrl: 'https://pbs.twimg.com/profile_images/1822890040312/icon.jpg', namespace: 'bootarou',
};
const ADDR = 'NB7E2NVQ2SP5B6SIBP6XC5VEZYKLDRJ5ASRLOOI';

// --- key ---------------------------------------------------------------------------------------------
ok(SOCIAL_METADATA_KEY_TEXT === 'social_meta_data', 'key text');
ok(SOCIAL_METADATA_KEY === generateMetadataKey('social_meta_data'), 'key is the scoped key of the text');
ok(/^[0-9A-F]{16}$/.test(keyToHex(SOCIAL_METADATA_KEY)), 'key hex');

// --- JSON out / in -------------------------------------------------------------------------------------
const json = serializeSocialMetadata(GOOD);
ok(Object.keys(JSON.parse(json)).join(',') === 'url,name,imageUrl,namespace', 'field order follows the spec', json);
ok(JSON.parse(json).namespace === 'bootarou', 'namespace kept');
ok(JSON.parse(serializeSocialMetadata({ ...GOOD, namespace: '' })).namespace === '', 'empty namespace stays a string');
ok(JSON.parse(serializeSocialMetadata({ ...GOOD, namespace: '@bootarou' })).namespace === 'bootarou', 'leading @ removed');
const back = parseSocialMetadata(json);
ok(back !== null && back.name === GOOD.name && back.url === safeHttpUrl(GOOD.url) && back.imageUrl === safeHttpUrl(GOOD.imageUrl) && back.namespace === 'bootarou', 'round trip', back);
ok(parseSocialMetadata(null) === null, 'null in');
ok(parseSocialMetadata('not json') === null, 'not json');
ok(parseSocialMetadata('[1,2]') === null, 'array');
ok(parseSocialMetadata('{}') === null, 'empty object');
ok(parseSocialMetadata('{"url":5,"name":{"a":1}}') === null, 'wrong types are ignored');
const evil = parseSocialMetadata('{"url":"javascript:alert(1)","name":"x","imageUrl":"data:image/svg+xml,<svg/>","namespace":"a"}');
ok(evil !== null && evil.url === '' && evil.imageUrl === '' && evil.name === 'x', 'non-http(s) URLs are dropped', evil);

// --- URL safety --------------------------------------------------------------------------------------------
ok(safeHttpUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1', 'https ok');
ok(safeHttpUrl('http://example.com') === 'http://example.com/', 'http ok');
for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//example.com', 'example.com', 'https://user:pw@example.com', 'https://exa mple.com', ' ', '', 'ftp://example.com', 'https://\u0000x.com']) {
  ok(safeHttpUrl(bad) === null, `rejects ${JSON.stringify(bad)}`);
}
ok(safeHttpUrl(42) === null, 'non-string');

// --- namespace -----------------------------------------------------------------------------------------------
ok(isValidNamespaceName('bootarou') && isValidNamespaceName('a.b.c') && isValidNamespaceName('my-name_1'), 'valid namespaces');
ok(!isValidNamespaceName('Boot') && !isValidNamespaceName('a.b.c.d') && !isValidNamespaceName('-a') && !isValidNamespaceName('a..b') && !isValidNamespaceName('日本'), 'invalid namespaces');

// --- form validation -------------------------------------------------------------------------------------------
const clean = (e: ReturnType<typeof validateSocialMetadata>) => Object.values(e).every((v) => v === null);
ok(clean(validateSocialMetadata(GOOD)), 'good input');
ok(clean(validateSocialMetadata({ ...GOOD, namespace: '' })), 'namespace is optional');
ok(validateSocialMetadata({ ...GOOD, url: '' }).url === 'required', 'url required');
ok(validateSocialMetadata({ ...GOOD, name: '  ' }).name === 'required', 'name required');
ok(validateSocialMetadata({ ...GOOD, imageUrl: '' }).imageUrl === 'required', 'imageUrl required');
ok(validateSocialMetadata({ ...GOOD, url: 'javascript:alert(1)' }).url === 'bad_url', 'bad url');
ok(validateSocialMetadata({ ...GOOD, namespace: 'Bad Name' }).namespace === 'bad_namespace', 'bad namespace');
ok(validateSocialMetadata({ ...GOOD, name: 'x'.repeat(101) }).name === 'too_long', 'name too long');
ok(validateSocialMetadata({ ...GOOD, url: `https://a.com/${'x'.repeat(300)}` }).url === 'too_long', 'url too long');
// 日本語の名前は UTF-8 で3バイト/文字。100文字 = 300バイト、4項目の最大でも 1,024 バイトを超える組み合わせを止める。
const big = { url: `https://a.com/${'x'.repeat(280)}`, imageUrl: `https://b.com/${'y'.repeat(280)}`, name: 'あ'.repeat(100), namespace: `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(20)}` };
ok(validateSocialMetadata(big).url === 'too_big', 'over 1,024 bytes is refused', validateSocialMetadata(big));

// --- sniffing images ----------------------------------------------------------------------------------------
ok(sniffRasterMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])) === 'image/png', 'png');
ok(sniffRasterMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg', 'jpeg');
ok(sniffRasterMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')) === null, 'svg is not used');
ok(sniffRasterMime(new TextEncoder().encode('<html>')) === null, 'html is not an image');

// --- reading from the node (fetch is replaced) ----------------------------------------------------------------------
const calls: string[] = [];
let active = 0, maxActive = 0;
const valueHex = bytesToHex(new TextEncoder().encode(json));
(globalThis as { fetch: unknown }).fetch = async (input: string) => {
  const url = String(input);
  calls.push(url);
  active++; maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, 5));
  active--;
  const empty = url.includes('NEMPTY');
  return { ok: true, status: 200, json: async () => ({ data: empty ? [] : [{ metadataEntry: { scopedMetadataKey: keyToHex(SOCIAL_METADATA_KEY), value: valueHex } }] }) };
};

async function main() {
  // 自分が（source = target として）付けたものだけを引く: クエリの sourceAddress と targetAddress が同じアドレス。
  const meta = await fetchSocialMetadata(ADDR);
  ok(meta !== null && meta.name === GOOD.name, 'fetch parses the value', meta);
  const q = calls[0] ?? '';
  const src = /sourceAddress=([A-Z0-9]+)/.exec(q)?.[1];
  const tgt = /targetAddress=([A-Z0-9]+)/.exec(q)?.[1];
  ok(!!src && src === tgt, 'queries only entries whose source is the address itself', q);
  ok(q.includes('metadataType=0') && q.includes(`scopedMetadataKey=${keyToHex(SOCIAL_METADATA_KEY)}`), 'account metadata, social key', q);

  // 登録が無いアドレスは null。
  const none = await fetchSocialMetadata('NEMPTY'.padEnd(39, 'A'));
  ok(none === null, 'no entry -> null', none);

  // キャッシュと、同時に同じアドレスを引かない。
  clearSocialMetadataCache();
  calls.length = 0;
  const [a, b] = await Promise.all([loadSocialMetadata(ADDR), loadSocialMetadata(ADDR)]);
  ok(a !== null && b !== null && calls.length === 1, 'same address in flight is fetched once', calls.length);
  await loadSocialMetadata(ADDR);
  ok(calls.length === 1 && cachedSocialMetadata(ADDR) !== undefined, 'second call served from cache', calls.length);

  // たくさんのアドレスでも、同時に出す問い合わせは絞る。
  clearSocialMetadataCache();
  calls.length = 0; maxActive = 0;
  const many = Array.from({ length: 12 }, (_, i) => `NB7E2NVQ2SP5B6SIBP6XC5VEZYKLDRJ5ASRLO${String.fromCharCode(65 + i)}${'A'}`);
  await Promise.all(many.map((x) => loadSocialMetadata(x)));
  ok(calls.length === 12 && maxActive <= 4, 'parallel requests are limited', { calls: calls.length, maxActive });

  // --- S.M.D の一覧（ノードから集める） -----------------------------------------------------------------------
  const kpOf = (c: string) => keyPairFromPrivateKey(c.repeat(64));
  const addrOf = (c: string) => addressFromPublicKey(kpOf(c).publicKey, getNetworkConfig().networkByte);
  const hexOf = (a: string) => bytesToHex(decodeAddress(a) as Uint8Array);
  const entry = (src: string, tgt: string, value: string) => ({ metadataEntry: { sourceAddress: hexOf(src), targetAddress: hexOf(tgt), scopedMetadataKey: keyToHex(SOCIAL_METADATA_KEY), value: bytesToHex(new TextEncoder().encode(value)) } });
  const A = addrOf('1'), B = addrOf('2'), C = addrOf('3'), D = addrOf('4');
  const listed: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (input: string) => {
    listed.push(String(input));
    const data = [
      entry(A, A, serializeSocialMetadata({ ...GOOD, name: 'Alice' })), // 自己登録
      entry(B, A, serializeSocialMetadata({ ...GOOD, name: 'Mallory' })), // 他人が A に付けたもの: 捨てる
      entry(C, C, 'not json'), // 形式が違う: 捨てる
      entry(D, D, JSON.stringify({ url: 'javascript:alert(1)', name: 'Eve', imageUrl: '', namespace: '' })), // 危ない URL は落とし、名前は残る
    ];
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  clearSocialMetadataCache();
  const page = await fetchSocialDirectoryPage(1);
  ok(listed[0]?.includes(`scopedMetadataKey=${keyToHex(SOCIAL_METADATA_KEY)}`) && listed[0]?.includes('metadataType=0') && !listed[0]?.includes('sourceAddress='), 'lists by key only', listed[0]);
  ok(page.items.length === 2, 'only self-registered, well-formed entries are listed', page.items.map((i) => i.meta.name));
  ok(page.items[0]?.address === A && page.items[0]?.meta.name === 'Alice', 'address decoded and name kept');
  ok(page.items[1]?.meta.name === 'Eve' && page.items[1]?.meta.url === '', 'unsafe url dropped, entry kept');
  ok(!page.hasMore, 'fewer than a full page -> no more');
  ok(cachedSocialMetadata(A)?.name === 'Alice', 'listing primes the cache');

  // 検索
  const [first, second] = page.items;
  ok(matchesSocialQuery(first, 'ali') && matchesSocialQuery(first, 'ALICE'), 'search by name, case-insensitive');
  ok(matchesSocialQuery(first, '@bootarou'), 'search by namespace, with @');
  ok(matchesSocialQuery(first, 'x.com/bootarou_0x00'), 'search by url');
  ok(matchesSocialQuery(first, A.slice(0, 8).toLowerCase()) && matchesSocialQuery(first, `${A.slice(0, 6)}-${A.slice(6, 12)}`), 'search by address, hyphens ignored');
  ok(!matchesSocialQuery(second, 'alice') && matchesSocialQuery(second, ''), 'non-matching and empty query');

  // 取れなかったときは null を返し、キャッシュしない。
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  clearSocialMetadataCache();
  const failed = await loadSocialMetadata(ADDR);
  ok(failed === null && cachedSocialMetadata(ADDR) === undefined, 'failure -> null, not cached');

  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
  process.exit(fails === 0 ? 0 : 1);
}
main();
