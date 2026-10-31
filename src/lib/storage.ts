
import localForage from 'localforage';


import * as bcrypt from 'bcryptjs'

import { getNetwork } from './symbol/network';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { addressBody } from './watchAddress';
import { nemAccountFromMnemonic } from './nem/hd';
import { purgeAccountData } from './accountPurge';
import { encryptString, decryptString } from './secretCrypto';
import { compareAccounts, Wallet, Wallets } from './wallet';
import type { StoredHarvestKeys } from './wallet';

// Re-exported so existing imports of `Wallet`, `compareAccounts` and `StoredHarvestKeys` from
// './storage' keep working unchanged - the model itself now lives in wallet.ts, and the
// encrypt/decryptString helpers now live in secretCrypto.ts (see each file's own header).
export { compareAccounts, Wallet };
export type { StoredHarvestKeys };

// The saved "this profile has a password" record. `hashedCode` used to hold a bcrypt hash of the password -
// a second, cheaper thing to brute-force next to the encrypted keys. It is now empty ('') for every profile
// whose keys are in the current format: the password is checked by opening the keys themselves (AES-GCM).
// A bcrypt hash only remains, until the profile is upgraded (see PinCodeHelper.check), on a profile whose keys
// are still in the old CryptoJS form - there a wrong password can slip through decryption, so the hash is the
// only safe check for it.
class PinCode {
  hashedCode = '';
}

// Tracks consecutive wrong-PIN entries across dialog re-opens and app restarts, so a
// PIN check can't be brute-forced just by closing/reopening PinDialog (which used to
// reset its own in-memory counter every time). See PinCodeHelper.check() /
// PinCodeHelper.LOCKOUT_* below for how this is used.
class PinAttempts {
  failedCount = 0;
  lockedUntil = 0; // epoch ms; 0 means "not locked"
}


export class Storage {
  private static readonly PIN_CODE_KEY = "PIN_CODE";
  private static readonly PIN_ATTEMPTS_KEY = "PIN_ATTEMPTS";
  private static readonly WALLETS_KEY = "WALLETS";
  // プロファイルごとのパスワード（確認用ハッシュ）と、間違えた回数。キーは profileKey。
  private static readonly PROFILE_PINS_KEY = "PROFILE_PINS";
  private static readonly PROFILE_PIN_ATTEMPTS_KEY = "PROFILE_PIN_ATTEMPTS";

  static setup() {
    // Driver order matters here. IndexedDB is listed first for normal http(s) hosting
    // (GitHub Pages) where it's fast and reliable, but when this file is opened directly
    // as file:///.../index.html, Chrome's IndexedDB implementation can throw
    // "Unsafe attempt to load URL ... 'file:' URLs are treated as unique security origins"
    // instead of cleanly failing — which broke the wallet-detection redirect entirely.
    // localForage tries each driver in order and falls back automatically if one throws
    // at setup time, but only if the earlier driver fails *before* being used for real
    // reads/writes. WEBSQL/LOCALSTORAGE both work fine under file://, so listing all three
    // means: use IndexedDB when it's actually usable, otherwise fall back safely.
    localForage.config({
      driver      : [localForage.INDEXEDDB, localForage.WEBSQL, localForage.LOCALSTORAGE],
      name        : 'VintageSymbolWallet',
      version     : 1.0,
      size        : 4980736, // Size of database, in bytes. WebSQL-only for now.
      storeName   : 'symbol_wallet_data', // Should be alphanumeric, with underscores.
      description : 'KASANE Wallet for Symbol'
    });
  }

  static async loadPinCode(): Promise<PinCode | null> {
    const storageObject = await localForage.getItem(this.PIN_CODE_KEY);
    if (storageObject) {
      return Object.assign(new PinCode(), storageObject);
    } else {
      return null;
    }
  }

  static async savePinCode(pinCode: PinCode) {
    await localForage.setItem(this.PIN_CODE_KEY, pinCode);
  }

  static async removePinCode() {
    await localForage.removeItem(this.PIN_CODE_KEY);
  }

  static async loadPinAttempts(): Promise<PinAttempts> {
    const storageObject = await localForage.getItem(this.PIN_ATTEMPTS_KEY);
    return storageObject ? Object.assign(new PinAttempts(), storageObject) : new PinAttempts();
  }

  static async savePinAttempts(attempts: PinAttempts) {
    await localForage.setItem(this.PIN_ATTEMPTS_KEY, attempts);
  }

  static async removePinAttempts() {
    await localForage.removeItem(this.PIN_ATTEMPTS_KEY);
  }

  static async loadProfilePins(): Promise<Record<string, PinCode>> {
    const raw: any = await localForage.getItem(this.PROFILE_PINS_KEY) || {};
    const result: Record<string, PinCode> = {};
    for (const key of Object.keys(raw)) {
      result[key] = Object.assign(new PinCode(), raw[key]);
    }
    return result;
  }

  static async saveProfilePins(pins: Record<string, PinCode>) {
    await localForage.setItem(this.PROFILE_PINS_KEY, pins);
  }

  static async loadProfileAttempts(): Promise<Record<string, PinAttempts>> {
    const raw: any = await localForage.getItem(this.PROFILE_PIN_ATTEMPTS_KEY) || {};
    const result: Record<string, PinAttempts> = {};
    for (const key of Object.keys(raw)) {
      result[key] = Object.assign(new PinAttempts(), raw[key]);
    }
    return result;
  }

