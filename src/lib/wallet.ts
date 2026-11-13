// The Wallet (one account) and Wallets (the saved collection of them) data model, split out of
// storage.ts so the model can be read on its own, separate from IndexedDB/localStorage plumbing
// (Storage), PIN handling (PinCodeHelper) and the higher-level operations (WalletsHelper).
import { addressFromPublicKey, convertAddressNetwork } from './symbol/crypto';
import { getNetworkConfig } from './symbol/network';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { nemAddressFromPublicKey, convertNemAddressNetwork } from './nem/crypto';
import { encryptString, decryptString, isLegacyCipher } from './secretCrypto';

export function compareAccounts(a: { accountIndex: number | null }, b: { accountIndex: number | null }): number {
  const ai = a.accountIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.accountIndex ?? Number.MAX_SAFE_INTEGER;
  return ai - bi;
}

/** 委任ハーベストの開始時に作ったリモート／VRFの秘密鍵（ブロック作成専用で、送金には使えない）。Wallet.encryptedHarvestKeys に暗号化して持つ。 */
export interface StoredHarvestKeys {
  remotePrivateKey: string;
  vrfPrivateKey: string;
  savedAt: number;
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
  // プロファイルを開いたときに最初に使うアカウント（チェーンごとに1つ）。どれにも付いていなければ、
  // 表示中のいちばん若いインデックスが開く。非表示にも削除にもできない。
  isDefault: boolean = false;
  // NEM only: public key of the delegated-harvesting (remote) account derived from this account's key.
  // Public information; saved when the remote account is activated so it can be shown without the password.
  nemRemotePublicKey: string = "";
  // 閲覧用アカウント：アドレスだけを登録したもの。秘密鍵・公開鍵・ニーモニックは持たない（encryptedSecret は空、
  // publicKey も空）ので、残高や履歴を見ることはできても、署名が要る操作（送金・作成・登録・設定）はできない。
  // `watchAddress` は入力されたアドレス（ハイフンなしの大文字）。アドレスは公開鍵と同じく、ネットワーク
  // （メインネット / テストネット）の違いはネットワークバイトとチェックサムだけなので、`address` は
  // 今選んでいるネットワークのアドレスに変換して返す。
  watchOnly: boolean = false;
  watchAddress: string = "";
  // Ledger（ハードウェアウォレット）のアカウント：公開鍵だけを持ち、秘密鍵・ニーモニック・パスワードは持たない
  // （encryptedSecret は空）。署名はそのつどデバイスで行う。デバイス内のパスは accountIndex から決まる
  // （Symbol: m/44'/4343'/<n>'/0'/0'、NEM: m/44'/43'/<n>'/0'/0'）。
  ledger: boolean = false;
  // SSS Extension のアカウント：Ledger と同じく公開鍵だけを持ち、秘密鍵・ニーモニック・パスワードは持たない
  // （encryptedSecret は空）。署名はそのつど SSS Extension に頼む。Symbol のみ。1つの SSS アカウントが1つのプロファイル。
  sss: boolean = false;
  encryptedSecret: string = "";
  // Symbol only: the remote / VRF private keys made when delegated harvesting was started (JSON of StoredHarvestKeys,
  // encrypted with the profile's password like the secret). Empty when none is kept. They can only harvest, never move
  // funds; they are kept so the delegation request can be sent to the node again (docs/FEATURES.md 委任リクエストの再送).
  encryptedHarvestKeys: string = "";
  // Present only for wallets created/imported from a recovery phrase. Absent for
  // wallets imported from a raw private key, since there is no phrase to back up.
  encryptedMnemonic: string | null = null;
  // 公式Symbolウォレット互換のテストネット鍵（Symbol のみ。BIP44 コイン種別 1: m/44'/1'/<n>'/0'/0'）。
  // publicKey / encryptedSecret（m/44'/4343'/…）はそのまま残し、テストネットではこの鍵だけを使う（ロード時に差し替え、
  // 保存時に戻す）。公式ウォレットのテストネットのプロファイルと同じアドレスになる。まだこの鍵が無い古いプロファイルは、
  // 変換せず従来の鍵のまま使う。
  testnetPublicKey: string = "";
  encryptedTestnetSecret: string = "";
  // メモリ上だけ: テストネット鍵に差し替えているとき、元の（4343 の）鍵を預かっておく入れ物。保存はしない。
  stash: { publicKey: string; encryptedSecret: string } | null = null;
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
    const networkByte = getNetworkConfig().networkByte; // 0x68 / 0x98 on both chains
    if (this.watchOnly) {
      if (!this.watchAddress) return "";
      const converted = this.chain === 'nem'
        ? convertNemAddressNetwork(this.watchAddress, networkByte)
        : convertAddressNetwork(this.watchAddress, networkByte);
      return converted ?? this.watchAddress;
    }
    if (!this.publicKey) return "";
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

