// キーストアファイルの取り込み（プロファイル作成）の確認：ファイルを読み、秘密鍵1本だけのプロファイルを作る。
// メモリ上のストレージで実行。 実行: npx tsx dev-tests/keystore-import.test.ts
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
const { buildKeystore, buildPlainKeyFile, peekKeystore, readKeystore } = await import('../src/lib/keystore');
const { clearPendingImport, getPendingImport, getPendingKeyImport, setPendingImport, setPendingKeyImport } = await import('../src/lib/pendingImport');
const { addressFromPublicKey, keyPairFromPrivateKey } = await import('../src/lib/symbol/crypto');
const { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } = await import('../src/lib/nem/crypto');
import type { KeystoreAccount } from '../src/lib/keystore';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

Storage.setup();
setChain('symbol'); setNetwork('mainnet');

const PRIVATE = 'DEADBEEF'.repeat(8);
const symKeys = keyPairFromPrivateKey(PRIVATE);
const nemKeys = nemKeyPairFromPrivateKey(PRIVATE);
const symAccount: KeystoreAccount = { chain: 'symbol', network: 'mainnet', address: addressFromPublicKey(symKeys.publicKey, 0x68), privateKey: PRIVATE, publicKey: symKeys.publicKey };
const nemAccount: KeystoreAccount = { chain: 'nem', network: 'mainnet', address: nemAddressFromPublicKey(nemKeys.publicKey, 0x68), privateKey: PRIVATE, publicKey: nemKeys.publicKey };
const KEYSTORE_PASSWORD = 'keystore password';
const PROFILE_PASSWORD = 'profile password 1';

// --- 1. 暗号化キーストア → 読み込み → プロファイル作成 ---
const sealed = await buildKeystore(symAccount, KEYSTORE_PASSWORD);
check('encrypted file: peek says encrypted', peekKeystore(sealed).encrypted === true);
const loaded = await readKeystore(sealed, KEYSTORE_PASSWORD);
const r1 = await WalletsHelper.addProfileFromKey('バックアップ', loaded, PROFILE_PASSWORD);
check('profile created', r1 === 'added');

const wallets = await WalletsHelper.gets();
check('exactly one wallet saved', wallets.length === 1);
const w = wallets[0];
check('key-only: no index, no mnemonic, not watch / ledger', w.accountIndex === null && !w.hasMnemonic() && !w.watchOnly && !w.ledger);
check('profile name is the given one', w.name === 'バックアップ');
check('own profile (profileKey = id)', w.profileKey === w.id);
check('public key and address match the file', w.publicKey === symAccount.publicKey && w.address === symAccount.address, w.address);
check('the profile password opens the private key', (await WalletsHelper.decryptKey(w.id, PROFILE_PASSWORD)) === PRIVATE);
check('the keystore password is not the profile password', (await WalletsHelper.decryptKey(w.id, KEYSTORE_PASSWORD)) === null);
check('the private key is not stored in the clear', !JSON.stringify([...mem.values()]).includes(PRIVATE));
check('the profile password is saved', await WalletsHelper.hasSavedCode?.(w.profileKey) !== false);
check('the new profile is the active symbol account', (await WalletsHelper.getActive('symbol'))?.id === w.id);

// --- 2. 同じ鍵をもう一度 → 作らない ---
const sealedAgain = await buildKeystore(symAccount, KEYSTORE_PASSWORD);
const r2 = await WalletsHelper.addProfileFromKey('もう一つ', await readKeystore(sealedAgain, KEYSTORE_PASSWORD), 'another password 2');
check('same key again: refused as exists', r2 === 'exists');
check('still one wallet', (await WalletsHelper.gets()).length === 1);
check('same key, lower-case public key: still exists', await WalletsHelper.addProfileFromKey('x', { chain: 'symbol', publicKey: symAccount.publicKey.toLowerCase(), privateKey: PRIVATE }, 'another password 2') === 'exists');

// --- 3. 平文の鍵ファイル（NEM）は別のチェーンなので別プロファイルとして作れる ---
const plain = buildPlainKeyFile(nemAccount);
check('plain file: peek says not encrypted', peekKeystore(plain).encrypted === false);
const nemLoaded = await readKeystore(plain);
const r3 = await WalletsHelper.addProfileFromKey('NEM用', nemLoaded, 'nem profile pw 3');
check('same private key on the other chain is a separate profile', r3 === 'added' && (await WalletsHelper.gets()).length === 2);
const nemWallet = (await WalletsHelper.getActive('nem'))!;
check('nem wallet: chain and address', nemWallet.chain === 'nem' && nemWallet.address === nemAccount.address, nemWallet.address);
check('the newest profile is the one that opens (same as any profile creation)', (await WalletsHelper.getActiveAny())?.id === nemWallet.id);

// --- 4. 次の画面に渡す一時状態（メモリ上だけ） ---
clearPendingImport();
check('pending: empty at first', getPendingKeyImport() === null && getPendingImport() === null);
setPendingKeyImport(symAccount);
check('pending: key import is held', getPendingKeyImport()?.privateKey === PRIVATE && getPendingImport() === null);
setPendingImport('word '.repeat(23) + 'word', 'symbol');
check('pending: starting a phrase import drops the key import', getPendingKeyImport() === null && getPendingImport() !== null);
setPendingKeyImport(symAccount);
check('pending: starting a key import drops the phrase', getPendingImport() === null && getPendingKeyImport() !== null);
clearPendingImport();
check('pending: clear removes both', getPendingKeyImport() === null && getPendingImport() === null);

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