  static async saveProfileAttempts(attempts: Record<string, PinAttempts>) {
    await localForage.setItem(this.PROFILE_PIN_ATTEMPTS_KEY, attempts);
  }

  static async removeProfilePinData() {
    await localForage.removeItem(this.PROFILE_PINS_KEY);
    await localForage.removeItem(this.PROFILE_PIN_ATTEMPTS_KEY);
  }

  static async loadWallets(): Promise<Wallets> {
    const storageObject: any = await localForage.getItem(this.WALLETS_KEY) || {};
    const wallets = Object.assign(new Wallets(), storageObject);
    wallets.wallets = ((wallets.wallets ?? []) as any[]).map((raw) => {
      const wallet = Object.assign(new Wallet(), raw);
      // 「非表示」の設定が入る前のバージョンで作られたプロファイル（profileId があり、複数インデックスを
      // 一括導出したもの）は、保存されたデータに hidden が無く、全インデックスが表示されてしまう。
      // インデックス 0 以外は、手動で表示するまで非表示として扱う（次に保存するときに hidden も保存される）。
      if (!('hidden' in raw) && wallet.profileId !== '' && wallet.profileId !== wallet.id
        && wallet.accountIndex !== null && wallet.accountIndex > 0) {
        wallet.hidden = true;
      }
      // 公式互換のテストネット鍵を使う設定なら、テストネットのときだけその鍵に差し替える。
      wallet.applyNetworkKeys(getNetwork());
      return wallet;
    });
    return wallets;
  }

  static async saveWallets(wallets: Wallets) {
    // 差し替えていた鍵は元に戻して保存する（メモリ上のオブジェクトはそのまま）。
    const stored = Object.assign(new Wallets(), wallets);
    stored.wallets = wallets.wallets.map((wallet) => wallet.toStored());
    await localForage.setItem(this.WALLETS_KEY, stored);
  }

}


export class PinCodeHelper {
  // Legacy placeholder password used - in older builds - to encrypt a wallet's secret
  // before a real PIN had been set. It is a fixed, publicly-known value (visible in the
  // shipped source), so any wallet still encrypted with it offers no real protection.
  // It is kept only so PinDialog's register/change flows can migrate a pre-existing
  // installation's wallet (one created before this fix, still encrypted with this
  // constant) onto the person's real PIN. Nothing new should ever be encrypted with
  // this value - see WalletCreationName.tsx, which now requires a
  // real PIN before a wallet is ever created/persisted.
  static readonly defaultPin = "093156";

  // After LOCKOUT_THRESHOLD consecutive wrong entries, checking a PIN is blocked for an
  // increasing cool-down instead of allowing unlimited retries. This is tracked in
  // storage (see PinAttempts) rather than component state, so it survives closing and
  // reopening PinDialog, and app restarts - closing the dialog no longer resets an
  // attacker's attempt count back to zero.
  private static readonly LOCKOUT_THRESHOLD = 3;
  private static readonly LOCKOUT_BASE_MS = 30 * 1000; // 30 seconds
  private static readonly LOCKOUT_MAX_MS = 30 * 60 * 1000; // capped at 30 minutes

  /**
   * パスワードはプロファイル（=1つのニーモニック）ごとに設定する。`profileKey` は Wallet.profileKey。
   * プロファイル専用のパスワードがまだ無い旧バージョンのプロファイルは、端末共通の旧パスワードが
   * あればそれを使う（確認に成功した時点で、そのプロファイル専用として保存し直す）。
   */
  private static async savedCodeFor(profileKey: string): Promise<PinCode | null> {
    const pins = await Storage.loadProfilePins();
    return pins[profileKey] ?? await Storage.loadPinCode();
  }

  static async hasSavedCode(profileKey: string): Promise<boolean> {
    return (await this.savedCodeFor(profileKey)) != null;
  }

  /** そのプロファイルのパスワードを設定（または変更）する。 */
  static async setForProfile(profileKey: string, rawCode: string) {
    // 呼び出し側が、プロファイルの鍵を新しいパスワードで暗号化し直した後に呼ぶ。ここでは「パスワードがある」という
    // 印だけを保存し、パスワードのハッシュは保存しない（検証は鍵の復号そのもので行う）。
    void rawCode;
    const pins = await Storage.loadProfilePins();
    pins[profileKey] = new PinCode();
    await Storage.saveProfilePins(pins);
    // A (re)registered password is a fresh secret - past failures shouldn't count against it.
    await this.clearAttempts(profileKey);
  }

  /** そのプロファイルのパスワードと失敗回数の記録を消す（プロファイル削除時）。 */
  static async removeForProfile(profileKey: string) {
    const pins = await Storage.loadProfilePins();
    delete pins[profileKey];
    await Storage.saveProfilePins(pins);
    await this.clearAttempts(profileKey);
  }

  private static async clearAttempts(profileKey: string) {
    const all = await Storage.loadProfileAttempts();
    if (profileKey in all) {
      delete all[profileKey];
      await Storage.saveProfileAttempts(all);
    }
  }

