// 旧形式（v3 でない暗号文）のプロファイルが強制削除され、現在の形式のプロファイルは残ることの確認（メモリ上のストレージで実行）。
// 実行: npx tsx dev-tests/legacy-profile-purge.test.ts
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const { Storage, WalletsHelper, Wallet, PinCodeHelper } = await import('../src/lib/storage');
const { setChain } = await import('../src/lib/chain');
const CryptoJS = ((await import('crypto-js')) as any).default;

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

Storage.setup();
setChain('nem');
const modern = await Wallet.createWithKeys('modern', 'AA'.repeat(32), 'BB'.repeat(32), 'pw', 'nem');
await WalletsHelper.addProfile([modern], modern.id, 'pw');
const old = await Wallet.createWithKeys('old', 'CC'.repeat(32), 'DD'.repeat(32), 'pw2', 'nem');
// 旧形式（CryptoJS のパスフレーズ方式）に差し替えてから保存する。
old.encryptedSecret = CryptoJS.AES.encrypt('DD'.repeat(32), 'pw2').toString();
await WalletsHelper.addProfile([old], modern.id, 'pw2');
await PinCodeHelper.setForProfile(old.profileKey, 'pw2');
mem.set(`kasane.backupDone.${old.profileKey}`, '1');

check('legacy profile is detected before', await WalletsHelper.profileHasLegacyCipher(old.profileKey));
check('modern profile is not legacy', !(await WalletsHelper.profileHasLegacyCipher(modern.profileKey)));

const n = await WalletsHelper.deleteLegacyProfiles();
check('exactly one profile deleted', n === 1, String(n));
const left = await WalletsHelper.gets();
check('legacy account is gone', left.every((w) => w.id !== old.id));
check('modern account stays', left.some((w) => w.id === modern.id));
check('legacy profile password is gone', !(await PinCodeHelper.hasSavedCode(old.profileKey)));
check('legacy profile leftovers are purged', !mem.has(`kasane.backupDone.${old.profileKey}`));
check('second run deletes nothing', (await WalletsHelper.deleteLegacyProfiles()) === 0);

process.exit(failed === 0 ? 0 : 1);
