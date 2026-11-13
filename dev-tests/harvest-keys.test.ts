// ハーベストのキーリンクの個別管理（リモート／VRF／ノードを公開鍵で1つずつリンク・解除・付け替え）: どのリンクを送るかの判定。通信なし。
// Run: npx tsx dev-tests/harvest-keys.test.ts
import { currentKey, isPublicKeyHex, planKeyChange } from '../src/lib/symbol/harvestKeys';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const k = (c: string) => c.repeat(64);
const OWN = k('A'), R = k('1'), V = k('2'), N = k('3'), R2 = k('4');
const none = { remotePublicKey: null, vrfPublicKey: null, nodePublicKey: null };
const all = { remotePublicKey: R, vrfPublicKey: V, nodePublicKey: N };
const partial = { remotePublicKey: R, vrfPublicKey: null, nodePublicKey: null };
const json = (x: unknown) => JSON.stringify(x);

ok(isPublicKeyHex(k('a')) && !isPublicKeyHex('abc') && !isPublicKeyHex(k('g')) && !isPublicKeyHex(k('a') + '0'), 'public key is 64 hex chars');
ok(currentKey(all, 'vrf') === V && currentKey(none, 'node') === null, 'current key of a kind');
ok(currentKey({ ...none, nodePublicKey: 'abcd' }, 'node') === 'ABCD', 'the current key is read in upper case');

// link
ok(json(planKeyChange(none, 'remote', 'link', R, OWN)) === json({ ok: true, links: [{ kind: 'remote', publicKey: R, link: true }] }), 'link one key');
ok(json(planKeyChange(none, 'node', 'link', N.toLowerCase(), OWN)) === json({ ok: true, links: [{ kind: 'node', publicKey: N, link: true }] }), 'a typed key in lower case is linked in upper case');
ok(json(planKeyChange(partial, 'vrf', 'link', V, OWN)) === json({ ok: true, links: [{ kind: 'vrf', publicKey: V, link: true }] }), 'link a missing key of a half-finished setup: only that one');
ok(planKeyChange(all, 'remote', 'link', R2, OWN).ok === false && (planKeyChange(all, 'remote', 'link', R2, OWN) as { error: string }).error === 'already_linked', 'link over an existing link is refused');
ok((planKeyChange(none, 'remote', 'link', 'xyz', OWN) as { error: string }).error === 'invalid_key', 'a bad key is refused');
ok((planKeyChange(none, 'remote', 'link', '', OWN) as { error: string }).error === 'invalid_key', 'an empty key is refused');
ok((planKeyChange(none, 'vrf', 'link', OWN.toLowerCase(), OWN) as { error: string }).error === 'own_key', 'the account\'s own key is refused');
ok((planKeyChange(partial, 'vrf', 'link', R, OWN) as { error: string }).error === 'duplicate_key', 'a key already linked as another kind is refused');
ok(planKeyChange(partial, 'remote', 'unlink', '', OWN).ok === true, 'unlink needs no typed key');

// unlink
ok(json(planKeyChange(all, 'vrf', 'unlink', 'ignored', OWN)) === json({ ok: true, links: [{ kind: 'vrf', publicKey: V, link: false }] }), 'unlink names the key that is linked now, not the typed one');
ok((planKeyChange(none, 'node', 'unlink', '', OWN) as { error: string }).error === 'not_linked', 'unlink of nothing is refused');
ok((planKeyChange(partial, 'node', 'unlink', '', OWN) as { error: string }).error === 'not_linked', 'unlink of a kind that is not linked is refused');

// replace
ok(json(planKeyChange(all, 'node', 'replace', R2, OWN)) === json({ ok: true, links: [{ kind: 'node', publicKey: N, link: false }, { kind: 'node', publicKey: R2, link: true }] }), 'replace = unlink the old, then link the new, in one go (this order)');
ok((planKeyChange(all, 'node', 'replace', N, OWN) as { error: string }).error === 'same_key', 'replacing with the same key is refused');
ok((planKeyChange(none, 'node', 'replace', R2, OWN) as { error: string }).error === 'not_linked', 'replace without a link is refused');
ok((planKeyChange(all, 'remote', 'replace', V, OWN) as { error: string }).error === 'duplicate_key', 'replace with a key linked as another kind is refused');
ok((planKeyChange(all, 'remote', 'replace', OWN, OWN) as { error: string }).error === 'own_key', 'replace with the own key is refused');

console.log(`${checks - fails}/${checks} passed`);
process.exit(fails === 0 ? 0 : 1);
