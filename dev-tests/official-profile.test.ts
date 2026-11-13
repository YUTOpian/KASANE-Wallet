// Symbol 公式ウォレットのプロファイルとの相互変換の確認（メモリ上のストレージで実行）。
// 実行: npx tsx dev-tests/official-profile.test.ts
//  1. 暗号・パスワードハッシュが公式ウォレット（symbol-sdk Crypto / SHA3-512）と同じ形式か
//     （公式ウォレットに同梱の crypto-js と SDK の Crypto.encrypt を実際に動かして作った暗号文を、そのまま読めるか）
//  2. 公式の localStorage の形（profiles / accounts）を読めるか
//  3. 公式 → KASANE（開く・取り込む・重複・パスワードが短いとき・秘密鍵だけ・テストネット）
//  4. KASANE → 公式（書き出して読み戻すと、同じ鍵になる）
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};

const { Storage, WalletsHelper, PinCodeHelper } = await import('../src/lib/storage');
const { setNetwork } = await import('../src/lib/symbol/network');
const { profileAccounts } = await import('../src/lib/accounts');
const { MnemonicHelper, symbolPath } = await import('../src/lib/symbol/hd');
const { keyPairFromPrivateKey, addressFromPublicKey } = await import('../src/lib/symbol/crypto');
const { NETWORKS } = await import('../src/lib/symbol/constants');
const format = await import('../src/lib/officialProfile/format');
const convert = await import('../src/lib/officialProfile/convert');

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

Storage.setup();
setNetwork('mainnet');

// 24 words of the BIP39 test vector (all-zero entropy).
const PHRASE = `${'abandon '.repeat(23)}art`;
const PASSWORD = 'official-pass-123';

// ---- 1. crypto -----------------------------------------------------------------------------
// Made by the official wallet's own code: crypto-js taken from the official bundle + symbol-sdk's Crypto.encrypt.
const OFFICIAL_VECTOR = {
  password: 'パスワードtest123',
  plain: '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
  encrypted: '47982421feabb51f444e71322e4dfd09e4cd72b27925c767ea6ff6a7637f1ca33UhqX+nKPYiN6KJnFwamVZDtAe2+T1ESdEjb91wMaZarPK571A9ZIHZV8AhxyD7xrqskJzWXOQTywVrWXFxXdn68lFTD02pGm7gms5xoSdU=',
};
check('crypto: opens a ciphertext made by the official code', (await format.officialDecrypt(OFFICIAL_VECTOR.encrypted, OFFICIAL_VECTOR.password)) === OFFICIAL_VECTOR.plain);
check('crypto: wrong password gives null', (await format.officialDecrypt(OFFICIAL_VECTOR.encrypted, 'wrong')) === null);
const sealed = await format.officialEncrypt('hello', PASSWORD);
check('crypto: output is salt(32 hex) + iv(32 hex) + base64', /^[0-9a-f]{64}[A-Za-z0-9+/]+=*$/.test(sealed));
check('crypto: round trip', (await format.officialDecrypt(sealed, PASSWORD)) === 'hello');
check('crypto: garbage gives null', (await format.officialDecrypt('zzzz', PASSWORD)) === null);
// NIST SHA3-512("abc")
check('hash: SHA3-512 (upper-case hex)', format.officialPasswordHash('abc') === 'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0');
check('hash: matches case-insensitively', format.officialPasswordMatches({ password: format.officialPasswordHash(PASSWORD).toLowerCase() }, PASSWORD) && !format.officialPasswordMatches({ password: format.officialPasswordHash(PASSWORD) }, 'nope'));

// ---- 2. reading the official shape ---------------------------------------------------------
const keys = MnemonicHelper.accountsFromMnemonic(PHRASE, 12);
const lonely = keyPairFromPrivateKey('3B9670B5CB19C893694FC49B461CE489BF9588BE16DBE8DC29CF06338133DEE6');