  /** 閲覧用アカウント（アドレスだけ）。署名に使う鍵は持たない。 */
  static createWatch(name: string, chain: ChainKey, address: string): Wallet {
    const wallet = new Wallet();
    wallet.createdAt = Date.now();
    wallet.chain = chain;
    wallet.name = name;
    wallet.watchOnly = true;
    wallet.watchAddress = address;
    return wallet;
  }

  /** Ledger のアカウント（公開鍵だけ）。`index` はデバイス内のアカウント番号。 */
  static createLedger(name: string, chain: ChainKey, publicKey: string, index: number): Wallet {
    const wallet = new Wallet();
    wallet.createdAt = Date.now();
    wallet.chain = chain;
    wallet.name = name;
    wallet.ledger = true;
    wallet.publicKey = publicKey.toUpperCase();
    wallet.accountIndex = index;
    return wallet;
  }

  /** SSS Extension のアカウント（公開鍵だけ）。Symbol のみ。 */
  static createSss(name: string, publicKey: string): Wallet {
    const wallet = new Wallet();
    wallet.createdAt = Date.now();
    wallet.chain = 'symbol';
    wallet.name = name;
    wallet.sss = true;
    wallet.publicKey = publicKey.toUpperCase();
    wallet.isDefault = true;
    return wallet;
  }

  /** 署名できないアカウントか（閲覧用、または対応していない Ledger）。SSS は署名できる側。 */
  get noSigner(): boolean {
    return this.watchOnly || this.ledger;
  }

  /** 秘密鍵をこの端末に持たないアカウントか（閲覧用・Ledger・SSS）。 */
  get keyless(): boolean {
    return this.watchOnly || this.ledger || this.sss;
  }

  static createId(): string {
    return new Date().getTime().toString(16)  + Math.floor(10000 * Math.random()).toString(16);
  }

  hasMnemonic(): boolean {
    return !!this.encryptedMnemonic;
  }

  /** 公式互換のテストネット鍵を持っているか（使う設定かどうかは問わない）。 */
  hasTestnetKeys(): boolean {
    return this.chain === 'symbol' && this.testnetPublicKey !== '' && this.encryptedTestnetSecret !== '';
  }

  /** いま、テストネット用の鍵（公式互換）に差し替えて使っているか。 */
  get usesTestnetKeys(): boolean {
    return this.stash !== null;
  }

  /** テストネットを選んでいて、公式互換の鍵を使う設定のアカウントは、publicKey / encryptedSecret をその鍵に差し替える。 */
  applyNetworkKeys(network: string): void {
    if (network !== 'testnet' || !this.hasTestnetKeys() || this.ledger || this.sss || this.watchOnly || this.stash !== null) {
      return;
    }
    this.stash = { publicKey: this.publicKey, encryptedSecret: this.encryptedSecret };
    this.publicKey = this.testnetPublicKey;
    this.encryptedSecret = this.encryptedTestnetSecret;
  }

