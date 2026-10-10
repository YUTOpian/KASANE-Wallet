
import * as CryptoJS from 'crypto-js';
import localForage from 'localforage';


import * as bcrypt from 'bcryptjs'

import { addressFromPublicKey } from './symbol/crypto';
import { getNetworkConfig } from './symbol/network';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { nemAddressFromPublicKey } from './nem/crypto';
import { nemAccountFromMnemonic } from './nem/hd';

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

/** プロファイル内の並び順：インデックス順。秘密鍵でインポートしたアカウント（インデックスなし）は最後。 */
export function compareAccounts(a: { accountIndex: number | null }, b: { accountIndex: number | null }): number {
  const ai = a.accountIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.accountIndex ?? Number.MAX_SAFE_INTEGER;
  return ai - bi;
}

export class Wallet {
  id: string = Wallet.createId();
  name: string = "";
  // Which blockchain this account is for. Accounts saved before NEM support have no value and are
  // Symbol accounts (the default). A profile (one recovery phrase) holds the Symbol accounts and
  // the NEM accounts derived from the same phrase.
  chain: ChainKey = 'symbol';
  // Ed25519 public key (hex). Symbol addresses differ per network (the network byte is part of
  // the address), so only the key is stored and the address is derived on demand - see `address`.
  publicKey: string = "";
  // Which BIP44 account index (m/44'/4343'/<n>'/0'/0' on Symbol, m/44'/43'/<n>'/0'/0' on NEM) of
  // the recovery phrase this wallet uses; null for wallets imported from a raw private key.
  accountIndex: number | null = null;
  // プロファイル（=1つのニーモニック）のID。同じニーモニックから作られた各インデックスのアカウントは
  // すべて同じ profileId を持つ。空のもの（旧バージョンで作られたウォレット）は、そのウォレット自身を
  // 1つのプロファイルとして扱う（profileKey を参照）。
  profileId: string = "";
  // このインデックス（アカウント）に自分でつけた名前。空なら「インデックス N」と表示する。
  accountName: string = "";
  // ウォレット切り替え画面に表示しないインデックス。プロファイル作成時に導出済みのアカウントのうち、
  // 手動で「表示」するまでは非表示にしておく（旧バージョンのウォレットは常に表示）。
  hidden: boolean = false;
  // NEM only: public key of the delegated-harvesting (remote) account derived from this account's key.
  // Public information; saved when the remote account is activated so it can be shown without the password.
  nemRemotePublicKey: string = "";
  encryptedSecret: string = "";
  // Present only for wallets created/imported from a recovery phrase. Absent for
  // wallets imported from a raw private key, since there is no phrase to back up.
  encryptedMnemonic: string | null = null;
  // 作成日時（ミリ秒）。旧バージョンで作られたウォレットは 0 のままなので、`createdAtMs` を使う。
  createdAt: number = 0;