function officialAccount(over: Partial<import('../src/lib/officialProfile/format').OfficialAccount>): import('../src/lib/officialProfile/format').OfficialAccount {
  return { id: 'x', name: 'n', profileName: 'P', node: '', type: 2, address: '', publicKey: '', encryptedPrivateKey: '', path: '', isMultisig: false, ...over };
}
async function officialDataset(opts: { name: string; password: string; networkType?: number; withSeed?: boolean; mnemonicPath?: (i: number) => string }) {
  const path = opts.mnemonicPath ?? symbolPath;
  const accounts = [
    officialAccount({ id: 'a0', name: 'Seed Account 1', profileName: opts.name, type: 1, publicKey: keys[0].publicKey, encryptedPrivateKey: await format.officialEncrypt(keys[0].privateKey, opts.password), path: path(0) }),
    officialAccount({ id: 'a2', name: 'Savings', profileName: opts.name, type: 1, publicKey: keys[2].publicKey, encryptedPrivateKey: await format.officialEncrypt(keys[2].privateKey, opts.password), path: path(2) }),
    officialAccount({ id: 'a3', name: 'Imported', profileName: opts.name, type: 2, publicKey: lonely.publicKey, encryptedPrivateKey: await format.officialEncrypt(lonely.privateKey, opts.password) }),
    officialAccount({ id: 'a4', name: 'My Trezor', profileName: opts.name, type: 4, publicKey: 'AB'.repeat(32) }),
  ];
  const profile = {
    profileName: opts.name, accounts: accounts.map((a) => a.id),
    seed: opts.withSeed === false ? '' : await format.officialEncrypt(PHRASE, opts.password),
    password: format.officialPasswordHash(opts.password), hint: '', networkType: opts.networkType ?? 104,
    generationHash: NETWORKS.mainnet.generationHash, termsAndConditionsApproved: true, selectedNodeUrlToConnect: '',
  };
  // As copied from the official wallet's localStorage: each value is a JSON string.
  return JSON.stringify({
    profiles: JSON.stringify({ version: 8, data: { [opts.name]: profile } }),
    accounts: JSON.stringify({ version: 7, data: Object.fromEntries(accounts.map((a) => [a.id, a])) }),
  });
}

const text = await officialDataset({ name: 'Official1', password: PASSWORD });
const data = format.parseOfficialData(text);
check('parse: profile and accounts read from localStorage strings', Object.keys(data.profiles).join() === 'Official1' && Object.keys(data.accounts).length === 4);
check('parse: versions are kept', data.versions.profiles === 8 && data.versions.accounts === 7);
check('parse: also accepts plain objects', Object.keys(format.parseOfficialData(JSON.stringify({ profiles: JSON.parse(JSON.parse(text).profiles), accounts: JSON.parse(JSON.parse(text).accounts) })).profiles).length === 1);
for (const [label, input, code] of [['empty', '  ', 'empty'], ['not json', 'abc', 'not-json'], ['no profiles', '{"foo":1}', 'no-profiles'], ['array', '[1]', 'bad-shape']] as const) {
  let got = '';
  try { format.parseOfficialData(input); } catch (e) { got = e instanceof format.OfficialFormatError ? e.code : 'other'; }
  check(`parse: ${label} -> ${code}`, got === code, got);
}
const summary = convert.listOfficialProfiles(data)[0];
check('list: name / mainnet / 4 accounts / has seed', summary.profileName === 'Official1' && summary.network === 'mainnet' && summary.accountCount === 4 && summary.hasSeed);

// ---- 3. official -> KASANE -----------------------------------------------------------------
check('open: wrong password is refused', ((await convert.openOfficialProfile(data, 'Official1', 'nope-nope-nope')) as { ok: boolean }).ok === false);
const opened = await convert.openOfficialProfile(data, 'Official1', PASSWORD);
if (!opened.ok) throw new Error('open failed');
const o = opened.profile;
check('open: the phrase is read', o.mnemonic === MnemonicHelper.normalize(PHRASE));
check('open: indexed accounts are recognised as derived (0 and 2), the lone key as imported', o.accounts.map((a) => `${a.kind}:${a.index}`).join() === 'derived:0,derived:2,imported:null');
check('open: Trezor is skipped, not lost silently', o.skipped.length === 1 && o.skipped[0].reason === 'trezor');

