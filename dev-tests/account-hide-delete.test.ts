// アカウント画面の「非表示」「削除」：いま使っている（一覧で選んだ）アカウントでも、隠す・削除できること。
// 使っているアカウントを隠す・消すときは、同じプロファイル・同じチェーンの次のアカウントに切り替わること。
// 実行: npx tsx dev-tests/account-hide-delete.test.ts（メモリ上のストレージ、通信なし）
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const { Storage, WalletsHelper, Wallet } = await import('../src/lib/storage');
const { setChain } = await import('../src/lib/chain');
const { nemKeyPairFromPrivateKey } = await import('../src/lib/nem/crypto');

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

Storage.setup();

// --- 1. インポートしたアカウント：使っている状態でも削除できる ---------------------------------
setChain('nem');
const base = await Wallet.createWithKeys('main', 'AA'.repeat(32), 'BB'.repeat(32), 'pw', 'nem');
await WalletsHelper.addProfile([base], base.id, 'pw');
const keyA = nemKeyPairFromPrivateKey('11'.repeat(32));
const keyB = nemKeyPairFromPrivateKey('22'.repeat(32));
await WalletsHelper.addImportedKeyToProfile(base.id, keyA.publicKey, keyA.privateKey, 'pw', 'nem');
await WalletsHelper.addImportedKeyToProfile(base.id, keyB.publicKey, keyB.privateKey, 'pw', 'nem');
const idOf = async (pub: string) => (await WalletsHelper.gets()).find((w) => w.publicKey === pub)!.id;
const a = await idOf(keyA.publicKey);

await WalletsHelper.setActive(a); // 一覧で選ぶと、そのアカウントが使用中になる
check('the imported account is active (as when picked in the list)', (await WalletsHelper.getActive('nem'))?.id === a);
check('delete the active imported account', await WalletsHelper.removeImportedAccount(a));
check('it is gone', (await WalletsHelper.gets()).every((w) => w.id !== a));
const after = await WalletsHelper.getActive('nem');
check('another account of the profile is active now', after !== null && after.id !== a && after.profileKey === base.profileKey, String(after?.id));

// 切り替え先のデフォルトを優先する
const b = await idOf(keyB.publicKey);
await WalletsHelper.updateAccount(base.id, { isDefault: true });
await WalletsHelper.setActive(b);
check('delete the active one: the default becomes active', (await WalletsHelper.removeImportedAccount(b)) && (await WalletsHelper.getActive('nem'))?.id === base.id);

// デフォルトのアカウントは消せない
check('the default account cannot be deleted', !(await WalletsHelper.removeImportedAccount(base.id)));
// 導出したのではないアカウント（インデックスなし）だけが対象。使っていない通常の削除も従来どおり
const keyC = nemKeyPairFromPrivateKey('33'.repeat(32));
await WalletsHelper.addImportedKeyToProfile(base.id, keyC.publicKey, keyC.privateKey, 'pw', 'nem');
const c = await idOf(keyC.publicKey);
check('delete a non-active imported account', await WalletsHelper.removeImportedAccount(c) && (await WalletsHelper.getActive('nem'))?.id === base.id);

// --- 2. ニーモニックから導出したアカウント：使っていても隠せる -----------------------------------
setChain('symbol');
const accounts = [0, 1, 2].map((i) => ({ index: i, publicKey: `${i}`.repeat(64), privateKey: `${i + 3}`.repeat(64) }));
const derived = await WalletsHelper.createProfileWithMnemonic('seed', 'word '.repeat(24).trim(), 'pw', accounts);
await WalletsHelper.addProfile(derived, derived[0].id, 'pw');
const [i0, i1, i2] = derived;
await WalletsHelper.updateAccount(i1.id, { hidden: false });
await WalletsHelper.updateAccount(i2.id, { hidden: false });

await WalletsHelper.setActive(i1.id);
await WalletsHelper.updateAccount(i1.id, { hidden: true });
const wallets = await WalletsHelper.gets();
check('the active derived account can be hidden', wallets.find((w) => w.id === i1.id)!.hidden === true);
check('the active account moved to index 0', (await WalletsHelper.getActive('symbol'))?.id === i0.id);
check('another index stays shown', wallets.find((w) => w.id === i2.id)!.hidden === false);

// 隠したものは、戻せる
await WalletsHelper.updateAccount(i1.id, { hidden: false });
check('a hidden account can be shown again', (await WalletsHelper.gets()).find((w) => w.id === i1.id)!.hidden === false);

// デフォルトは隠せない
await WalletsHelper.updateAccount(i0.id, { isDefault: true });
await WalletsHelper.updateAccount(i0.id, { hidden: true });
check('the default account is never hidden', (await WalletsHelper.gets()).find((w) => w.id === i0.id)!.hidden === false);

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