  /**
   * Milliseconds remaining before a password check for this profile is allowed again, or 0 if not
   * currently locked out. Callers (PasswordDialog) should check this before letting the person type,
   * rather than only discovering the lockout after a check() call.
   */
  static async getLockoutRemainingMs(profileKey: string): Promise<number> {
    const attempts = (await Storage.loadProfileAttempts())[profileKey];
    if (!attempts || attempts.lockedUntil === 0) {
      return 0;
    }
    const remaining = attempts.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  static async check(profileKey: string, pinCode: string): Promise<boolean> {
    // Still cooling down from previous failures - refuse the check outright (even if
    // `pinCode` happens to be correct) instead of letting every attempt through and
    // only rate-limiting the UI layer.
    if ((await this.getLockoutRemainingMs(profileKey)) > 0) {
      return false;
    }

    const savedCode = await this.savedCodeFor(profileKey);
    if (!savedCode) {
      return false;
    }

    const isCorrect = await this.verify(profileKey, savedCode, pinCode);
    if (isCorrect) {
      // 旧バージョンの共通パスワードで通ったプロファイルは、そのプロファイル専用のパスワードとして保存する。
      const pins = await Storage.loadProfilePins();
      if (!pins[profileKey]) {
        pins[profileKey] = savedCode;
        await Storage.saveProfilePins(pins);
      }
      await this.clearAttempts(profileKey);
      return true;
    }

    const all = await Storage.loadProfileAttempts();
    const failedCount = (all[profileKey]?.failedCount ?? 0) + 1;
    let lockedUntil = 0;
    if (failedCount >= this.LOCKOUT_THRESHOLD) {
      // Exponential backoff for every failure at/after the threshold: 30s, 60s, 120s, ...
      // capped at LOCKOUT_MAX_MS, so continued guessing gets slower rather than free.
      const overBy = failedCount - this.LOCKOUT_THRESHOLD;
      const delay = Math.min(this.LOCKOUT_BASE_MS * (2 ** overBy), this.LOCKOUT_MAX_MS);
      lockedUntil = Date.now() + delay;
    }
    all[profileKey] = Object.assign(new PinAttempts(), { failedCount, lockedUntil });
    await Storage.saveProfileAttempts(all);
    return false;
  }

  /**
   * パスワードが合っているか。鍵が現在の形式（AES-GCM）なら、鍵を実際に開けるかで確かめる（認証タグが合わなければ
   * 失敗するので、間違ったパスワードが通ることはない）。旧形式（CryptoJS）の鍵が残っているあいだだけは、保存済みの
   * bcrypt ハッシュで確かめる（旧形式の復号は、間違ったパスワードでも「それらしい文字列」になることがあるため）。
   */
  private static async verify(profileKey: string, savedCode: PinCode, pinCode: string): Promise<boolean> {
    const keyed = (await Storage.loadWallets()).gets().filter((w) => w.profileKey === profileKey && w.encryptedSecret.length > 0);
    if (keyed.some((w) => w.hasLegacyCipher())) {
      return savedCode.hashedCode.length > 0 && await bcrypt.compare(pinCode, savedCode.hashedCode);
    }
    if (keyed.length === 0) {
      return false;
    }
    if (savedCode.hashedCode.length > 0) {
      // 鍵はすべて現在の形式。もう安い方の検証器（bcrypt ハッシュ）は要らないので、通ったときに捨てる。
      const ok = (await decryptString(keyed[0].encryptedSecret, pinCode)) !== null;
      if (ok) {
        await this.dropLegacyVerifier(profileKey);
      }
      return ok;
    }
    return (await decryptString(keyed[0].encryptedSecret, pinCode)) !== null;
  }

  /** プロファイルの bcrypt ハッシュを捨て、「パスワードあり」の印だけにする。端末共通の旧ハッシュも、不要になれば消す。 */
  static async dropLegacyVerifier(profileKey: string) {
    const pins = await Storage.loadProfilePins();
    pins[profileKey] = new PinCode();
    await Storage.saveProfilePins(pins);
    const global = await Storage.loadPinCode();
    if (global) {
      const keyedProfiles = new Set((await Storage.loadWallets()).gets().filter((w) => w.encryptedSecret.length > 0).map((w) => w.profileKey));
      if ([...keyedProfiles].every((key) => pins[key] !== undefined)) {
        await Storage.removePinCode();
      }
    }
  }

  /** すべてのパスワード（プロファイルごとのものと、旧バージョンの共通のもの）を消す。最後のプロファイルを消したとき用。 */
  static async remove() {
    await Storage.removePinCode();
    await Storage.removePinAttempts();
    await Storage.removeProfilePinData();
  }
}


export class WalletsHelper {
  /**
   * Gets wallet.
   * @param {string} id Wallet ID
   * @returns {Promise<Wallet | null>} Wallet which has the given ID or null if there is no wallet which has the ID.
   */
  static async get(id: string): Promise<Wallet | null> {
    return (await Storage.loadWallets()).get(id);
  }

  /**
   * Gets wallets.
   * @returns {Wallet[]} All wallets.
   */
  static async gets(): Promise<Wallet[]> {
    return (await Storage.loadWallets()).gets();
  }

  /**
   * Gets active wallet.
   * @returns {Wallet | null} Active wallet or null if there is no active wallet.
   */
  static async getActive(chain?: ChainKey): Promise<Wallet | null> {
    // No argument: the active account of the chain currently selected (Symbol / NEM).
    return (await Storage.loadWallets()).getActive(chain);
  }