  /** 作成日時（ミリ秒）。未保存のものは、id の先頭（作成時刻の16進数）から復元する。 */
  get createdAtMs(): number {
    if (this.createdAt > 0) return this.createdAt;
    const parsed = parseInt(this.id.slice(0, 11), 16);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** The profile this account belongs to (legacy wallets without a profileId are their own profile). */
  get profileKey(): string {
    return this.profileId || this.id;
  }

  /** Address of this wallet on the currently selected network (mainnet "N...", testnet "T..."). */
  get address(): string {
    if (!this.publicKey) return "";
    const networkByte = getNetworkConfig().networkByte; // 0x68 / 0x98 on both chains
    return this.chain === 'nem'
      ? nemAddressFromPublicKey(this.publicKey, networkByte)
      : addressFromPublicKey(this.publicKey, networkByte);
  }

  static async createWithKeys(name: string, publicKey: string, secretKey: string, password: string, chain: ChainKey = 'symbol') {
    const wallet = new Wallet();
    wallet.createdAt = Date.now();
    wallet.chain = chain;
    wallet.name = name;
    wallet.publicKey = publicKey;
    wallet.encryptedSecret = await encryptString(secretKey, password);
    return wallet;
  }

  static async createWithMnemonic(name: string, publicKey: string, secretKey: string, mnemonic: string, password: string, accountIndex: number = 0, chain: ChainKey = 'symbol') {
    const wallet = await Wallet.createWithKeys(name, publicKey, secretKey, password, chain);
    wallet.encryptedMnemonic = await encryptString(mnemonic, password);
    wallet.accountIndex = accountIndex;
    return wallet;
  }

  static createId(): string {
    return new Date().getTime().toString(16)  + Math.floor(10000 * Math.random()).toString(16);
  }

  hasMnemonic(): boolean {
    return !!this.encryptedMnemonic;
  }

  async decryptSecret(password: string): Promise<string | null> {
    return decryptString(this.encryptedSecret, password);
  }

  async decryptMnemonic(password: string): Promise<string | null> {
    if (!this.encryptedMnemonic) {
      return null;
    }
    return decryptString(this.encryptedMnemonic, password);
  }

  async encryptSecret(oldPassword: string, newPassword: string): Promise<boolean> {
    const rawSecret = await this.decryptSecret(oldPassword);
    if (rawSecret === null) {
      return false;
    }
    this.encryptedSecret = await encryptString(rawSecret, newPassword);

    if (this.encryptedMnemonic) {
      const rawMnemonic = await this.decryptMnemonic(oldPassword);
      if (rawMnemonic === null) {
        return false;
      }
      this.encryptedMnemonic = await encryptString(rawMnemonic, newPassword);
    }
    return true;
  }
}

class Wallets {
  wallets: Wallet[] = [];
  // The active account of each chain: the Symbol one (kept under its original name so data saved
  // before NEM support still loads) and the NEM one. Both always belong to the same profile.
  activeId: string = '';
  activeNemId: string = '';

  get(id: String): Wallet | null {
    const wallet =  this.wallets.find((wallet) => wallet.id === id);
    if (wallet) {
      return wallet;
    } else {
      return null;
    }
  }
  /** All accounts, or only those of one chain. */
  gets(chain?: ChainKey): Wallet[] {
    return this.wallets.filter((wallet) => chain === undefined || wallet.chain === chain);
  }

  private activeIdOf(chain: ChainKey): string {
    return chain === 'nem' ? this.activeNemId : this.activeId;
  }

  /** The profile's account of a chain that is shown first: the lowest visible index. */
  private firstAccountOf(profileKey: string, chain: ChainKey): Wallet | null {
    const accounts = this.wallets
      .filter((wallet) => wallet.profileKey === profileKey && wallet.chain === chain)
      .sort(compareAccounts);
    return accounts.find((wallet) => !wallet.hidden) ?? accounts[0] ?? null;
  }

  /**
   * The active account of a chain. If that chain has none recorded (a profile made before NEM was
   * added, or the person just switched chain), it is the first account of the same profile as the
   * other chain's active account; null when the profile has no account on this chain.
   */
  getActive(chain: ChainKey = getChain()): Wallet | null {
    const own = this.get(this.activeIdOf(chain));
    if (own && own.chain === chain) {
      return own;
    }
    const other = this.get(this.activeIdOf(chain === 'nem' ? 'symbol' : 'nem'));
    return other ? this.firstAccountOf(other.profileKey, chain) : null;
  }

  getIndex(id: string): number {
    for (let index=0; index< this.wallets.length; index++) {
      if (this.wallets[index].id === id) {
        return index;
      }
    }
    return -1;
  }

  getActiveIndex(chain: ChainKey = getChain()): number {
    return this.getIndex(this.activeIdOf(chain));
  }

