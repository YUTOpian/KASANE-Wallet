// Account restrictions: the multisig (cosigner) helpers and the namespace-alias address input.
// These checks use the SDK only for address encoding, never the network.
// Run: npx tsx dev-tests/restriction-multisig-alias.test.ts
import { sha3_256 } from '@noble/hashes/sha3.js';
import { addressBytesToString } from '../src/lib/symbol/crypto';
import * as R from '../src/lib/symbol/restrictions';
import { parseRestrictionAddressInput } from '../src/lib/symbol/restrictionAlias';
import { classifyRecipientInput } from '../src/lib/symbol/recipientInput';

const aliasNameOf = (raw: string): string | null => { const c = classifyRecipientInput(raw); return c.kind === 'alias' ? c.name : null; };
import type { AliasResolver } from '../src/lib/symbol/restrictionAlias';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// A well-formed address (network byte + 20 bytes + 3 checksum bytes) for either network.
function addressOf(networkByte: number, seed: number): { text: string; hex: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(24);
  bytes[0] = networkByte;
  for (let i = 1; i < 21; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  bytes.set(sha3_256(bytes.subarray(0, 21)).subarray(0, 3), 21);
  return { text: addressBytesToString(bytes), hex: Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(''), bytes };
}
const TESTNET = 0x98;
const MAINNET = 0x68;
const mine = addressOf(TESTNET, 1);
const friend = addressOf(TESTNET, 2);
const mainnetAddress = addressOf(MAINNET, 3);

// --- values as the node writes them
ok(R.canonicalRestrictionValue('address', friend.hex) === friend.text, 'address: 48 hex -> base32');
const aliasBytes = new Uint8Array(24);
aliasBytes[0] = TESTNET | 1; // the low bit of the first byte marks a namespace alias
aliasBytes.set([0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89], 1);
const aliasHex = Array.from(aliasBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
ok(R.canonicalRestrictionValue('address', aliasHex) === '@ABCDEF0123456789', 'address: alias-marked value keeps the namespace id', R.canonicalRestrictionValue('address', aliasHex));
ok(R.canonicalRestrictionValue('mosaic', '6bed913fa20223f8') === '6BED913FA20223F8', 'mosaic id upper-cased');
ok(R.canonicalRestrictionValue('operation', 0x4154) === '4154', 'operation number -> hex code');
ok(R.canonicalRestrictionValue('operation', 'not a number') === null, 'unreadable operation -> null');

// --- reading a restriction transaction (what a cosigner is shown)
const c1 = R.parseRestrictionChange(0x4150, 0xC001, [friend.hex], []);
ok(c1 !== null && c1.rule.kind === 'address' && c1.rule.direction === 'outgoing' && c1.mode === 'block'
  && c1.additions[0] === friend.text && c1.deletions.length === 0, 'address change is read', c1);
const c2 = R.parseRestrictionChange(0x4250, 0x0002, ['6BED913FA20223F8'], ['72C0212E67A08BCE']);
ok(c2 !== null && c2.rule.kind === 'mosaic' && c2.mode === 'allow' && c2.deletions[0] === '72C0212E67A08BCE', 'mosaic change is read', c2);
const c3 = R.parseRestrictionChange(0x4350, 0x4004, [0x4154, 0x4350], []);
ok(c3 !== null && c3.rule.kind === 'operation' && c3.additions.join() === '4154,4350', 'operation change is read', c3);
ok(R.parseRestrictionChange(0x4250, 0x0001, [], []) === null, 'flags that say address on a mosaic transaction -> null');
ok(R.parseRestrictionChange(0x4150, 0x0003, [], []) === null, 'flags that say two things -> null');
ok(R.parseRestrictionChange(0x4154, 0x0001, [], []) === null, 'a transfer is not a restriction');
ok(R.parseRestrictionChange(0x4350, 0x4004, ['xyz'], []) === null, 'an unreadable value -> null (shown as unknown)');
ok(R.RESTRICTION_TX_TYPE.address === 0x4150 && R.RESTRICTION_TX_TYPE.mosaic === 0x4250 && R.RESTRICTION_TX_TYPE.operation === 0x4350, 'transaction types');

// --- size of the embedded transaction (48 header + 8 body + values, padded to 8)
ok(R.embeddedRestrictionSize('address', 1, 0) === 80, 'address x1', R.embeddedRestrictionSize('address', 1, 0));
ok(R.embeddedRestrictionSize('address', 2, 3) === 56 + 24 * 5, 'address x5');
ok(R.embeddedRestrictionSize('mosaic', 2, 1) === 80, 'mosaic x3');
ok(R.embeddedRestrictionSize('operation', 1, 0) === 64, 'operation x1 pads 58 up to 64');
ok(R.embeddedRestrictionSize('operation', 4, 0) === 64, 'operation x4 is exactly 64');
ok(R.embeddedRestrictionSize('operation', 5, 0) === 72, 'operation x5 pads 66 up to 72');
for (const kind of R.RESTRICTION_KINDS) {
  for (let n = 1; n <= 9; n += 1) ok(R.embeddedRestrictionSize(kind, n, 0) % 8 === 0, `${kind} x${n}: multiple of 8`);
}

// --- an operation allow list on a multisig account that leaves out "change multisig settings"
const opRule: R.RestrictionRule = { kind: 'operation', direction: 'outgoing' };
ok(R.lacksMultisigModification(opRule, 'allow', ['4154', '4350']) === true, 'allow list without 4155 is flagged');
ok(R.lacksMultisigModification(opRule, 'allow', ['4154', '4350', '4155']) === false, 'allow list with 4155 is fine');
ok(R.lacksMultisigModification(opRule, 'allow', []) === false, 'an empty list restricts nothing');
ok(R.lacksMultisigModification(opRule, 'block', ['4154']) === false, 'block list is fine');
ok(R.lacksMultisigModification({ kind: 'address', direction: 'incoming' }, 'allow', ['X']) === false, 'only operation lists are checked');

// --- namespace alias input
ok(aliasNameOf('nem.group') === 'nem.group', 'alias: nem.group');
ok(aliasNameOf('@nem') === 'nem', 'alias: @nem');
ok(aliasNameOf('Nem.Group') === 'nem.group', 'alias: lower-cased');
ok(aliasNameOf('nem') === null, 'a bare word is not an alias');
ok(aliasNameOf(friend.text) === null, 'an address is not an alias');
ok(aliasNameOf('a'.repeat(64)) === null, 'a 64-hex-like string is not an alias');

const opts = { networkByte: TESTNET, ownAddress: mine.text };
const calls: string[] = [];
const resolver = (reply: Awaited<ReturnType<AliasResolver>>): AliasResolver => async (input) => {
  calls.push(input.kind === 'alias' ? input.name : input.kind);
  return reply;
};
async function main() {
  const good = await parseRestrictionAddressInput('nem.group', opts, resolver({ ok: true, address: friend.text, via: 'alias', label: 'nem.group' }));
  ok(good.ok && good.value === friend.text && good.alias === 'nem.group', 'alias resolves to the real address', good);
  ok(calls.join() === 'nem.group', 'the resolver got the alias name', calls);

  const withAt = await parseRestrictionAddressInput('@Nem.Group', opts, resolver({ ok: true, address: friend.text, via: 'alias', label: 'nem.group' }));
  ok(withAt.ok && withAt.alias === 'nem.group', '@ and capitals are accepted', withAt);

  const reasons: Array<['not_found' | 'no_address_alias' | 'expired' | 'wrong_network' | 'invalid', string]> = [
    ['not_found', 'alias_not_found'], ['no_address_alias', 'alias_no_address'], ['expired', 'alias_expired'],
    ['wrong_network', 'alias_wrong_network'], ['invalid', 'invalid_address'],
  ];
  for (const [reason, error] of reasons) {
    const r = await parseRestrictionAddressInput('nem.group', opts, resolver({ ok: false, reason }));
    ok(!r.ok && r.error === error, `reason ${reason} -> ${error}`, r);
  }

  const failing = await parseRestrictionAddressInput('nem.group', opts, async () => { throw new Error('network down'); });
  ok(!failing.ok && failing.error === 'alias_lookup_failed', 'a failed lookup is its own error', failing);

  const noNetwork = await parseRestrictionAddressInput('nem.group', { ownAddress: mine.text }, resolver({ ok: true, address: friend.text, via: 'alias', label: 'x' }));
  ok(!noNetwork.ok && noNetwork.error === 'alias_lookup_failed', 'no network byte -> no lookup');

  // The address the alias points to is checked like a typed one.
  const toSelf = await parseRestrictionAddressInput('me.name', opts, resolver({ ok: true, address: mine.text, via: 'alias', label: 'me.name' }));
  ok(!toSelf.ok && toSelf.error === 'own_address', 'an alias that points at the account itself is refused', toSelf);
  const toMainnet = await parseRestrictionAddressInput('main.name', opts, resolver({ ok: true, address: mainnetAddress.text, via: 'alias', label: 'main.name' }));
  ok(!toMainnet.ok && toMainnet.error === 'wrong_network', 'an alias that points at another network is refused', toMainnet);

  // For a multisig account the "own" address is the multisig account, not the wallet.
  const multi = addressOf(TESTNET, 9);
  const toMulti = await parseRestrictionAddressInput('safe.name', { networkByte: TESTNET, ownAddress: multi.text }, resolver({ ok: true, address: multi.text, via: 'alias', label: 'safe.name' }));
  ok(!toMulti.ok && toMulti.error === 'own_address', 'the multisig account cannot list itself');
  const walletOnMulti = await parseRestrictionAddressInput(mine.text, { networkByte: TESTNET, ownAddress: multi.text }, resolver({ ok: false, reason: 'not_found' }));
  ok(walletOnMulti.ok && walletOnMulti.value === mine.text, 'the cosigner wallet itself can be listed on a multisig account');

  // Plain input never reaches the resolver.
  calls.length = 0;
  const plain = await parseRestrictionAddressInput(friend.text.toLowerCase(), opts, resolver({ ok: false, reason: 'not_found' }));
  ok(plain.ok && plain.value === friend.text && plain.alias === undefined && calls.length === 0, 'a real address is not looked up', plain);
  const dashed = await parseRestrictionAddressInput(friend.text.match(/.{1,6}/g)!.join('-'), opts, resolver({ ok: false, reason: 'not_found' }));
  ok(dashed.ok && dashed.value === friend.text && calls.length === 0, 'a hyphenated address is accepted', dashed);
  const key = await parseRestrictionAddressInput('A'.repeat(64), opts, resolver({ ok: false, reason: 'not_found' }));
  ok(!key.ok && key.error === 'invalid_address' && calls.length === 0, 'a public key is not accepted here', key);
  const junk = await parseRestrictionAddressInput('hello', opts, resolver({ ok: false, reason: 'not_found' }));
  ok(!junk.ok && junk.error === 'invalid_address' && calls.length === 0, 'a bare word stays an address error', junk);
  const tooLong = await parseRestrictionAddressInput('a.b.c.d', opts, resolver({ ok: false, reason: 'not_found' }));
  ok(!tooLong.ok && tooLong.error === 'invalid_address' && calls.length === 0, 'a four-level name is not a namespace', tooLong);

  console.log(`${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
}
void main();