  /**
   * The active account of the selected chain, or - when this profile has no account on that chain
   * yet (NEM not set up) - the active account of the other chain. For things that belong to the
   * profile as a whole: its password, backup, deletion.
   */
  static async getActiveAny(): Promise<Wallet | null> {
    const wallets = await Storage.loadWallets();
    return wallets.getActive() ?? wallets.getActive('symbol') ?? wallets.getActive('nem');
  }

  /** Whether any account exists, on any chain. */
  static async hasAny(): Promise<boolean> {
    return (await Storage.loadWallets()).gets().length > 0;
  }

  /**
   * Sets active wallet.
   * @param {string} id Wallet ID.
   */
  static async setActive(id: string) {
    const wallets = await Storage.loadWallets();
    wallets.setActive(id);
    await Storage.saveWallets(wallets);
  }

  /**
   * Adds Wallet.
   * @param {Wallet} wallet New Wallet.
   * @param {boolean} activate If the wallet is activated now or not.
   */
  static async add(wallet: Wallet, activate: boolean = false) {
    const wallets = await Storage.loadWallets();
    wallets.add(wallet);
    if (activate) {
      wallets.setActive(wallet.id);
    }
    await Storage.saveWallets(wallets);
  }

  /**
   * Accounts (one per index) of the profile that the given wallet belongs to, ordered by index.
   */
  static async getProfileWallets(id: string, chain?: ChainKey): Promise<Wallet[]> {
    return (await Storage.loadWallets()).getProfileWallets(id, chain);
  }

  /**
   * Creates a brand-new profile: one account per entry of `accounts` (BIP44 index 0..N-1 of the
   * same recovery phrase), all sharing one profileId and one encrypted copy of the phrase, so
   * switching between them later never needs the password. Nothing is saved until addProfile().
   */
  static async createProfileWithMnemonic(
    name: string,
    mnemonic: string,
    password: string,
    accounts: { index: number; publicKey: string; privateKey: string; chain?: ChainKey; testnet?: { publicKey: string; privateKey: string } }[],
    // インデックス 0 のウォレットにつける名前（空なら「インデックス 0」と表示される）。
    firstAccountName: string = '',
  ): Promise<Wallet[]> {
    const usedIds = new Set((await this.gets()).map((wallet) => wallet.id));
    const profileId = Wallet.createId();
    // Encrypted once and shared: the same ciphertext opens with the same password.
    const encryptedMnemonic = await encryptString(mnemonic, password);
    return Promise.all(accounts.map(async (account) => {
      const wallet = new Wallet();
      wallet.createdAt = Date.now();
      while (usedIds.has(wallet.id)) {
        wallet.id = Wallet.createId();
      }
      usedIds.add(wallet.id);
      wallet.name = name;
      wallet.chain = account.chain ?? 'symbol';
      wallet.profileId = profileId;
      wallet.publicKey = account.publicKey;
      wallet.accountIndex = account.index;
      // 最初に表示されるのはインデックス 0 だけ。残りは、ウォレット切り替え画面で手動で表示する。
      wallet.hidden = account.index !== 0;
      wallet.accountName = account.index === 0 ? firstAccountName : '';
      wallet.encryptedSecret = await encryptString(account.privateKey, password);
      wallet.encryptedMnemonic = encryptedMnemonic;
      // 新しいプロファイルは、テストネットでは公式ウォレットと同じ導出（コイン種別 1）を使う。
      if (account.testnet && wallet.chain === 'symbol') {
        wallet.testnetPublicKey = account.testnet.publicKey;
        wallet.encryptedTestnetSecret = await encryptString(account.testnet.privateKey, password);
      }
      return wallet;
    }));
  }

  /**
   * 同じプロファイルの中で、ニーモニックを持つアカウント（導出済みのいずれか）。
   * 秘密鍵だけでインポートしたアカウントはニーモニックを持たないので、プロファイルの
   * バックアップ（ニーモニック）はこちらから取り出す。無ければ null。
   */
  static async getProfileMnemonicWallet(id: string): Promise<Wallet | null> {
    const profileWallets = await this.getProfileWallets(id);
    return profileWallets.find((wallet) => wallet.hasMnemonic()) ?? null;
  }

  /**
   * 秘密鍵でインポートしたアカウントを、`profileWalletId` のプロファイルに追加する（インデックスなし）。
   * すでに端末にある鍵なら新しく作らず、同じプロファイルなら再表示、別プロファイルなら 'other-profile' を返す。
   */
  static async addImportedKeyToProfile(
    profileWalletId: string,
    publicKey: string,
    privateKey: string,
    password: string,
    // The chain the key is for (default: the chain currently selected).
    chain: ChainKey = getChain(),
  ): Promise<'added' | 'shown' | 'other-profile'> {
    const stored = await Storage.loadWallets();
    const target = stored.get(profileWalletId);
    if (target == null) {
      throw new Error('profile not found');
    }
    const existing = stored.gets().find((wallet) => wallet.publicKey === publicKey && wallet.chain === chain);
    if (existing) {
      if (existing.profileKey !== target.profileKey) {
        return 'other-profile';
      }
      existing.hidden = false;
      await Storage.saveWallets(stored);
      return 'shown';
    }
    const wallet = await Wallet.createWithKeys(target.name, publicKey, privateKey, password, chain);
    while (stored.get(wallet.id) !== null) {
      wallet.id = Wallet.createId();
    }
    wallet.profileId = target.profileKey;
    wallet.hidden = false;
    stored.add(wallet);
    await Storage.saveWallets(stored);
    return 'added';
  }

