// Recipient typed as a namespace alias or a public key (Symbol). REST is mocked.
// Run: npx tsx dev-tests/symbol-recipient-alias.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey, hexToBytes } from '../src/lib/symbol/crypto';
import { classifyRecipientInput, namespaceIdPath, namespaceLabels } from '../src/lib/symbol/recipientInput';
import { resolveRecipientInput } from '../src/lib/symbol/api';
import { getNetwork, getNetworkConfig, setCustomNodeUrl } from '../src/lib/symbol/network';
import { XYM_NAMESPACE_ID } from '../src/lib/symbol/constants';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- parsing
const kp = new KeyPair(PrivateKey.random());
const pk = kp.publicKey.toString();
ok(JSON.stringify(classifyRecipientInput('nem.group')) === '{"kind":"alias","name":"nem.group"}', 'dotted name is an alias');
ok(JSON.stringify(classifyRecipientInput('  @NEM.Group ')) === '{"kind":"alias","name":"nem.group"}', 'leading @, case and spaces');
ok(JSON.stringify(classifyRecipientInput('@nem')) === '{"kind":"alias","name":"nem"}', 'bare root needs @');
ok(classifyRecipientInput('nem').kind === 'other', 'bare word is not an alias');
ok(classifyRecipientInput('a.b.c.d').kind === 'other', 'depth limit 3');
ok(classifyRecipientInput('a..b').kind === 'other', 'empty label');
ok(classifyRecipientInput('a.-b').kind === 'other', 'label cannot start with -');
ok(classifyRecipientInput(pk.toLowerCase()).kind === 'publicKey', '64 hex is a public key');
ok(classifyRecipientInput('NABC').kind === 'other', 'short text is other');
ok(namespaceLabels('symbol.xym')?.length === 2, 'labels');
ok(namespaceIdPath(['symbol', 'xym'])[1] === XYM_NAMESPACE_ID, 'symbol.xym id matches the known XYM alias id', namespaceIdPath(['symbol', 'xym']));

// --- resolution with a mocked gateway
const cfg = getNetworkConfig();
const nb = cfg.networkByte;
const owner = addressFromPublicKey(pk, nb);
const target = addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), nb);
const otherNetTarget = addressFromPublicKey(new KeyPair(PrivateKey.random()).publicKey.toString(), nb === 0x98 ? 0x68 : 0x98);
const hexOf = (a: string) => Array.from(new Address(a).bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
import { Address } from 'symbol-sdk/symbol';

const ids = namespaceIdPath(['nem', 'group']);
let height = 1000;
const store: Record<string, unknown> = {};
const entry = (o: { owner?: string; end?: string; alias?: unknown; active?: boolean }) => ({
  meta: { active: o.active ?? true },
  namespace: { ownerAddress: hexOf(o.owner ?? owner), endHeight: o.end ?? '5000', alias: o.alias ?? { type: 0 } },
});
globalThis.fetch = (async (url: string) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const body = path === '/chain/info' ? { height: String(height) } : store[path.replace('/namespaces/', '')];
  if (!body) return new Response('{"code":"ResourceNotFound"}', { status: 404 });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
setCustomNodeUrl(getNetwork(), 'http://mock.local');
const resolve = (name: string) => resolveRecipientInput({ kind: 'alias', name }, nb);

store[ids[0]] = entry({});
store[ids[1]] = entry({ alias: { type: 2, address: hexOf(target) } });
let r = await resolve('nem.group');
ok(r.ok && r.address === target, 'resolves to the linked address', r);

r = await resolve('nem.other');
ok(!r.ok && r.reason === 'not_found', 'unknown namespace', r);

store[ids[1]] = entry({});
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'no_address_alias', 'no alias linked', r);

store[ids[1]] = entry({ alias: { type: 1, mosaicId: '1234' } });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'no_address_alias', 'mosaic alias is not an address alias', r);

store[ids[1]] = entry({ alias: { type: 2, address: hexOf(target) }, end: '999' });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'expired', 'expired child', r);

store[ids[1]] = entry({ alias: { type: 2, address: hexOf(target) } });
store[ids[0]] = entry({ end: '999' });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'expired', 'expired root', r);

store[ids[0]] = entry({ owner: target });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'expired', 'root re-registered by another owner', r);

store[ids[0]] = entry({});
store[ids[1]] = entry({ alias: { type: 2, address: hexOf(target) }, active: false });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'expired', 'inactive entry', r);

store[ids[1]] = entry({ alias: { type: 2, address: hexOf(otherNetTarget) } });
r = await resolve('nem.group');
ok(!r.ok && r.reason === 'wrong_network', 'address of another network', r);

store[ids[1]] = entry({ alias: { type: 2, address: hexOf(target) }, end: '18446744073709551615' });
r = await resolve('nem.group');
ok(r.ok && r.address === target, 'eternal namespace', r);

// --- public key
const pkRes = await resolveRecipientInput({ kind: 'publicKey', publicKey: pk }, nb);
ok(pkRes.ok && pkRes.address === owner, 'public key -> address', pkRes);

void hexToBytes;
console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