const imported = await convert.importOpenedProfile(o, PASSWORD);
check('import: imported', imported.status === 'imported' && imported.keptMnemonic === true);
const all = await WalletsHelper.gets();
const symbol = all.filter((w) => w.chain === 'symbol');
check('import: Symbol accounts 0..9 plus the imported key; NEM accounts made too', symbol.length === 11 && all.filter((w) => w.chain === 'nem').length === 10);
const byIndex = (i: number) => symbol.find((w) => w.accountIndex === i)!;
check('import: indices 0 and 2 are shown, others stay hidden', !byIndex(0).hidden && !byIndex(2).hidden && byIndex(1).hidden && byIndex(5).hidden);
check('import: names - default "Seed Account 1" dropped, "Savings" kept', byIndex(0).accountName === '' && byIndex(2).accountName === 'Savings');
const key = symbol.find((w) => w.accountIndex === null)!;
check('import: the lone key is an imported account of the same profile', key.profileKey === byIndex(0).profileKey && !key.hidden && key.accountName === 'Imported' && key.publicKey === lonely.publicKey);
check('import: secrets open with the password', (await key.decryptSecret(PASSWORD)) === lonely.privateKey && (await byIndex(2).decryptSecret(PASSWORD)) === keys[2].privateKey && (await byIndex(0).decryptMnemonic(PASSWORD)) === MnemonicHelper.normalize(PHRASE));
check('import: the profile password is saved', await PinCodeHelper.check(byIndex(0).profileKey, PASSWORD));
check('import: active account is index 0', (await WalletsHelper.getActive('symbol'))?.id === byIndex(0).id);
check('import: importing the same profile again is refused', (await convert.importOpenedProfile(o, PASSWORD)).status === 'duplicate');

// short official password -> KASANE needs another one, and the secrets are re-encrypted with it
mem.clear();
const shortText = await officialDataset({ name: 'Short', password: 'abc123', withSeed: false });
const shortData = format.parseOfficialData(shortText);
const shortOpen = await convert.openOfficialProfile(shortData, 'Short', 'abc123');
if (!shortOpen.ok) throw new Error('open short failed');
check('short password: not usable as a KASANE password', !convert.isKasanePasswordUsable('abc123') && convert.isKasanePasswordUsable(PASSWORD));
let threw = false;
try { await convert.importOpenedProfile(shortOpen.profile, 'abc123'); } catch { threw = true; }
check('short password: importing with it is refused', threw);
check('no seed: all accounts come in as key accounts, no phrase', shortOpen.profile.mnemonic === null && shortOpen.profile.accounts.every((a) => a.kind === 'imported'));
const newPassword = 'a-new-kasane-password';
const r2 = await convert.importOpenedProfile(shortOpen.profile, newPassword);
const w2 = (await WalletsHelper.gets()).filter((w) => w.chain === 'symbol');
check('no seed: 3 accounts, none with a phrase, opens with the new password', r2.status === 'imported' && w2.length === 3 && w2.every((w) => !w.hasMnemonic() && w.accountIndex === null) && (await w2[0].decryptSecret(newPassword)) !== null);

// testnet profile: the official wallet derives m/44'/1'/…. This dataset's keys are the coin-type-4343 ones (they do not match the coin-type-1 derivation of the phrase) -> they must come in as keys, not as "derived"
mem.clear();
const testText = await officialDataset({ name: 'Test1', password: PASSWORD, networkType: 152, mnemonicPath: (i) => `m/44'/1'/${i}'/0'/0'` });
const testOpen = await convert.openOfficialProfile(format.parseOfficialData(testText), 'Test1', PASSWORD);
if (!testOpen.ok) throw new Error('open testnet failed');
check('testnet path (coin type 1) with keys that do not match the phrase: every account is imported as a key, none is "derived"', testOpen.profile.network === 'testnet' && testOpen.profile.accounts.every((a) => a.kind === 'imported'));

// ---- 4. KASANE -> official -> KASANE --------------------------------------------------------
mem.clear();
const accounts = profileAccounts(PHRASE);
const made = await WalletsHelper.createProfileWithMnemonic('MyProfile', PHRASE, PASSWORD, accounts, 'Main');
made.find((w) => w.chain === 'symbol' && w.accountIndex === 1)!.hidden = false;
await WalletsHelper.addProfile(made, made[0].id, PASSWORD);

check('export: wrong password is refused', (await convert.exportProfileToOfficial(made[0].id, 'wrong-password')).ok === false);
const exported = await convert.exportProfileToOfficial(made[0].id, PASSWORD);
if (!exported.ok) throw new Error('export failed');
const p = Object.values(exported.data.profiles.data)[0];
const accs = Object.values(exported.data.accounts.data);
check('export: versions match the official wallet 1.2.0', exported.data.profiles.version === 8 && exported.data.accounts.version === 7);
check('export: profile fields', p.profileName === 'MyProfile' && p.networkType === 104 && p.generationHash === NETWORKS.mainnet.generationHash && p.password === format.officialPasswordHash(PASSWORD) && p.termsAndConditionsApproved === true);
check('export: the phrase is in seed (official format)', (await format.officialDecrypt(p.seed, PASSWORD)) === MnemonicHelper.normalize(PHRASE));
check('export: 2 shown accounts, SEED type with m/44\'/4343\'/n\'/0\'/0\' paths', accs.length === 2 && accs.every((a) => a.type === 1) && accs.map((a) => a.path).join() === `${symbolPath(0)},${symbolPath(1)}`);
check('export: ids listed in the profile', p.accounts.join() === accs.map((a) => a.id).join());
const a1 = accs[1];
check('export: address is plain and matches the key', a1.address === addressFromPublicKey(a1.publicKey, 0x68) && !a1.address.includes('-') && a1.publicKey === keys[1].publicKey);
check('export: private key opens with the password and matches', (await format.officialDecrypt(a1.encryptedPrivateKey, PASSWORD)) === keys[1].privateKey);
check('export: name of index 0 is kept', accs[0].name === 'Main');