  /**
   * Gives a profile that has none yet its NEM accounts, derived from the recovery phrase it already
   * holds (needs the profile's password to open the phrase). One NEM account is made for every
   * indexed Symbol account of the profile, with the same index name and visibility.
   * 'no-mnemonic': the profile was imported from private keys, so there is no phrase to derive from.
   */
  static async addNemAccountsToProfile(
    profileWalletId: string,
    password: string,
  ): Promise<'added' | 'exists' | 'no-mnemonic' | 'wrong-password'> {
    const stored = await Storage.loadWallets();
    const target = stored.get(profileWalletId);
    if (target == null) {
      throw new Error('profile not found');
    }
    const profileWallets = stored.getProfileWallets(profileWalletId);
    if (profileWallets.some((wallet) => wallet.chain === 'nem')) {
      return 'exists';
    }
    const source = profileWallets.find((wallet) => wallet.hasMnemonic());
    if (!source) {
      return 'no-mnemonic';
    }
    const phrase = await source.decryptMnemonic(password);
    if (phrase === null) {
      return 'wrong-password';
    }
    const usedIds = new Set(stored.gets().map((wallet) => wallet.id));
    for (const symbolAccount of profileWallets.filter((wallet) => wallet.chain === 'symbol' && wallet.accountIndex !== null)) {
      const account = nemAccountFromMnemonic(phrase, symbolAccount.accountIndex as number);
      const wallet = await Wallet.createWithKeys(symbolAccount.name, account.publicKey, account.privateKey, password, 'nem');
      while (usedIds.has(wallet.id)) {
        wallet.id = Wallet.createId();
      }
      usedIds.add(wallet.id);
      wallet.profileId = target.profileKey;
      wallet.accountIndex = symbolAccount.accountIndex;
      wallet.accountName = symbolAccount.accountName;
      wallet.hidden = symbolAccount.hidden;
      wallet.isDefault = symbolAccount.isDefault;
      wallet.encryptedMnemonic = source.encryptedMnemonic;
      stored.add(wallet);
    }
    // The NEM side now follows this profile (index order, first visible account).
    stored.setActive(stored.getActive('symbol')?.id ?? target.id);
    await Storage.saveWallets(stored);
    return 'added';
  }

  /** Changes one account's own settings: its index name and whether it is shown when switching. */
  /** Removes one account that was imported from a private key. False when it is not removable (derived or in use). */
  static async removeImportedAccount(id: string): Promise<boolean> {
    const wallets = await Storage.loadWallets();
    const target = wallets.get(id);
    if (!wallets.removeImportedAccount(id)) {
      return false;
    }
    await Storage.saveWallets(wallets);
    // 完全に消す：ウォレットのIDで別保存していた設定（ハーベストのノードなど）も残さない。
    if (target) purgeAccountData([{ id: target.id, profileKey: target.profileKey }], { profileRemoved: false });
    return true;
  }

  static async updateAccount(id: string, patch: { accountName?: string; hidden?: boolean; isDefault?: true; nemRemotePublicKey?: string }) {
    const wallets = await Storage.loadWallets();
    wallets.updateAccount(id, patch);
    await Storage.saveWallets(wallets);
  }

  /**
   * Saves every wallet of a new profile at once and makes `activeId` the active one.
   * `password` はこのプロファイルのパスワード（各アカウントの暗号化に使ったもの）。プロファイルごとに保存する。
   */
  static async addProfile(wallets: Wallet[], activeId: string, password: string) {
    // パスワードを先に保存する。ウォレットだけ保存されてパスワードが無い状態を作らないため。
    await PinCodeHelper.setForProfile(wallets[0].profileKey, password);
    const stored = await Storage.loadWallets();
    wallets.forEach((wallet) => stored.add(wallet));
    stored.setActive(activeId);
    await Storage.saveWallets(stored);
  }

  /**
   * 秘密鍵1本だけのプロファイルを作る（キーストアファイルの取り込み）：ニーモニックは持たず、アカウントはインデックスなしの1つだけ。
   * `password` はこのプロファイルのパスワード。すでに端末に同じ鍵（同じチェーン）があれば何も作らず 'exists' を返す。
   * 作ったウォレットを、そのチェーンの現在のアカウントにする。
   */
  static async addProfileFromKey(
    name: string,
    account: { chain: ChainKey; publicKey: string; privateKey: string },
    password: string,
  ): Promise<'added' | 'exists'> {
    const stored = await Storage.loadWallets();
    if (stored.gets().some((w) => w.chain === account.chain && w.publicKey.toUpperCase() === account.publicKey.toUpperCase())) return 'exists';
    const wallet = await Wallet.createWithKeys(name, account.publicKey.toUpperCase(), account.privateKey, password, account.chain);
    while (stored.get(wallet.id) !== null) wallet.id = Wallet.createId();
    await WalletsHelper.addProfile([wallet], wallet.id, password);
    return 'added';
  }

