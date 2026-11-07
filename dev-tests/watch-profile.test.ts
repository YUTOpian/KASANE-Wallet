// 閲覧用プロファイルの保存・アクティブ切り替え・アドレス変換の確認（メモリ上のストレージで実行）。
// 実行: npx tsx dev-tests/watch-profile.test.ts
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};

const { Storage, WalletsHelper } = await import('../src/lib/storage');
const { setChain } = await import('../src/lib/chain');
const { setNetwork } = await import('../src/lib/symbol/network');
const { addressFromPublicKey } = await import('../src/lib/symbol/crypto');
const { nemAddressFromPublicKey } = await import('../src/lib/nem/crypto');

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

Storage.setup();
const key = '3B9670B5CB19C893694FC49B461CE489BF9588BE16DBE8DC29CF06338133DEE6';
const symMain = addressFromPublicKey(key, 0x68);
const symTest = addressFromPublicKey(key, 0x98);
const nemMain = nemAddressFromPublicKey(key, 0x68);
const nemTest = nemAddressFromPublicKey(key, 0x98);

// --- 1. Symbol のアドレスで閲覧用プロファイルを作る ---
setChain('symbol'); setNetwork('mainnet');
const created = await WalletsHelper.addWatchProfile('見るだけ', 'symbol', symMain);
check('created is watch-only', created.watchOnly === true && created.publicKey === '' && created.encryptedSecret === '');
check('no mnemonic / no secret', !created.hasMnemonic() && (await created.decryptSecret('whatever')) === null);

let active = await WalletsHelper.getActive('symbol');
check('symbol active is the watch account', active?.id === created.id);
check('address on mainnet', active?.address === symMain, String(active?.address));
check('NEM has no account yet', (await WalletsHelper.getActive('nem')) === null);
check('getActiveAny finds the watch profile', (await WalletsHelper.getActiveAny())?.id === created.id);
check('isActiveWatchOnly (symbol selected)', await WalletsHelper.isActiveWatchOnly());
setChain('nem');
check('isActiveWatchOnly (nem selected, no nem address)', await WalletsHelper.isActiveWatchOnly());
setChain('symbol');

// --- 2. ネットワークを切り替えても同じアカウントのアドレスが出る ---
setNetwork('testnet');
check('address follows the network', (await WalletsHelper.getActive('symbol'))?.address === symTest);
setNetwork('mainnet');

// --- 3. NEM のアドレスを同じプロファイルに追加 ---
const r1 = await WalletsHelper.addWatchAddressToProfile(created.id, 'nem', nemTest); // テストネット表記で入れても
check('add nem address', r1 === 'added');
const nemActive = await WalletsHelper.getActive('nem');
check('nem active exists after add', nemActive?.chain === 'nem' && nemActive.watchOnly);
check('nem address on mainnet (converted)', nemActive?.address === nemMain, String(nemActive?.address));
setNetwork('testnet');
check('nem address on testnet', (await WalletsHelper.getActive('nem'))?.address === nemTest);
setNetwork('mainnet');
check('symbol still active', (await WalletsHelper.getActive('symbol'))?.id === created.id);

// --- 4. 重複（同じアカウントの別ネットワーク表記でも）は追加しない ---
check('duplicate nem (other network spelling) rejected', (await WalletsHelper.addWatchAddressToProfile(created.id, 'nem', nemMain)) === 'exists');
check('duplicate symbol rejected', (await WalletsHelper.addWatchAddressToProfile(created.id, 'symbol', symTest)) === 'exists');

// --- 5. 通常のプロファイルには追加できない ---
const all = await WalletsHelper.gets();
check('two accounts in the profile', all.length === 2 && all.every((w) => w.profileKey === created.profileKey));
const { Wallet } = await import('../src/lib/storage');
const normal = await WalletsHelper.createWithKeys('normal', key, '00'.repeat(32), 'passw0rd!', 'symbol');
await WalletsHelper.add(normal, false);
let threw = false;
try { await WalletsHelper.addWatchAddressToProfile(normal.id, 'nem', nemMain); } catch { threw = true; }
check('cannot add a watch address to a normal profile', threw);
check('normal wallet is not watch-only', normal instanceof Wallet && normal.watchOnly === false);

// --- 6. 保存して読み直しても閲覧用のまま ---
const reloaded = await Storage.loadWallets();
const w0 = reloaded.get(created.id);
check('reload keeps watchOnly + watchAddress', w0?.watchOnly === true && w0.watchAddress === symMain);

// --- 7. 別のプロファイルを選んだら閲覧用ではなくなる／戻すと閲覧用 ---
await WalletsHelper.setActive(normal.id);
check('normal profile active -> not watch-only', !(await WalletsHelper.isActiveWatchOnly()));
await WalletsHelper.setActive(created.id);
check('back to watch profile', await WalletsHelper.isActiveWatchOnly());

// --- 8. 閲覧用プロファイルを削除（パスワード設定なしでも失敗しない） ---
await WalletsHelper.delete(created.id);
const left = await WalletsHelper.gets();
check('profile deleted, normal remains', left.length === 1 && left[0].id === normal.id);

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