  /** 保存用のコピー。差し替えていた鍵は元の場所へ戻す（差し替え中に再暗号化された分も、それぞれの場所に入る）。 */
  toStored(): Wallet {
    const out = Object.assign(new Wallet(), this);
    if (this.stash !== null) {
      out.testnetPublicKey = this.publicKey;
      out.encryptedTestnetSecret = this.encryptedSecret;
      out.publicKey = this.stash.publicKey;
      out.encryptedSecret = this.stash.encryptedSecret;
    }
    out.stash = null;
    return out;
  }

  /** 暗号化された値のどれかが、旧形式（CryptoJS のパスフレーズ方式）のままか。閲覧用・Ledger のアカウントは鍵を持たないので false。 */
  hasLegacyCipher(): boolean {
    return [this.encryptedSecret, this.encryptedMnemonic ?? '', this.encryptedTestnetSecret, this.encryptedHarvestKeys, this.stash?.encryptedSecret ?? '']
      .some(isLegacyCipher);
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

  /** Keeps the remote / VRF private keys (encrypted with `password`, which the caller has already checked). */
  async setHarvestKeys(keys: { remotePrivateKey: string; vrfPrivateKey: string }, password: string): Promise<void> {
    const stored: StoredHarvestKeys = { remotePrivateKey: keys.remotePrivateKey.toUpperCase(), vrfPrivateKey: keys.vrfPrivateKey.toUpperCase(), savedAt: Date.now() };
    this.encryptedHarvestKeys = await encryptString(JSON.stringify(stored), password);
  }

  /** The kept remote / VRF private keys; null when none is kept, the password is wrong or the data is damaged. */
  async decryptHarvestKeys(password: string): Promise<StoredHarvestKeys | null> {
    if (!this.encryptedHarvestKeys) {
      return null;
    }
    const text = await decryptString(this.encryptedHarvestKeys, password);
    if (text === null) {
      return null;
    }
    try {
      const keys = JSON.parse(text) as Partial<StoredHarvestKeys>;
      const hex64 = /^[0-9a-fA-F]{64}$/;
      if (typeof keys.remotePrivateKey !== 'string' || typeof keys.vrfPrivateKey !== 'string' || !hex64.test(keys.remotePrivateKey) || !hex64.test(keys.vrfPrivateKey)) {
        return null;
      }
      return { remotePrivateKey: keys.remotePrivateKey.toUpperCase(), vrfPrivateKey: keys.vrfPrivateKey.toUpperCase(), savedAt: Number(keys.savedAt) || 0 };
    } catch {
      return null;
    }
  }

  async encryptSecret(oldPassword: string, newPassword: string): Promise<boolean> {
    const rawSecret = await this.decryptSecret(oldPassword);
    if (rawSecret === null) {
      return false;
    }
    this.encryptedSecret = await encryptString(rawSecret, newPassword);

    // 公式互換のテストネット鍵（保存されている分と、差し替え中に預かっている元の鍵）もパスワードに合わせる。
    if (this.encryptedTestnetSecret) {
      const rawTestnet = await decryptString(this.encryptedTestnetSecret, oldPassword);
      if (rawTestnet === null) {
        return false;
      }
      this.encryptedTestnetSecret = await encryptString(rawTestnet, newPassword);
    }
    if (this.stash && this.stash.encryptedSecret) {
      const rawStashed = await decryptString(this.stash.encryptedSecret, oldPassword);
      if (rawStashed === null) {
        return false;
      }
      this.stash = { publicKey: this.stash.publicKey, encryptedSecret: await encryptString(rawStashed, newPassword) };
    }

    if (this.encryptedMnemonic) {
      const rawMnemonic = await this.decryptMnemonic(oldPassword);
      if (rawMnemonic === null) {
        return false;
      }
      this.encryptedMnemonic = await encryptString(rawMnemonic, newPassword);
    }
    // The kept harvesting keys follow the password too (otherwise they could not be opened after a password change).
    if (this.encryptedHarvestKeys) {
      const rawHarvest = await decryptString(this.encryptedHarvestKeys, oldPassword);
      if (rawHarvest === null) {
        return false;
      }
      this.encryptedHarvestKeys = await encryptString(rawHarvest, newPassword);
    }
    return true;
  }
}

export class Wallets {
  wallets: Wallet[] = [];
  // The active account of each chain: the Symbol one (kept under its original name so data saved
  // before NEM support still loads) and the NEM one. Both always belong to the same profile.
  activeId: string = '';
  activeNemId: string = '';