  /**
   * 閲覧用プロファイルを作る：アドレスだけを持つアカウント1つ。パスワードは設定しない（守るべき秘密が無い）。
   * `address` は parseWatchAddress で確かめたもの。作ったウォレットを、そのチェーンの現在のアカウントにする。
   */
  static async addWatchProfile(name: string, chain: ChainKey, address: string): Promise<Wallet> {
    const stored = await Storage.loadWallets();
    const wallet = Wallet.createWatch(name, chain, address);
    while (stored.get(wallet.id) !== null) {
      wallet.id = Wallet.createId();
    }
    wallet.profileId = Wallet.createId();
    stored.add(wallet);
    stored.setActive(wallet.id);
    await Storage.saveWallets(stored);
    return wallet;
  }

  /**
   * 閲覧用プロファイルに、見るアドレスを追加する（Symbol / NEM どちらでも）。
   * 'exists': そのアドレスはこのプロファイルにすでにある。
   */
  static async addWatchAddressToProfile(profileWalletId: string, chain: ChainKey, address: string): Promise<'added' | 'exists'> {
    const stored = await Storage.loadWallets();
    const target = stored.get(profileWalletId);
    if (target == null || !target.watchOnly) {
      throw new Error('watch profile not found');
    }
    const body = addressBody(chain, address);
    const duplicated = stored.getProfileWallets(profileWalletId, chain)
      .some((wallet) => wallet.watchOnly && addressBody(chain, wallet.watchAddress) === body);
    if (duplicated) {
      return 'exists';
    }
    const wallet = Wallet.createWatch(target.name, chain, address);
    while (stored.get(wallet.id) !== null) {
      wallet.id = Wallet.createId();
    }
    wallet.profileId = target.profileKey;
    stored.add(wallet);
    // このチェーンにまだアカウントが無かったなら、これを使うようにする。
    if (stored.getActive(chain)?.profileKey !== target.profileKey) {
      stored.setActive(wallet.id);
    }
    await Storage.saveWallets(stored);
    return 'added';
  }

  /** 閲覧用のプロファイルか（アクティブなアカウントの確認用）。 */
  static async isActiveWatchOnly(): Promise<boolean> {
    return (await this.getActiveAny())?.watchOnly === true;
  }

  /** Ledger のプロファイルか（アクティブなアカウントの確認用）。 */
  static async isActiveLedger(): Promise<boolean> {
    return (await this.getActiveAny())?.ledger === true;
  }

  /** SSS Extension のプロファイルか（アクティブなアカウントの確認用）。 */
  static async isActiveSss(): Promise<boolean> {
    return (await this.getActiveAny())?.sss === true;
  }

  /** この公開鍵の SSS プロファイルが、すでに端末にあるか。 */
  static async hasSssProfile(publicKey: string): Promise<boolean> {
    const key = publicKey.toUpperCase();
    return (await Storage.loadWallets()).gets().some((w) => w.sss && w.publicKey.toUpperCase() === key);
  }

  /**
   * SSS Extension のアカウントをプロファイルとして追加する（公開鍵だけ。パスワードは設定しない）。
   * 1つの SSS アカウントが1つのプロファイル。同じ公開鍵がすでにあれば追加しない（'exists'）。
   * `activate` が true のときは、追加したアカウントを使う状態にする（Symbol に切り替わる）。
   */
  static async addSssProfile(name: string, publicKey: string, activate: boolean): Promise<{ status: 'added' | 'exists'; wallet: Wallet }> {
    const stored = await Storage.loadWallets();
    const key = publicKey.toUpperCase();
    const existing = stored.gets().find((w) => w.sss && w.publicKey.toUpperCase() === key);
    if (existing) {
      if (activate) { stored.setActive(existing.id); await Storage.saveWallets(stored); }
      return { status: 'exists', wallet: existing };
    }
    const wallet = Wallet.createSss(name, key);
    while (stored.get(wallet.id) !== null) {
      wallet.id = Wallet.createId();
    }
    wallet.profileId = Wallet.createId();
    stored.add(wallet);
    // 追加しても、いま使っているアカウントは変えない（操作の途中で切り替わらないように）。
    // ただしアクティブなアカウントがまだ1つも無いときだけ、これを使う。
    if (activate || stored.getActive('symbol') === null) {
      stored.setActive(wallet.id);
    }
    await Storage.saveWallets(stored);
    return { status: 'added', wallet };
  }

  /**
   * Ledger のプロファイルを作る。`accounts` はデバイスから読んだ公開鍵（インデックス順）。先頭の1つだけを
   * 表示し、残りは非表示で持つ（アカウント画面から表示できる）。パスワードは設定しない（守る秘密が無い）。
   */
  static async addLedgerProfile(name: string, chain: ChainKey, accounts: Array<{ index: number; publicKey: string }>): Promise<Wallet> {
    if (accounts.length === 0) throw new Error('no ledger accounts');
    const stored = await Storage.loadWallets();
    const profileId = Wallet.createId();
    const wallets = accounts.map((a, i) => {
      const wallet = Wallet.createLedger(name, chain, a.publicKey, a.index);
      wallet.profileId = profileId;
      wallet.hidden = i !== 0;
      wallet.isDefault = i === 0;
      return wallet;
    });
    for (const wallet of wallets) {
      while (stored.get(wallet.id) !== null || wallets.some((o) => o !== wallet && o.id === wallet.id)) {
        wallet.id = Wallet.createId();
      }
      stored.add(wallet);
    }
    stored.setActive(wallets[0].id);
    await Storage.saveWallets(stored);
    return wallets[0];
  }