  /** Makes the account active on its own chain, and moves the other chain to the same profile. */
  setActive(id: string) {
    const wallet = this.get(id);
    if (!wallet) {
      return;
    }
    const otherChain: ChainKey = wallet.chain === 'nem' ? 'symbol' : 'nem';
    const otherCurrent = this.get(this.activeIdOf(otherChain));
    // Keep the other chain's account if it is already of this profile (it may be a non-first index).
    const otherNext = otherCurrent && otherCurrent.profileKey === wallet.profileKey
      ? otherCurrent
      : this.firstAccountOf(wallet.profileKey, otherChain);
    if (wallet.chain === 'nem') {
      this.activeNemId = wallet.id;
      this.activeId = otherNext ? otherNext.id : '';
    } else {
      this.activeId = wallet.id;
      this.activeNemId = otherNext ? otherNext.id : '';
    }
  }

  add(wallet: Wallet){
    this.wallets.push(wallet);
  }

  // プロファイル単位で削除する：指定したウォレットと同じプロファイルのアカウント（Symbol / NEM 両方）をすべて消す。
  delete(id: string) {
    const target = this.get(id);
    if (!target) {
      return;
    }
    const key = target.profileKey;
    this.wallets = this.wallets.filter((wallet) => wallet.profileKey !== key);

    if (this.get(this.activeId) === null) {
      this.activeId = this.wallets.find((wallet) => wallet.chain === 'symbol')?.id ?? '';
    }
    if (this.get(this.activeNemId) === null) {
      // Left empty: getActive('nem') then follows the Symbol account's profile.
      this.activeNemId = '';
    }
  }

  // 指定したウォレットと同じプロファイルのアカウント（インデックス順）。chain を指定すると、その
  // チェーンのアカウントだけ。
  getProfileWallets(id: string, chain?: ChainKey): Wallet[] {
    const target = this.get(id);
    if (!target) {
      return [];
    }
    return this.wallets
      .filter((wallet) => wallet.profileKey === target.profileKey && (chain === undefined || wallet.chain === chain))
      .sort(compareAccounts);
  }

  // 1つのアカウント（インデックス）だけの設定を書き換える：インデックス名・表示／非表示。
  updateAccount(id: string, patch: { accountName?: string; hidden?: boolean; nemRemotePublicKey?: string }) {
    const wallet = this.get(id);
    if (!wallet) {
      return;
    }
    if (patch.accountName !== undefined) {
      wallet.accountName = patch.accountName;
    }
    if (patch.hidden !== undefined) {
      wallet.hidden = patch.hidden;
    }
    if (patch.nemRemotePublicKey !== undefined) {
      wallet.nemRemotePublicKey = patch.nemRemotePublicKey;
    }
  }