  get(id: string): Wallet | null {
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
    return accounts.find((wallet) => wallet.isDefault) ?? accounts.find((wallet) => !wallet.hidden) ?? accounts[0] ?? null;
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
  updateAccount(id: string, patch: { accountName?: string; hidden?: boolean; isDefault?: true; nemRemotePublicKey?: string }) {
    const wallet = this.get(id);
    if (!wallet) {
      return;
    }
    if (patch.isDefault) {
      // 同じプロファイル・同じチェーンで、デフォルトは1つだけ。デフォルトにしたアカウントは必ず表示する。
      for (const w of this.wallets) {
        if (w.profileKey === wallet.profileKey && w.chain === wallet.chain) {
          w.isDefault = false;
        }
      }
      wallet.isDefault = true;
      wallet.hidden = false;
    }
    if (patch.accountName !== undefined) {
      wallet.accountName = patch.accountName;
    }
    if (patch.hidden !== undefined && !(patch.hidden && wallet.isDefault)) {
      // 使っているアカウントを隠すときは、先に次のアカウントへ切り替える（切り替え先が無ければ隠さない）。
      if (!patch.hidden || this.leaveActive(wallet)) {
        wallet.hidden = patch.hidden;
      }
    }
    if (patch.nemRemotePublicKey !== undefined) {
      wallet.nemRemotePublicKey = patch.nemRemotePublicKey;
    }
  }

  // 使っているアカウントを隠す・取り除くときの、次に使うアカウント：同じプロファイル・同じチェーンの
  // デフォルト → 表示中の先頭 → それ以外。無ければ null。
  private replacementFor(wallet: Wallet): Wallet | null {
    const others = this.getProfileWallets(wallet.id, wallet.chain).filter((w) => w.id !== wallet.id);
    return others.find((w) => w.isDefault) ?? others.find((w) => !w.hidden) ?? others[0] ?? null;
  }

  // wallet がいま使われていれば、次のアカウントに切り替える。使われていなければ何もしない（true）。
  // 切り替え先が無いときは false（何も変えない）。
  private leaveActive(wallet: Wallet): boolean {
    if (wallet.id !== this.activeId && wallet.id !== this.activeNemId) {
      return true;
    }
    const next = this.replacementFor(wallet);
    if (!next) {
      return false;
    }
    this.setActive(next.id);
    return true;
  }

  // 秘密鍵でインポートしたアカウント（インデックスなし）を1つだけ取り除く。ニーモニックから導出した
  // アカウントは消さず、「非表示」にするだけ（いつでも戻せる）。デフォルトのアカウントは消さない。
  // いま使っているアカウントは、同じプロファイルの次のアカウント（デフォルトなど）に切り替えてから消す。
  removeImportedAccount(id: string): boolean {
    const wallet = this.get(id);
    if (!wallet || wallet.accountIndex !== null || wallet.isDefault || !this.leaveActive(wallet)) {
      return false;
    }
    this.wallets = this.wallets.filter((w) => w.id !== id);
    return true;
  }

  // 名前はプロファイル名。同じプロファイルのアカウントすべて（両チェーン）に同じ名前を持たせる。
  setName(id: string, name: string) {
    for (const wallet of this.getProfileWallets(id)) {
      wallet.name = name;
    }
  }
}