  /**
   * Deletes a profile: the given wallet and every other account of the same profile - its
   * recovery phrase, the keys derived from it, and any private keys imported into the profile.
   * @param {string} id Wallet ID (any account of the profile)
   */
  static async delete(id: string) {
    const wallets = await Storage.loadWallets();
    const wallet = wallets.get(id);
    if (wallet == null) {
      return;
    }
    const profileKey = wallet.profileKey;
    const removed = wallets.getProfileWallets(id).map((w) => ({ id: w.id, profileKey: w.profileKey }));
    wallets.delete(id);
    await Storage.saveWallets(wallets);
    // そのプロファイルのパスワードも一緒に消す。
    await PinCodeHelper.removeForProfile(profileKey);
    // ウォレットのIDやプロファイルのキーで別保存していた設定・バックアップ済みの印も残さない。
    purgeAccountData(removed, { profileRemoved: true });
  }

  /**
   * Deletes every wallet on this device - every recovery phrase and private key stored
   * locally is gone once this resolves. There's no way back short of re-importing from an
   * external backup. Used by Settings > Logout; every other flow removes one wallet at a
   * time (see delete()).
   */
  static async deleteAll() {
    const removed = (await Storage.loadWallets()).gets().map((w) => ({ id: w.id, profileKey: w.profileKey }));
    await Storage.saveWallets(new Wallets());
    purgeAccountData(removed, { profileRemoved: true });
  }

  /** Keeps the remote / VRF private keys of this account's delegated harvesting, encrypted with `password` (already checked). */
  static async saveHarvestKeys(id: string, keys: { remotePrivateKey: string; vrfPrivateKey: string }, password: string): Promise<void> {
    const wallets = await Storage.loadWallets();
    const wallet = wallets.get(id);
    if (!wallet) {
      return;
    }
    await wallet.setHarvestKeys(keys, password);
    await Storage.saveWallets(wallets);
  }

  /** The kept keys, or null (none kept / wrong password / damaged). */
  static async loadHarvestKeys(id: string, password: string): Promise<StoredHarvestKeys | null> {
    const wallet = await this.get(id);
    return wallet ? wallet.decryptHarvestKeys(password) : null;
  }

  /** Forgets the kept keys (harvesting stopped, or the keys no longer match the links). */
  static async clearHarvestKeys(id: string): Promise<void> {
    const wallets = await Storage.loadWallets();
    const wallet = wallets.get(id);
    if (!wallet || wallet.encryptedHarvestKeys === '') {
      return;
    }
    wallet.encryptedHarvestKeys = '';
    await Storage.saveWallets(wallets);
  }

  static async decryptKey(id: string, password: string): Promise<string | null> {
    const wallet = await this.get(id);
    if (!wallet) {
      return null;
    }
    // SSS Extension のアカウントは秘密鍵を持たない。空文字を返すと、署名する側（signMaybeSss）が拡張に頼む。
    if (wallet.sss) {
      return '';
    }
    const secret = await wallet.decryptSecret(password);
    if (secret !== null) {
      await this.migrateLegacyEncryptionIfNeeded(wallet, password);
    }
    return secret;
  }

  /**
   * Decrypts the recovery phrase (BIP39 mnemonic) for the given wallet, for the app-wide
   * Settings > バックアップ flow (see WalletBackup). Returns null if the wallet doesn't
   * exist, the password is wrong, or the wallet has no mnemonic (imported by private key).
   */
  static async decryptMnemonic(id: string, password: string): Promise<string | null> {
    const wallet = await this.get(id);
    if (!wallet) {
      return null;
    }
    const mnemonic = await wallet.decryptMnemonic(password);
    if (mnemonic !== null) {
      await this.migrateLegacyEncryptionIfNeeded(wallet, password);
    }
    return mnemonic;
  }

  /**
   * Upgrades a wallet's secret/mnemonic to the current AES-GCM format (see decryptString's
   * block comment near V2_PREFIX) if either is still in the legacy CryptoJS format.
   * Previously this only happened when the person went through Settings > PIN変更 (which
   * re-encrypts via encryptWallets); a wallet that was never touched there could stay on
   * the weaker legacy format indefinitely. Called from decryptKey/decryptMnemonic above so
   * ordinary use (unlocking Symbol/NEM, viewing a backup) upgrades it in the background.
   * Best-effort: never throws, and does nothing if the wallet is already current or if
   * re-encryption fails for any reason - the caller already has the plaintext it asked
   * for either way, so a failed migration attempt shouldn't disrupt it.
   */
  private static async migrateLegacyEncryptionIfNeeded(wallet: Wallet, password: string) {
    if (!wallet.hasLegacyCipher()) {
      return;
    }
    try {
      // Re-encrypting with the same password on both sides just rewrites the ciphertext
      // in the current format without actually changing what unlocks it.
      if (!(await wallet.encryptSecret(password, password))) {
        return;
      }
      const wallets = await Storage.loadWallets();
      const stored = wallets.get(wallet.id);
      if (stored) {
        stored.encryptedSecret = wallet.encryptedSecret;
        stored.stash = wallet.stash;
        stored.encryptedMnemonic = wallet.encryptedMnemonic;
        await Storage.saveWallets(wallets);
      }
    } catch {
      // Best-effort migration only - swallow and leave the wallet on the legacy format
      // for next time rather than surfacing an error for what the caller sees as a
      // successful decrypt.
    }
  }

