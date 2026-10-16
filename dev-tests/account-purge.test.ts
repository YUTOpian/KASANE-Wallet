// アカウント／プロファイルを削除したとき、IDで別保存していたデータも消えることと、同じ .wlt をもう一度読み込めることの確認（メモリ上のストレージで実行）。
// 実行: npx tsx dev-tests/account-purge.test.ts
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
const { buildWlt, parseWlt, openWlt } = await import('../src/lib/nem/wlt');
const { isPurgeKey } = await import('../src/lib/accountPurge');

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

// キー判定そのもの
{
  const ids = new Set(['aaa']), profiles = new Set(['pk1']);
  check('harvest node of a removed wallet', isPurgeKey('kasane.nem.harvestNode.mainnet.aaa', ids, profiles));
  check('harvest node of another wallet stays', !isPurgeKey('kasane.nem.harvestNode.mainnet.bbb', ids, profiles));
  check('multisig remote of a removed wallet', isPurgeKey('kasane.nem.multisigRemote.testnet.aaa.NABC', ids, profiles));
  check('multisig remote of another wallet stays', !isPurgeKey('kasane.nem.multisigRemote.testnet.bbb.NABC', ids, profiles));
  check('an id that merely starts the same stays', !isPurgeKey('kasane.nem.harvestNode.mainnet.aaab', ids, profiles));
  check('backup mark of a removed profile', isPurgeKey('kasane.backupDone.pk1', ids, profiles));
  check('backup mark of another profile stays', !isPurgeKey('kasane.backupDone.pk2', ids, profiles));
  check('unrelated keys stay', !isPurgeKey('kasane.guideWizardSeen', ids, profiles));
}

Storage.setup();
setChain('nem');
const base = await Wallet.createWithKeys('main', 'AA'.repeat(32), 'BB'.repeat(32), 'pw', 'nem');
await WalletsHelper.addProfile([base], base.id, 'pw');
const other = await Wallet.createWithKeys('other', 'CC'.repeat(32), 'DD'.repeat(32), 'pw2', 'nem');
await WalletsHelper.addProfile([other], base.id, 'pw2');

const pair = nemKeyPairFromPrivateKey('11'.repeat(32));
const wlt = buildWlt({ name: 'x', privateKey: pair.privateKey, publicKey: pair.publicKey, networkByte: 0x68 }, 'password1');
const acc = openWlt(parseWlt(wlt), 'password1');

check('import from .wlt', (await WalletsHelper.addImportedKeyToProfile(base.id, acc.publicKey, acc.privateKey, 'pw', 'nem')) === 'added');
const added = (await WalletsHelper.gets()).find((w) => w.publicKey === acc.publicKey)!;
mem.set(`kasane.nem.harvestNode.mainnet.${added.id}`, 'https://node');
mem.set(`kasane.nem.multisigRemote.mainnet.${added.id}.NMULTISIG`, 'AB'.repeat(32));
mem.set(`kasane.nem.harvestNode.mainnet.${base.id}`, 'https://keep');
mem.set(`kasane.backupDone.${base.profileKey}`, '1');

check('delete the imported account', await WalletsHelper.removeImportedAccount(added.id));
check('the account record is gone', (await WalletsHelper.gets()).every((w) => w.publicKey !== acc.publicKey));
check('its harvest node is purged', !mem.has(`kasane.nem.harvestNode.mainnet.${added.id}`));
check('its multisig remote key is purged', !mem.has(`kasane.nem.multisigRemote.mainnet.${added.id}.NMULTISIG`));
check("another account's setting stays", mem.get(`kasane.nem.harvestNode.mainnet.${base.id}`) === 'https://keep');
check("the profile's backup mark stays", mem.get(`kasane.backupDone.${base.profileKey}`) === '1');
check('the same .wlt can be imported again', (await WalletsHelper.addImportedKeyToProfile(base.id, acc.publicKey, acc.privateKey, 'pw', 'nem')) === 'added');

// プロファイルごと削除
await WalletsHelper.delete(base.id);
check('deleting a profile purges its settings', !mem.has(`kasane.nem.harvestNode.mainnet.${base.id}`) && !mem.has(`kasane.backupDone.${base.profileKey}`));
check('the other profile is untouched', (await WalletsHelper.gets()).some((w) => w.id === other.id));

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