const json = format.officialExportToJson(exported.data);
const script = format.officialConsoleScript(exported.data);
check('export: JSON file reads back', Object.keys(format.parseOfficialData(json).profiles).join() === 'MyProfile');
check('export: console script merges into existing data (no overwrite of the lists)', script.includes("localStorage.setItem('profiles'") && script.includes('同じ名前のプロファイルがあるので'));

// Back into an empty KASANE: same accounts.
mem.clear();
const back = await convert.openOfficialProfile(format.parseOfficialData(json), 'MyProfile', PASSWORD);
if (!back.ok) throw new Error('re-open failed');
check('round trip: both accounts come back as derived 0 and 1 with the phrase', back.profile.mnemonic === MnemonicHelper.normalize(PHRASE) && back.profile.accounts.map((a) => `${a.kind}:${a.index}`).join() === 'derived:0,derived:1');
await convert.importOpenedProfile(back.profile, PASSWORD);
const again = (await WalletsHelper.gets()).filter((w) => w.chain === 'symbol' && !w.hidden);
check('round trip: same public keys after import', again.map((w) => w.publicKey).join() === [keys[0].publicKey, keys[1].publicKey].join());

// ---- 5. finding official data in this browser (same address) --------------------------------
mem.clear();
const detect = await import('../src/lib/officialProfile/detect');
check('detect: nothing in the browser -> nothing found', (await detect.findNewOfficialProfiles()) === null);
const detJson = JSON.parse(await officialDataset({ name: 'Found1', password: PASSWORD })) as { profiles: string; accounts: string };
mem.set('profiles', detJson.profiles);
mem.set('accounts', detJson.accounts);
const found1 = await detect.findNewOfficialProfiles();
check('detect: a profile in the browser is found', found1 !== null && found1.profiles.map((x) => x.profileName).join() === 'Found1');
if (found1 === null) throw new Error('detect failed');
check('detect: broken data is ignored, not an error', (mem.set('profiles', 'not json'), (await detect.findNewOfficialProfiles()) === null));
mem.set('profiles', detJson.profiles);
detect.dismissOfficialProfiles(found1.text, ['Found1']);
check('detect: "don\'t ask again" silences that profile', (await detect.findNewOfficialProfiles()) === null);
mem.delete('kasane.officialProfileDismissed');
check('detect: found again once the silence is removed', (await detect.findNewOfficialProfiles()) !== null);
const open5 = await convert.openOfficialProfile(format.parseOfficialData(found1.text), 'Found1', PASSWORD);
if (!open5.ok) throw new Error('open failed');
await convert.importOpenedProfile(open5.profile, PASSWORD);
check('detect: not offered again once it has been imported', (await detect.findNewOfficialProfiles()) === null);
// Delete the imported profile from KASANE: as long as the browser still has the official profile, it can be imported again.
const importedWallet = (await WalletsHelper.gets()).find((w) => w.chain === 'symbol')!;
await WalletsHelper.delete(importedWallet.id);
check('delete: the imported profile is gone from KASANE', (await WalletsHelper.gets()).length === 0);
check('delete: the browser still has it, so it is offered again', (await detect.findNewOfficialProfiles())?.profiles.map((x) => x.profileName).join() === 'Found1');
detect.dismissOfficialProfiles(found1.text, ['Found1']);
check('delete: even after "don\'t ask again", the manual import still lists it', (await detect.findNewOfficialProfiles()) === null && (await detect.findNewOfficialProfiles({ ignoreDismissed: true }))?.profiles.length === 1);
const open6 = await convert.openOfficialProfile(format.parseOfficialData(found1.text), 'Found1', PASSWORD);
if (!open6.ok) throw new Error('open after delete failed');
check('delete: it can be imported again', (await convert.importOpenedProfile(open6.profile, PASSWORD)).status === 'imported');

if (failed > 0) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall ok');