  static async createWithKeys(name: string, publicKey: string, secretKey: string, password: string, chain: ChainKey = getChain()) {
    let wallet: Wallet;
    do {
      wallet = await Wallet.createWithKeys(name, publicKey, secretKey, password, chain);
    } while ((await this.get(wallet.id)) != null);

    return wallet;
  }

  /**
   * Creates a wallet backed by a BIP39 recovery phrase (new wallet creation, or mnemonic import).
   * The mnemonic itself is stored encrypted alongside the private key so it can be re-shown
   * for backup later (see WalletBackup).
   */
  static async createWithMnemonic(name: string, publicKey: string, secretKey: string, mnemonic: string, password: string, accountIndex: number = 0, chain: ChainKey = getChain()) {
    let wallet: Wallet;
    do {
      wallet = await Wallet.createWithMnemonic(name, publicKey, secretKey, mnemonic, password, accountIndex, chain);
    } while ((await this.get(wallet.id)) != null);

    return wallet;
  }

  /**
   * Re-encrypts every account of one profile (旧バージョンの既定パスワードで暗号化されたプロファイルを、
   * 本当のパスワードへ移行するときなど)。
   * @param {string} profileKey Wallet.profileKey
   */
  static async encryptProfile(profileKey: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const wallets = await Storage.loadWallets();
    for (const wallet of wallets.gets().filter((w) => w.profileKey === profileKey)) {
      if (!(await wallet.encryptSecret(oldPassword, newPassword))) {
        return false;
      }
    }
    await Storage.saveWallets(wallets);
    return true;
  }

  /**
   * 旧形式（CryptoJS のパスフレーズ方式）の暗号文が残っているプロファイルを、すべて強制的に消す。
   * アクティブでないプロファイルも対象。パスワードの確認や移行は行わない（取り消せない）。
   * 消したプロファイル（アカウント）の数を返す。何も無ければ 0。
   */
  static async deleteLegacyProfiles(): Promise<number> {
    const wallets = await Storage.loadWallets();
    const legacyProfileKeys = [...new Set(wallets.gets().filter((w) => w.hasLegacyCipher()).map((w) => w.profileKey))];
    let count = 0;
    for (const profileKey of legacyProfileKeys) {
      const target = (await Storage.loadWallets()).gets().find((w) => w.profileKey === profileKey);
      if (target) {
        await this.delete(target.id);
        count += 1;
      }
    }
    if (count > 0) {
      const remaining = await Storage.loadWallets();
      if (remaining.gets().length === 0) {
        // 守る鍵がひとつも無くなったので、端末共通の旧パスワードなども残さない。
        await PinCodeHelper.remove();
      } else {
        // 旧共通パスワードが、もう誰にも使われなくなっていれば消す。
        const keyed = remaining.gets().filter((w) => w.encryptedSecret.length > 0);
        const pins = await Storage.loadProfilePins();
        if (keyed.every((w) => pins[w.profileKey] !== undefined)) {
          await Storage.removePinCode();
        }
      }
    }
    return count;
  }

  /** そのプロファイルに、旧形式の暗号文がまだ残っているアカウントがあるか。 */
  static async profileHasLegacyCipher(profileKey: string): Promise<boolean> {
    return (await Storage.loadWallets()).gets().some((w) => w.profileKey === profileKey && w.hasLegacyCipher());
  }

  /**
   * プロファイルのパスワードを変更する。
   * 1. いまのパスワードを確認する（失敗回数のロックアウトも PinCodeHelper.check が扱う）。
   * 2. プロファイルの全アカウント（Symbol / NEM / インポートした秘密鍵）の秘密鍵とニーモニックを、
   *    新しいパスワードで暗号化し直す。ひとつでも復号できなければ、何も保存せずに中止する。
   * 3. 確認用ハッシュを新しいパスワードに差し替える。失敗したときは暗号化を元に戻す。
   * @returns 'ok' | 'wrong' (いまのパスワードが違う / ロック中) | 'error' (暗号化し直しに失敗)
   */
  static async changeProfilePassword(profileKey: string, oldPassword: string, newPassword: string): Promise<'ok' | 'wrong' | 'error'> {
    if (!(await PinCodeHelper.check(profileKey, oldPassword))) {
      return 'wrong';
    }
    if (!(await this.encryptProfile(profileKey, oldPassword, newPassword))) {
      return 'error';
    }
    try {
      await PinCodeHelper.setForProfile(profileKey, newPassword);
    } catch {
      // 確認用ハッシュを書けなかった場合、暗号化だけが新しいパスワードになると開けなくなるので戻す。
      await this.encryptProfile(profileKey, newPassword, oldPassword);
      return 'error';
    }
    return 'ok';
  }

  /**
   * Gets wallet name.
   * @param {string} id Wallet ID.
   * @returns {string} Wallet Name.
   */
  static async getName(id: string): Promise<string> {
    const wallet = await this.get(id);
    if (!wallet) {
      return '';
    }
    return wallet.name;
  }

  /**
   * Sets wallet name.
   * @param {string} id Wallet ID.
   * @param {string} name New wallet ID.
   */
  static async setName(id: string, name: string) {
    const wallets = await Storage.loadWallets();
    wallets.setName(id, name);
    await Storage.saveWallets(wallets);
  }
}


