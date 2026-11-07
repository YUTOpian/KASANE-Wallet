// Viewing metadata that OTHER accounts attached to a target (他人が付けたメタデータ): the node's rows are turned into
// entries, the wallet's own entries are left out (the editor lists those itself), malformed rows are skipped, and the
// result is ordered (owner of the target first) and grouped by source. Everything here is offline.
// Run: npx tsx dev-tests/metadata-others-view.test.ts
import { addressBytesToString, addressFromPublicKey, bytesToHex, decodeAddress, keyPairFromPrivateKey } from '../src/lib/symbol/crypto';
import { encodeValue, generateMetadataKey, keyToHex } from '../src/lib/symbol/metadata';
import { groupBySource, parseOtherMetadata } from '../src/lib/symbol/metadataOther';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

let networkCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => { networkCalls++; return Promise.reject(new Error('offline')); };

const cfg = getNetworkConfig();
const addrOf = (hexKey: string) => addressFromPublicKey(keyPairFromPrivateKey(hexKey.repeat(64)).publicKey, cfg.networkByte);
const wallet = addrOf('1');
const owner = addrOf('2');
const alice = addrOf('3');
const bob = addrOf('4');
// The node reports addresses as 48 hex chars.
const hexAddr = (a: string) => bytesToHex(decodeAddress(a) as Uint8Array);
const row = (source: string, key: bigint, value: Uint8Array | string) => ({
  metadataEntry: { sourceAddress: hexAddr(source), scopedMetadataKey: keyToHex(key), value: typeof value === 'string' ? bytesToHex(encodeValue(value)) : bytesToHex(value) },
});

const kDesc = generateMetadataKey('description');
const kUrl = generateMetadataKey('url');

// --- the wallet's own entries are left out ---------------------------------------------------------
const rows = [row(wallet, kDesc, 'mine'), row(alice, kDesc, 'from alice'), row(owner, kUrl, 'https://example.com')];
const parsed = parseOtherMetadata(rows, [wallet], owner);
ok(parsed.length === 2, 'the wallet\'s own entry is excluded', parsed.length);
ok(parsed.every((e) => e.source !== wallet), 'no entry of the wallet remains');
ok(parsed[0].source === owner && parsed[1].source === alice, 'the owner of the target comes first', parsed.map((e) => e.source));
ok(parsed[1].valueText === 'from alice' && parsed[1].key === keyToHex(kDesc), 'value and key are decoded', parsed[1]);

// --- the source comes back in the plain (base32) form, matching normalizeAddress -----------------------
ok(parsed[1].source === addressBytesToString(decodeAddress(alice) as Uint8Array), 'source is a base32 address');

// --- an address typed with hyphens still excludes ----------------------------------------------------
const hyphenated = wallet.replace(/(.{6})/g, '$1-');
ok(parseOtherMetadata([row(wallet, kDesc, 'x')], [hyphenated]).length === 0, 'exclusion ignores hyphens');

// --- same key from two sources: both are kept --------------------------------------------------------
const twoSources = parseOtherMetadata([row(bob, kDesc, 'b'), row(alice, kDesc, 'a')], [wallet]);
ok(twoSources.length === 2, 'the same key from two sources shows twice');
ok(twoSources.map((e) => e.source).join() === [alice, bob].sort().join(), 'sources are sorted', twoSources.map((e) => e.source));

// --- binary values fall back to hex --------------------------------------------------------------------
const bin = parseOtherMetadata([row(alice, kUrl, new Uint8Array([0xff, 0x00, 0x01]))], [wallet])[0];
ok(bin.valueText === null && bin.valueHex === 'FF0001', 'binary value has no text and keeps its hex', bin);

// --- malformed rows are skipped, not fatal -----------------------------------------------------------------
const messy = parseOtherMetadata([
  {}, { metadataEntry: {} },
  { metadataEntry: { sourceAddress: 'zz', scopedMetadataKey: keyToHex(kDesc), value: '00' } },
  { metadataEntry: { sourceAddress: hexAddr(alice), scopedMetadataKey: keyToHex(kDesc), value: 'xyz' } },
  row(alice, kDesc, 'fine'),
], [wallet]);
ok(messy.length === 1 && messy[0].valueText === 'fine', 'malformed rows are skipped', messy);

// --- empty ---------------------------------------------------------------------------------------------------
ok(parseOtherMetadata([], [wallet]).length === 0, 'no rows -> no entries');
ok(groupBySource([]).length === 0, 'no entries -> no groups');

// --- grouping ----------------------------------------------------------------------------------------------------
const groups = groupBySource(parseOtherMetadata([row(alice, kDesc, '1'), row(alice, kUrl, '2'), row(owner, kDesc, '3')], [wallet], owner));
ok(groups.length === 2, 'one group per source', groups.length);
ok(groups[0].source === owner && groups[0].entries.length === 1, 'owner group first');
ok(groups[1].source === alice && groups[1].entries.length === 2, 'alice group has both entries');

ok(networkCalls === 0, 'no network access', networkCalls);
console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