  // 名前はプロファイル名。同じプロファイルのアカウントすべて（両チェーン）に同じ名前を持たせる。
  setName(id: string, name: string) {
    for (const wallet of this.getProfileWallets(id)) {
      wallet.name = name;
    }
  }
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
      return wallet;
    });
    return wallets;
  }

  static async saveWallets(wallets: Wallets) {
    await localForage.setItem(this.WALLETS_KEY, wallets);
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
    const hashedCode = await bcrypt.hash(rawCode, 10);
    const pinCode = new PinCode();
    pinCode.hashedCode = hashedCode;
    const pins = await Storage.loadProfilePins();
    pins[profileKey] = pinCode;
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

    const isCorrect = await bcrypt.compare(pinCode, savedCode.hashedCode);
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
    accounts: { index: number; publicKey: string; privateKey: string; chain?: ChainKey }[],
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
      wallet.encryptedMnemonic = source.encryptedMnemonic;
      stored.add(wallet);
    }
    // The NEM side now follows this profile (index order, first visible account).
    stored.setActive(stored.getActive('symbol')?.id ?? target.id);
    await Storage.saveWallets(stored);
    return 'added';
  }

  /** Changes one account's own settings: its index name and whether it is shown when switching. */
  static async updateAccount(id: string, patch: { accountName?: string; hidden?: boolean; nemRemotePublicKey?: string }) {
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
    wallets.delete(id);
    await Storage.saveWallets(wallets);
    // そのプロファイルのパスワードも一緒に消す。
    await PinCodeHelper.removeForProfile(profileKey);
  }

  /**
   * Deletes every wallet on this device - every recovery phrase and private key stored
   * locally is gone once this resolves. There's no way back short of re-importing from an
   * external backup. Used by Settings > Logout; every other flow removes one wallet at a
   * time (see delete()).
   */
  static async deleteAll() {
    await Storage.saveWallets(new Wallets());
  }

  static async decryptKey(id: string, password: string): Promise<string | null> {
    const wallet = await this.get(id);
    if (!wallet) {
      return null;
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
    const secretIsLegacy = wallet.encryptedSecret.length > 0 && !wallet.encryptedSecret.startsWith(V2_PREFIX);
    const mnemonicIsLegacy = !!wallet.encryptedMnemonic && !wallet.encryptedMnemonic.startsWith(V2_PREFIX);
    if (!secretIsLegacy && !mnemonicIsLegacy) {
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
        stored.encryptedMnemonic = wallet.encryptedMnemonic;
        await Storage.saveWallets(wallets);
      }
    } catch (e) {
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


// --- PIN-based encryption for encryptedSecret/encryptedMnemonic --------------------------
//
// The PIN the person types (4-6 raw digits) is never used directly as an AES key/passphrase.
// It's first stretched through PBKDF2-HMAC-SHA256 with a random per-secret salt and a high
// iteration count, so an attacker who extracts the encrypted blob from IndexedDB still has
// to brute-force the PIN through 210,000 PBKDF2 rounds per guess rather than a single cheap
// AES decrypt - closing the gap described in the security review above (a raw 4-6 digit
// keyspace is otherwise exhaustible almost instantly). This uses the browser's native
// Web Crypto API (SubtleCrypto) rather than crypto-js's pure-JS PBKDF2: crypto-js took
// ~2 seconds for one derivation at this iteration count in testing (would mean a
// multi-second freeze on every PIN unlock/send/backup), while SubtleCrypto's native
// implementation does the same work in the low tens of milliseconds. AES-GCM (authenticated
// encryption) also replaces AES-CBC here, so a wrong PIN fails the auth tag immediately
// instead of relying on "did this decrypt to plausible-looking UTF-8?" as a proxy.
//
// New format (written by every encryptString call from now on):
//   "v2:" + base64(salt) + ":" + base64(iv) + ":" + base64(ciphertext+authTag)
// Old format (still readable, never written): CryptoJS.AES.encrypt(message, pin).toString()
//   - i.e. CryptoJS's own passphrase mode (EVP_BytesToKey/MD5, embedded salt, AES-CBC).
//   Kept decryptable so wallets created before this change don't lose their secret/
//   mnemonic; they're transparently upgraded to the new format the next time
//   encryptSecret() runs (Settings > PIN変更 flow), since that always re-encrypts through
//   encryptString().
const V2_PREFIX = 'v2:';
const PBKDF2_ITERATIONS = 210000; // OWASP 2023 minimum for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12; // recommended nonce length for AES-GCM

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesGcmKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptString(message: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesGcmKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(message));
  return `${V2_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decryptString(encrypted: string, password: string): Promise<string | null> {
  try {
    if (encrypted.startsWith(V2_PREFIX)) {
      const [saltB64, ivB64, cipherB64] = encrypted.slice(V2_PREFIX.length).split(':');
      if (!saltB64 || !ivB64 || !cipherB64) {
        return null;
      }
      const salt = base64ToBytes(saltB64);
      const iv = base64ToBytes(ivB64);
      const key = await deriveAesGcmKey(password, salt);
      // AES-GCM throws if the auth tag doesn't match (wrong password or tampered data) -
      // caught below, so a wrong PIN reliably yields null rather than garbage plaintext.
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, base64ToBytes(cipherB64) as BufferSource);
      return new TextDecoder().decode(plainBuf);
    }

    // Legacy format from before this change - see block comment above.
    const decrypted = CryptoJS.AES.decrypt(encrypted, password);
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    return text.length > 0 ? text : null;
  } catch (e) {
    return null;
  }
}

